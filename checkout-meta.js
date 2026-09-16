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
