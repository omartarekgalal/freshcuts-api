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
import { PROVIDERS, activeProvider } from "./couriers.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();
/* Flying Arrow — الوثائق الإنتاجية (2026-08-17). القاعدة هي مسار التكامل
   كامل زي ما هو في الوثيقة، فالمسارات تحت بقت قصيرة ومطابقة حرفياً. */
const FA_BASE = () => env("FLYINGARROW_BASE", "https://flyingarrow-backend.com/api/v1/integration").replace(/\/+$/, "");
const FA_KEY = () => env("FLYINGARROW_API_KEY", "");
const FA_LIVE = () => Boolean(FA_KEY());

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
  // Whole riyals only: the fee enters the POS invoice as quantity × a 1-SAR
  // "رسوم التوصيل" product (TabSense rejects free-form amounts), so a
  // fractional fee literally cannot be booked.
  return { deliverable: true, fee: Math.round(fee), distanceKm: r2(dist), breakdown };
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
      -- رقمهم المقروء (ORD-2026-9AB723) وتكلفة التوصيلة الفعلية عندهم:
      -- من غير التكلفة مفيش طريقة نعرف بيها إحنا بنكسب ولا بنخسر على كل
      -- طلب توصيل، لأن اللي بنحصّله من العميل سياستنا إحنا.
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fa_order_number TEXT;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS cost NUMERIC;
      -- المزوّد بقى قابل للتبديل، فكل شحنة بتفتكر مين ودّاها: من غير ده،
      -- لو بدّلنا شركة، الشحنات القديمة هتتتبّع بالـAPI الغلط.
      -- provider_ref = مرجع الشحنة عند المزوّد (رقمهم في Flying Arrow،
      -- ورقم طلبنا في Leajlak لأن تتبعهم برقمنا).
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'flyingarrow';
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS provider_ref TEXT;
      UPDATE dl_shipments SET provider_ref = fa_order_id
        WHERE provider_ref IS NULL AND fa_order_id IS NOT NULL;
      -- نتيجة التوزيع: هل اتعيّن كابتن فعلاً ولا الطلب اتصعّد لمشرف؟
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS dispatch JSONB;
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
    // The storefront's incentives (progress bar to free delivery, min-order
    // nudge) need the thresholds, not just the verdict.
    return { ...res, policyId: pol.id, policyName: pol.name, policy: publicPolicy(cfg), ...gaps(cfg, orderTotal) };
  }
  const publicPolicy = (cfg) => ({
    baseFee: cfg.baseFee, baseKm: cfg.baseKm, perKm: cfg.perKm, maxKm: cfg.maxKm,
    freeOverTotal: cfg.freeOverTotal ?? null, minOrderTotal: cfg.minOrderTotal || 0,
  });
  const gaps = (cfg, total) => ({
    toFree: cfg.freeOverTotal != null ? Math.max(0, Math.round((cfg.freeOverTotal - (Number(total) || 0)) * 100) / 100) : null,
    toMin: Math.max(0, Math.round(((cfg.minOrderTotal || 0) - (Number(total) || 0)) * 100) / 100),
  });

  /* رقم الجوال بصيغة E.164 اللي وثيقتهم بتستخدمها (+9665XXXXXXXX). بنبعت
     أرقام محلية في كل حتة تانية، فالتحويل بيحصل هنا مرة واحدة. */
  const e164 = (v) => {
    const d = String(v || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
    return /^5\d{8}$/.test(d) ? `+966${d}` : String(v || "");
  };

  /* dispatch(order) — إنشاء طلب Flying Arrow بعد ما الكاشير يقبل.

     الجسم مطابق للوثيقة الإنتاجية حرفياً: `lat`/`lng` (مش latitude/longitude
     — دي كانت هتخلي كل إرسالة ترجع 422)، ومن غير أي حقول زيادة.

     payment_method: العميل دفع لنا أونلاين والتوصيلة ضمن الفاتورة، فالمفروض
     `wallet` (تتخصم من رصيدنا عندهم) عشان الكابتن ما يجيش يحصّل فلوس من
     المطعم أو العميل. `cash` معناها إن حد في الفرع هيدفع للكابتن نقدي كل
     طلب. القيمة قابلة للتغيير من الإعدادات، والافتراضي wallet. */
  async function dispatch(order) {
    const all = await getSettingsData();
    const settings = all.delivery || {};
    const provider = activeProvider(all);
    if (!provider.configured()) {
      throw Object.assign(
        new Error(`${provider.label}: مفاتيح ناقصة (${provider.missing().join(", ")})`),
        { code: "COURIER_UNCONFIGURED", provider: provider.id });
    }
    const cfg = {
      ...settings,
      storeLat: STORE_LAT(), storeLng: STORE_LNG(),
      webhookUrl: `${env("PUBLIC_API_URL", "https://freshcuts-api.o2m8.me")}/api/delivery/courier-webhook`,
    };
    const res = await provider.dispatch(order, cfg);

    /* نجاح الإنشاء مش معناه إن في كابتن جاي. Flying Arrow ممكن ترجّع
       dispatch_result.status = "escalated_to_supervisor" ومعاها «No eligible
       drivers are online in the zone»: الطلب اتسجّل بس محدش استلمه — ولازم
       ده يبان في اللوحة بدل ما نفتكر إن كله تمام والعميل مستني أكله. */
    const dr = (res.raw && res.raw.dispatch_result) || {};
    const assigned = Boolean(dr.driver_id) || dr.status === "dispatched" ||
      Boolean(res.driver) || res.status === "assigned";

    await pool.query(
      `INSERT INTO dl_shipments(shop_order_no, provider, provider_ref, fa_order_id, fa_order_number,
                                status, driver, cost, dispatch, events)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [order.order_no, provider.id, res.ref,
       provider.id === "flyingarrow" ? res.ref : null,
       res.orderNumber, res.status || "pending",
       res.driver ? jb(res.driver) : null, res.cost,
       jb({ status: dr.status || null, driverId: dr.driver_id ?? null, zoneId: dr.zone_id ?? null,
            message: dr.message || null, assigned }),
       jb([{ at: new Date().toISOString(), event: "created", provider: provider.id, resp: res.raw }])]
    );
    if (!assigned) {
      console.error(`[delivery] ${order.order_no}: ${provider.label} accepted the order but NO DRIVER — ${dr.status || res.status || "?"}: ${dr.message || ""}`);
    }
    return {
      provider: provider.id, faOrderId: res.ref, orderNumber: res.orderNumber,
      cost: res.cost, assigned, dispatch: dr, raw: res.raw,
    };
  }

  /* تسعيرة المركبة عندهم (١٥ ر.س أساسي + ٢ ر.س/كم + ضريبة وقت كتابة ده).
     بتتخزّن ساعة في الذاكرة — القيم دي بتتغير عندهم مش كل دقيقة، وبنحتاجها
     في كل حساب هامش. */
  let _vehCache = { at: 0, byId: {} };
  async function faVehicles() {
    if (Date.now() - _vehCache.at < 3600_000 && Object.keys(_vehCache.byId).length) return _vehCache.byId;
    const r = await fa("/service-vehicles");
    const byId = {};
    for (const v of r?.data?.service_vehicles || []) byId[String(v.id)] = v;
    _vehCache = { at: Date.now(), byId };
    return byId;
  }
  const VAT = 1.15;
  /* تكلفة التوصيلة علينا.

     مهم: القايمة العامة عندهم (GET /service-vehicles) بتقول 25 ر.س أساسي +
     2.5/كم — ودي **مش** تسعيرتنا. الاتفاق المطبّق على حسابنا 9 ر.س لأول 4
     كم + 1.8 لكل كم بعدها، واتأكدنا منه من طلب حقيقي على 4.99 كم رجع 12.40
     شامل الضريبة (9 + 0.99×1.8 = 10.78 ← ضريبة 1.62 ← 12.40). لو حسبنا
     الهامش بالقايمة العامة هنشوف خسارة وهمية في كل طلب.

     القيم قابلة للتعديل من الإعدادات لو الاتفاق اتغيّر، وبنرجع للقايمة
     بتاعتهم بس لو محدش حدّد حاجة. */
  const FA_INCLUDED_KM = () => Number(env("FA_INCLUDED_KM", "4"));
  function faCost(veh, km, contract) {
    const c = contract || {};
    const includedKm = Number(c.includedKm) || FA_INCLUDED_KM();
    const base = c.baseFee != null ? Number(c.baseFee)
      : (veh && veh.pricing && Number(veh.pricing.base_price)) || 0;
    const per = c.perKm != null ? Number(c.perKm)
      : (veh && veh.pricing && Number(veh.pricing.price_per_km)) || 0;
    const min = c.minFare != null ? Number(c.minFare)
      : (veh && veh.pricing && Number(veh.pricing.minimum_fare)) || 0;
    const extra = Math.max(0, (Number(km) || 0) - includedKm);
    return Math.max(min, base + per * extra) * VAT;
  }
  /* الاتفاق المطبّق فعلاً — الافتراضي هو اللي اتأكدنا منه بطلب حقيقي. */
  const courierContract = (settings) => ({
    baseFee: Number(settings?.contractBaseFee ?? 9),
    perKm: Number(settings?.contractPerKm ?? 1.8),
    includedKm: Number(settings?.contractIncludedKm ?? 4),
    minFare: settings?.contractMinFare != null ? Number(settings.contractMinFare) : 0,
  });

  /* تتبع الشحنة من عندهم — شبكة أمان تحت الويبهوك. الويبهوك ممكن يضيع
     (نشر، انقطاع، خطأ عندهم) والعميل ساعتها بيفضل شايف حالة قديمة. */
  async function trackShipment(sh) {
    const p = PROVIDERS[sh.provider] || PROVIDERS.flyingarrow;
    return p.track(sh);
  }

  /* إلغاء الشحنة — بيرجع رسوم الإلغاء والمبلغ المسترد. بنستخدمها لما الطلب
     يتلغي بعد ما الكابتن اتعيّن، عشان ما ندفعش توصيلة لطلب مش هيتوصل. */
  async function cancelShipment(orderNo, reason) {
    const sh = await shipmentOf(orderNo);
    if (!sh) return null;
    if (["delivered", "cancelled"].includes(String(sh.status))) return null;
    const p = PROVIDERS[sh.provider] || PROVIDERS.flyingarrow;
    if (!p.configured()) return null;
    try {
      const r = await p.cancel(sh, reason || "order cancelled by restaurant");
      await pool.query(
        `UPDATE dl_shipments SET status='cancelled', events = events || $2::jsonb, updated_at=NOW()
          WHERE id=$1`,
        [sh.id, jb([{ at: new Date().toISOString(), event: "cancel", provider: p.id, resp: r.raw,
                      fee: r.fee, refund: r.refund }])]);
      return r;
    } catch (e) {
      console.error(`[delivery] cancel failed for ${orderNo} (${p.id}):`, e.message);
      await pool.query(
        `UPDATE dl_shipments SET events = events || $2::jsonb, updated_at=NOW() WHERE id=$1`,
        [sh.id, jb([{ at: new Date().toISOString(), event: "cancel_failed", provider: p.id, error: e.message }])]);
      return null;
    }
  }

  async function shipmentOf(orderNo) {
    const r = await pool.query(
      "SELECT * FROM dl_shipments WHERE shop_order_no=$1 ORDER BY id DESC LIMIT 1", [orderNo]);
    return r.rows[0] || null;
  }

  /* ── routes ── */

  // PUBLIC — the active policy's thresholds, for the cart BEFORE a location
  // exists («التوصيل من 10 ر.س», «ضيف 22 ر.س وتوصيلك مجاني»).
  app.get("/api/delivery/policy", async (c) => {
    const pol = await activePolicy();
    if (!pol) return c.json({ ok: true, policy: null });
    const cfg = { ...DEFAULT_POLICY, ...pol.config };
    const total = Number(c.req.query("total")) || 0;
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ ok: true, policy: publicPolicy(cfg), ...gaps(cfg, total) });
  });

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

  /* ADMIN — البيانات المرجعية من عندهم مباشرة، عشان معرّف المدينة والمركبة
     يتختاروا من قائمة حقيقية بدل ما نحزر رقم ونكتشف الغلط وقت أول طلب. */
  app.get("/api/delivery/fa/reference", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const all = await getSettingsData();
    const provider = activeProvider(all);
    /* الرد دايماً 200 حتى لو الاتصال فشل: كلاودفلير بيستبدل أي 5xx بصفحة
       خطأ من عنده، فرسالة الشركة الحقيقية («المفتاح غير نشط») كانت بتضيع
       واللوحة تقول «تعذّر الاتصال» وبس. */
    const base = {
      ok: false,
      provider: provider.id, providerLabel: provider.label,
      needsRef: provider.needsRef,
      providers: Object.values(PROVIDERS).map((p) => ({
        id: p.id, label: p.label, configured: p.configured(), missing: p.missing(),
      })),
      cities: [], vehicles: [],
    };
    if (!provider.configured()) {
      return c.json({ ...base, error: "no_api_key", missing: provider.missing() });
    }
    try {
      const ref = await provider.reference();
      return c.json({ ...base, ok: true, ...ref });
    } catch (e) {
      return c.json({
        ...base, error: e.message, status: e.status || null,
        vendor: (e.resp && (e.resp.error_code || e.resp.message)) || null,
      });
    }
  });

  /* PUBLIC — Flying Arrow's webhook. Their four events (order.driver_assigned,
     order.pickup_completed, order.delivered, order.cancelled) drive both the
     shipment row and the customer-facing order stage via shop. There is no
     signature in their guide, so we match strictly on our own
     external_order_id and treat the payload as untrusted data. */
  app.post("/api/delivery/courier-webhook", async (c) => {
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false }, 400); }

    /* شكل الويبهوك بيختلف من شركة للتانية: Flying Arrow بتبعت
       external_order_id + event، و Leajlak بتبعت id + status. فبنسأل كل
       مزوّد «ده بتاعك؟» وأول واحد يفهم الرسالة هو صاحبها. بنبدأ بالفعّال
       عشان الحالة الشائعة تتحل من أول محاولة، وبنكمّل على الباقي عشان
       شحنة قديمة من شركة قديمة تفضل تتحدّث صح بعد التبديل. */
    const all = await getSettingsData();
    const active = activeProvider(all);
    const order = [active, ...Object.values(PROVIDERS).filter((x) => x.id !== active.id)];
    let ev = null, from = null;
    for (const p of order) {
      const parsed = p.parseWebhook(b);
      if (parsed && parsed.orderNo) { ev = parsed; from = p; break; }
    }
    if (!ev) return c.json({ ok: true, ignored: true });

    /* المطابقة برقمنا أولاً، وبمرجع المزوّد لو رقمنا مش في الرسالة —
       Flying Arrow بيرجّع external_order_id فاضي أحياناً. */
    const upd = await pool.query(
      `UPDATE dl_shipments SET
         status = COALESCE($2, status),
         driver = COALESCE($3, driver),
         cost = COALESCE($5, cost),
         events = events || $4::jsonb,
         updated_at = NOW()
       WHERE (($1::text IS NOT NULL AND shop_order_no = $1)
           OR ($6::text IS NOT NULL AND provider = $7 AND provider_ref = $6))
       RETURNING id, shop_order_no, status`,
      [ev.orderNo, ev.status,
       ev.driver ? jb(ev.driver) : null,
       jb([{ at: new Date().toISOString(), provider: from.id, event: ev.rawStatus, payload: b }]),
       ev.cost, ev.ref || null, from.id]
    );
    if (!upd.rowCount) return c.json({ ok: true, ignored: true }); // طلب مش عندنا
    const matchedNo = upd.rows[0].shop_order_no;
    if (ev.status) {
      const api = shop();
      if (api) {
        api.onShipmentEvent(matchedNo, ev.status, b).catch((e) =>
          console.error("[delivery] shipment event handler failed:", e.message));
      }
    }
    return c.json({ ok: true });
  });

  app.get("/api/delivery/shipments", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      "SELECT * FROM dl_shipments ORDER BY id DESC LIMIT 100")).rows;
    return c.json({ ok: true, shipments: rows });
  });

  /* شبكة أمان الويبهوك: كل دقيقتين بنسأل عن الشحنات اللي لسه في الطريق.
     الويبهوك ممكن يضيع وقت نشر أو انقطاع، والعميل ساعتها بيفضل قاعد على
     شاشة تتبع واقفة — وده أسوأ إحساس ممكن نديهوله بعد ما دفع. */
  async function pollInFlight() {
    const rows = (await pool.query(
      `SELECT id, shop_order_no, provider, provider_ref, status FROM dl_shipments
        WHERE provider_ref IS NOT NULL
          AND status NOT IN ('delivered','cancelled')
          AND updated_at < NOW() - INTERVAL '3 minutes'
          AND created_at > NOW() - INTERVAL '12 hours'
        LIMIT 20`)).rows;
    for (const r of rows) {
      const p = PROVIDERS[r.provider] || PROVIDERS.flyingarrow;
      if (!p.configured()) continue;
      let o;
      try { o = await p.track(r); } catch { continue; }
      if (!o || !o.status || o.status === r.status) {
        await pool.query("UPDATE dl_shipments SET updated_at=NOW() WHERE id=$1", [r.id]);
        continue;
      }
      await pool.query(
        `UPDATE dl_shipments SET status=$2, driver=COALESCE($3, driver), cost=COALESCE($5, cost),
                events = events || $4::jsonb, updated_at=NOW() WHERE id=$1`,
        [r.id, o.status, o.driver ? jb(o.driver) : null,
         jb([{ at: new Date().toISOString(), provider: p.id, event: "poll", status: o.status }]),
         o.cost]);
      const api = shop();
      if (api) {
        api.onShipmentEvent(r.shop_order_no, o.status, { source: "poll", order: o.raw })
          .catch((e) => console.error("[delivery] poll handler failed:", e.message));
      }
    }
  }
  const POLL_MIN = Number(env("FA_POLL_MINUTES", "2"));
  if (POLL_MIN > 0) {
    setInterval(() => pollInFlight().catch((e) => console.error("[delivery] poll failed:", e.message)),
      POLL_MIN * 60_000);
  }

  return { quote, dispatch, shipmentOf, trackShipment, cancelShipment,
           isLive: () => activeProvider({}).configured(), faCost, faVehicles, courierContract, PROVIDERS };
}
