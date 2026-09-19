/* ═══════════════════════════════════════════════════════════════════════════
   JOURNEY — رحلة العميل على الموقع (مسار ٠٢، مبسّط، ١٧ سبتمبر ٢٠٢٦)

   طلب عمر: «عايزين ممارسة كويسة نقدر نبص بيها ع التقارير ورحلة العميل بشكل
   سهل وسلس». الموديول ده بيجاوب على سؤال واحد: **فين بنخسر العميل وليه؟**

   ─ المصادر ───────────────────────────────────────────────────────────────
   • المتجر (static/journey.js) بيبعت دفعات أحداث من طرف أول، مش بتروح لأي
     منصة إعلانات: session_start, offer_view, picker_open, item_add/remove,
     cart_open, checkout_view, address_step_open, address_set, otp_*,
     coupon_*, payment_*, order_created … (القايمة الكاملة WEB_EVENTS تحت).
   • السيرفر: checkout_result من shop.js (deps.journey().emit)، وorder_paid من
     ناقل order-events. حالات الطلب بعد الدفع مابتتنسخش — الخط الزمني بيقرا
     shop_order_events مباشرة (الخطة الرئيسية C1).

   ─ الهوية والخصوصية ──────────────────────────────────────────────────────
   • anon_id = fc_dev (نفس deviceId بتاع السلة)، session_id = fc_jsid (٣٠ دقيقة
     خمول، أو مصدر جديد في الرابط).
   • الجوال **عمره ما بيتبعت من المتصفح**. الربط بعد OTP بيحصل على السيرفر:
     POST /api/journey/identify بتوكن العميل (cust:) → acct_sessions → phone.
     وبعد الدفع من shop_orders. الجوال بيتعرض مقنّع بس (5•••••12).
   • props بتتنضف: مفاتيح شكلها بيانات شخصية بتتشال، وأي ٩ أرقام بتبدأ بـ5
     بتتحول [redacted]. الاحتفاظ ١٨٠ يوم.
   • بوتات (botfilter.js لو موجود + UA احتياطي) وQA (utm_source=qa/cro-audit)
     وأرقام الموظفين/طلبات الاختبار: بتتخزن بعلامة، ومابتدخلش الأرقام. جلسات
     QA بتبان في مستكشف الجلسات بعلامة QA.

   ─ السرعة ────────────────────────────────────────────────────────────────
   journey_sessions نفسه هو الـrollup: صف لكل جلسة فيه أبعد خطوة (max_step)
   والنتيجة. التقرير = GROUP BY على صفوف الجلسات (آلاف مش ملايين) + كاش ٦٠ ث.

   ─ المسارات ──────────────────────────────────────────────────────────────
   عامة:  POST /api/journey/batch      (text/plain عشان sendBeacon، دايماً 200)
          POST /api/journey/identify   (Authorization: Bearer cust:<token>)
   إدارة (PATH_SECTIONS: /api/journey → analytics):
          GET  /api/journey/report?range=today|yesterday|7d|30d
          GET  /api/journey/sessions?range=&q=&filter=
          GET  /api/journey/sessions/:sid
          GET  /api/journey/health
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { customerId } from "./customer-id.js";

/* ═══ pure lib (متجرّب في journey.test.mjs) ═════════════════════════════ */

export const RETENTION_DAYS = 180;
export const TZ = "Asia/Riyadh";
export const BIZ_DAY_START_HOUR = 4;

export const STEPS = Object.freeze([
  { step: 0, key: "landed", label: "دخل الموقع" },
  { step: 1, key: "viewed", label: "فتح عرض أو صنف" },
  { step: 2, key: "cart", label: "أضاف للسلة" },
  { step: 3, key: "checkout", label: "فتح إتمام الطلب" },
  { step: 4, key: "address", label: "حدّد عنوان مقبول (أو استلام)" },
  { step: 5, key: "otp", label: "أكّد جواله" },
  { step: 6, key: "payment", label: "وصل لصفحة الدفع" },
  { step: 7, key: "paid", label: "دفع" },
]);
export const PAID_STEP = 7;

// أحداث المتصفح المسموحة — أي اسم تاني بيترفض
export const WEB_EVENTS = Object.freeze([
  "session_start", "page_view", "offer_view", "picker_open", "item_view",
  "item_add", "item_remove", "cart_open", "checkout_view", "address_step_open",
  "address_set", "pickup_selected", "otp_gate_shown", "otp_requested", "otp_verified", "otp_failed",
  "coupon_applied", "coupon_failed", "checkout_submit", "checkout_error", "order_created",
  "payment_sheet_open", "payment_method_selected", "payment_redirect", "payment_failed",
  "order_paid_client", "webview_guard", "store_closed_block", "track_view", "page_hide", "error_js",
  // ١٩/٩ (تحليل CRO): المنتقي + قفل الأوراق + أخطاء الفورم + أول لمسة + الهروب من متصفح التطبيق
  "picker_choice", "picker_add_blocked", "picker_close", "sheet_close", "form_error",
  "first_input", "page_visible", "iab_escape", "iab_stay",
  // ١٩/٩ (قرار المالك): فتح السلة لزائر الإعلان بعد العرض + طلب الموقع أول ما خطوة العنوان تتفتح
  "auto_cart_open", "auto_cart_back",
  "geo_prompt", "geo_granted", "geo_denied", "geo_timeout", "geo_unavailable", "geo_skipped",
  // ١٩/٩: شرح «ازاي أفعّل الموقع» (حالة المتصفح denied) + تبديل لغة الواجهة
  "geo_help", "lang_switch",
]);

/* نوع خطأ الـJS. المتصفح بيبعت kind من ١٩/٩؛ القديم بنصنّفه من الرسالة والملف.
   first_party/inline = ممكن يكون بتاعنا ويستاهل نصلحه. الباقي دخيل (جسر متصفح
   التطبيق، سكريبت دومين تاني، كود محقون) — بيتعرض بس مابيتحسبش «خطأ في الصفحة». */
export const ERROR_KINDS = Object.freeze({
  first_party: "من كودنا", inline: "سكريبت جوّه الصفحة", third_party: "سكريبت دومين تاني",
  cross_origin: "دومين تاني (التفاصيل مخفية)", iab_bridge: "جسر متصفح فيسبوك/انستجرام", injected: "كود محقون من التطبيق",
});
export function classifyJsError(props = {}) {
  const p = props && typeof props === "object" ? props : {};
  if (p.kind && ERROR_KINDS[p.kind]) return p.kind;
  const msg = String(p.msg || "");
  if (/Java object is gone|webkit\.messageHandlers|invoking postMessage/i.test(msg)) return "iab_bridge";
  if (/^Script error\.?$/i.test(msg)) return "cross_origin";
  const src = String(p.src || "");
  if (!src) return "injected";
  if (/^\/static\//.test(src)) return "first_party";
  return "inline";
}
export const isOurError = (kind) => kind === "first_party" || kind === "inline";
// نفس المنطق بالـSQL (للأحداث القديمة من غير kind)
const ERR_KIND_SQL = `COALESCE(NULLIF(e.props->>'kind',''),
  CASE WHEN e.props->>'msg' ~* '(Java object is gone|webkit\\.messageHandlers|invoking postMessage)' THEN 'iab_bridge'
       WHEN e.props->>'msg' ~* '^Script error\\.?$' THEN 'cross_origin'
       WHEN COALESCE(e.props->>'src','') = '' THEN 'injected'
       WHEN e.props->>'src' LIKE '/static/%' THEN 'first_party'
       ELSE 'inline' END)`;
const WEB_SET = new Set(WEB_EVENTS);
export const SERVER_EVENTS = Object.freeze(["checkout_result", "order_paid", "identified"]);
const SERVER_SET = new Set(SERVER_EVENTS);

/* الخطوة اللي الحدث بيثبتها. order_paid (٧) من السيرفر بس — المتصفح مايقدرش
   يعلن إنه دفع. */
export function stepOf(name, props = {}, source = "web") {
  const p = props && typeof props === "object" ? props : {};
  switch (name) {
    case "session_start": case "page_view": return 0;
    case "offer_view": case "picker_open": case "item_view": return 1;
    case "item_add": return 2;
    case "checkout_view": case "address_step_open": return 3;
    case "address_set": return p.deliverable === true ? 4 : 3;
    case "pickup_selected": return 3;
    case "otp_verified": return 5;
    case "payment_sheet_open": case "payment_redirect": case "payment_method_selected": case "order_created": return 6;
    case "checkout_result": return p.ok === true ? 6 : null;
    case "order_paid": return source === "server" ? PAID_STEP : null;
    default: return null;
  }
}

const PII_KEY_RE = /phone|mobile|name|address|street|building|floor|apartment|landmark|^lat|^lng|^lon|latitude|longitude|email|otp_code|^code$|card|token|password|notes?$/i;
const PHONE_RE = /(?:\+?966|0)?5\d{8}/g;
export function scrubString(s, max = 120) {
  let v = String(s == null ? "" : s).replace(/[ -]/g, " ");
  v = v.replace(PHONE_RE, "[redacted]");
  v = v.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return v.slice(0, max);
}

/* props آمنة: ≤ ٢٠ مفتاح، قيم بسيطة بس، مفيش بيانات شخصية. */
export function sanitizeProps(props) {
  const out = {};
  if (!props || typeof props !== "object" || Array.isArray(props)) return out;
  let n = 0;
  for (const [k0, v] of Object.entries(props)) {
    if (n >= 20) break;
    const k = String(k0).replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40);
    if (!k || PII_KEY_RE.test(k)) continue;
    if (v == null) continue;
    if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "number") { if (Number.isFinite(v)) out[k] = Math.round(v * 100) / 100; else continue; }
    else if (typeof v === "string") { const s = scrubString(v); if (!s) continue; out[k] = s; }
    else if (Array.isArray(v)) out[k] = v.slice(0, 10).map((x) => (typeof x === "number" ? x : scrubString(x, 40)));
    else continue;
    n++;
  }
  return out;
}

export const QA_SOURCES = new Set(["qa", "cro-audit", "cro_audit", "test"]);
export const isQaUtm = (u = {}) => QA_SOURCES.has(String(u.utm_source || "").trim().toLowerCase())
  || String(u.utm_campaign || "").toLowerCase().startsWith("cro-audit");

export function deviceOf(ua = "") {
  const s = String(ua || "");
  if (/iPhone|iPod/i.test(s)) return "iphone";
  if (/iPad/i.test(s)) return "ipad";
  if (/Android/i.test(s)) return "android";
  if (/Windows|Macintosh|Linux|CrOS/i.test(s)) return "desktop";
  return "other";
}
export function inAppOf(ua = "") {
  const s = String(ua || "");
  if (/Instagram/i.test(s)) return "instagram";
  if (/FBAN|FBAV|FB_IAB|FBIOS|\[FB/i.test(s)) return "facebook";
  if (/musical_ly|BytedanceWebview|TikTok|trill_/i.test(s)) return "tiktok";
  if (/Snapchat/i.test(s)) return "snapchat";
  if (/Twitter/i.test(s)) return "twitter";
  if (/Line\//i.test(s)) return "line";
  return null;
}

const FALLBACK_BOT_RE = /bot\b|crawler|spider|facebookexternalhit|meta-externalagent|headlesschrome|lighthouse|python-|curl\/|wget\/|go-http-client|node-fetch|axios\//i;

export const CHANNEL_LABELS = Object.freeze({
  meta_ads: "إعلانات ميتا", google_ads: "إعلانات جوجل", tiktok_ads: "إعلانات تيك توك", snap_ads: "إعلانات سناب",
  instagram: "انستجرام (مجاني)", facebook: "فيسبوك (مجاني)", tiktok: "تيك توك (مجاني)", snapchat: "سناب (مجاني)",
  google: "جوجل (بحث/خرائط)", sms: "رسائل SMS", whatsapp: "واتساب", push: "إشعارات",
  qr: "QR", offer_link: "رابط عرض", campaign_link: "رابط حملة", ai: "ذكاء اصطناعي",
  delivery_app: "تطبيقات التوصيل", referral: "مواقع أخرى", direct: "مباشر", qa: "QA/اختبار",
});

/* المصدر — أول قاعدة تنطبق تكسب */
export function classifyChannel(s = {}) {
  const src = String(s.utm_source || "").trim().toLowerCase();
  const med = String(s.utm_medium || "").trim().toLowerCase();
  const clicks = new Set((s.click_ids || []).map((x) => String(x).toLowerCase()));
  const ref = String(s.referrer_host || "").toLowerCase();
  const paidMed = /paid|cpc|ads?$|ppc|paid_social|sponsored/.test(med);
  if (isQaUtm(s)) return "qa";
  if (src === "sms" || med === "sms") return "sms";
  if (src === "whatsapp" || src === "wa" || med === "whatsapp") return "whatsapp";
  if (src === "push" || med === "push") return "push";
  if (src === "qr" || med === "qr") return "qr";
  if (clicks.has("fbclid") && (paidMed || !src || /^(meta|fb|facebook|ig|instagram)$/.test(src)) && (paidMed || /^(meta|fb|facebook|ig|instagram)$/.test(src))) return "meta_ads";
  if (/^(meta|fb|facebook|ig|instagram)$/.test(src) && paidMed) return "meta_ads";
  if (clicks.has("gclid") || clicks.has("gbraid") || clicks.has("wbraid") || (src === "google" && paidMed)) return "google_ads";
  if (clicks.has("ttclid") || (src === "tiktok" && paidMed)) return "tiktok_ads";
  if (clicks.has("sccid") || clicks.has("scid") || (/^snap(chat)?$/.test(src) && paidMed)) return "snap_ads";
  if (med === "offer-link" || med === "offer_link") return "offer_link";
  if (s.link_slug) return "campaign_link";
  if (/^(ig|instagram)$/.test(src)) return "instagram";
  if (/^(fb|facebook|meta)$/.test(src)) return "facebook";
  if (src === "tiktok") return "tiktok";
  if (/^snap(chat)?$/.test(src)) return "snapchat";
  if (src === "google" || src === "gmb" || src === "google_maps") return "google";
  if (/^(keeta|hungerstation|ninja|jahez)$/.test(src)) return "delivery_app";
  if (clicks.has("fbclid")) return s.in_app === "instagram" ? "instagram" : "facebook";
  if (/(^|\.)instagram\.com$/.test(ref)) return "instagram";
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/.test(ref)) return "facebook";
  if (/(^|\.)tiktok\.com$/.test(ref)) return "tiktok";
  if (/(^|\.)snapchat\.com$/.test(ref)) return "snapchat";
  if (/(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yandex\.[a-z.]+)$/.test(ref)) return "google";
  if (/(chatgpt\.com|openai\.com|perplexity\.ai|gemini\.google\.com|copilot\.microsoft\.com)$/.test(ref)) return "ai";
  if (/(^|\.)(wa\.me|whatsapp\.com)$/.test(ref)) return "whatsapp";
  if (s.in_app === "instagram") return "instagram";
  if (s.in_app === "facebook") return "facebook";
  if (s.in_app === "tiktok") return "tiktok";
  if (s.in_app === "snapchat") return "snapchat";
  if (src) return "referral";
  if (ref && !/freshcuts\.sa$|o2m8\.me$/.test(ref)) return "referral";
  return "direct";
}

export function maskPhone(pn) {
  const d = String(pn || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
  if (d.length < 4) return null;
  return `${d[0]}${"•".repeat(Math.max(1, d.length - 3))}${d.slice(-2)}`;
}

const SID_RE = /^s[a-z0-9]{8,40}$/;
const ANON_RE = /^[a-z0-9_-]{2,64}$/i;
const ORDER_RE = /^[A-Z]{0,3}\d{6,20}$/;
export const validSid = (s) => typeof s === "string" && SID_RE.test(s);

/* جسم /batch → {sessionId, anonId, session, events[]} أو {error} — صافي */
export function parseBatch(raw, { now = Date.now(), maxEvents = 50 } = {}) {
  let b = raw;
  if (typeof raw === "string") {
    if (raw.length > 48_000) return { error: "too_large" };
    try { b = JSON.parse(raw); } catch { return { error: "bad_payload" }; }
  }
  if (!b || typeof b !== "object") return { error: "bad_payload" };
  const sessionId = String(b.sessionId || "");
  const anonId = String(b.anonId || "");
  if (!validSid(sessionId) || !ANON_RE.test(anonId)) return { error: "bad_ids" };
  const s = b.session && typeof b.session === "object" ? b.session : null;
  const clip = (v, n = 120) => (v == null || v === "" ? null : scrubString(v, n) || null);
  const session = s ? {
    landing_path: clip(String(s.landing_path || "").split("?")[0], 200),
    referrer_host: clip(String(s.referrer_host || "").toLowerCase(), 120),
    utm_source: clip(s.utm_source, 80), utm_medium: clip(s.utm_medium, 80),
    utm_campaign: clip(s.utm_campaign, 120), utm_content: clip(s.utm_content, 120), utm_term: clip(s.utm_term, 120),
    link_slug: clip(s.link_slug, 60), coupon_param: clip(s.coupon_param, 30),
    click_ids: Array.isArray(s.click_ids) ? s.click_ids.map((x) => String(x).replace(/[^a-zA-Z]/g, "").slice(0, 12)).filter(Boolean).slice(0, 6) : [],
    app_version: clip(s.app_version, 30), lang: clip(s.lang, 10), vw: Number.isFinite(Number(s.vw)) ? Math.round(Number(s.vw)) : null,
    pwa: s.pwa === true,
    ui_lang: s.ui_lang === "en" || s.ui_lang === "ar" ? s.ui_lang : null,
  } : null;
  const events = [];
  const rejected = {};
  for (const e of (Array.isArray(b.events) ? b.events : []).slice(0, maxEvents)) {
    const name = String(e && e.n || "");
    if (!WEB_SET.has(name)) { rejected.unknown = (rejected.unknown || 0) + 1; continue; }
    const t = Number(e.t);
    const clientTs = Number.isFinite(t) && Math.abs(t - now) < 12 * 3600_000 ? new Date(t) : null;
    const seq = Number.isSafeInteger(Number(e.seq)) && Number(e.seq) > 0 ? Number(e.seq) : null;
    const props = sanitizeProps(e.p);
    events.push({
      name, seq, clientTs, props,
      path: e.path ? scrubString(String(e.path).split("?")[0].replace(/\/track\/[^/]+/, "/track/:order"), 120) : null,
      step: stepOf(name, props, "web"),
    });
  }
  return { sessionId, anonId, session, events, rejected, qa: b.qa === true };
}

/* يوم العمل (الرياض −٤ ساعات) وساعة الرياض المحلية */
export function bizDayOf(d = new Date()) {
  const r = new Date(d.getTime() + 3 * 3600_000 - BIZ_DAY_START_HOUR * 3600_000);
  return r.toISOString().slice(0, 10);
}
export const riyadhHourOf = (d = new Date()) => new Date(d.getTime() + 3 * 3600_000).getUTCHours();

export function rangeOf(range, now = new Date()) {
  const today = bizDayOf(now);
  const shift = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
  switch (String(range || "today")) {
    case "yesterday": { const y = shift(today, -1); return { key: "yesterday", from: y, to: y, days: 1 }; }
    case "7d": return { key: "7d", from: shift(today, -6), to: today, days: 7 };
    case "30d": return { key: "30d", from: shift(today, -29), to: today, days: 30 };
    default: return { key: "today", from: today, to: today, days: 1 };
  }
}

const pct = (a, b) => (b > 0 ? a / b : 0);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const arInt = (n) => Math.round(Number(n) || 0).toLocaleString("ar-SA");
const arPct = (x) => `${Math.round((Number(x) || 0) * 100).toLocaleString("ar-SA")}٪`;

/* القمع من عدد الجلسات اللي وصلت كل خطوة (تراكمي) */
export function buildFunnel(reached) {
  const start = Number(reached[0]) || 0;
  return STEPS.map((s, i) => {
    const n = Number(reached[i]) || 0;
    const prev = i === 0 ? n : Number(reached[i - 1]) || 0;
    return {
      step: s.step, key: s.key, label: s.label, sessions: n,
      pctOfStart: pct(n, start), pctOfPrev: i === 0 ? 1 : pct(n, prev),
      lost: i === 0 ? 0 : Math.max(0, prev - n), dropPct: i === 0 ? 0 : (prev > 0 ? 1 - n / prev : 0),
    };
  });
}

const OTP_REASON = {
  wrong_code: "كتبوا الرمز غلط", expired: "الرمز انتهى", too_many_attempts: "محاولات كتير",
  resend_too_soon: "طلبوا رمز جديد بسرعة", daily_limit: "وصلوا الحد اليومي", sms_failed: "الرسالة مااتبعتتش",
  temporarily_unavailable: "الإرسال واقف مؤقتاً", invalid_phone: "رقم غير صحيح", rate_limited: "ضغط كتير",
  network: "النت فصل", sms_not_configured: "الرسائل مش متظبطة",
};
const CHECKOUT_REASON = {
  store_closed: "المطعم كان مقفول", out_of_zone: "العنوان خارج نطاق التوصيل", under_minimum: "أقل من الحد الأدنى",
  coupon: "مشكلة في الكود", name_missing: "الاسم ناقص", dine_in_only: "صنف داخل الصالة بس",
  quote_failed: "رسوم التوصيل ماتحسبتش", otp_required: "محتاج تأكيد جوال", payment_init_failed: "بوابة الدفع مافتحتش",
  not_deliverable: "العنوان مش متاح للتوصيل", invalid_phone: "رقم غير صحيح", address_required: "العنوان ناقص",
  network: "النت فصل", other: "سبب تاني",
};
export const reasonLabel = (kind, code) => {
  const c = String(code || "");
  if (kind === "otp") return OTP_REASON[c] || c || "غير معروف";
  if (kind === "checkout") return CHECKOUT_REASON[c] || (c.startsWith("coupon_") ? "مشكلة في الكود" : c || "غير معروف");
  return c || "غير معروف";
};

/* «فين بنخسر العملاء؟» — أكبر ٣ فجوات بجملة عربي بسيطة + السبب المتسجّل.
   ctx: { inAppShare, closedShare, adsShare, reasons: {step→[{label,n}]}, outOfZone, avgKm } */
export function leaksFrom(funnel, ctx = {}) {
  const start = funnel[0] ? funnel[0].sessions : 0;
  if (!start) return [];
  const cands = [];
  for (let i = 1; i < funnel.length; i++) {
    const f = funnel[i], prev = funnel[i - 1];
    if (!f.lost || prev.sessions < 3) continue;
    const reasons = (ctx.reasons && ctx.reasons[prev.step]) || [];
    const top = reasons.filter((r) => r.n > 0).sort((a, b) => b.n - a.n).slice(0, 2);
    let title, why = "", fix = "";
    switch (prev.key) {
      case "landed":
        title = `${arPct(f.dropPct)} من الزوار (${arInt(f.lost)}) خرجوا من غير ما يفتحوا أي عرض أو صنف`;
        if (ctx.closedShare >= 0.3) { why = `${arPct(ctx.closedShare)} من الزيارات وصلت والمطعم مقفول`; fix = "خلّي الإعلانات تشتغل وقت الفتح بس"; }
        else if (ctx.inAppShare >= 0.5) { why = `${arPct(ctx.inAppShare)} منهم جوّه متصفح فيسبوك/انستجرام`; fix = "رابط الإعلان لازم يفتح العرض على طول"; }
        else fix = "الصفحة الأولى لازم توري العرض والسعر فوق من غير تمرير";
        break;
      case "viewed":
        title = `${arInt(f.lost)} فتحوا عرض أو صنف وماضافوش للسلة (${arPct(f.dropPct)})`;
        fix = "راجع السعر والصور وسهولة الاختيار في المنتقي";
        break;
      case "cart":
        title = `${arInt(f.lost)} أضافوا للسلة ومافتحوش إتمام الطلب (${arPct(f.dropPct)})`;
        fix = "زرار السلة والإجمالي لازم يبانوا واضحين";
        break;
      case "checkout":
        title = `${arInt(f.lost)} فتحوا إتمام الطلب ووقفوا عند العنوان (${arPct(f.dropPct)})`;
        if (ctx.outOfZone > 0) why = `${arInt(ctx.outOfZone)} عنوان طلع خارج نطاق التوصيل${ctx.avgKm ? ` (متوسط ${arInt(ctx.avgKm)} كم)` : ""}`;
        fix = "اعرض الاستلام من الفرع بديل واضح، وسهّل تحديد الموقع";
        break;
      case "address":
        title = `${arInt(f.lost)} حدّدوا العنوان ووقفوا عند تأكيد الجوال (${arPct(f.dropPct)})`;
        fix = "راجع وصول رسالة الرمز والتعبئة التلقائية على الآيفون";
        break;
      case "otp":
        title = `${arInt(f.lost)} أكّدوا جوالهم ووصلوش لصفحة الدفع (${arPct(f.dropPct)})`;
        fix = "راجع رسايل الخطأ في إتمام الطلب";
        break;
      case "payment":
        title = `${arInt(f.lost)} فتحوا صفحة الدفع ومادفعوش (${arPct(f.dropPct)})`;
        if (ctx.paymentInApp >= 0.4) why = `${arPct(ctx.paymentInApp)} منهم كانوا جوّه متصفح تطبيق`;
        fix = "جرّب مدى وApple Pay على الأجهزة، ووضّح «افتح في المتصفح»";
        break;
      default:
        title = `${arInt(f.lost)} وقفوا بعد «${prev.label}»`;
    }
    if (top.length) why = [why, "الأسباب المتسجّلة: " + top.map((r) => `${r.label} (${arInt(r.n)})`).join("، ")].filter(Boolean).join(" — ");
    cands.push({ fromStep: prev.step, toStep: f.step, from: prev.label, to: f.label, lost: f.lost, dropPct: r2(f.dropPct), title, why, fix });
  }
  return cands.sort((a, b) => b.lost - a.lost || b.dropPct - a.dropPct).slice(0, 3);
}

/* تطابق إعلان ميتا (اسم الإعلان) مع utm_content بتاع جلساتنا: «KILO-A» ↔ «96-m2-kilo-a» */
export function adMatches(adName, utmContent) {
  const n = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = n(adName), u = n(utmContent);
  if (!a || !u) return false;
  return a === u || u.endsWith(a) || a.endsWith(u) || (a.length >= 4 && u.includes(a));
}

/* ═══ register ════════════════════════════════════════════════════════════ */

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, normPhone, jb } = ctx;
  const analytics = deps.analytics || null;
  const J = (v) => (jb ? jb(v) : JSON.stringify(v));

  // botfilter.js (مراجعة النمو) ممكن مايكونش اتنشر لسه — استيراد مرن
  let isBotRequest = ({ ua }) => (FALLBACK_BOT_RE.test(String(ua || "")) ? "ua" : false);
  import("./botfilter.js").then((m) => { if (m && typeof m.isBotRequest === "function") isBotRequest = m.isBotRequest; }).catch(() => {});

  // كوبون المالك (طلبات تجربة) + تعريف «مدفوع» نفسه بتاع تقرير المتجر (cms.js PAID_ONLINE)
  const STAFF_COUPONS = new Set(["OMAR-9X4T"]);
  const PAID_SQL = `o.status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')`;
  let ready = false;
  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS journey_sessions (
        session_id TEXT PRIMARY KEY,
        anon_id TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        biz_day DATE NOT NULL,
        start_hour SMALLINT,
        landing_path TEXT, referrer_host TEXT,
        utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
        link_slug TEXT, coupon_param TEXT,
        click_ids TEXT[] NOT NULL DEFAULT '{}',
        channel TEXT NOT NULL DEFAULT 'direct',
        device TEXT, in_app TEXT, app_version TEXT,
        store_open BOOLEAN,
        is_bot BOOLEAN NOT NULL DEFAULT FALSE,
        is_qa BOOLEAN NOT NULL DEFAULT FALSE,
        is_staff BOOLEAN NOT NULL DEFAULT FALSE,
        events INT NOT NULL DEFAULT 0,
        max_step SMALLINT NOT NULL DEFAULT 0,
        cart_max NUMERIC NOT NULL DEFAULT 0,
        last_event TEXT,
        order_no TEXT,
        paid BOOLEAN NOT NULL DEFAULT FALSE,
        revenue NUMERIC NOT NULL DEFAULT 0,
        phone_norm TEXT,
        identified_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS journey_sessions_day_idx ON journey_sessions(biz_day, channel);
      CREATE INDEX IF NOT EXISTS journey_sessions_anon_idx ON journey_sessions(anon_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS journey_sessions_order_idx ON journey_sessions(order_no) WHERE order_no IS NOT NULL;
      CREATE INDEX IF NOT EXISTS journey_sessions_started_idx ON journey_sessions(started_at DESC);

      CREATE TABLE IF NOT EXISTS journey_events (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        client_ts TIMESTAMPTZ,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'web',
        name TEXT NOT NULL,
        step SMALLINT,
        seq INT,
        path TEXT,
        props JSONB NOT NULL DEFAULT '{}'::jsonb,
        order_no TEXT
      );
      CREATE INDEX IF NOT EXISTS journey_events_session_idx ON journey_events(session_id, at);
      CREATE INDEX IF NOT EXISTS journey_events_name_idx ON journey_events(name, at);
      CREATE UNIQUE INDEX IF NOT EXISTS journey_events_seq_uq ON journey_events(session_id, seq) WHERE seq IS NOT NULL;

      CREATE TABLE IF NOT EXISTS journey_identities (
        anon_id TEXT NOT NULL,
        phone_norm TEXT NOT NULL,
        method TEXT NOT NULL,
        first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (anon_id, phone_norm)
      );
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS journey_sid TEXT;
      -- ١٩/٩ (tracking-architecture.md): معرّف العميل الموحّد + لغة الواجهة + إزاي اتعرف
      ALTER TABLE journey_sessions ADD COLUMN IF NOT EXISTS customer_id TEXT;
      ALTER TABLE journey_sessions ADD COLUMN IF NOT EXISTS ui_lang TEXT;
      ALTER TABLE journey_sessions ADD COLUMN IF NOT EXISTS identified_via TEXT;
      CREATE INDEX IF NOT EXISTS journey_sessions_phone_idx ON journey_sessions(phone_norm, started_at DESC) WHERE phone_norm IS NOT NULL;
      CREATE INDEX IF NOT EXISTS journey_sessions_cid_idx ON journey_sessions(customer_id) WHERE customer_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS journey_identities_phone_idx ON journey_identities(phone_norm);
    `);
    ready = true;
  }
  ensureSchema()
    .then(() => console.log("[journey] schema ready"))
    .catch((e) => console.error("[journey] schema failed:", e.message));

  /* ── الموظفين/الاختبار ── */
  let staffCache = { at: 0, set: new Set() };
  async function staffPhones() {
    if (Date.now() - staffCache.at < 5 * 60_000) return staffCache.set;
    const set = new Set();
    try {
      const d = getSettingsData ? await getSettingsData() : {};
      const lists = [d?.cms?.staffPhones, d?.delivery?.alertPhones, d?.delivery?.newOrderPhones, d?.journey?.staffPhones];
      for (const l of lists) for (const p of (Array.isArray(l) ? l : String(l || "").split(/[,\s]+/))) {
        const n = normPhone ? normPhone(typeof p === "object" && p ? p.phone : p) : String(p);
        if (n) set.add(n);
      }
    } catch { /* ignore */ }
    staffCache = { at: Date.now(), set };
    return set;
  }
  let hoursCache = { at: 0, hours: null };
  async function storeOpenNow() {
    try {
      if (Date.now() - hoursCache.at > 60_000) {
        const d = getSettingsData ? await getSettingsData() : {};
        hoursCache = { at: Date.now(), hours: d?.hours || null };
      }
      const { isOpenNow } = await import("./carts.js");
      return isOpenNow(hoursCache.hours);
    } catch { return null; }
  }

  /* ── rate limit ── */
  const rl = new Map();
  function limited(key, n, max) {
    const now = Date.now();
    const slot = rl.get(key);
    if (!slot || now - slot.start > 3600_000) { rl.set(key, { start: now, n }); return false; }
    slot.n += n;
    if (rl.size > 20000) rl.clear();
    return slot.n > max;
  }
  const ipOf = (c) => c.req.header("cf-connecting-ip") || String(c.req.header("x-forwarded-for") || "").split(",")[0].trim() || "?";

  /* ── تسجيل حدث (مشترك بين المتجر والسيرفر) ── */
  async function applyEvents(sessionId, events, source = "web") {
    if (!events.length) return 0;
    const cols = [];
    const vals = [];
    let i = 1;
    for (const e of events) {
      cols.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++}::jsonb,$${i++},$${i++})`);
      const orderNo = e.props && ORDER_RE.test(String(e.props.order_no || "")) ? String(e.props.order_no) : null;
      vals.push(sessionId, source, e.name, e.step, e.seq, e.clientTs || null, J(e.props || {}), orderNo, e.path || null);
    }
    const ins = await pool.query(
      `INSERT INTO journey_events (session_id, source, name, step, seq, client_ts, props, order_no, path)
       VALUES ${cols.join(",")} ON CONFLICT DO NOTHING RETURNING name, step, props, order_no`, vals);
    const rows = ins.rows;
    if (!rows.length) return 0;
    const maxStep = rows.reduce((m, r) => (r.step != null && r.step > m ? r.step : m), 0);
    const cartMax = rows.reduce((m, r) => Math.max(m, Number(r.props?.cart_subtotal) || 0), 0);
    const orderNo = rows.map((r) => r.order_no).filter(Boolean).pop() || null;
    const last = rows[rows.length - 1].name;
    await pool.query(
      `UPDATE journey_sessions SET events = events + $2, last_seen_at = NOW(),
              max_step = GREATEST(max_step, $3), cart_max = GREATEST(cart_max, $4),
              order_no = COALESCE($5, order_no), last_event = $6
        WHERE session_id = $1`,
      [sessionId, rows.length, maxStep, cartMax, orderNo, last]);
    if (orderNo) {
      pool.query(`UPDATE shop_orders SET journey_sid=$2 WHERE order_no=$1 AND journey_sid IS NULL`, [orderNo, sessionId])
        .catch(() => {});
    }
    return rows.length;
  }

  /* ═══ POST /api/journey/batch (عام) ═══ */
  app.post("/api/journey/batch", async (c) => {
    try {
      if (!ready) return c.json({ ok: false, error: "starting" });
      const raw = await c.req.text().catch(() => "");
      const p = parseBatch(raw);
      if (p.error) return c.json({ ok: false, error: p.error });
      const ip = ipOf(c);
      if (limited(`j:${ip}`, p.events.length || 1, 1500) || limited(`s:${p.sessionId}`, p.events.length || 1, 800)) {
        return c.json({ ok: false, error: "rate_limited" });
      }
      const ua = c.req.header("user-agent") || "";
      const s = p.session;
      // الجلسة: بتتعمل مع أول دفعة. لو الدفعة الأولى ضاعت بنعمل صف بالحد الأدنى
      const now = new Date();
      const meta = s || { click_ids: [] };
      const inApp = inAppOf(ua);
      const channel = classifyChannel({ ...meta, in_app: inApp });
      const qa = p.qa || isQaUtm(meta) || channel === "qa";
      const bot = Boolean(isBotRequest({ ua, ip }));
      const open = await storeOpenNow();
      await pool.query(
        `INSERT INTO journey_sessions (session_id, anon_id, biz_day, start_hour, landing_path, referrer_host,
            utm_source, utm_medium, utm_campaign, utm_content, utm_term, link_slug, coupon_param, click_ids,
            channel, device, in_app, app_version, store_open, is_bot, is_qa, ui_lang)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (session_id) DO UPDATE SET
            is_qa = journey_sessions.is_qa OR EXCLUDED.is_qa,
            is_bot = journey_sessions.is_bot OR EXCLUDED.is_bot,
            -- لو أول دفعة ضاعت: أول دفعة فيها بيانات المصدر بتكمّل الناقص
            landing_path = COALESCE(journey_sessions.landing_path, EXCLUDED.landing_path),
            referrer_host = COALESCE(journey_sessions.referrer_host, EXCLUDED.referrer_host),
            utm_source = COALESCE(journey_sessions.utm_source, EXCLUDED.utm_source),
            utm_medium = COALESCE(journey_sessions.utm_medium, EXCLUDED.utm_medium),
            utm_campaign = COALESCE(journey_sessions.utm_campaign, EXCLUDED.utm_campaign),
            utm_content = COALESCE(journey_sessions.utm_content, EXCLUDED.utm_content),
            link_slug = COALESCE(journey_sessions.link_slug, EXCLUDED.link_slug),
            click_ids = CASE WHEN cardinality(journey_sessions.click_ids) = 0 THEN EXCLUDED.click_ids ELSE journey_sessions.click_ids END,
            channel = CASE WHEN journey_sessions.channel = 'direct' THEN EXCLUDED.channel ELSE journey_sessions.channel END,
            ui_lang = COALESCE(EXCLUDED.ui_lang, journey_sessions.ui_lang)`,
        [p.sessionId, p.anonId, bizDayOf(now), riyadhHourOf(now), meta.landing_path || null, meta.referrer_host || null,
         meta.utm_source || null, meta.utm_medium || null, meta.utm_campaign || null, meta.utm_content || null,
         meta.utm_term || null, meta.link_slug || null, meta.coupon_param || null, meta.click_ids || [],
         channel, deviceOf(ua), inApp, meta.app_version || null, open, bot, qa, meta.ui_lang || null]);
      const accepted = await applyEvents(p.sessionId, p.events, "web");
      return c.json({ ok: true, accepted, rejected: Object.values(p.rejected).reduce((a, b) => a + b, 0) });
    } catch (e) {
      console.error("[journey] batch failed:", e.message);
      return c.json({ ok: false, error: "server" });
    }
  });

  /* ═══ POST /api/journey/identify (عام، بتوكن العميل) ═══
     الربط بالجوال على السيرفر بس — المتصفح مابيبعتش الرقم. */
  app.post("/api/journey/identify", async (c) => {
    try {
      const h = c.req.header("Authorization") || "";
      const m = h.match(/^Bearer cust:([a-f0-9]{48,96})$/i);
      let b = {};
      try { b = JSON.parse(await c.req.text()); } catch { b = {}; }
      const sid = String(b.sessionId || "");
      // otp = بعد رمز التحقق مباشرة؛ token = جلسة جديدة لعميل داخل بحسابه من قبل
      const method = b.method === "token" ? "token" : "otp";
      if (!m || !validSid(sid)) return c.json({ ok: false, error: "bad_request" });
      if (limited(`i:${ipOf(c)}`, 1, 60)) return c.json({ ok: false, error: "rate_limited" });
      const r = await pool.query(`SELECT phone_norm FROM acct_sessions WHERE token=$1`, [m[1]]);
      const pn = r.rows[0]?.phone_norm;
      if (!pn) return c.json({ ok: false, error: "unknown_token" });
      const staff = (await staffPhones()).has(pn);
      const cid = await customerId(pool, pn);
      const up = await pool.query(
        `UPDATE journey_sessions SET phone_norm=$2, customer_id=COALESCE($4, customer_id),
                identified_at=COALESCE(identified_at, NOW()), identified_via=COALESCE(identified_via, $5),
                is_staff = is_staff OR $3
          WHERE session_id=$1 RETURNING anon_id, started_at`, [sid, pn, staff, cid, method]);
      const anon = up.rows[0]?.anon_id;
      let backfilled = 0;
      if (anon) {
        await pool.query(
          `INSERT INTO journey_identities (anon_id, phone_norm, method) VALUES ($1,$2,$3)
           ON CONFLICT (anon_id, phone_norm) DO UPDATE SET last_at=NOW()`, [anon, pn, method]);
        backfilled = await backfillDevice(anon, pn, cid, up.rows[0].started_at, staff);
        await applyEvents(sid, [{ name: "identified", step: null, seq: null, props: { method, staff, backfilled } }], "server");
      }
      return c.json({ ok: true, linked: Boolean(anon), backfilled });
    } catch (e) {
      console.error("[journey] identify failed:", e.message);
      return c.json({ ok: false, error: "server" });
    }
  });

  /* ── ربط جلسات الجهاز اللي قبل الـOTP بنفس العميل ──
     «دخل من إعلان امبارح، اتفرّج ومشي، ورجع النهارده أكّد رقمه» = نفس العميل.
     بنربط جلسات نفس الجهاز (anon_id) من غير جوال في آخر ٣٠ يوم، ولحد الجلسة
     الحالية بس — مش اللي بعدها (جهاز العيلة ممكن يتسلّم لحد تاني). الجهاز اللي
     اتربط بأكتر من رقم مابيتعملهوش backfill (مش عارفين مين). أحداث الجلسة نفسها
     مربوطة بالـsession_id، فربط الجلسة = ربط كل أحداثها اللي قبل الـOTP. */
  async function backfillDevice(anon, pn, cid, uptoTs, staff = false) {
    try {
      const multi = await pool.query(
        `SELECT count(DISTINCT phone_norm)::int AS n FROM journey_identities WHERE anon_id=$1`, [anon]);
      if ((multi.rows[0]?.n || 0) > 1) return 0;
      const r = await pool.query(
        `UPDATE journey_sessions SET phone_norm=$2, customer_id=COALESCE($3, customer_id),
                identified_via='device_backfill', is_staff = is_staff OR $5
          WHERE anon_id=$1 AND phone_norm IS NULL
            AND started_at > NOW() - INTERVAL '30 days' AND started_at <= COALESCE($4::timestamptz, NOW())`,
        [anon, pn, cid, uptoTs || null, staff]);
      return r.rowCount || 0;
    } catch (e) {
      console.error("[journey] backfill failed:", e.message);
      return 0;
    }
  }

  /* ═══ أحداث السيرفر ═══ */
  async function emit(name, props = {}) {
    if (!ready || !SERVER_SET.has(name)) return;
    const sid = props && props.journey_sid;
    if (!validSid(sid)) return;
    const clean = sanitizeProps({ ...props, journey_sid: undefined, client: undefined });
    const step = stepOf(name, clean, "server");
    await applyEvents(sid, [{ name, step, seq: null, props: clean }], "server");
  }

  // order_paid من ناقل الطلبات → الجلسة اتدفعت
  import("./order-events.js").then((oe) => {
    oe.subscribe(async (evt) => {
      if (!ready || !evt || !evt.orderNo) return;
      const r = await pool.query(
        `SELECT order_no, journey_sid, total, phone_norm, is_test, coupon FROM shop_orders WHERE order_no=$1`, [evt.orderNo]);
      const o = r.rows[0];
      if (!o || !validSid(o.journey_sid)) return;
      const staff = o.is_test === true || STAFF_COUPONS.has(String(o.coupon || "").toUpperCase()) || (await staffPhones()).has(o.phone_norm);
      const cid = o.phone_norm ? await customerId(pool, o.phone_norm) : null;
      const up = await pool.query(
        `UPDATE journey_sessions SET paid=TRUE, revenue=$2, order_no=$3, max_step=GREATEST(max_step, ${PAID_STEP}),
                phone_norm=COALESCE(phone_norm, $4), customer_id=COALESCE(customer_id, $6),
                identified_via=COALESCE(identified_via, CASE WHEN $4::text IS NOT NULL THEN 'order' END),
                is_staff = is_staff OR $5
          WHERE session_id=$1 RETURNING anon_id, started_at`,
        [o.journey_sid, Number(o.total) || 0, o.order_no, o.phone_norm || null, staff, cid]);
      // الدفع = هوية مؤكدة للجهاز ده (حتى لو الـOTP اتخطّى) → ربط جلساته اللي قبل كده
      const anon = up.rows[0]?.anon_id;
      if (anon && o.phone_norm) {
        await pool.query(
          `INSERT INTO journey_identities (anon_id, phone_norm, method) VALUES ($1,$2,'order')
           ON CONFLICT (anon_id, phone_norm) DO UPDATE SET last_at=NOW()`, [anon, o.phone_norm]).catch(() => {});
        await backfillDevice(anon, o.phone_norm, cid, up.rows[0].started_at, staff);
      }
      await pool.query(
        `INSERT INTO journey_events (session_id, source, name, step, props, order_no) VALUES ($1,'server','order_paid',$2,$3::jsonb,$4)`,
        [o.journey_sid, PAID_STEP, J({ total: Number(o.total) || 0, gateway: evt.data?.gateway || null }), o.order_no]);
    }, "order_paid");
  }).catch((e) => console.error("[journey] order-events subscribe failed:", e.message));

  /* ── مطابقة دورية مع shop_orders (لو حدث الناقل ضاع وقت rollover) + الاحتفاظ ── */
  let lastSweep = 0;
  async function sweep(force = false) {
    if (!ready || (!force && Date.now() - lastSweep < 60_000)) return;
    lastSweep = Date.now();
    try {
      await pool.query(
        `UPDATE journey_sessions s SET
            order_no = o.order_no,
            paid = s.paid OR ${PAID_SQL},
            revenue = CASE WHEN ${PAID_SQL} THEN o.total ELSE s.revenue END,
            max_step = GREATEST(s.max_step, CASE WHEN ${PAID_SQL} THEN ${PAID_STEP} ELSE 6 END),
            phone_norm = COALESCE(s.phone_norm, o.phone_norm),
            is_staff = s.is_staff OR COALESCE(o.is_test, false) OR upper(COALESCE(o.coupon,'')) = ANY($1::text[])
           FROM shop_orders o
          WHERE (o.journey_sid = s.session_id OR (s.order_no IS NOT NULL AND o.order_no = s.order_no))
            AND o.created_at > NOW() - INTERVAL '3 days'
            AND (s.order_no IS DISTINCT FROM o.order_no OR (NOT s.paid AND ${PAID_SQL}))`,
        [[...STAFF_COUPONS]]);
      await linkSweep();
      const staff = [...(await staffPhones())];
      if (staff.length) {
        await pool.query(
          `UPDATE journey_sessions SET is_staff=TRUE
            WHERE NOT is_staff AND phone_norm = ANY($1::text[]) AND started_at > NOW() - INTERVAL '3 days'`, [staff]);
        // نفس الجهاز اللي اتربط برقم موظف = جلسات موظف
        await pool.query(
          `UPDATE journey_sessions s SET is_staff=TRUE FROM journey_identities i
            WHERE NOT s.is_staff AND i.anon_id = s.anon_id AND i.phone_norm = ANY($1::text[])
              AND s.started_at > NOW() - INTERVAL '3 days'`, [staff]);
      }
    } catch (e) { console.error("[journey] sweep failed:", e.message); }
  }
  /* ── ربط دوري (tracking-architecture.md §٤) ──
     ١) طلب من غير journey_sid (journey.js ماتحمّلش/اتحجب) ⇒ آخر جلسة لنفس
        الجهاز (customer.deviceId = fc_dev = anon_id) بدأت قبل الطلب بـ٣ ساعات.
     ٢) طلب مدفوع بجهاز ⇒ هوية الجهاز (method 'order').
     ٣) جلسة جديدة من جهاز معروف برقم واحد بس ⇒ نفس العميل (identified_via 'device').
     ٤) customer_id للجلسات اللي عندها جوال ومن غير معرّف (Node — الـHMAC مش في SQL). */
  async function linkSweep() {
    await pool.query(
      `WITH m AS (
         SELECT o.order_no, (SELECT js.session_id FROM journey_sessions js
                  WHERE js.anon_id = o.customer->>'deviceId'
                    AND js.started_at BETWEEN o.created_at - INTERVAL '3 hours' AND o.created_at + INTERVAL '1 minute'
                  ORDER BY js.started_at DESC LIMIT 1) AS sid
           FROM shop_orders o
          WHERE o.journey_sid IS NULL AND o.created_at > NOW() - INTERVAL '3 days'
            AND COALESCE(o.customer->>'deviceId','') ~ '^[a-z0-9_-]{8,64}$')
       UPDATE shop_orders o SET journey_sid = m.sid FROM m
        WHERE o.order_no = m.order_no AND m.sid IS NOT NULL AND o.journey_sid IS NULL`).catch((e) => console.error("[journey] order sid link:", e.message));
    await pool.query(
      `INSERT INTO journey_identities (anon_id, phone_norm, method)
       SELECT DISTINCT o.customer->>'deviceId', o.phone_norm, 'order' FROM shop_orders o
        WHERE o.created_at > NOW() - INTERVAL '3 days' AND ${PAID_SQL} AND o.phone_norm IS NOT NULL
          AND COALESCE(o.is_test, false) = false
          AND COALESCE(o.customer->>'deviceId','') ~ '^[a-z0-9_-]{8,64}$'
       ON CONFLICT (anon_id, phone_norm) DO NOTHING`).catch((e) => console.error("[journey] order identities:", e.message));
    await pool.query(
      `UPDATE journey_sessions s SET phone_norm = i.phone_norm, identified_via = 'device'
         FROM (SELECT anon_id, min(phone_norm) AS phone_norm FROM journey_identities
                WHERE last_at > NOW() - INTERVAL '180 days' GROUP BY anon_id HAVING count(DISTINCT phone_norm) = 1) i
        WHERE s.anon_id = i.anon_id AND s.phone_norm IS NULL AND NOT s.is_bot
          AND s.started_at > NOW() - INTERVAL '3 days'`).catch((e) => console.error("[journey] device link:", e.message));
    try {
      const r = await pool.query(
        `SELECT DISTINCT phone_norm FROM journey_sessions
          WHERE customer_id IS NULL AND phone_norm IS NOT NULL LIMIT 300`);
      for (const { phone_norm: pn } of r.rows) {
        const cid = await customerId(pool, pn);
        if (cid) await pool.query(`UPDATE journey_sessions SET customer_id=$2 WHERE phone_norm=$1 AND customer_id IS NULL`, [pn, cid]);
      }
    } catch (e) { console.error("[journey] cid fill:", e.message); }
  }

  let lastRetention = 0;
  async function retention() {
    if (!ready || Date.now() - lastRetention < 12 * 3600_000) return;
    lastRetention = Date.now();
    try {
      await pool.query(`DELETE FROM journey_events WHERE at < NOW() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]);
      await pool.query(`DELETE FROM journey_sessions WHERE started_at < NOW() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]);
      await pool.query(`DELETE FROM journey_identities WHERE last_at < NOW() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]);
    } catch (e) { console.error("[journey] retention failed:", e.message); }
  }
  const timer = setInterval(() => { sweep(true); retention(); }, 5 * 60_000);
  if (timer.unref) timer.unref();

  /* ── صرف ميتا (مستوى الحملة والإعلان) — كاش ١٠ دقايق، وبيحترم بوابة الحصة ── */
  const spendCache = new Map();
  async function metaSpend(from, to) {
    const key = `${from}|${to}`;
    const hit = spendCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.val;
    let val = { ok: false, total: 0, ads: [], campaigns: [], reason: null };
    try {
      const ads = await import("./ads.js");
      const p = ads.byId ? ads.byId("meta") : null;
      if (!p || !ads.canManage(p)) val.reason = "ميتا مش مربوطة";
      else {
        const env = (k) => (process.env[k] || "").trim();
        const token = env("META_CAPI_TOKEN");
        const act = p.actId();
        const fields = "ad_id,ad_name,adset_name,campaign_id,campaign_name,spend,impressions,inline_link_clicks,actions";
        const tr = encodeURIComponent(JSON.stringify({ since: from, until: to }));
        const read = async () => ads.httpJson(`${p.base()}/${act}/insights?level=ad&fields=${fields}&time_range=${tr}&limit=500`,
          { headers: { Authorization: `Bearer ${token}` } });
        const res = typeof ads.platformRead === "function"
          ? await ads.platformRead(p, read, { priority: "telemetry" })
          : await read();
        if (!res || res.ok === false || !res.json) val.reason = (res && (res.reason || res.error || res.json?.error?.message)) || "قراءة ميتا فشلت";
        else {
          const rows = (res.json.data || []).map((r) => {
            const act = (Array.isArray(r.actions) ? r.actions : []);
            const a = (t) => Number((act.find((x) => x.action_type === t) || {}).value || 0);
            return {
              adId: r.ad_id, ad: r.ad_name, adset: r.adset_name, campaign: r.campaign_name, campaignId: r.campaign_id,
              spend: r2(r.spend), impressions: Number(r.impressions || 0), clicks: Number(r.inline_link_clicks || 0),
              metaAddToCart: a("offsite_conversion.fb_pixel_add_to_cart") || a("add_to_cart"),
              metaPurchases: a("offsite_conversion.fb_pixel_purchase") || a("purchase"),
            };
          });
          const camps = {};
          for (const r of rows) {
            const k = r.campaign || r.campaignId;
            camps[k] = camps[k] || { campaign: k, spend: 0, clicks: 0 };
            camps[k].spend = r2(camps[k].spend + r.spend); camps[k].clicks += r.clicks;
          }
          val = { ok: true, total: r2(rows.reduce((s, r) => s + r.spend, 0)), ads: rows, campaigns: Object.values(camps), reason: null };
        }
      }
    } catch (e) { val.reason = String(e.message || e).slice(0, 200); }
    spendCache.set(key, { at: Date.now(), val });
    if (spendCache.size > 40) spendCache.clear();
    return val;
  }

  /* ── الإيراد اليومي (صالة / تطبيقات / أونلاين) من ts_orders ── */
  async function dailyRevenue(from, to) {
    try {
      const { channelSql, SALES_ONLY } = await import("./analytics.js");
      const apps = analytics && typeof analytics.deliveryApps === "function" ? await analytics.deliveryApps() : [];
      const rows = (await pool.query(
        `SELECT o.calendar_day::text AS day, ${channelSql("$3::text[]")} AS ch, count(*)::int AS orders, COALESCE(sum(o.total),0)::float AS revenue
           FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
          GROUP BY 1,2 ORDER BY 1`, [from, to, apps])).rows;
      const days = {};
      for (const r of rows) {
        const d = days[r.day] || (days[r.day] = { day: r.day, hall: 0, apps: 0, online: 0, total: 0, orders: 0, byApp: {} });
        const bucket = r.ch === "website" ? "online" : r.ch === "inhouse" ? "hall" : "apps";
        d[bucket] = r2(d[bucket] + r.revenue);
        if (bucket === "apps") d.byApp[r.ch] = r2((d.byApp[r.ch] || 0) + r.revenue);
        d.total = r2(d.total + r.revenue);
        d.orders += r.orders;
      }
      return { ok: true, source: "ts_orders", days: Object.values(days) };
    } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200), days: [] }; }
  }

  /* ═══ GET /api/journey/report ═══ */
  const reportCache = new Map();
  const REAL = `NOT s.is_bot AND NOT s.is_qa AND NOT s.is_staff`;

  async function breakdown(expr, from, to, extraWhere = "") {
    const rows = (await pool.query(
      `SELECT ${expr} AS k, count(*)::int AS sessions,
              count(*) FILTER (WHERE s.max_step >= 1)::int AS viewed,
              count(*) FILTER (WHERE s.max_step >= 2)::int AS cart,
              count(*) FILTER (WHERE s.max_step >= 3)::int AS checkout,
              count(*) FILTER (WHERE s.max_step >= 6)::int AS payment,
              count(*) FILTER (WHERE s.paid)::int AS paid,
              COALESCE(sum(s.revenue) FILTER (WHERE s.paid),0)::float AS revenue
         FROM journey_sessions s
        WHERE s.biz_day BETWEEN $1::date AND $2::date AND ${REAL} ${extraWhere}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 40`, [from, to])).rows;
    return rows.map((r) => ({
      key: r.k, sessions: r.sessions, viewed: r.viewed, cart: r.cart, checkout: r.checkout, payment: r.payment,
      paid: r.paid, revenue: r2(r.revenue), cartRate: r2(pct(r.cart, r.sessions)), conv: pct(r.paid, r.sessions),
    }));
  }

  /* ── ⚠️ أخطاء الصفحة: بتاعتنا ولا دخيلة، وهل العميل كمّل بعدها؟ ──
     «كمّل» = عمل أي حدث تفاعلي بعد الخطأ بأكتر من ثانية (مش قفل/خروج). */
  async function pageErrorsPanel(from, to) {
    try {
      const rows = (await pool.query(
        `SELECT ${ERR_KIND_SQL} AS kind, left(e.props->>'msg', 90) AS msg, NULLIF(e.props->>'src','') AS src,
                count(*)::int AS n, count(DISTINCT e.session_id)::int AS sessions,
                count(DISTINCT e.session_id) FILTER (WHERE NOT EXISTS (
                  SELECT 1 FROM journey_events x WHERE x.session_id = e.session_id AND x.at > e.at + interval '1 second'
                     AND x.name NOT IN ('page_hide','error_js','page_visible')))::int AS stopped,
                count(DISTINCT e.session_id) FILTER (WHERE s.paid)::int AS paid,
                count(*) FILTER (WHERE (e.props->>'hidden')::boolean IS TRUE)::int AS hidden
           FROM journey_events e JOIN journey_sessions s ON s.session_id = e.session_id
          WHERE e.name = 'error_js' AND s.biz_day BETWEEN $1::date AND $2::date AND ${REAL}
          GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 30`, [from, to])).rows;
      const byKind = {};
      for (const r of rows) {
        const k = byKind[r.kind] || (byKind[r.kind] = { kind: r.kind, label: ERROR_KINDS[r.kind] || r.kind, ours: isOurError(r.kind), n: 0, sessions: 0 });
        k.n += r.n; k.sessions += r.sessions;
      }
      return {
        ok: true,
        ours: rows.filter((r) => isOurError(r.kind)).reduce((s, r) => s + r.n, 0),
        foreign: rows.filter((r) => !isOurError(r.kind)).reduce((s, r) => s + r.n, 0),
        kinds: Object.values(byKind).sort((a, b) => b.n - a.n),
        top: rows.map((r) => ({ ...r, label: ERROR_KINDS[r.kind] || r.kind, ours: isOurError(r.kind) })),
      };
    } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 160) }; }
  }

  /* ── 🎯 قمع المنتقي لكل عرض: فتح ← اختار ← (زرار ناقص) ← أضاف، وقفل ليه ── */
  async function pickerPanel(from, to) {
    try {
      const rows = (await pool.query(
        `WITH o AS (
           SELECT e.session_id, COALESCE(e.props->>'title','—') AS title, min(e.at) AS t0
             FROM journey_events e JOIN journey_sessions s ON s.session_id = e.session_id
            WHERE e.name = 'picker_open' AND s.biz_day BETWEEN $1::date AND $2::date AND ${REAL}
            GROUP BY 1,2)
         SELECT o.title, count(*)::int AS opened,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM journey_events x WHERE x.session_id=o.session_id AND x.name='picker_choice' AND x.props->>'title' = o.title))::int AS chose,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM journey_events x WHERE x.session_id=o.session_id AND x.name='picker_add_blocked' AND x.props->>'title' = o.title))::int AS blocked,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM journey_events x WHERE x.session_id=o.session_id AND x.name='item_add' AND x.at >= o.t0))::int AS added,
                count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM journey_events x WHERE x.session_id=o.session_id AND x.at > o.t0 + interval '5 seconds'
                                                   AND x.name NOT IN ('page_hide','error_js','picker_close')))::int AS left_fast,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM journey_events x WHERE x.session_id=o.session_id AND x.name='picker_choice'))::int AS tracked
           FROM o GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, [from, to])).rows;
      const closes = (await pool.query(
        `SELECT COALESCE(e.props->>'title','—') AS title, COALESCE(e.props->>'reason','other') AS reason, count(*)::int AS n,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY (e.props->>'dwell_ms')::numeric)::float AS median_ms
           FROM journey_events e JOIN journey_sessions s ON s.session_id = e.session_id
          WHERE e.name = 'picker_close' AND s.biz_day BETWEEN $1::date AND $2::date AND ${REAL}
          GROUP BY 1,2`, [from, to])).rows;
      const choices = (await pool.query(
        `SELECT COALESCE(e.props->>'title','—') AS title, e.props->>'choice' AS choice, count(*)::int AS n
           FROM journey_events e JOIN journey_sessions s ON s.session_id = e.session_id
          WHERE e.name = 'picker_choice' AND e.props->>'choice' IS NOT NULL AND s.biz_day BETWEEN $1::date AND $2::date AND ${REAL}
          GROUP BY 1,2 ORDER BY 3 DESC LIMIT 40`, [from, to])).rows;
      return {
        ok: true,
        rows: rows.map((r) => ({
          ...r, addRate: pct(r.added, r.opened),
          closes: closes.filter((c) => c.title === r.title).map(({ reason, n, median_ms }) => ({ reason, n, medianSec: median_ms != null ? Math.round(median_ms / 100) / 10 : null })),
          topChoices: choices.filter((c) => c.title === r.title).slice(0, 6).map(({ choice, n }) => ({ choice, n })),
        })),
      };
    } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 160) }; }
  }

  async function buildReport(range) {
    const rg = rangeOf(range);
    const { from, to } = rg;
    await sweep();
    const base = (await pool.query(
      `SELECT count(*)::int AS sessions,
              ${STEPS.map((s) => `count(*) FILTER (WHERE s.max_step >= ${s.step} OR (${s.step} = ${PAID_STEP} AND s.paid))::int AS r${s.step}`).join(",")},
              count(*) FILTER (WHERE s.paid)::int AS paid_sessions,
              COALESCE(sum(s.revenue) FILTER (WHERE s.paid),0)::float AS tracked_revenue,
              count(*) FILTER (WHERE s.in_app IS NOT NULL)::int AS in_app,
              count(*) FILTER (WHERE s.store_open = false)::int AS closed,
              count(*) FILTER (WHERE s.channel LIKE '%\\_ads' ESCAPE '\\')::int AS ads,
              (SELECT count(*) FROM journey_sessions q WHERE q.biz_day BETWEEN $1::date AND $2::date AND q.is_qa)::int AS qa,
              (SELECT count(*) FROM journey_sessions q WHERE q.biz_day BETWEEN $1::date AND $2::date AND q.is_bot)::int AS bots,
              (SELECT count(*) FROM journey_sessions q WHERE q.biz_day BETWEEN $1::date AND $2::date AND q.is_staff AND NOT q.is_qa)::int AS staff
         FROM journey_sessions s
        WHERE s.biz_day BETWEEN $1::date AND $2::date AND ${REAL}`, [from, to])).rows[0];
    const reached = STEPS.map((s) => base[`r${s.step}`]);
    const funnel = buildFunnel(reached);

    // الحقيقة من shop_orders (مش من التتبع): الطلبات المدفوعة والإيراد
    const orders = (await pool.query(
      `SELECT count(*)::int AS paid, COALESCE(sum(o.total),0)::float AS revenue,
              count(*) FILTER (WHERE o.journey_sid IS NOT NULL)::int AS tracked
         FROM shop_orders o
        WHERE ((o.created_at AT TIME ZONE '${TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date BETWEEN $1::date AND $2::date
          AND ${PAID_SQL} AND NOT COALESCE(o.is_test,false) AND upper(COALESCE(o.coupon,'')) <> ALL($3::text[])`,
      [from, to, [...STAFF_COUPONS]])).rows[0];

    // أسباب الوقوف عند كل خطوة (من أحداث الجلسات اللي وقفت عندها)
    const reasonRows = (await pool.query(
      `SELECT s.max_step AS step, e.name,
              COALESCE(e.props->>'reason', e.props->>'error', e.props->>'code', '') AS code, count(DISTINCT s.session_id)::int AS n
         FROM journey_sessions s JOIN journey_events e ON e.session_id = s.session_id
        WHERE s.biz_day BETWEEN $1::date AND $2::date AND ${REAL} AND NOT s.paid
          AND e.name IN ('otp_failed','checkout_error','payment_failed','coupon_failed','store_closed_block','checkout_result')
          AND NOT (e.name = 'checkout_result' AND (e.props->>'ok')::boolean IS TRUE)
        GROUP BY 1,2,3`, [from, to])).rows;
    const reasons = {};
    for (const r of reasonRows) {
      const kind = r.name === "otp_failed" ? "otp" : r.name === "payment_failed" ? "payment" : "checkout";
      const code = r.name === "store_closed_block" ? "store_closed" : r.name === "checkout_result" ? String(r.code || "").replace(/^coupon_.*/, "coupon") : r.code;
      const label = r.name === "payment_failed" ? `رفض الدفع: ${r.code || "غير معروف"}` : reasonLabel(kind, code);
      const arr = reasons[r.step] || (reasons[r.step] = []);
      const found = arr.find((x) => x.label === label);
      if (found) found.n += r.n; else arr.push({ label, n: r.n });
    }
    const addr = (await pool.query(
      `SELECT count(DISTINCT e.session_id) FILTER (WHERE (e.props->>'deliverable')::boolean IS FALSE)::int AS out_zone,
              avg((e.props->>'km')::numeric) FILTER (WHERE (e.props->>'deliverable')::boolean IS FALSE)::float AS avg_km
         FROM journey_events e JOIN journey_sessions s ON s.session_id = e.session_id
        WHERE e.name='address_set' AND s.biz_day BETWEEN $1::date AND $2::date AND ${REAL}`, [from, to])).rows[0];
    const payInApp = (await pool.query(
      `SELECT count(*) FILTER (WHERE in_app IS NOT NULL)::int AS a, count(*)::int AS n FROM journey_sessions s
        WHERE s.biz_day BETWEEN $1::date AND $2::date AND ${REAL} AND s.max_step = 6 AND NOT s.paid`, [from, to])).rows[0];
    const leaks = leaksFrom(funnel, {
      inAppShare: pct(base.in_app, base.sessions), closedShare: pct(base.closed, base.sessions),
      reasons, outOfZone: addr.out_zone, avgKm: addr.avg_km, paymentInApp: pct(payInApp.a, payInApp.n),
    });

    const [pageErrors, picker] = await Promise.all([pageErrorsPanel(from, to), pickerPanel(from, to)]);
    const [byChannel, byDevice, byInApp, byOpen, byHour, byAd] = await Promise.all([
      breakdown("s.channel", from, to),
      breakdown("s.device", from, to),
      breakdown("COALESCE(s.in_app, 'none')", from, to),
      breakdown("CASE WHEN s.store_open IS FALSE THEN 'closed' WHEN s.store_open THEN 'open' ELSE 'unknown' END", from, to),
      breakdown("s.start_hour", from, to),
      breakdown("COALESCE(s.utm_campaign,'—') || ' / ' || COALESCE(s.utm_content,'—')", from, to, "AND s.channel = 'meta_ads'"),
    ]);
    byHour.sort((a, b) => Number(a.key) - Number(b.key));
    for (const r of byChannel) r.label = CHANNEL_LABELS[r.key] || r.key;

    const spend = await metaSpend(from, to);
    const adRows = spend.ok ? spend.ads.map((a) => {
      const ours = byAd.filter((b) => adMatches(a.ad, String(b.key).split(" / ")[1]));
      const sum = (k) => ours.reduce((s, x) => s + (x[k] || 0), 0);
      return { ...a, sessions: sum("sessions"), cart: sum("cart"), paid: sum("paid"), revenue: r2(sum("revenue")),
               cpa: sum("paid") ? r2(a.spend / sum("paid")) : null };
    }).sort((x, y) => y.spend - x.spend) : [];
    const adsChannel = byChannel.find((r) => r.key === "meta_ads") || { paid: 0, revenue: 0, sessions: 0 };

    const aov = orders.paid ? orders.revenue / orders.paid : 0;
    const out = {
      ok: true, range: rg.key, from, to, generatedAt: new Date().toISOString(),
      kpis: {
        sessions: base.sessions,
        cartRate: pct(reached[2], base.sessions),
        checkoutRate: pct(reached[3], base.sessions),
        paidSessions: base.paid_sessions,
        conversion: pct(base.paid_sessions, base.sessions),
        paidOrders: orders.paid, revenue: r2(orders.revenue), aov: r2(aov), trackedOrders: orders.tracked,
        adSpend: spend.ok ? spend.total : null,
        adOrders: adsChannel.paid, adRevenue: adsChannel.revenue,
        cpa: spend.ok && adsChannel.paid ? r2(spend.total / adsChannel.paid) : null,
        roas: spend.ok && spend.total ? r2(adsChannel.revenue / spend.total) : null,
        blendedCpa: spend.ok && orders.paid ? r2(spend.total / orders.paid) : null,
        blendedRoas: spend.ok && spend.total ? r2(orders.revenue / spend.total) : null,
        spendNote: spend.ok ? "صرف ميتا بيوم الحساب الإعلاني (توقيت لوس أنجلوس)، مش يوم المطعم" : (spend.reason || null),
      },
      funnel, leaks, pageErrors, picker,
      breakdowns: { channel: byChannel, device: byDevice, inApp: byInApp, storeOpen: byOpen, hour: byHour, metaAds: byAd },
      ads: adRows, campaigns: spend.ok ? spend.campaigns : [],
      excluded: { qa: base.qa, bots: base.bots, staff: base.staff },
      revenueDaily: await dailyRevenue(from, to),
    };
    return out;
  }

  app.get("/api/journey/report", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    try {
      const range = String(c.req.query("range") || "today");
      const key = range;
      const hit = reportCache.get(key);
      if (hit && Date.now() - hit.at < 60_000 && c.req.query("fresh") !== "1") return c.json({ ...hit.val, cached: true });
      const val = await buildReport(range);
      reportCache.set(key, { at: Date.now(), val });
      return c.json(val);
    } catch (e) {
      console.error("[journey] report failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e).slice(0, 200) });
    }
  });

  /* ═══ مستكشف الجلسات ═══ */
  function resultOf(s) {
    if (s.paid) return { kind: "paid", label: "دفع ✓" };
    const st = STEPS[Math.min(Number(s.max_step) || 0, STEPS.length - 1)];
    if (s.order_no) return { kind: "order", label: "اتعمل طلب ومادفعش" };
    return { kind: "dropped", label: `وقف بعد: ${st.label}` };
  }
  function sessionRow(s) {
    return {
      sessionId: s.session_id, startedAt: s.started_at, lastSeenAt: s.last_seen_at,
      channel: s.channel, channelLabel: CHANNEL_LABELS[s.channel] || s.channel,
      utmCampaign: s.utm_campaign, utmContent: s.utm_content, landing: s.landing_path, referrer: s.referrer_host,
      device: s.device, inApp: s.in_app, storeOpen: s.store_open, hour: s.start_hour,
      maxStep: s.max_step, maxStepLabel: STEPS[Math.min(s.max_step, 7)].label,
      cart: r2(s.cart_max), orderNo: s.order_no, paid: s.paid, revenue: r2(s.revenue),
      phoneMasked: maskPhone(s.phone_norm), events: s.events, lastEvent: s.last_event,
      tags: [s.is_qa && "QA", s.is_staff && "موظف", s.is_bot && "بوت"].filter(Boolean),
      result: resultOf(s), steps: s.steps || [],
    };
  }

  app.get("/api/journey/sessions", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    try {
      await sweep();
      const rg = rangeOf(c.req.query("range") || "today");
      const q = String(c.req.query("q") || "").trim().slice(0, 40);
      const filter = String(c.req.query("filter") || "all");
      const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 60));
      const where = [];
      const params = [];
      if (q) {
        params.push(`%${q.replace(/[%_]/g, "")}%`);
        where.push(`(s.order_no ILIKE $${params.length} OR s.session_id ILIKE $${params.length}
                    OR EXISTS (SELECT 1 FROM shop_orders o WHERE o.journey_sid = s.session_id AND o.order_no ILIKE $${params.length}))`);
      } else {
        params.push(rg.from, rg.to);
        where.push(`s.biz_day BETWEEN $1::date AND $2::date`);
      }
      if (filter === "paid") where.push("s.paid");
      else if (filter === "dropped") where.push("NOT s.paid AND s.max_step >= 2 AND NOT s.is_bot");
      else if (filter === "qa") where.push("s.is_qa");
      else if (filter === "bots") where.push("s.is_bot");
      else if (filter === "real") where.push(REAL);
      else if (!q) where.push("NOT s.is_bot");
      params.push(limit);
      const rows = (await pool.query(
        `SELECT s.*, (SELECT array_agg(x.name ORDER BY x.first) FROM (
                    SELECT e.name, min(e.at) AS first FROM journey_events e
                     WHERE e.session_id = s.session_id AND e.name NOT IN ('page_view','page_hide','item_view')
                     GROUP BY e.name ORDER BY 2 LIMIT 14) x) AS steps
           FROM journey_sessions s
          WHERE ${where.join(" AND ")}
          ORDER BY s.started_at DESC LIMIT $${params.length}`, params)).rows;
      return c.json({ ok: true, range: rg.key, rows: rows.map(sessionRow) });
    } catch (e) {
      console.error("[journey] sessions failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e).slice(0, 200) });
    }
  });

  app.get("/api/journey/sessions/:sid", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    try {
      const sid = String(c.req.param("sid") || "");
      if (!validSid(sid)) return c.json({ ok: false, error: "bad_sid" });
      const s = (await pool.query(`SELECT * FROM journey_sessions WHERE session_id=$1`, [sid])).rows[0];
      if (!s) return c.json({ ok: false, error: "not_found" });
      const events = (await pool.query(
        `SELECT at, client_ts, source, name, step, path, props, order_no FROM journey_events
          WHERE session_id=$1 ORDER BY COALESCE(client_ts, at), id LIMIT 400`, [sid])).rows;
      let order = null, orderEvents = [];
      const orderNo = s.order_no || (await pool.query(`SELECT order_no FROM shop_orders WHERE journey_sid=$1 ORDER BY created_at DESC LIMIT 1`, [sid])).rows[0]?.order_no;
      if (orderNo) {
        const o = (await pool.query(
          `SELECT order_no, status, total, option, coupon, pay_gateway, created_at FROM shop_orders WHERE order_no=$1`, [orderNo])).rows[0];
        if (o) order = { orderNo: o.order_no, status: o.status, total: r2(o.total), option: o.option, coupon: o.coupon, gateway: o.pay_gateway, createdAt: o.created_at };
        orderEvents = (await pool.query(
          `SELECT at, name, source, ok, summary, data FROM shop_order_events WHERE order_no=$1 ORDER BY at LIMIT 200`, [orderNo])
          .catch(() => ({ rows: [] }))).rows;
      }
      const other = (await pool.query(
        `SELECT session_id, started_at, channel, max_step, paid FROM journey_sessions
          WHERE anon_id=$1 AND session_id<>$2 ORDER BY started_at DESC LIMIT 10`, [s.anon_id, sid])).rows;
      return c.json({
        ok: true, session: sessionRow(s),
        events: events.map((e) => ({ at: e.client_ts || e.at, source: e.source, name: e.name, step: e.step, path: e.path, props: e.props })),
        order, orderEvents,
        otherSessions: other.map((x) => ({ sessionId: x.session_id, startedAt: x.started_at, channel: CHANNEL_LABELS[x.channel] || x.channel, maxStep: x.max_step, paid: x.paid })),
      });
    } catch (e) {
      console.error("[journey] session detail failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e).slice(0, 200) });
    }
  });

  app.get("/api/journey/health", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    try {
      const r = (await pool.query(
        `SELECT (SELECT max(at) FROM journey_events) AS last_event_at,
                (SELECT count(*) FROM journey_events WHERE at > NOW() - INTERVAL '1 hour')::int AS events_last_hour,
                (SELECT count(*) FROM journey_sessions WHERE started_at > NOW() - INTERVAL '24 hours')::int AS sessions_24h,
                (SELECT count(*) FROM journey_events)::int AS events_total`)).rows[0];
      return c.json({ ok: true, build: "journey-v1", ...r });
    } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  });

  return { emit, sweep };
}
