// portals.js — read the REAL store status straight from each delivery
// platform's own merchant portal.
//
// Why this exists: inferring "channel is down" from order silence is wrong —
// a quiet hour looks identical to a broken integration. The only honest signal
// is what the platform itself says about the store (open / closed / paused).
//
// Each portal is a small adapter with the same shape:
//   { id, label, configured(), status() -> { state, detail, raw } }
// state: "open" | "closed" | "unknown" | "error"
//
// Adding a platform later = one more adapter here; the health endpoint and the
// POS app pick it up with no other change.

import https from "node:https";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// Ninja's gateway answers 500 to anything undici (global fetch) sends — the
// extra sec-fetch-*/accept-encoding hints it adds are enough to upset it —
// while a plain node:https request with the same token succeeds. So that one
// portal gets a raw client.
function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { host: u.hostname, path: u.pathname + u.search, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/* ─── HungerStation (Deliveryhero vendor portal) ──────────────────────────────
   Auth: POST /api/1/auth/form -> { token } (JWT, 14 days, no refresh endpoint,
   so we simply log in again when it expires).
   Status: GET /api/1/platforms/restaurants/availabilities
           -> availabilityState: OPEN | CLOSED_UNTIL | CLOSED_TODAY            */
const HS = {
  base: process.env.HS_API_BASE || "https://vendor-api-sa.me.restaurant-partners.com",
  email: process.env.HS_EMAIL || "",
  password: process.env.HS_PASSWORD || "",
  globalEntity: process.env.HS_GLOBAL_ENTITY || "HS_SA",
  vendorId: process.env.HS_VENDOR_ID || "",          // e.g. 187493
  lpvId: process.env.HS_LPV_ID || "",                // e.g. SFNfU0EtMTg3NDkz
  deviceUuid: process.env.HS_DEVICE_UUID || "WEB|freshcuts-server",
  _token: null,
  _tokenAt: 0,
};

function hsHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    Accept: "application/json",
    "x-global-entity-id": HS.globalEntity,
    "x-platform-vendor-id": HS.vendorId,
    "x-vendor-id": HS.lpvId,
    "x-rps-device": HS.deviceUuid,
    "x-rps-client-app-name": "vendor-web",
    ...extra,
  };
}

async function hsToken() {
  // The JWT lasts 14 days; refresh well before that and on demand.
  const TEN_DAYS = 10 * 24 * 3600 * 1000;
  if (HS._token && Date.now() - HS._tokenAt < TEN_DAYS) return HS._token;
  const body = new URLSearchParams({ username: HS.email, password: HS.password });
  const res = await fetch(`${HS.base}/api/1/auth/form`, {
    method: "POST",
    headers: hsHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
    body,
  });
  if (!res.ok) throw new Error(`hs login HTTP ${res.status}`);
  const j = await res.json();
  if (!j.token) throw new Error("hs login: no token in response");
  HS._token = j.token;
  HS._tokenAt = Date.now();
  return HS._token;
}

const hungerstation = {
  id: "hungerstation",
  label: "هنقرستيشن",
  configured: () => !!(HS.email && HS.password && HS.vendorId && HS.lpvId),
  async status() {
    const token = await hsToken();
    const res = await fetch(`${HS.base}/api/1/platforms/restaurants/availabilities`, {
      headers: hsHeaders({ Authorization: `Bearer ${token}` }),
    });
    if (res.status === 401 || res.status === 403) {
      // Either the token died or PerimeterX challenged us — both mean "we
      // cannot vouch for the store right now", which is not the same as closed.
      HS._token = null;
      throw new Error(`hs availabilities HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`hs availabilities HTTP ${res.status}`);
    const j = await res.json();
    const list = Array.isArray(j) ? j : (j.availabilities || j.data || []);
    const first = list[0] || {};
    const st = String(first.availabilityState || first.state || "").toUpperCase();
    // currentSlotEndAt is when the current open/closed slot flips, which is the
    // only genuinely useful thing to show a cashier staring at a closed store.
    const until = first.currentSlotEndAt || first.closedUntil;
    const localTime = (iso) => {
      try {
        return new Date(iso).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Riyadh" });
      } catch { return String(iso); }
    };
    return {
      state: st === "OPEN" ? "open" : st ? "closed" : "unknown",
      detail: st === "OPEN" ? (until ? `المتجر مفتوح حتى ${localTime(until)}` : "المتجر مفتوح")
        : st === "CLOSED_UNTIL" ? `مقفول حتى ${until ? localTime(until) : "?"}`
        : st === "CLOSED_TODAY" ? "مقفول اليوم"
        : st === "CLOSED" ? (until ? `مقفول — يفتح ${localTime(until)}` : "المتجر مقفول")
        : `حالة غير معروفة (${st || "فاضية"})`,
      raw: first,
    };
  },
};

/* ─── Keeta (Meituan "sailor" merchant portal) ────────────────────────────────
   GET /api/scm/shop/base/summary?shopId=<id> answers with
     businessStatus     1 = open
     duringBusinessHour whether we are inside the configured hours
     deliveryRestStatus / pickupRestStatus  1 = accepting
   Auth is the portal session cookie plus a set of Meituan bookkeeping headers
   (the page keeps them in localStorage under __fc_biz). Their login is captcha
   / risk-scored, so we carry a cookie rather than trying to log in headlessly;
   KEETA_COOKIE is refreshed from a logged-in browser when it lapses.          */
const KEETA = {
  base: process.env.KEETA_BASE || "https://merchant.mykeeta.com",
  shopId: process.env.KEETA_SHOP_ID || "",
  cookie: process.env.KEETA_COOKIE || "",
  headers: process.env.KEETA_HEADERS || "",   // JSON copied from __fc_biz
};

const keeta = {
  id: "keeta",
  label: "كيتا",
  configured: () => !!(KEETA.shopId && KEETA.cookie),
  missing: "KEETA_SHOP_ID / KEETA_COOKIE (+ KEETA_HEADERS)",
  async status() {
    let extra = {};
    try { extra = KEETA.headers ? JSON.parse(KEETA.headers) : {}; } catch { extra = {}; }
    const res = await fetch(`${KEETA.base}/api/scm/shop/base/summary?shopId=${encodeURIComponent(KEETA.shopId)}`, {
      headers: { "User-Agent": UA, Accept: "application/json", Cookie: KEETA.cookie, ...extra },
    });
    if (!res.ok) throw new Error(`keeta HTTP ${res.status}`);
    const j = await res.json();
    // Their gateway answers 200 with a non-zero code for auth problems.
    if (j.code !== 0 || !j.data) throw new Error(`keeta code ${j.code}: ${j.message || "الجلسة انتهت — جدّد KEETA_COOKIE"}`);
    const d = j.data;
    const open = d.businessStatus === 1 && d.duringBusinessHour !== false;
    const resting = d.deliveryRestStatus != null && d.deliveryRestStatus !== 1;
    return {
      state: open && !resting ? "open" : "closed",
      detail: !open && d.duringBusinessHour === false ? "خارج ساعات العمل"
        : resting ? "التوصيل موقوف مؤقتاً"
        : open ? "المتجر مفتوح" : "المتجر مقفول",
      raw: { businessStatus: d.businessStatus, duringBusinessHour: d.duringBusinessHour, deliveryRestStatus: d.deliveryRestStatus },
    };
  },
};

/* ─── Ninja (restaurant-portal.ananinja.com) ──────────────────────────────────
   GET {base}/restaurants/branches/{id} -> JSON:API, data.attributes.status is
   "available" | "busy" | "closed".

   Their login is MFA'd (password -> preAuthToken -> EMAIL OTP -> jwtToken),
   so a server can never log in unattended. We therefore carry the tokens:
   the access JWT lives 24h and the refresh token 7 days, and we try the
   refresh endpoint before giving up. When both lapse the tile says so
   explicitly rather than pretending the branch is fine.                        */
const NINJA = {
  base: process.env.NINJA_API_BASE || "https://food-vendor-portal.ananinja.com",
  adminBase: process.env.NINJA_ADMIN_BASE || "https://admin.ananinja.com",
  branchId: process.env.NINJA_BRANCH_ID || "",
  jwt: process.env.NINJA_JWT || "",
  refresh: process.env.NINJA_REFRESH_TOKEN || "",
  branchPath: process.env.NINJA_BRANCH_PATH || "/restaurants/branches/{id}",
  _jwt: null,
};

function jwtExpired(tok) {
  try {
    const p = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString());
    return !p.exp || p.exp * 1000 < Date.now() + 60_000;
  } catch { return true; }
}

async function ninjaToken() {
  const current = NINJA._jwt || NINJA.jwt;
  if (current && !jwtExpired(current)) return current;
  if (!NINJA.refresh) throw new Error("انتهت صلاحية التوكن — لازم تسجيل دخول جديد");
  // The three POST shapes guessed here never worked, so Ninja's tile has been
  // reporting a dead branch whenever the JWT lapsed. The real call, captured
  // from the portal: a GET to admin.ananinja.com — different host AND different
  // verb — carrying the REFRESH token in the Authorization header. The refresh
  // token rotates on each call but the old one stays valid to its own 7-day
  // expiry, so there is nothing to persist.
  const r = await rawGet(`${NINJA.adminBase}/users/users/refresh`, {
    "User-Agent": UA,
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${NINJA.refresh}`,
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`انتهت صلاحية التوكن — سجّل دخول وحدّث NINJA_JWT (HTTP ${r.status})`);
  }
  let tok = null;
  try {
    const j = JSON.parse(r.body);
    tok = j?.data?.attributes?.jwtToken || j.jwtToken || j.token || j.accessToken;
  } catch { /* fall through to the error below */ }
  if (!tok) throw new Error("انتهت صلاحية التوكن — رد التحديث مافيهوش توكن");
  NINJA._jwt = tok;
  return tok;
}

const ninja = {
  id: "ninja",
  label: "نينجا",
  configured: () => !!(NINJA.branchId && (NINJA.jwt || NINJA.refresh)),
  missing: "NINJA_BRANCH_ID / NINJA_JWT",
  async status() {
    const token = await ninjaToken();
    const res = await rawGet(NINJA.base + NINJA.branchPath.replace("{id}", NINJA.branchId), {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      Origin: "https://restaurant-portal.ananinja.com",
    });
    if (res.status === 401 || res.status === 403) {
      NINJA._jwt = null;
      throw new Error("انتهت صلاحية التوكن — سجّل دخول وحدّث NINJA_JWT");
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`ninja HTTP ${res.status}`);
    const j = JSON.parse(res.body);
    const a = j?.data?.attributes || j?.data || j;
    const st = String(a.status || "").toLowerCase();
    return {
      state: st === "available" ? "open" : st ? "closed" : "unknown",
      detail: st === "available" ? "المتجر مفتوح"
        : st === "busy" ? "مشغول مؤقتاً"
        : st === "closed" ? "المتجر مقفول"
        : `الحالة: ${st || "غير معروفة"}`,
      raw: { status: a.status, activationStatus: a.activationStatus, enabled: a.enabled },
    };
  },
};

const PORTALS = [hungerstation, keeta, ninja];

// Cache so the POS app polling every 30s doesn't hammer the platforms.
const cache = new Map();
const TTL_MS = Number(process.env.PORTAL_CACHE_MS || 120000);

async function checkAll() {
  const out = [];
  for (const p of PORTALS) {
    if (!p.configured()) {
      out.push({ id: p.id, label: p.label, state: "unconfigured", detail: p.missing ? `غير مربوط (${p.missing})` : "غير مربوط" });
      continue;
    }
    const hit = cache.get(p.id);
    if (hit && Date.now() - hit.at < TTL_MS) { out.push(hit.value); continue; }
    try {
      const s = await p.status();
      const value = { id: p.id, label: p.label, state: s.state, detail: s.detail };
      cache.set(p.id, { at: Date.now(), value });
      out.push(value);
    } catch (e) {
      const value = { id: p.id, label: p.label, state: "error", detail: `تعذر الفحص: ${e.message}` };
      cache.set(p.id, { at: Date.now(), value });
      out.push(value);
    }
  }
  return out;
}

export { checkAll, PORTALS };
