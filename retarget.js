/* ═══════════════════════════════════════════════════════════════════════════
   RETARGET — per-platform customer identity capture for HungerStation & Ninja.

   Registered by index.js via `register(app, ctx)`.

   ── READ THIS FIRST: what this module can and cannot do ───────────────────
   It does NOT capture phone numbers or names, because neither platform gives
   them to the vendor. This was established by exhausting both merchant APIs
   (2026-08-01):

   • HungerStation (`vendor-api-sa.me.restaurant-partners.com`) — the order
     object has a `customer` block, but on every real order it contains only
     `{ customerId }`. The one order in the account carrying a phone/name is
     Deliveryhero's synthetic test fixture: `test: true`, externalId prefixed
     `TOTO-`, name "Max", phone "+49123456789" (a German dummy). The vendor
     portal's whole 84-endpoint surface has no /customers resource, no export,
     no webhook registration. `/api/2/recent-orders` returns a legacy customer
     block with phone/firstName/lastName all null.

   • Ninja (`food-vendor-portal.ananinja.com`) — the order object's complete
     attribute set contains `userId` and nothing else about the person. No
     name, no phone, no email, no address. `?include=user` / `?include=customer`
     are silently ignored (relationships come back empty). The finance
     `orders_detailed_report` is pure money (commission/VAT/net sales). The
     ad-hoc report builder (`POST /restaurants-finance/report/generate`)
     answers 500 to `group_by: ["user_id"]` and to any `joins: ["user"]`.

   So the reachable unit of identity is an OPAQUE PLATFORM CUSTOMER ID. That
   is still worth capturing: it is stable across orders (HS `customerId`
   12960461 was verified on three separate orders), which buys us repeat rate,
   order frequency and lifetime value per platform — the numbers Omar cannot
   get from FeedUs or the POS today. It buys us no outbound contact channel.
   Getting phones requires the platforms' consent, not more code.

   ── Why this must run on a schedule ───────────────────────────────────────
   Both APIs are rolling recent-order windows, not history APIs. HungerStation
   ignores `from`/`to` in practice (a 90-day and a 365-day window returned the
   same 5 orders; month-by-month sweeps back to January returned nothing).
   There is therefore NO historical backfill available — only forward capture.
   Every order we fail to poll is lost permanently, so the sync route is meant
   to be called regularly (hourly is ample at current volume) and is written
   to be idempotent: re-syncing the same window is a no-op.
═══════════════════════════════════════════════════════════════════════════ */

import https from "node:https";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/* Ninja's gateway answers HTTP 500 to anything Node's global fetch (undici)
   sends — the extra sec-fetch and accept-encoding hints it adds are enough to
   upset it — while a plain node:https request with the same token succeeds. Same
   raw client as portals.js, for the same reason. HungerStation is happy
   either way; it uses this one too so there is a single code path. */
function raw(method, url, headers = {}, body = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { host: u.hostname, path: u.pathname + u.search, method, headers },
      (res) => {
        let buf = "";
        res.on("data", (d) => { buf += d; });
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}
const rawGet = (url, headers, ms) => raw("GET", url, headers, null, ms);

function parseJson(body, what) {
  try { return JSON.parse(body); } catch { throw new Error(`${what}: response was not JSON`); }
}

/* ─── HungerStation connector ─────────────────────────────────────────────
   Auth is the same POST /api/1/auth/form that portals.js uses (14-day JWT).

   The one non-obvious thing: `vendorIds` must be the COMPOSITE key
   `<globalEntityId>#<platformRestaurantId>` — e.g. `HS_SA#187493`. Neither
   the LPV id (`SFNfU0EtMTg3NDkz`) nor the bare restaurant id works; the
   gateway rejects both with a bodyless 403 that looks like a WAF block but
   is not. The portal builds it the same way:
     restaurant.platformRestaurants.map(p => `${p.globalEntityId}#${p.id}`)

   We read `/api/2/deliveries`, NOT `/api/2/recent-orders`. They return
   different shapes and only `deliveries` carries `customer.customerId`.   */
const HS = {
  base: process.env.HS_API_BASE || "https://vendor-api-sa.me.restaurant-partners.com",
  email: process.env.HS_EMAIL || "",
  password: process.env.HS_PASSWORD || "",
  globalEntity: process.env.HS_GLOBAL_ENTITY || "HS_SA",
  vendorId: process.env.HS_VENDOR_ID || "",
  lpvId: process.env.HS_LPV_ID || "",
  deviceUuid: process.env.HS_DEVICE_UUID || "WEB|freshcuts-server",
  _token: null,
  _tokenAt: 0,
};

const hsConfigured = () => !!(HS.email && HS.password && HS.vendorId && HS.lpvId);
const hsVendorKey = () => `${HS.globalEntity}#${HS.vendorId}`;

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
  const TEN_DAYS = 10 * 24 * 3600 * 1000;
  if (HS._token && Date.now() - HS._tokenAt < TEN_DAYS) return HS._token;
  const res = await fetch(`${HS.base}/api/1/auth/form`, {
    method: "POST",
    headers: hsHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({ username: HS.email, password: HS.password }),
  });
  if (!res.ok) throw new Error(`hs login HTTP ${res.status}`);
  const j = await res.json();
  if (!j.token) throw new Error("hs login: no token in response");
  HS._token = j.token;
  HS._tokenAt = Date.now();
  return HS._token;
}

/** Recent HungerStation orders, normalised. `days` is advisory — the platform
 *  clamps the window to whatever it considers "recent" regardless. */
export async function fetchHungerstationOrders(days = 30) {
  if (!hsConfigured()) throw new Error("hungerstation not configured");
  const token = await hsToken();
  const to = new Date().toISOString();
  const from = new Date(Date.now() - days * 864e5).toISOString();
  const url =
    `${HS.base}/api/2/deliveries?vendorIds=${encodeURIComponent(hsVendorKey())}` +
    `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await rawGet(url, hsHeaders({ Authorization: `Bearer ${token}` }));
  if (res.status === 401 || res.status === 403) {
    HS._token = null;
    throw new Error(`hs deliveries HTTP ${res.status}`);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`hs deliveries HTTP ${res.status}`);
  const j = parseJson(res.body, "hs deliveries");
  const list = Array.isArray(j) ? j : (j.orders || j.data || []);
  return list
    // Deliveryhero injects synthetic test orders (test:true, externalId
    // "TOTO-…", customer "Max" / +49123456789). They would otherwise show up
    // as a real repeat customer and poison every retention number.
    .filter((o) => o && o.test !== true && !String(o.externalId || "").startsWith("TOTO-"))
    .map((o) => ({
      platform: "hungerstation",
      externalId: String(o.externalId || o.id || ""),
      platformCustomerId: o.customer?.customerId ? String(o.customer.customerId) : null,
      orderedAt: o.timestamp || null,
      total: o.payment?.total ?? null,
      currency: o.payment?.currency || "SAR",
      state: o.state || null,
      transport: o.transport?.type || null,
      raw: o,
    }))
    .filter((o) => o.externalId);
}

/* ─── Ninja connector ─────────────────────────────────────────────────────
   The access JWT lives 24h, so it is always refreshed rather than trusted.
   The refresh call is a GET to admin.ananinja.com with the REFRESH token in
   the Authorization header — note both the verb and the host, portals.js
   currently POSTs to public.ananinja.com and always fails:
     GET https://admin.ananinja.com/users/users/refresh
       Authorization: Bearer <refresh token>
     -> { data: { attributes: { jwtToken, refreshToken } } }
   The refresh token rotates on every call but the old one keeps working
   until its own 7-day expiry, so we do not need to persist the new one.

   Pagination brackets must be percent-encoded: `page%5Bsize%5D`. Sending a
   literal `page[size]` gets a 500 from their gateway. Without any page param
   the endpoint silently returns a single order.                            */
const NINJA = {
  base: process.env.NINJA_API_BASE || "https://food-vendor-portal.ananinja.com",
  adminBase: process.env.NINJA_ADMIN_BASE || "https://admin.ananinja.com",
  branchId: process.env.NINJA_BRANCH_ID || "",
  jwt: process.env.NINJA_JWT || "",
  refresh: process.env.NINJA_REFRESH_TOKEN || "",
  _jwt: null,
};

const ninjaConfigured = () => !!(NINJA.branchId && (NINJA.jwt || NINJA.refresh));

function jwtExpired(tok) {
  try {
    const p = JSON.parse(Buffer.from(String(tok).split(".")[1], "base64url").toString());
    return !p.exp || p.exp * 1000 < Date.now() + 60_000;
  } catch { return true; }
}

async function ninjaToken() {
  const current = NINJA._jwt || NINJA.jwt;
  if (current && !jwtExpired(current)) return current;
  if (!NINJA.refresh) throw new Error("ninja: no refresh token — re-login required");
  const res = await rawGet(`${NINJA.adminBase}/users/users/refresh`, {
    "User-Agent": "Mozilla/5.0",
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${NINJA.refresh}`,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`ninja refresh HTTP ${res.status} — NINJA_REFRESH_TOKEN has lapsed, log in again`);
  }
  const tok = parseJson(res.body, "ninja refresh")?.data?.attributes?.jwtToken;
  if (!tok) throw new Error("ninja refresh: no jwtToken in response");
  NINJA._jwt = tok;
  return tok;
}

const NINJA_PAGE_SIZE = 50;
const NINJA_MAX_PAGES = 20;   // hard stop; we are not paging their whole history

/** Recent Ninja orders, normalised. */
export async function fetchNinjaOrders() {
  if (!ninjaConfigured()) throw new Error("ninja not configured");
  const token = await ninjaToken();
  const headers = {
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    Origin: "https://restaurant-portal.ananinja.com",
  };
  const out = [];
  for (let page = 1; page <= NINJA_MAX_PAGES; page++) {
    const url =
      `${NINJA.base}/restaurants/orders?branch_id=${encodeURIComponent(NINJA.branchId)}` +
      `&page%5Bnumber%5D=${page}&page%5Bsize%5D=${NINJA_PAGE_SIZE}`;
    const res = await rawGet(url, headers);
    if (res.status === 401 || res.status === 403) {
      NINJA._jwt = null;
      throw new Error(`ninja orders HTTP ${res.status}`);
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`ninja orders HTTP ${res.status}`);
    const rows = parseJson(res.body, "ninja orders")?.data || [];
    for (const r of rows) {
      const a = r.attributes || {};
      out.push({
        platform: "ninja",
        externalId: String(a.externalId || r.id || ""),
        platformCustomerId: a.userId != null ? String(a.userId) : null,
        orderedAt: a.createdAt || null,
        total: a.totalAmount ?? null,
        currency: a.currency || "SAR",
        state: a.status || null,
        transport: null,
        raw: r,
      });
    }
    if (rows.length < NINJA_PAGE_SIZE) break;
  }
  return out.filter((o) => o.externalId);
}

const CONNECTORS = {
  hungerstation: { fetch: fetchHungerstationOrders, configured: hsConfigured },
  ninja: { fetch: fetchNinjaOrders, configured: ninjaConfigured },
};

/* ─── Storage ─────────────────────────────────────────────────────────────
   One table. `platform_customer_id` is nullable because a platform can hand
   us an order with no customer handle at all, and an order we cannot
   attribute is still worth keeping for the denominator.                    */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS platform_orders (
    platform             text        NOT NULL,
    external_id          text        NOT NULL,
    platform_customer_id text,
    ordered_at           timestamptz,
    total                numeric(12,2),
    currency             text,
    state                text,
    transport            text,
    first_seen           timestamptz NOT NULL DEFAULT now(),
    last_seen            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (platform, external_id)
  );
  CREATE INDEX IF NOT EXISTS platform_orders_cust_idx
    ON platform_orders (platform, platform_customer_id);
  CREATE INDEX IF NOT EXISTS platform_orders_day_idx
    ON platform_orders (ordered_at);
`;

let schemaReady = null;
function ensureSchema(pool) {
  if (!schemaReady) {
    schemaReady = pool.query(SCHEMA).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

export function register(app, ctx) {
  const { pool } = ctx;

  /* ───────────────────────────────────────────────────────────────────────
     POST /api/retarget/sync — pull recent orders from both platforms.

     Idempotent: an order already stored is refreshed, never duplicated. A
     platform that is unconfigured or erroring never blocks the other one;
     each reports its own outcome so a lapsed Ninja token is visible rather
     than silently halving the data.
  ─────────────────────────────────────────────────────────────────────── */
  app.post("/api/retarget/sync", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return err;
    await ensureSchema(pool);

    const body = await c.req.json().catch(() => ({}));
    const days = Math.min(90, Math.max(1, Number(body.days) || 30));
    const only = body.platform ? [String(body.platform)] : Object.keys(CONNECTORS);

    const results = {};
    for (const name of only) {
      const conn = CONNECTORS[name];
      if (!conn) { results[name] = { ok: false, error: "unknown_platform" }; continue; }
      if (!conn.configured()) { results[name] = { ok: false, error: "not_configured" }; continue; }
      try {
        const orders = await conn.fetch(days);
        let inserted = 0, updated = 0, withCustomer = 0;
        for (const o of orders) {
          if (o.platformCustomerId) withCustomer++;
          const r = await pool.query(
            `INSERT INTO platform_orders
               (platform, external_id, platform_customer_id, ordered_at, total, currency, state, transport)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (platform, external_id) DO UPDATE SET
               platform_customer_id = COALESCE(EXCLUDED.platform_customer_id, platform_orders.platform_customer_id),
               ordered_at = COALESCE(EXCLUDED.ordered_at, platform_orders.ordered_at),
               total      = COALESCE(EXCLUDED.total, platform_orders.total),
               state      = EXCLUDED.state,
               transport  = COALESCE(EXCLUDED.transport, platform_orders.transport),
               last_seen  = now()
             RETURNING (xmax = 0) AS is_new`,
            [o.platform, o.externalId, o.platformCustomerId, o.orderedAt,
             o.total, o.currency, o.state, o.transport]
          );
          if (r.rows[0]?.is_new) inserted++; else updated++;
        }
        results[name] = { ok: true, fetched: orders.length, inserted, updated, withCustomerId: withCustomer };
      } catch (e) {
        results[name] = { ok: false, error: String(e?.message || e) };
      }
    }

    return c.json({
      ok: Object.values(results).some((r) => r.ok),
      days,
      results,
      // Said plainly so nobody builds an SMS campaign on top of this table.
      note: "identity only — neither platform exposes customer name or phone to the vendor",
    });
  });

  /* ───────────────────────────────────────────────────────────────────────
     GET /api/retarget/customers — repeat rate and lifetime value per
     platform, off the captured ids. `?platform=` optionally narrows it.
  ─────────────────────────────────────────────────────────────────────── */
  app.get("/api/retarget/customers", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return err;
    await ensureSchema(pool);

    const platform = c.req.query("platform") || null;
    const where = platform ? `WHERE platform = $1` : ``;
    const params = platform ? [platform] : [];

    const summary = (await pool.query(
      `SELECT platform,
              count(*)::int                                        AS orders,
              count(platform_customer_id)::int                     AS attributed_orders,
              count(DISTINCT platform_customer_id)::int            AS customers,
              round(COALESCE(sum(total), 0)::numeric, 2)           AS revenue,
              min(ordered_at)                                      AS first_order,
              max(ordered_at)                                      AS last_order
         FROM platform_orders ${where}
        GROUP BY platform ORDER BY platform`,
      params
    )).rows;

    const top = (await pool.query(
      `SELECT platform, platform_customer_id,
              count(*)::int                              AS orders,
              round(COALESCE(sum(total), 0)::numeric, 2) AS lifetime_value,
              min(ordered_at)                            AS first_order,
              max(ordered_at)                            AS last_order
         FROM platform_orders
        WHERE platform_customer_id IS NOT NULL
          ${platform ? "AND platform = $1" : ""}
        GROUP BY platform, platform_customer_id
        ORDER BY orders DESC, lifetime_value DESC
        LIMIT 50`,
      params
    )).rows;

    // Repeat rate = share of identified customers with more than one order.
    const repeat = (await pool.query(
      `SELECT platform,
              count(*)::int                                   AS customers,
              count(*) FILTER (WHERE n > 1)::int              AS repeat_customers,
              round(AVG(n)::numeric, 2)                       AS orders_per_customer
         FROM (SELECT platform, platform_customer_id, count(*)::int AS n
                 FROM platform_orders
                WHERE platform_customer_id IS NOT NULL
                  ${platform ? "AND platform = $1" : ""}
                GROUP BY platform, platform_customer_id) t
        GROUP BY platform ORDER BY platform`,
      params
    )).rows;

    return c.json({ ok: true, summary, repeat, top });
  });
}

export default { register, fetchHungerstationOrders, fetchNinjaOrders };
