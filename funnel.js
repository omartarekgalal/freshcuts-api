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

   PURCHASE من السيرفر (W0-02، 16 سبتمبر). funnel_events كان فيه ٣٧ Purchase
   قصاد أقل من ٥ طلبات حقيقية مدفوعة. الأسباب من الكود:
     ١) track.html بيطلق Purchase مع كل تحميل فيه ?new=1/?paid=1 — كل ريفريش
        أو رجوع للصفحة = صف جديد (والقيمة من fc_last_value، ساعات صفر).
     ٢) نفس الطلب بيتطلق مرتين من المتصفح: مرة من app.js لحظة الدفع ومرة من
        صفحة التتبع — والـroute كان بيدخّل صف لكل واحدة من غير أي فحص.
     ٣) طلبات الاختبار (أرقام الموظفين) بتتحسب زي أي طلب.
     ٤) ads.loadOrders كان بيحجز الطلب كـphysical_store قبل ما المتصفح يوصل،
        فالـPurchase بتاع الويب ماكانش بيوصل المنصة كـwebsite أبداً.
   الإصلاح هنا: serverPurchase({orderNo}) بيبني الحدث من shop_orders نفسه
   (الإجمالي الحقيقي + المنتجات بمعرّفات الكتالوج + fbc/fbp/ip/ua من
   attribution) وبيحجز بـrequest.source='website'، و/api/funnel/event بيرجّع
   {duplicate:true} لأي Purchase لنفس الطلب خلال ٢٤ ساعة من غير ما يدخّل صف،
   وads.loadOrders بيستنى ٦ ساعات قبل ما يلمس طلب موقع.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { hashEmail, hashPhoneDigits, hashPhonePlus, phoneDigits, httpJson } from "./ads.js";
import { MULTIPLY } from "./tsstore.js";

const env = (k) => (process.env[k] || "").trim();
const META_VER = () => env("META_API_VERSION") || "v25.0";

// Web pixels can differ from the offline event sets; fall back to the same id.
const metaPixel = () => env("META_WEB_PIXEL_ID") || env("META_PIXEL_ID");
const ttPixel = () => env("TIKTOK_WEB_PIXEL_ID") || env("TIKTOK_PIXEL_ID");
const snapPixel = () => env("SNAP_WEB_PIXEL_ID") || env("SNAP_PIXEL_ID");

const EVENT_NAMES = new Set([
  "PageView", "ViewContent", "AddToCart", "InitiateCheckout", "Purchase", "Lead", "Contact",
  // أضيفت 2026-08-13 لفلو الدفع الأونلاين: فتح شاشة الدفع + إنشاء حساب —
  // الاتنين إشارات تحسين قوية لخوارزميات المنصات.
  "AddPaymentInfo", "CompleteRegistration",
]);
// Meta name → TikTok / Snap vocabulary.
const TT_NAME = { PageView: "Pageview", ViewContent: "ViewContent", AddToCart: "AddToCart",
  InitiateCheckout: "InitiateCheckout", Purchase: "CompletePayment", Lead: "SubmitForm", Contact: "Contact",
  AddPaymentInfo: "AddPaymentInfo", CompleteRegistration: "CompleteRegistration" };
const SNAP_NAME = { PageView: "PAGE_VIEW", ViewContent: "VIEW_CONTENT", AddToCart: "ADD_CART",
  InitiateCheckout: "START_CHECKOUT", Purchase: "PURCHASE", Lead: "SIGN_UP", Contact: "CUSTOM_EVENT_1",
  AddPaymentInfo: "ADD_BILLING", CompleteRegistration: "SIGN_UP" };

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

/* ── server-side Purchase helpers (pure — مفيش DB ولا شبكة، عشان الاختبارات) ── */

// Purchase لنفس الطلب خلال المدة دي = تكرار (ريفريش صفحة التتبع، أو المتصفح
// بعد السيرفر). بعدها بيتعامل كحدث جديد — عمر ما طلب واحد يتدفع مرتين في يوم.
export const PURCHASE_DEDUP_HOURS = 24;

// حالات مالهاش شراء حقيقي: لسه مادفعش، انتهى، أو اترفض واترجّعت فلوسه.
const NO_PURCHASE_STATUS = /pending_payment|expired|refund|reject|cancel/;
const VAT = 0.15;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** shop_orders.items → contents بمعرّفات الكتالوج.
 *  المتجر بيبعت product_id بتاع تاب سينس — هو نفسه الـid اللي فيد الكتالوج
 *  بينشره — فمش محتاجين نطابق بالاسم إلا لسطر ناقصه product_id (match اختياري،
 *  ads.matchToCatalog). سعر السطر: unit_amount صافي × MULTIPLY، فبنرجّعه ريال
 *  شامل الضريبة وبعد خصم الطلب (الباقات سعرها محسوب أصلاً فمابتتخصمش). السطور
 *  المتكررة لنفس المنتج (الباقة بتتفرد لأكتر من سطر) بتتجمع في سطر واحد. */
export async function purchaseContentsOf(items, discountPercent = 0, match = null) {
  const pct = Math.max(0, Math.min(100, Number(discountPercent) || 0));
  const byId = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== "object") continue;
    let id = it.product_id != null && it.product_id !== "" ? String(it.product_id) : null;
    if (!id && match && it.name) {
      const hit = await Promise.resolve(match(it.name)).catch(() => null);
      if (hit && hit !== "__fee__") id = String(hit);
    }
    if (!id) continue;
    const quantity = Math.max(1, Math.round(Number(it.quantity) || 1));
    const net = (Number(it.unit_amount) || 0) / MULTIPLY;
    const gross = net * (1 + VAT) * (pct > 0 && !it.bundle ? 1 - pct / 100 : 1);
    const cur = byId.get(id);
    if (cur) {
      // متوسط مرجّح عشان quantity × item_price يفضل مساوي لمجموع السطور
      const total = cur.itemPrice * cur.quantity + gross * quantity;
      cur.quantity += quantity;
      cur.itemPrice = r2(total / cur.quantity);
    } else {
      byId.set(id, { id: id.slice(0, 64), name: it.name ? String(it.name).slice(0, 120) : null, quantity, itemPrice: r2(gross) });
    }
  }
  return [...byId.values()].slice(0, 50);
}

/** صف shop_orders (+ contents جاهزة) → الحدث بنفس شكل /api/funnel/event.
 *  event_id = pos_order_id — نفس المفتاح اللي المتصفح وads.js بيستعملوه،
 *  فالمنصة بتشيل التكرار بين البكسل والسيرفر. */
export function serverPurchaseEvent(order, { contents = [], digits = null, now = Date.now(), baseUrl = "" } = {}) {
  const a = order?.attribution && typeof order.attribution === "object" ? order.attribution : {};
  const click = a.click && typeof a.click === "object" ? a.click : {};
  const s = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));
  const posId = String(order.pos_order_id);
  return {
    name: "Purchase",
    eventId: posId,
    orderId: posId,
    value: r2(order.total),
    contents,
    numItems: contents.reduce((acc, i) => acc + i.quantity, 0),
    currency: "SAR",
    time: Math.floor(now / 1000),
    url: baseUrl ? `${baseUrl}/track/${encodeURIComponent(order.order_no)}` : "",
    referrer: "",
    ip: s(a.ip, 64),
    ua: s(a.ua, 400) || "",
    digits,
    email: null,
    utm: a.utm && typeof a.utm === "object" ? a.utm : {},
    click: {
      fbp: s(click.fbp, 200), fbc: s(click.fbc, 300),
      ttclid: s(click.ttclid, 300), ttp: s(click.ttp, 200),
      // سناب بيسمّيه ScCid في الرابط وscid في pixels.js
      scid: s(click.scid ?? click.ScCid, 300),
      gclid: s(click.gclid, 300), gbraid: s(click.gbraid, 300), wbraid: s(click.wbraid, 300),
    },
  };
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, jb, normPhone } = ctx;
  const attribution = deps.attribution || null;   // attribution.register() return value
  // الاختبارات بتحقن http بدل الشبكة؛ الإنتاج بيستعمل httpJson بتاع ads.js.
  const http = deps.httpJson || httpJson;
  // ads.matchToCatalog اختياري (late-bound زي باقي الموديولات) — للسطور اللي
  // ناقصها product_id بس.
  const adsOf = typeof deps.ads === "function" ? deps.ads : () => deps.ads || null;

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
      -- what was in the basket. Added 2026-08-09: without it the web events
      -- carried no product ids at all, so the catalog could not retarget a
      -- browser that had already looked at a specific dish.
      ALTER TABLE funnel_events ADD COLUMN IF NOT EXISTS contents JSONB;

      -- Clicks on /go/keeta | /go/hungerstation | /go/ninja. These leave our
      -- site for a delivery app we cannot instrument, so the click is the last
      -- thing we will ever see of that customer. Kept here — NOT pushed to any
      -- ad platform — because the platform has no way to close the loop on it
      -- and a fabricated conversion is worse than no conversion.
      CREATE TABLE IF NOT EXISTS go_clicks (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        utm JSONB,
        referrer TEXT,
        ip TEXT,
        ua TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS go_clicks_time_idx ON go_clicks(target, created_at DESC);
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
          // A ViewContent/AddToCart without content_ids is invisible to the
          // product catalog: Meta cannot retarget "the dish he looked at",
          // only "someone who visited". The ids are the catalog's own ids.
          ...(e.contents.length ? {
            content_type: "product",
            content_ids: e.contents.map((i) => i.id),
            contents: e.contents.map((i) => ({ id: i.id, quantity: i.quantity, item_price: i.itemPrice })),
            num_items: e.numItems,
          } : {}),
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
            ...(e.contents.length ? {
              contents: e.contents.map((i) => ({
                content_id: i.id, content_name: i.name || undefined,
                quantity: i.quantity, price: i.itemPrice,
              })),
            } : {}),
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
            ...(e.contents.length ? {
              content_ids: e.contents.map((i) => i.id),
              number_items: String(e.numItems),
            } : {}),
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
  // source: 'website' لطلب موجود في shop_orders (المتجر)، و'funnel' لأي حاجة تانية.
  async function claimPurchase(orderId, platform, e, source = "funnel") {
    const r = await pool.query(
      `INSERT INTO ads_events (id, order_id, event_name, event_time, value, currency, platform, status, request, attempts)
       VALUES ($1,$2,'Purchase',to_timestamp($3),$4,$5,$6,'pending',$7,1)
       ON CONFLICT (order_id, platform, event_name) DO NOTHING
       RETURNING id`,
      [`${platform}:Purchase:${orderId}`, String(orderId), e.time, e.value, e.currency, platform,
       jb({ source, eventId: e.eventId })]);
    return r.rowCount > 0 ? r.rows[0].id : null;
  }
  async function finishPurchase(rowId, ok, response) {
    if (!rowId) return;
    await pool.query(`UPDATE ads_events SET status=$2, response=$3 WHERE id=$1`,
      [rowId, ok ? "sent" : "failed", jb(response)]).catch(() => {});
  }

  /* يبعت الحدث للمنصات المضبوطة. الـPurchase بيعدّي على الحجز المشترك الأول —
     لو claimPurchase رجّع null (الطلب اتبعت قبل كده للمنصة دي) مفيش HTTP خالص. */
  async function forwardAll(e, { claimSource = "funnel" } = {}) {
    const results = {};
    for (const f of FORWARDS) {
      const call = f.build(e);
      if (!call) { results[f.id] = { skipped: "not configured" }; continue; }
      let rowId = null;
      if (e.name === "Purchase" && e.orderId) {
        try { rowId = await claimPurchase(e.orderId, f.id, e, claimSource); }
        catch (err) { results[f.id] = { error: `claim: ${err.message}` }; continue; }
        if (!rowId) { results[f.id] = { skipped: "already reported for this order" }; continue; }
      }
      try {
        const res = await http(call.url, { method: "POST", headers: call.headers, body: call.body, timeout: 10000 });
        const ok = f.okOf(res);
        results[f.id] = ok ? { sent: true } : { error: res.json?.error?.message || res.json?.message || res.error || `HTTP ${res.status}` };
        await finishPurchase(rowId, ok, { via: claimSource, httpStatus: res.status });
      } catch (err) {
        results[f.id] = { error: String(err.message || err) };
        await finishPurchase(rowId, false, { via: claimSource, error: String(err.message || err) });
      }
    }
    return results;
  }

  /* طلب المتجر اللي الـid ده بيشاور عليه (رقم نقطة البيع أو W…). null لو مش
     طلب متجر أو الجدول مش موجود — عمر الحدث ما يقع بسبب البحث ده. */
  async function findShopOrder(id) {
    if (!id) return null;
    try {
      const r = await pool.query(
        `SELECT order_no, pos_order_id, total FROM shop_orders
          WHERE pos_order_id = $1 OR order_no = $1
          ORDER BY created_at DESC LIMIT 1`, [String(id)]);
      return r.rows[0] || null;
    } catch { return null; }
  }

  /* فيه Purchase متسجّل لأي id من دول خلال ٢٤ ساعة؟ (G3: ريفريش التتبع +
     إطلاق مزدوج). لو الفحص نفسه فشل بنكمّل — الحجز في ads_events لسه بيمنع
     الإرسال المزدوج للمنصات، واللي بيضيع بس دقة العدّاد. */
  async function recentPurchase(ids) {
    const list = [...new Set(ids.filter(Boolean).map(String))];
    if (!list.length) return false;
    try {
      const r = await pool.query(
        `SELECT 1 FROM funnel_events
          WHERE event_name = 'Purchase' AND order_id = ANY($1::text[])
            AND created_at > NOW() - ($2 || ' hours')::interval
          LIMIT 1`, [list, String(PURCHASE_DEDUP_HOURS)]);
      return r.rowCount > 0;
    } catch (err) {
      console.error("[funnel] dedup check failed:", err.message);
      return false;
    }
  }

  async function storeEvent(e, { pnLocal = null, results = {} } = {}) {
    await pool.query(
      `INSERT INTO funnel_events (id, event_name, event_id, order_id, value, currency, url, referrer, utm, click_ids, phone_norm, ip, ua, results, contents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [crypto.randomUUID(), e.name, e.eventId, e.orderId, e.value, e.currency, e.url, e.referrer,
       jb(e.utm || {}), jb(e.click), pnLocal || null, e.ip, e.ua, jb(results),
       e.contents.length ? jb(e.contents) : null]).catch((err) => {
        console.error("[funnel] store failed:", err.message);
      });
  }

  /* ═══ serverPurchase ══════════════════════════════════════════════════
     الشراء الموثوق: بيتنده من shop.js بعد ما طلب مدفوع ينزل نقطة البيع
     (W0-03). بيقرا الطلب من shop_orders — مش من المتصفح — فالقيمة هي اللي
     اتدفعت فعلاً، والمنتجات موجودة، والـfbc/fbp/ip/ua من attribution اللي
     اتسجّلت وقت الـcheckout. مابيرميش على حالات الطلب: كل حالة بترجع كنتيجة.
       { ok:true, orderId, results }       اتبعت (أو اتخطّى per-platform)
       { ok:true, duplicate:true }         Purchase لنفس الطلب خلال ٢٤ ساعة
       { ok:false, skipped:"…" }           طلب مش مؤهل (مش موجود/اختبار/…)   */
  async function serverPurchase({ orderNo } = {}) {
    if (!orderNo) return { ok: false, skipped: "no_order_no" };
    // to_jsonb(o) عشان attribution وis_test بيتضافوا في وحدات تانية (W0-03/W1-01):
    // لو العمود لسه مش موجود القراءة ماتقعش، القيمة بس بتبقى null.
    const r = await pool.query(`SELECT to_jsonb(o) AS o FROM shop_orders o WHERE o.order_no = $1`, [String(orderNo)]);
    const order = r.rows[0]?.o;
    if (!order) return { ok: false, skipped: "not_found" };
    if (!order.pos_order_id) return { ok: false, skipped: "no_pos_order" };
    if (order.is_test === true) return { ok: false, skipped: "test_order" };
    if (NO_PURCHASE_STATUS.test(String(order.status || ""))) return { ok: false, skipped: `status:${order.status}` };
    if (!(Number(order.total) > 0)) return { ok: false, skipped: "zero_total" };

    if (await recentPurchase([order.pos_order_id, order.order_no])) {
      return { ok: true, duplicate: true, orderId: String(order.pos_order_id) };
    }

    const match = adsOf()?.matchToCatalog || null;
    const contents = await purchaseContentsOf(order.items, order.discount_percent, match);
    const pnLocal = order.phone_norm ? normPhone(order.phone_norm) : "";
    const digits = pnLocal ? phoneDigits(pnLocal, normPhone) : null;
    const baseUrl = (env("STOREFRONT_PUBLIC_URL") || "https://freshcuts.sa").split(",")[0].trim().replace(/\/+$/, "");
    const e = serverPurchaseEvent(order, { contents, digits, baseUrl });

    const results = await forwardAll(e, { claimSource: "website" });
    await storeEvent(e, { pnLocal, results });
    if (attribution?.linkOrder) {
      attribution.linkOrder({ orderId: e.orderId }).catch((err) => {
        console.error("[funnel] link-lead failed:", err.message);
      });
    }
    return { ok: true, orderId: e.orderId, results };
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

    let value = Math.round((Number(b.value) || 0) * 100) / 100;
    if (value < 0 || value > 100000) return c.json({ ok: false, error: "value out of range" }, 400);
    let orderId = b.orderId ? String(b.orderId).slice(0, 64) : null;
    const eventId = String(b.eventId || orderId || crypto.randomUUID()).slice(0, 64);

    /* Purchase لطلب متجر: الـid الرسمي هو رقم نقطة البيع (نفس مفتاح ads.js
       وserverPurchase)، والحجز بيتسجّل website. لو نفس الطلب اتسجّل Purchase
       خلال ٢٤ ساعة (ريفريش التتبع، app.js + track.html، أو السيرفر سبق) →
       duplicate من غير إدراج ولا إرسال. */
    let claimSource = "funnel";
    if (name === "Purchase" && orderId) {
      const shop = await findShopOrder(orderId);
      if (shop) {
        claimSource = "website";
        // الطلب لسه مانزلش نقطة البيع: حجز بـW… هيبقى مفتاح تاني غير رقم
        // نقطة البيع = إرسال مزدوج بعدين. serverPurchase هيبلّغ عنه لما ينزل.
        if (!shop.pos_order_id) return c.json({ ok: true, deferred: true });
        orderId = String(shop.pos_order_id);
        // القيمة من shop_orders.total (اللي اتدفع فعلاً) مش من المتصفح — الراوت
        // عام، والمتصفح ساعات بيبعت صفر أو قيمة قديمة من fc_last_value.
        if (Number(shop.total) > 0) value = r2(shop.total);
      }
      if (await recentPurchase([orderId, b.orderId, shop?.order_no])) {
        return c.json({ ok: true, duplicate: true });
      }
    }
    const url = String(b.url || "").slice(0, 500);
    const clicks = b.clickIds && typeof b.clickIds === "object" ? b.clickIds : {};
    const utm = b.utm && typeof b.utm === "object" ? b.utm : {};
    const pnLocal = b.phone ? normPhone(b.phone) : "";
    const digits = pnLocal ? phoneDigits(pnLocal, normPhone) : null;

    /* Basket contents. The storefront sends the SAME product ids the catalog
       feed publishes (both come from the TabSense menu), so a browser that
       viewed a dish can be retargeted with that exact dish. Capped and coerced
       here because this route is public. */
    const contents = (Array.isArray(b.contents) ? b.contents : []).slice(0, 50).map((i) => ({
      id: String(i?.id ?? "").slice(0, 64),
      name: i?.name ? String(i.name).slice(0, 120) : null,
      quantity: Math.max(1, Math.min(999, Math.round(Number(i?.quantity) || 1))),
      itemPrice: Math.round((Number(i?.item_price ?? i?.itemPrice) || 0) * 100) / 100,
    })).filter((i) => i.id);

    const e = {
      name, eventId, orderId, value,
      contents,
      numItems: contents.reduce((a, i) => a + i.quantity, 0),
      currency: String(b.currency || "SAR").slice(0, 3).toUpperCase(),
      time: Math.floor(Date.now() / 1000),
      url, referrer: String(b.referrer || "").slice(0, 500),
      utm,
      ip: ip || null,
      ua: String(c.req.header("user-agent") || "").slice(0, 400),
      digits, email: b.email ? String(b.email).slice(0, 200) : null,
      click: {
        fbp: String(clicks.fbp || "").slice(0, 200) || null,
        fbc: String(clicks.fbc || "").slice(0, 300) || null,
        ttclid: String(clicks.ttclid || "").slice(0, 300) || null,
        ttp: String(clicks.ttp || "").slice(0, 200) || null,
        scid: String(clicks.scid || "").slice(0, 300) || null,
        /* Google's click ids. gclid is the normal one; gbraid/wbraid are what
           Google sends instead on iOS app / web-to-app journeys where a gclid
           is not available. Stored so that when this order later appears at
           the till, ads.js can key its offline conversion on a REAL click —
           that is the only thing that makes a Google upload strong rather
           than a hashed-phone best guess. */
        gclid: String(clicks.gclid || "").slice(0, 300) || null,
        gbraid: String(clicks.gbraid || "").slice(0, 300) || null,
        wbraid: String(clicks.wbraid || "").slice(0, 300) || null,
      },
    };


    const results = await forwardAll(e, { claimSource });
    await storeEvent(e, { pnLocal, results });

    // A Purchase with an order id closes the loop: the same phone (or the same
    // order id) may already be sitting in this table as a Lead from an ad. Link
    // it now so /api/attribution/* can say "مؤكد" instead of guessing. Never
    // blocks the response — the autopilot sweep catches anything missed here.
    if (attribution?.linkOrder && orderId && (name === "Purchase" || name === "InitiateCheckout")) {
      attribution.linkOrder({ orderId }).catch((err) => {
        console.error("[funnel] link-lead failed:", err.message);
      });
    }

    return c.json({ ok: true, results });
  });

  /* ── delivery-app redirect clicks ──────────────────────────────────────
     The storefront used to forward these to /api/funnel/event as a Lead. That
     was wrong twice over: the call is server-to-server, so the "customer" IP
     Meta/TikTok/Snap received was the storefront container's own address and
     the event carried no identifier at all; and Lead is the event three live
     campaigns optimise on, so every /go click taught the delivery algorithms
     to find more people who look like our own datacentre. Recorded here
     instead, and reported by /api/funnel/delivery-lift below. */
  const GO_TARGETS = new Set(["keeta", "hungerstation", "ninja"]);
  app.post("/api/funnel/go-click", async (c) => {
    const ip = (c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "").split(",")[0].trim();
    if (rateLimited(`go:${ip || "unknown"}`)) return c.json({ ok: false, error: "rate limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }
    const target = String(b.target || "").toLowerCase().slice(0, 32);
    if (!GO_TARGETS.has(target)) return c.json({ ok: false, error: "unknown target" }, 400);
    await pool.query(
      `INSERT INTO go_clicks (id, target, utm, referrer, ip, ua) VALUES ($1,$2,$3,$4,$5,$6)`,
      [crypto.randomUUID(), target,
       jb(b.utm && typeof b.utm === "object" ? b.utm : {}),
       String(b.referrer || "").slice(0, 500) || null,
       String(b.ip || ip || "").slice(0, 64) || null,
       String(b.ua || c.req.header("user-agent") || "").slice(0, 400) || null])
      .catch((err) => console.error("[funnel] go-click store failed:", err.message));
    return c.json({ ok: true });
  });

  /* ── delivery-app lift test ────────────────────────────────────────────
     The owner's bar: an ad that sends people to Keeta/HungerStation is worth
     running only if it returns MORE THAN 7 SAR of delivery-app sales per 1 SAR
     spent. Nothing about a delivery app is directly attributable — the app
     tells us nothing about where its customer came from — so the only honest
     test is a before/after on that app's OWN sales, with the clicks we sent as
     the evidence that the ad actually pushed traffic there.

     Per app, per day: our redirect clicks, the app's orders and revenue from
     ts_orders, plus a baseline computed from the days BEFORE the test window.
     `lift` is revenue above that baseline; `ratio` is lift ÷ spend. Spend is
     not guessed: it must be passed in (?spend_keeta=…), because no ad platform
     knows which of its campaigns was the delivery-app one. */
  app.get("/api/funnel/delivery-lift", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(Math.max(Number(c.req.query("days") || 14), 2), 120);
    // The test window: days the campaign ran. Everything before it, inside the
    // same query range, is the baseline.
    const testFrom = c.req.query("from") || null;      // YYYY-MM-DD, optional

    const orders = await pool.query(
      `SELECT o.calendar_day AS day,
              lower(COALESCE(NULLIF(s.source_note,''),'unknown')) AS app,
              count(*)::int AS orders,
              round(COALESCE(sum(o.total),0)::numeric,2) AS revenue
         FROM ts_orders o
         JOIN order_sources s ON s.order_id = o.order_id
        WHERE s.source = 'delivery_app'
          AND o.calendar_day > CURRENT_DATE - $1::int
        GROUP BY 1,2 ORDER BY 1`, [days + 1]);

    const clicks = await pool.query(
      `SELECT (created_at AT TIME ZONE 'Asia/Riyadh')::date AS day, target AS app, count(*)::int AS clicks
         FROM go_clicks
        WHERE created_at > NOW() - ($1 || ' days')::interval
        GROUP BY 1,2 ORDER BY 1`, [String(days + 1)]);

    const apps = {};
    const app_ = (name) => (apps[name] ||= { app: name, days: {}, clicks: 0, orders: 0, revenue: 0 });
    for (const r of orders.rows) {
      const a = app_(r.app);
      const d = (a.days[r.day.toISOString().slice(0, 10)] ||= { day: r.day.toISOString().slice(0, 10), clicks: 0, orders: 0, revenue: 0 });
      d.orders = r.orders; d.revenue = Number(r.revenue);
      a.orders += r.orders; a.revenue += Number(r.revenue);
    }
    for (const r of clicks.rows) {
      const a = app_(r.app);
      const key = r.day.toISOString().slice(0, 10);
      const d = (a.days[key] ||= { day: key, clicks: 0, orders: 0, revenue: 0 });
      d.clicks = r.clicks; a.clicks += r.clicks;
    }

    const BAR = Number(process.env.DELIVERY_LIFT_BAR || 7);   // owner's 7:1 bar
    const out = Object.values(apps).map((a) => {
      const rows = Object.values(a.days).sort((x, y) => x.day.localeCompare(y.day));
      const test = testFrom ? rows.filter((r) => r.day >= testFrom) : [];
      const base = testFrom ? rows.filter((r) => r.day < testFrom) : rows;
      const avg = (list, k) => (list.length ? list.reduce((s, r) => s + r[k], 0) / list.length : 0);
      const baselineRevPerDay = Math.round(avg(base, "revenue") * 100) / 100;
      const testRevPerDay = Math.round(avg(test, "revenue") * 100) / 100;
      const spend = Number(c.req.query(`spend_${a.app}`) || 0);
      const liftPerDay = testFrom ? Math.round((testRevPerDay - baselineRevPerDay) * 100) / 100 : null;
      const liftTotal = liftPerDay == null ? null : Math.round(liftPerDay * test.length * 100) / 100;
      return {
        app: a.app,
        days: rows,
        totals: { clicks: a.clicks, orders: a.orders, revenue: Math.round(a.revenue * 100) / 100 },
        baselineRevPerDay, testRevPerDay,
        testDays: test.length, baselineDays: base.length,
        spend: spend || null,
        liftPerDay, liftTotal,
        ratio: spend > 0 && liftTotal != null ? Math.round((liftTotal / spend) * 100) / 100 : null,
        verdict: spend > 0 && liftTotal != null
          ? (liftTotal / spend >= BAR ? "نجح — فوق الحد" : "فشل — تحت الحد")
          : "محتاج فترة اختبار (from=) ومصروف (spend_<app>=)",
      };
    }).sort((x, y) => y.totals.revenue - x.totals.revenue);

    // What would make the test valid. Reported alongside the numbers rather
    // than assumed, because most of it is not true yet.
    const linkable = { keeta: true, hungerstation: false, ninja: false };
    return c.json({
      ok: true, days, from: testFrom, bar: BAR, apps: out,
      requirements: {
        realDeepLinks: linkable,
        note: "روابط /go/hungerstation و /go/ninja لسه راجعة على order.o2m8.me نفسه — أي إعلان عليها بيقيس لا شيء.",
        minTestDays: 7, minBaselineDays: 14,
        spendMustBeDedicated: true,
      },
    });
  });

  /* Funnel numbers, two ways of cutting time — and the difference matters.

     `days` is a ROLLING window off NOW(): "the last 7×24 hours". That is what
     the dashboard has always asked for and it stays exactly as it was.

     `from`/`to` cut on the TABSENSE BUSINESS DAY (Riyadh clock minus 4h), the
     same boundary every sales number in this API uses. reports.js asks for
     that one, because a funnel counted over a different span than the sales it
     sits next to is not a funnel — it is two unrelated numbers side by side. */
  const BIZ_DAY = `(((created_at AT TIME ZONE 'Asia/Riyadh') - interval '4 hours')::date)`;

  async function funnelStats({ days = 7, from = null, to = null } = {}) {
    const ranged = !!(from && to);
    const where = ranged
      ? `${BIZ_DAY} BETWEEN $1::date AND $2::date`
      : `created_at > NOW() - ($1 || ' days')::interval`;
    const params = ranged ? [from, to] : [String(days)];

    const r = await pool.query(
      `SELECT event_name, count(*)::int AS n, COALESCE(sum(value) FILTER (WHERE event_name='Purchase'),0) AS purchase_value,
              count(DISTINCT ip)::int AS uniques
         FROM funnel_events WHERE ${where} GROUP BY event_name`, params);
    const bySrc = await pool.query(
      `SELECT COALESCE(NULLIF(utm->>'utm_source',''),'(مباشر)') AS source,
              count(*) FILTER (WHERE event_name='PageView')::int AS views,
              count(*) FILTER (WHERE event_name='Purchase')::int AS purchases,
              COALESCE(sum(value) FILTER (WHERE event_name='Purchase'),0) AS revenue
         FROM funnel_events WHERE ${where}
        GROUP BY 1 ORDER BY views DESC LIMIT 15`, params);
    /* أول حدث اتسجّل على الإطلاق. من غيره تقرير بيغطي أسبوع بدأ التتبع في
       نصّه بيقرا كأن نص الأسبوع كان صفر زيارات — وده كذب. */
    const first = await pool.query(`SELECT min(created_at) AS first FROM funnel_events`);
    return {
      days: ranged ? null : days, from: ranged ? from : null, to: ranged ? to : null,
      basis: ranged ? "business-day" : "rolling",
      firstEventAt: first.rows[0]?.first || null,
      events: r.rows, sources: bySrc.rows,
    };
  }

  app.get("/api/funnel/stats", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(Number(c.req.query("days") || 7), 90);
    return c.json({ ok: true, ...(await funnelStats({ days })) });
  });

  console.log(`[funnel] routes ready (pixels: meta=${metaPixel() ? "set" : "—"} tiktok=${ttPixel() ? "set" : "—"} snap=${snapPixel() ? "set" : "—"})`);
  return { funnelStats, serverPurchase };
}
