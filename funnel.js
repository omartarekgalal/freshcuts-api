/* ═══════════════════════════════════════════════════════════════════════════
   FUNNEL — web pixel + Conversions-API bridge for the online storefront
   (order.o2m8.me) and any landing page.

   The browser fires the platform pixels client-side AND posts the same event
   here; we forward it server-side (Meta CAPI / TikTok Events API / Snap CAPI)
   carrying the click ids, IP and user-agent the pixels alone often lose to
   ad-blockers and iOS. Same event_id on both legs → the platform de-dupes.
   This is what "تحسين البيكسل" actually means in practice: match quality.

   PUBLIC routes (no auth — they are called by customers' browsers):
     GET  /api/funnel/config   → pixel ids only (they are public by nature;
                                 anyone can read them out of any website)
     POST /api/funnel/event    → one event; rate-limited per IP

   ADMIN routes:
     GET  /api/funnel/stats    → funnel counts (views→carts→checkouts→orders)

   PURCHASE DEDUP ACROSS PIPELINES. The storefront's Purchase carries the
   TabSense order id. We claim (order_id, platform, 'Purchase') in ads_events —
   the same unique key ads.js uses for the POS offline sync — so the same order
   can never be reported to the same platform twice, no matter which pipeline
   gets there first.

   PRIVACY. Phone/email are hashed before any payload leaves this process;
   raw identifiers are stored only as phone_norm (same policy as the rest of
   the API). Click ids and UTMs are not secrets.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { hashEmail, hashPhoneDigits, hashPhonePlus, phoneDigits, httpJson } from "./ads.js";

const env = (k) => (process.env[k] || "").trim();
const META_VER = () => env("META_API_VERSION") || "v25.0";

// Web pixels can differ from the offline event sets; fall back to the same id.
const metaPixel = () => env("META_WEB_PIXEL_ID") || env("META_PIXEL_ID");
const ttPixel = () => env("TIKTOK_WEB_PIXEL_ID") || env("TIKTOK_PIXEL_ID");
const snapPixel = () => env("SNAP_WEB_PIXEL_ID") || env("SNAP_PIXEL_ID");

const EVENT_NAMES = new Set([
  "PageView", "ViewContent", "AddToCart", "InitiateCheckout", "Purchase", "Lead", "Contact",
]);
// Meta name → TikTok / Snap vocabulary.
const TT_NAME = { PageView: "Pageview", ViewContent: "ViewContent", AddToCart: "AddToCart",
  InitiateCheckout: "InitiateCheckout", Purchase: "CompletePayment", Lead: "SubmitForm", Contact: "Contact" };
const SNAP_NAME = { PageView: "PAGE_VIEW", ViewContent: "VIEW_CONTENT", AddToCart: "ADD_CART",
  InitiateCheckout: "START_CHECKOUT", Purchase: "PURCHASE", Lead: "SIGN_UP", Contact: "CUSTOM_EVENT_1" };

/* ── naive per-IP rate limit: 240 events/hour is far above real browsing ── */
const rl = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const slot = rl.get(ip);
  if (!slot || now - slot.start > 3600_000) { rl.set(ip, { start: now, n: 1 }); return false; }
  slot.n++;
  if (rl.size > 5000) rl.clear();           // memory guard, resets everyone
  return slot.n > 240;
}

export function register(app, ctx) {
  const { pool, requireAdmin, jb, normPhone } = ctx;

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS funnel_events (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        event_id TEXT,
        order_id TEXT,
        value NUMERIC,
        currency TEXT DEFAULT 'SAR',
        url TEXT,
        referrer TEXT,
        utm JSONB,
        click_ids JSONB,
        phone_norm TEXT,
        ip TEXT,
        ua TEXT,
        results JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS funnel_events_time_idx ON funnel_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS funnel_events_name_idx ON funnel_events(event_name, created_at DESC);
    `);
  }
  ensureSchema()
    .then(() => console.log("[funnel] schema ready"))
    .catch((e) => console.error("[funnel] schema failed:", e.message));

  /* ── platform forwards (web-flavoured payloads) ───────────────────────── */

  function metaCall(e) {
    const pixel = metaPixel(), token = env("META_CAPI_TOKEN");
    if (!pixel || !token) return null;
    const user_data = {
      client_ip_address: e.ip || undefined,
      client_user_agent: e.ua || undefined,
    };
    if (e.click.fbp) user_data.fbp = e.click.fbp;
    if (e.click.fbc) user_data.fbc = e.click.fbc;
    const ph = e.digits ? hashPhoneDigits(e.digits) : null;
    const em = hashEmail(e.email);
    if (ph) user_data.ph = [ph];
    if (em) user_data.em = [em];
    const body = {
      data: [{
        event_name: e.name,
        event_time: e.time,
        event_id: e.eventId,
        action_source: "website",
        event_source_url: e.url || undefined,
        user_data,
        custom_data: {
          currency: e.currency, value: e.value,
          ...(e.orderId ? { order_id: e.orderId } : {}),
        },
      }],
      access_token: token,
    };
    if (env("META_TEST_EVENT_CODE")) body.test_event_code = env("META_TEST_EVENT_CODE");
    return { url: `https://graph.facebook.com/${META_VER()}/${pixel}/events`, body, headers: { "Content-Type": "application/json" } };
  }

  function tiktokCall(e) {
    const pixel = ttPixel(), token = env("TIKTOK_ACCESS_TOKEN");
    if (!pixel || !token) return null;
    const user = {
      ip: e.ip || undefined,
      user_agent: e.ua || undefined,
    };
    if (e.click.ttclid) user.ttclid = e.click.ttclid;
    if (e.click.ttp) user.ttp = e.click.ttp;
    const ph = e.digits ? hashPhonePlus(e.digits) : null;
    const em = hashEmail(e.email);
    if (ph) user.phone = ph;
    if (em) user.email = em;
    return {
      url: "https://business-api.tiktok.com/open_api/v1.3/event/track/",
      headers: { "Content-Type": "application/json", "Access-Token": token },
      body: {
        event_source: "web",
        event_source_id: pixel,
        data: [{
          event: TT_NAME[e.name] || e.name,
          event_time: e.time,
          event_id: e.eventId,
          user,
          page: { url: e.url || undefined, referrer: e.referrer || undefined },
          properties: {
            currency: e.currency, value: e.value, content_type: "product",
            ...(e.orderId ? { order_id: e.orderId } : {}),
          },
        }],
      },
    };
  }

  function snapCall(e) {
    const pixel = snapPixel(), token = env("SNAP_ACCESS_TOKEN");
    if (!pixel || !token) return null;
    const user_data = {
      client_ip_address: e.ip || undefined,
      client_user_agent: e.ua || undefined,
    };
    if (e.click.scid) user_data.sc_click_id = e.click.scid;
    const ph = e.digits ? hashPhoneDigits(e.digits) : null;
    const em = hashEmail(e.email);
    if (ph) user_data.ph = [ph];
    if (em) user_data.em = [em];
    return {
      url: `https://tr.snapchat.com/v3/${pixel}/events?access_token=${token}`,
      headers: { "Content-Type": "application/json" },
      body: {
        data: [{
          event_name: SNAP_NAME[e.name] || e.name,
          event_time: e.time,
          event_id: e.eventId,
          action_source: "WEB",
          event_source_url: e.url || undefined,
          user_data,
          custom_data: {
            currency: e.currency, value: String(e.value),
            ...(e.orderId ? { order_id: e.orderId } : {}),
          },
        }],
      },
    };
  }

  const FORWARDS = [
    { id: "meta", build: metaCall, okOf: (r) => r.ok && typeof r.json?.events_received === "number" },
    { id: "tiktok", build: tiktokCall, okOf: (r) => r.ok && r.json?.code === 0 },
    { id: "snapchat", build: snapCall, okOf: (r) => r.ok && (!r.json || r.json.status === "VALID" || r.json.status === "SUCCESS") },
  ];

  // Claim the (order, platform, Purchase) slot shared with ads.js's offline sync.
  async function claimPurchase(orderId, platform, e) {
    const r = await pool.query(
      `INSERT INTO ads_events (id, order_id, event_name, event_time, value, currency, platform, status, request, attempts)
       VALUES ($1,$2,'Purchase',to_timestamp($3),$4,$5,$6,'pending',$7,1)
       ON CONFLICT (order_id, platform, event_name) DO NOTHING
       RETURNING id`,
      [`${platform}:Purchase:${orderId}`, String(orderId), e.time, e.value, e.currency, platform,
       jb({ source: "funnel", eventId: e.eventId })]);
    return r.rowCount > 0 ? r.rows[0].id : null;
  }
  async function finishPurchase(rowId, ok, response) {
    if (!rowId) return;
    await pool.query(`UPDATE ads_events SET status=$2, response=$3 WHERE id=$1`,
      [rowId, ok ? "sent" : "failed", jb(response)]).catch(() => {});
  }

  /* ═══ ROUTES ═══════════════════════════════════════════════════════════ */

  /* Pixel ids for the storefront loader. Public by design — pixel ids are
     visible in the HTML of every site that uses them. Tokens NEVER here. */
  app.get("/api/funnel/config", (c) => {
    return c.json({
      ok: true,
      meta: metaPixel() || null,
      tiktok: ttPixel() || null,
      snapchat: snapPixel() || null,
      // Google Ads gtag: the conversion id loads the tag, the label routes the
      // WhatsApp-click conversion. Both are public page values, like a pixel id.
      google: env("GOOGLE_ADS_CONVERSION_ID") || null,
      googleLabel: env("GOOGLE_ADS_CONVERSION_LABEL") || null,
    });
  });

  app.post("/api/funnel/event", async (c) => {
    const ip = (c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "").split(",")[0].trim();
    if (rateLimited(ip || "unknown")) return c.json({ ok: false, error: "rate limited" }, 429);

    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }
    const name = String(b.eventName || "");
    if (!EVENT_NAMES.has(name)) return c.json({ ok: false, error: "unknown eventName" }, 400);

    const value = Math.round((Number(b.value) || 0) * 100) / 100;
    if (value < 0 || value > 100000) return c.json({ ok: false, error: "value out of range" }, 400);
    const orderId = b.orderId ? String(b.orderId).slice(0, 64) : null;
    const eventId = String(b.eventId || orderId || crypto.randomUUID()).slice(0, 64);
    const url = String(b.url || "").slice(0, 500);
    const clicks = b.clickIds && typeof b.clickIds === "object" ? b.clickIds : {};
    const utm = b.utm && typeof b.utm === "object" ? b.utm : {};
    const pnLocal = b.phone ? normPhone(b.phone) : "";
    const digits = pnLocal ? phoneDigits(pnLocal, normPhone) : null;

    const e = {
      name, eventId, orderId, value,
      currency: String(b.currency || "SAR").slice(0, 3).toUpperCase(),
      time: Math.floor(Date.now() / 1000),
      url, referrer: String(b.referrer || "").slice(0, 500),
      ip: ip || null,
      ua: String(c.req.header("user-agent") || "").slice(0, 400),
      digits, email: b.email ? String(b.email).slice(0, 200) : null,
      click: {
        fbp: String(clicks.fbp || "").slice(0, 200) || null,
        fbc: String(clicks.fbc || "").slice(0, 300) || null,
        ttclid: String(clicks.ttclid || "").slice(0, 300) || null,
        ttp: String(clicks.ttp || "").slice(0, 200) || null,
        scid: String(clicks.scid || "").slice(0, 300) || null,
      },
    };

    const results = {};
    for (const f of FORWARDS) {
      const call = f.build(e);
      if (!call) { results[f.id] = { skipped: "not configured" }; continue; }
      // Purchases go through the cross-pipeline dedup claim.
      let rowId = null;
      if (name === "Purchase" && orderId) {
        try { rowId = await claimPurchase(orderId, f.id, e); }
        catch (err) { results[f.id] = { error: `claim: ${err.message}` }; continue; }
        if (!rowId) { results[f.id] = { skipped: "already reported for this order" }; continue; }
      }
      try {
        const res = await httpJson(call.url, { method: "POST", headers: call.headers, body: call.body, timeout: 10000 });
        const ok = f.okOf(res);
        results[f.id] = ok ? { sent: true } : { error: res.json?.error?.message || res.json?.message || res.error || `HTTP ${res.status}` };
        await finishPurchase(rowId, ok, { via: "funnel", httpStatus: res.status });
      } catch (err) {
        results[f.id] = { error: String(err.message || err) };
        await finishPurchase(rowId, false, { via: "funnel", error: String(err.message || err) });
      }
    }

    await pool.query(
      `INSERT INTO funnel_events (id, event_name, event_id, order_id, value, currency, url, referrer, utm, click_ids, phone_norm, ip, ua, results)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [crypto.randomUUID(), name, eventId, orderId, value, e.currency, url, e.referrer,
       jb(utm), jb(e.click), pnLocal || null, e.ip, e.ua, jb(results)]).catch((err) => {
        console.error("[funnel] store failed:", err.message);
      });

    return c.json({ ok: true, results });
  });

  /* Funnel numbers for the dashboard. */
  app.get("/api/funnel/stats", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(Number(c.req.query("days") || 7), 90);
    const r = await pool.query(
      `SELECT event_name, count(*)::int AS n, COALESCE(sum(value) FILTER (WHERE event_name='Purchase'),0) AS purchase_value,
              count(DISTINCT ip)::int AS uniques
         FROM funnel_events
        WHERE created_at > NOW() - ($1 || ' days')::interval
        GROUP BY event_name`, [String(days)]);
    const bySrc = await pool.query(
      `SELECT COALESCE(NULLIF(utm->>'utm_source',''),'(مباشر)') AS source,
              count(*) FILTER (WHERE event_name='PageView')::int AS views,
              count(*) FILTER (WHERE event_name='Purchase')::int AS purchases,
              COALESCE(sum(value) FILTER (WHERE event_name='Purchase'),0) AS revenue
         FROM funnel_events
        WHERE created_at > NOW() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY views DESC LIMIT 15`, [String(days)]);
    return c.json({ ok: true, days, events: r.rows, sources: bySrc.rows });
  });

  console.log(`[funnel] routes ready (pixels: meta=${metaPixel() ? "set" : "—"} tiktok=${ttPixel() ? "set" : "—"} snap=${snapPixel() ? "set" : "—"})`);
}
