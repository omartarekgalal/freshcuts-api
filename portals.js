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

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

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
    return {
      state: st === "OPEN" ? "open" : st ? "closed" : "unknown",
      detail: st === "OPEN" ? "المتجر مفتوح"
        : st === "CLOSED_UNTIL" ? `مقفول حتى ${first.closedUntil || "?"}`
        : st === "CLOSED_TODAY" ? "مقفول اليوم"
        : "حالة غير معروفة",
      raw: first,
    };
  },
};

/* ─── Keeta / Ninja ───────────────────────────────────────────────────────────
   Their merchant portals need a login we do not hold yet. The adapters are
   declared so the UI lists the channel and says exactly what is missing,
   instead of silently pretending everything is fine.                          */
function pendingPortal(id, label, envPrefix) {
  return {
    id, label,
    configured: () => false,
    missing: `${envPrefix}_EMAIL / ${envPrefix}_PASSWORD`,
    async status() { throw new Error("not configured"); },
  };
}

const PORTALS = [
  hungerstation,
  pendingPortal("keeta", "كيتا", "KEETA"),
  pendingPortal("ninja", "نينجا", "NINJA"),
];

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
