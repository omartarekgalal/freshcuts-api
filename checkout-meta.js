/* ═══════════════════════════════════════════════════════════════════════════
   CHECKOUT META — عقد بيانات الـcheckout (الخطة الرئيسية §٤-٣، W0-03).

   المتجر بيبعت مع /api/shop/checkout:
     body.attribution = { fc_link, utm:{…}, click:{…}, landing_at, entry }
     body.journey_sid / body.client / body.app_version
   وده كله جاي من المتصفح = مش موثوق. فبنعدّيه على قايمة مفاتيح مسموحة،
   وكل قيمة بتتقص ≤ ٣٠٠ حرف، وأي مفتاح مش معروف بيتشال.

   ip وua **من الهيدر بس** — لو المتصفح بعت ip/ua في الـbody بيتجاهلوا، عشان
   دول اللي بيروحوا لميتا في Purchase (CAPI) ومحدش يقدر يزوّرهم من الصفحة.

   parseCheckoutMeta(body, headers) → { attribution, journey_sid, client, app_version }
   headers = دالة (name) => value (زي c.req.header)، أو Headers، أو object عادي.
═══════════════════════════════════════════════════════════════════════════ */

export const MAX_LEN = 300;
export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id"];
// scid = نفس ScCid بتاع سناب — pixels.js بيحفظه باسم scid وfunnel.js بيقرا الاتنين
export const CLICK_KEYS = ["fbc", "fbp", "fbclid", "ttclid", "ttp", "ScCid", "scid", "gclid", "gbraid", "wbraid"];
export const CLIENTS = ["web", "webview", "pwa", "ios", "android"];

/* قيمة نصية نضيفة أو null — أرقام بتتحول نص، وobjects/arrays بتتشال.
   مهم: Postgres JSONB بيرفض \u0000 وأي surrogate يتيم ("\ud83d") — ولو ده حصل
   الـINSERT بتاع الطلب كله بيقع بعد ما جلسة الدفع اتعملت. فبنشيل حروف التحكم
   والـsurrogates اليتيمة، والقص مابيقسمش إيموجي نصين. */
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function clip(v, n = MAX_LEN) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  let s = v.replace(CTRL_RE, "").replace(LONE_SURROGATE_RE, "").trim();
  if (!s) return null;
  if (s.length > n) {
    s = s.slice(0, n);
    // لو القص وقع في نص زوج surrogate، نشيل النص الأول
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  }
  return s || null;
}

function pickStrings(src, keys) {
  const out = {};
  if (!src || typeof src !== "object" || Array.isArray(src)) return out;
  for (const k of keys) {
    const v = clip(src[k]);
    if (v != null) out[k] = v;
  }
  return out;
}

function headerGetter(headers) {
  if (typeof headers === "function") return (n) => headers(n);
  if (headers && typeof headers.get === "function") return (n) => headers.get(n);
  if (headers && typeof headers === "object") {
    const lower = {};
    for (const [k, v] of Object.entries(headers)) lower[String(k).toLowerCase()] = v;
    return (n) => lower[n.toLowerCase()];
  }
  return () => undefined;
}

function ipFrom(get) {
  // Cloudflare هو اللي بيحط cf-connecting-ip؛ x-forwarded-for احتياطي (أول hop)
  const raw = get("cf-connecting-ip") || String(get("x-forwarded-for") || "").split(",")[0];
  const s = clip(raw, 64);
  return s && /^[0-9a-fA-F:.]+$/.test(s) ? s : null;
}

export function parseCheckoutMeta(body, headers) {
  const b = body && typeof body === "object" ? body : {};
  const a = b.attribution && typeof b.attribution === "object" && !Array.isArray(b.attribution) ? b.attribution : {};
  const get = headerGetter(headers);

  let landingAt = clip(a.landing_at);
  if (landingAt && Number.isNaN(Date.parse(landingAt))) landingAt = null;

  const attribution = {
    fc_link: clip(a.fc_link),
    utm: pickStrings(a.utm, UTM_KEYS),
    click: pickStrings(a.click, CLICK_KEYS),
    landing_at: landingAt,
    entry: clip(a.entry),
    ip: ipFrom(get),
    ua: clip(get("user-agent")),
    captured: "checkout",
  };

  const clientRaw = String(b.client || "").trim().toLowerCase();
  const client = CLIENTS.includes(clientRaw) ? clientRaw : "web";
  const app_version = clip(b.app_version, 20);
  const sid = String(b.journey_sid ?? "").trim();
  const journey_sid = sid && sid.length <= 64 && /^[a-z0-9_-]+$/.test(sid) ? sid : null;

  return { attribution, journey_sid, client, app_version };
}

/* ── مصدر الطلب في عمود واحد (attrib_source) ───────────────────────────────
   العمود موجود في orders-schema من W4-02 وماكانش بيتكتب أبداً، فأي تقرير
   «الطلبات دي جت منين» كان لازم يفتح jsonb لكل صف. دلوقتي بنكتب توكن واحد.

   الترتيب: utm_source صريح > click id (fbclid/ttclid/ScCid/gclid) > سلاج رابط
   fc_link > قناة الجلسة (journey) > referrer > direct. أي حاجة مش معروفة
   بترجع نفسها منضّفة (حروف صغيرة/أرقام/شرطة) بدل ما نلزقها في "other" —
   اسم غلط أحسن من تصنيف مخترع. */
const SOURCE_ALIASES = {
  meta: "meta", facebook: "meta", fb: "meta", instagram: "meta", ig: "meta", messenger: "meta",
  meta_ads: "meta", facebook_ads: "meta",
  snapchat: "snapchat", snap: "snapchat", sc: "snapchat", snap_ads: "snapchat", snapchat_ads: "snapchat",
  tiktok: "tiktok", tt: "tiktok", bytedance: "tiktok", tiktok_ads: "tiktok",
  campaign_link: "link", link: "link", referral: "referral",
  google: "google", googleads: "google", gads: "google", maps: "google",
  sms: "sms", taqnyat: "sms",
  whatsapp: "whatsapp", wa: "whatsapp",
  qr: "offline", sticker: "offline", print: "offline", bag: "offline", offline: "offline",
  push: "push", webpush: "push",
  email: "email", newsletter: "email",
  direct: "direct", none: "direct", "(direct)": "direct",
};
const REF_HOSTS = [
  [/(^|\.)(facebook|instagram|fb|messenger)\./, "meta"],
  [/(^|\.)(snapchat)\./, "snapchat"],
  [/(^|\.)(tiktok)\./, "tiktok"],
  [/(^|\.)(google|googleadservices|gstatic)\./, "google"],
  [/(^|\.)(whatsapp|wa\.me)/, "whatsapp"],
];

const slugish = (v) => String(v || "").toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || null;

export function normalizeSource(raw) {
  const s = String(raw || "").toLowerCase().trim();
  if (!s) return null;
  return SOURCE_ALIASES[s] || slugish(s);
}

/* attribution = العمود زي ما هو متخزن. session = صف journey_sessions أو null. */
export function classifySource(attribution, session = null) {
  const a = attribution && typeof attribution === "object" ? attribution : {};
  const utm = a.utm && typeof a.utm === "object" ? a.utm : {};
  const click = a.click && typeof a.click === "object" ? a.click : {};

  const fromUtm = normalizeSource(utm.utm_source);
  if (fromUtm) return fromUtm;
  if (click.fbclid || click.fbc) return "meta";
  if (click.ttclid) return "tiktok";
  if (click.ScCid || click.scid) return "snapchat";
  if (click.gclid || click.gbraid || click.wbraid) return "google";
  if (a.fc_link) return "link";

  if (session) {
    const fromSession = normalizeSource(session.utm_source) || normalizeSource(session.channel);
    if (fromSession && fromSession !== "direct") return fromSession;
    const host = String(session.referrer_host || "").toLowerCase();
    for (const [re, id] of REF_HOSTS) if (re.test(host)) return id;
  }
  return "direct";
}

/* الجلسة بتتسجّل على السيرفر ساعة الهبوط (utm + سلاج الرابط)، والـcheckout
   بيبعت اللي في الـlocalStorage. المتصفّح الداخلي بتاع فيسبوك بيمسح التخزين
   كتير، فالطلب بيوصل بـ utm فاضي وهو أصلاً جاي من إعلان. الدالة دي بتكمّل
   الناقص من الجلسة **من غير ما تدوس** على أي قيمة بعتها المتصفّح. */
export function mergeSessionAttribution(attribution, session) {
  const a = attribution && typeof attribution === "object" ? { ...attribution } : {};
  if (!session) return { attribution: a, enriched: false };
  const utm = { ...(a.utm && typeof a.utm === "object" ? a.utm : {}) };
  let enriched = false;
  for (const k of UTM_KEYS) {
    if (utm[k] == null && session[k] != null) { const v = clip(session[k]); if (v) { utm[k] = v; enriched = true; } }
  }
  if (!a.fc_link && session.link_slug) { const v = clip(session.link_slug); if (v) { a.fc_link = v; enriched = true; } }
  if (!a.landing_at && session.started_at) {
    const d = session.started_at instanceof Date ? session.started_at.toISOString() : clip(session.started_at);
    if (d && !Number.isNaN(Date.parse(d))) { a.landing_at = d; enriched = true; }
  }
  if (enriched) { a.utm = utm; a.captured = a.captured ? `${a.captured}+journey` : "journey"; }
  return { attribution: a, enriched };
}

export const SESSION_ATTR_SQL =
  "SELECT utm_source, utm_medium, utm_campaign, utm_content, utm_term, link_slug, channel, referrer_host, started_at" +
  " FROM journey_sessions WHERE session_id = $1";

/* بعد ما طلب مدفوع ينزل نقطة البيع: Purchase من السيرفر (funnel.serverPurchase).
   fire-and-forget — عمره ما يوقف أو يوقّع الطلب، لا sync ولا async. */
export function fireServerPurchase(funnelDep, orderNo, log = console) {
  try {
    const api = typeof funnelDep === "function" ? funnelDep() : funnelDep;
    const p = api?.serverPurchase?.({ orderNo });
    if (p && typeof p.catch === "function") {
      p.catch((e) => log.error(`[shop] serverPurchase failed for ${orderNo}: ${e?.message || e}`));
    }
  } catch (e) {
    log.error(`[shop] serverPurchase threw for ${orderNo}: ${e?.message || e}`);
  }
}
