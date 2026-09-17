/* ═══════════════════════════════════════════════════════════════════════════
   BOT FILTER — crawlers, link-preview fetchers and ad-review bots are not
   customers (growth audit, 17 Sept 2026).

   What the audit measured on the 96 campaign's first day:
     • 252 PageView + 4 Contact from Meta's ad-review crawler (2a03:2880:* and
       the other AS32934 ranges) between 02:00 and 06:00 — every one forwarded
       to Meta CAPI / TikTok / Snap as a real visit, poisoning the "website
       visitors" audiences and the pixel's learning.
     • cms_links.clicks = 1,410 against 119 real clicks at Meta (×12).
   The review bots use ordinary mobile user agents, so the UA test alone misses
   them — the IP ranges are what actually catch them.

   isBotRequest({ ua, ip }) → false | "ua" | "meta_ip"   (pure, no I/O)
   BOT_SQL(alias)           → SQL condition that is TRUE for a bot row, for the
                              stats queries over rows stored before this filter.
═══════════════════════════════════════════════════════════════════════════ */

export const BOT_UA_RE = /facebookexternalhit|meta-externalagent|meta-externalfetcher|facebot|facebookcatalog|bingpreview|bingbot|googlebot|adsbot-google|mediapartners-google|google-inspectiontool|googleother|twitterbot|linkedinbot|slackbot|telegrambot|discordbot|whatsapp\/|skypeuripreview|snapchat.*(?:preview|bot)|bytespider|tiktokspider|petalbot|yandexbot|baiduspider|duckduckbot|applebot|semrushbot|ahrefsbot|headlesschrome|phantomjs|puppeteer|playwright|lighthouse|pagespeed|pingdom|uptimerobot|uptime-kuma|python-requests|python-httpx|curl\/|wget\/|go-http-client|node-fetch|axios\/|\bcrawler\b|\bspider\b/i;

/* Meta (AS32934) — the ad-review crawler and link-preview fetchers. Real
   customers browse from their own carrier/ISP, including inside the Facebook
   and Instagram in-app browsers, so these never hide a person. */
const META_V4 = [
  "31.13.24.0/21", "31.13.64.0/18", "45.64.40.0/22", "57.141.0.0/16", "66.220.144.0/20", "69.63.176.0/20",
  "69.171.224.0/19", "74.119.76.0/22", "102.132.96.0/20", "103.4.96.0/22", "129.134.0.0/16",
  "157.240.0.0/16", "163.70.128.0/17", "173.252.64.0/18", "179.60.192.0/22", "185.60.216.0/22",
  "185.89.216.0/22", "204.15.20.0/22",
];
const META_V6 = ["2a03:2880:", "2620:0:1c"];

function v4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const V4_RANGES = META_V4.map((c) => {
  const [base, bits] = c.split("/");
  const b = Number(bits);
  const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  return { net: (v4ToInt(base) & mask) >>> 0, mask };
});

export function isMetaIp(ip) {
  let s = String(ip || "").trim().toLowerCase();
  if (!s) return false;
  if (s.startsWith("::ffff:")) s = s.slice(7);          // IPv4-mapped IPv6
  if (s.includes(":")) return META_V6.some((p) => s.startsWith(p));
  const n = v4ToInt(s);
  if (n == null) return false;
  return V4_RANGES.some((r) => ((n & r.mask) >>> 0) === r.net);
}

export function isBotRequest({ ua = "", ip = "" } = {}) {
  if (BOT_UA_RE.test(String(ua || ""))) return "ua";
  if (isMetaIp(ip)) return "meta_ip";
  return false;
}

/* SQL for rows stored BEFORE this filter existed. Prefix matching (text column,
   no inet cast that one malformed row could crash) — a little wider than the
   exact CIDRs above, which is fine for excluding crawler noise from stats. */
const SQL_IP_PREFIXES = ["2a03:2880:%", "2620:0:1c%", "31.13.%", "69.171.%", "66.220.%", "173.252.%", "69.63.%",
  "157.240.%", "129.134.%", "163.70.%", "179.60.19%", "185.60.21%", "204.15.2%", "102.132.%"];
const SQL_UA_RE = "facebookexternalhit|meta-externalagent|meta-externalfetcher|facebot|facebookcatalog|bingpreview|headlesschrome|lighthouse|bytespider|twitterbot|googlebot|adsbot";
export function BOT_SQL(alias = "") {
  const a = alias ? alias + "." : "";
  return `(COALESCE(${a}ua,'') ~* '${SQL_UA_RE}' OR ${SQL_IP_PREFIXES.map((p) => `COALESCE(${a}ip,'') LIKE '${p}'`).join(" OR ")})`;
}
