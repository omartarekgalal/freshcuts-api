/* ═══════════════════════════════════════════════════════════════════════════
   DELIVERY — own-delivery pricing policies + the Flying Arrow courier API.

   Omar's spec (2026-08-11, asked directly):
   - Fee is distance-based: «اول (عدد) كم بسعر وكل كم زيادة بسعر» — a base
     bundle of km at a flat price, then a per-km price for every extra km.
   - Plus the discount schemes delivery apps use (free delivery over X,
     flat/percent promos), MULTIPLE policies switchable from the dashboard.
   - The customer picks a location; the quote comes from the active policy;
     the courier and its tracking come from Flying Arrow's API.

   Flying Arrow status (probed 2026-08-11): staging + demo key WORK; their
   guide has NO quote endpoint, NO cities/vehicles listing, NO driver-location
   endpoint, payment_method documents only "cash", production URL not issued.
   So: WE price the delivery (policies below), they move the parcel, and
   their webhooks (order.created → …→ order.delivered) drive our tracking.
   city_id / service_vehicle_id come from their support → settings.

   Distance: haversine × routeFactor. Straight-line understates real roads;
   the factor (default 1.3, editable per policy) is the standard correction.
   If their support later exposes a routing quote we can swap it in behind
   the same computeDeliveryFee interface.
═══════════════════════════════════════════════════════════════════════════ */

import { STORE_LAT, STORE_LNG } from "./tsstore.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();
const FA_BASE = () => env("FLYINGARROW_BASE", "https://staging.flyingarrow-backend.com/api").replace(/\/+$/, "");
const FA_KEY = () => env("FLYINGARROW_API_KEY", "demo-api-key-X5X29KXwT1XyvI1akdyKqAby1unLiNHc");

/* ── pure pricing engine (unit-tested offline in delivery.test.mjs) ─────── */

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const DEFAULT_POLICY = {
  type: "distance_tiers",
  baseKm: 3,          // «اول 3 كم»
  baseFee: 10,        // «بسعر 10 ريال»
  perKm: 2,           // «وكل كم زيادة بـ 2 ريال» (charged per started km)
  feeCap: null,       // never charge more than this (null = no cap)
  freeOverTotal: null,// order total that earns free delivery (null = never)
  minOrderTotal: 0,   // below this the quote refuses the order
  maxKm: 15,          // beyond this we don't deliver
  routeFactor: 1.3,   // haversine → road-distance correction
  discount: { mode: "none", value: 0, label: "" }, // none|flat|percent on the FEE
};

/* computeDeliveryFee(config, {distanceKm, orderTotal}) → one of:
   {deliverable:false, reason}  — out of range / under minimum
   {deliverable:true, fee, distanceKm, breakdown[]} — fee in SAR, rounded to
   2dp, never negative; breakdown lines are Arabic strings the storefront can
   show so the customer sees WHY the fee is what it is. */
export function computeDeliveryFee(cfgIn, { distanceKm, orderTotal }) {
  const cfg = { ...DEFAULT_POLICY, ...(cfgIn || {}) };
  const dist = Number(distanceKm) || 0;
  const total = Number(orderTotal) || 0;
  const breakdown = [];

  if (cfg.maxKm != null && dist > cfg.maxKm) {
    return { deliverable: false, reason: "out_of_range", maxKm: cfg.maxKm, distanceKm: r2(dist) };
  }
  if (total < (cfg.minOrderTotal || 0)) {
    return { deliverable: false, reason: "under_minimum", minOrderTotal: cfg.minOrderTotal, distanceKm: r2(dist) };
  }

  let fee = Number(cfg.baseFee) || 0;
  breakdown.push(`أول ${cfg.baseKm} كم: ${r2(fee)} ر.س`);
  const extraKm = Math.max(0, Math.ceil(dist - cfg.baseKm)); // per STARTED km
  if (extraKm > 0) {
    const extra = extraKm * (Number(cfg.perKm) || 0);
    fee += extra;
    breakdown.push(`${extraKm} كم إضافي × ${cfg.perKm} = ${r2(extra)} ر.س`);
  }
  if (cfg.feeCap != null && fee > cfg.feeCap) {
    fee = Number(cfg.feeCap);
    breakdown.push(`حد أقصى للتوصيل: ${r2(fee)} ر.س`);
  }
  const d = cfg.discount || {};
  if (d.mode === "flat" && d.value > 0) {
    fee = Math.max(0, fee - Number(d.value));
    breakdown.push(`${d.label || "خصم"}: -${r2(d.value)} ر.س`);
  } else if (d.mode === "percent" && d.value > 0) {
    const cut = fee * Math.min(100, Number(d.value)) / 100;
    fee = Math.max(0, fee - cut);
    breakdown.push(`${d.label || "خصم"} ${d.value}%: -${r2(cut)} ر.س`);
  }
  if (cfg.freeOverTotal != null && total >= cfg.freeOverTotal) {
    fee = 0;
    breakdown.push(`توصيل مجاني للطلبات فوق ${r2(cfg.freeOverTotal)} ر.س`);
  }
  return { deliverable: true, fee: r2(fee), distanceKm: r2(dist), breakdown };
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/* ── Flying Arrow client ────────────────────────────────────────────────── */

async function fa(path, { method = "GET", body } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  let resp;
  try {
    resp = await fetch(`${FA_BASE()}${path}`, {
      method,
      headers: {
        "X-API-Key": FA_KEY(),
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } finally { clearTimeout(t); }
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
  if (!resp.ok) {
    throw Object.assign(new Error(`FlyingArrow ${path}: ${data.message || resp.status}`),
      { code: "FA_ERROR", status: resp.status, resp: data });
  }
  return data;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;
  const shop = deps.shop || (() => null);   // late-bound: shipment status → order status

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dl_policies (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        priority INT NOT NULL DEFAULT 0,
        config JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS dl_shipments (
        id BIGSERIAL PRIMARY KEY,
        shop_order_no TEXT NOT NULL,
        fa_order_id TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        driver JSONB,
        events JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS dl_shipments_order_idx ON dl_shipments(shop_order_no);
      CREATE INDEX IF NOT EXISTS dl_shipments_fa_idx ON dl_shipments(fa_order_id);
    `);
    // Seed one sensible policy so the quote endpoint works before Omar edits
    // anything — inactive until he flips it on from the dashboard.
    const n = await pool.query("SELECT count(*)::int AS n FROM dl_policies");
    if (!n.rows[0].n) {
      await pool.query(
        "INSERT INTO dl_policies(name, active, priority, config) VALUES ($1,$2,$3,$4)",
        ["السياسة الأساسية", true, 0, jb(DEFAULT_POLICY)]
      );
    }
  }
  ensureSchema()
    .then(() => console.log("[delivery] schema ready"))
    .catch((e) => console.error("[delivery] schema failed:", e.message));

  async function activePolicy() {
    const r = await pool.query(
      "SELECT id, name, config FROM dl_policies WHERE active ORDER BY priority DESC, id LIMIT 1");
    return r.rows[0] || null;
  }

  /* quote({lat, lng, orderTotal}) — the ONE entry point storefront + shop.js
     both use, so the customer can never be quoted one fee and charged
     another. */
  async function quote({ lat, lng, orderTotal }) {
    const pol = await activePolicy();
    if (!pol) return { deliverable: false, reason: "no_policy" };
    const cfg = { ...DEFAULT_POLICY, ...pol.config };
    const straight = haversineKm(STORE_LAT(), STORE_LNG(), Number(lat), Number(lng));
    const res = computeDeliveryFee(cfg, { distanceKm: straight * (cfg.routeFactor || 1), orderTotal });
    return { ...res, policyId: pol.id, policyName: pol.name };
  }

  /* dispatch(order) — create the Flying Arrow order once the cashier accepts.
     city_id / service_vehicle_id come from settings.delivery (their support
     supplies the values). payment_method is "cash" per their docs — for a
     PREPAID order the driver collects nothing; their support confirms the
     right value (open question, tracked in the task list). */
  async function dispatch(order) {
    const settings = (await getSettingsData()).delivery || {};
    const addr = order.address || {};
    const faBody = {
      service_vehicle_id: Number(settings.faVehicleId || 1),
      city_id: Number(settings.faCityId || 1),
      quantity: 1,
      payment_method: settings.faPaymentMethod || "cash",
      external_order_id: order.order_no,
      webhook_url: `${env("PUBLIC_API_URL", "https://freshcuts-api.o2m8.me")}/api/delivery/courier-webhook`,
      locations: [
        {
          type: "pickup", sequence: 1,
          address: settings.pickupAddress || "Fresh Cuts, Jeddah",
          latitude: STORE_LAT(),
          longitude: STORE_LNG(),
          contact_name: settings.pickupContactName || "Fresh Cuts",
          contact_phone: settings.pickupContactPhone || "",
        },
        {
          type: "dropoff", sequence: 2,
          address: addr.street || addr.area || "Delivery",
          latitude: Number(addr.latitude), longitude: Number(addr.longitude),
          contact_name: order.customer?.name || "",
          contact_phone: order.customer?.phone || "",
        },
      ],
    };
    const created = await fa("/v1/integration/orders", { method: "POST", body: faBody });
    const faId = created?.data?.id ?? created?.id ?? created?.order_id ?? null;
    await pool.query(
      `INSERT INTO dl_shipments(shop_order_no, fa_order_id, status, events)
       VALUES ($1,$2,'created', $3)`,
      [order.order_no, faId != null ? String(faId) : null, jb([{ at: new Date().toISOString(), event: "created", resp: created }])]
    );
    return { faOrderId: faId, raw: created };
  }

  async function shipmentOf(orderNo) {
    const r = await pool.query(
      "SELECT * FROM dl_shipments WHERE shop_order_no=$1 ORDER BY id DESC LIMIT 1", [orderNo]);
    return r.rows[0] || null;
  }

  /* ── routes ── */

  // PUBLIC — the storefront asks for a fee as the customer moves the map pin.
  app.get("/api/delivery/quote", async (c) => {
    const lat = Number(c.req.query("lat")), lng = Number(c.req.query("lng"));
    const total = Number(c.req.query("total")) || 0;
    if (!isFinite(lat) || !isFinite(lng) || !lat || !lng) {
      return c.json({ ok: false, error: "lat/lng required" }, 400);
    }
    return c.json({ ok: true, ...(await quote({ lat, lng, orderTotal: total })) });
  });

  // Admin CRUD for policies — the dashboard's pricing editor.
  app.get("/api/delivery/policies", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query("SELECT * FROM dl_policies ORDER BY priority DESC, id")).rows;
    return c.json({ ok: true, defaults: DEFAULT_POLICY, policies: rows });
  });
  app.post("/api/delivery/policies", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json();
    const r = await pool.query(
      `INSERT INTO dl_policies(name, active, priority, config) VALUES ($1,$2,$3,$4) RETURNING *`,
      [String(b.name || "سياسة جديدة"), Boolean(b.active), Number(b.priority) || 0, jb({ ...DEFAULT_POLICY, ...(b.config || {}) })]
    );
    return c.json({ ok: true, policy: r.rows[0] });
  });
  app.put("/api/delivery/policies/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json();
    const r = await pool.query(
      `UPDATE dl_policies SET
         name = COALESCE($2, name),
         active = COALESCE($3, active),
         priority = COALESCE($4, priority),
         config = COALESCE($5, config),
         updated_at = NOW()
       WHERE id=$1 RETURNING *`,
      [Number(c.req.param("id")),
       b.name != null ? String(b.name) : null,
       typeof b.active === "boolean" ? b.active : null,
       b.priority != null ? Number(b.priority) : null,
       b.config ? jb({ ...DEFAULT_POLICY, ...b.config }) : null]
    );
    if (!r.rowCount) return c.json({ ok: false, error: "not found" }, 404);
    return c.json({ ok: true, policy: r.rows[0] });
  });
  app.delete("/api/delivery/policies/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM dl_policies WHERE id=$1", [Number(c.req.param("id"))]);
    return c.json({ ok: true });
  });

  /* PUBLIC — Flying Arrow's webhook. Their six events (order.created,
     order.confirmed, order.driver_assigned, order.pickup_completed,
     order.delivered, order.cancelled) drive both the shipment row and the
     customer-facing order stage via shop. There is no signature in their
     guide, so we match strictly on our own external_order_id and treat the
     payload as untrusted data. */
  app.post("/api/delivery/courier-webhook", async (c) => {
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false }, 400); }
    const orderNo = b.external_order_id || null;
    const event = String(b.event || b.status || "");
    if (!orderNo || !event) return c.json({ ok: true, ignored: true });
    const upd = await pool.query(
      `UPDATE dl_shipments SET
         status = $2,
         driver = COALESCE($3, driver),
         events = events || $4::jsonb,
         updated_at = NOW()
       WHERE shop_order_no = $1
       RETURNING id`,
      [String(orderNo), event.replace(/^order\./, ""),
       b.driver ? jb(b.driver) : null,
       jb([{ at: new Date().toISOString(), event, payload: b }])]
    );
    if (!upd.rowCount) return c.json({ ok: true, ignored: true }); // unknown order — do nothing
    const api = shop();
    if (api) {
      api.onShipmentEvent(String(orderNo), event.replace(/^order\./, ""), b).catch((e) =>
        console.error("[delivery] shipment event handler failed:", e.message));
    }
    return c.json({ ok: true });
  });

  app.get("/api/delivery/shipments", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      "SELECT * FROM dl_shipments ORDER BY id DESC LIMIT 100")).rows;
    return c.json({ ok: true, shipments: rows });
  });

  return { quote, dispatch, shipmentOf };
}
