/* ═══════════════════════════════════════════════════════════════════════════
   PORTAL — بوابة المطعم (كاشير + مدير): دخول بالـPIN، طلبات حيّة لحظة بلحظة
   (SSE + استطلاع احتياطي)، خط زمني كامل لكل طلب، طلب/إلغاء مندوب للمدير،
   Web Push لأجهزة الفريق، وتقارير الأونلاين.

   قواعد:
   - البوابة مابتكرّرش منطق الطلب: الحالة والإرسال والإلغاء من shop.js/delivery.js
     نفسهم، والـSLA من slaCheck. التغييرات بتوصل من ناقل order-events + فحص
     دوري للفروق (عشان التحديثات اللي مابتطلعش حدث زي موقع الكابتن).
   - مفيش أي فلوس هنا: لا استرجاع ولا إلغاء طلب (قرار المالك).
   - أي خطأ في البث أو الإشعارات بيتبلع ويتسجّل — الشيك أوت/نقطة البيع/المندوب
     مابيستنوش البوابة ولا بيتأثروا بيها.

   الأدوار: cashier = قراية + «شفته» + «سلّمت للمندوب». manager = الكل + طلب/إلغاء
   مندوب + التقارير + تجربة الإشعار.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import * as orderEvents from "./order-events.js";
import { dispatchDelayOf } from "./delivery.js";
import {
  identitiesFrom, matchLogin, currentFingerprint, signToken, verifyToken, tokenSecret,
  makeLoginLimiter, clientIp, toPortalOrder, orderSignature, sseFrame, SSE_HEADERS,
  buildTimeline, hashPin, verifyPin, validPin, normStaffList, ROLES, TOKEN_TTL_MS, TOKEN_PREFIX, KITCHEN_TOKEN_TTL_MS,
} from "./portal-core.js";
import { makePortalPush, validSubscription } from "./portal-push.js";
import { parseRange, buildReport } from "./portal-reports.js";
import { makeNameResolver, backfillItemNames } from "./product-names.js";
import { register as registerSoldOut } from "./soldout.js";

export const AUDIT_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS portal_audit (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    staff_id TEXT,
    staff_name TEXT,
    role TEXT,
    action TEXT NOT NULL,
    order_no TEXT,
    ok BOOLEAN,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS portal_audit_order_idx ON portal_audit(order_no, at)`,
  `CREATE INDEX IF NOT EXISTS portal_audit_at_idx ON portal_audit(at DESC)`,
]);

/* الطلبات + آخر شحنة. $1 = ساعات (feed) أو مصفوفة أرقام (refresh/detail) */
const ORDER_COLS = `o.order_no, o.status, o.option, o.customer, o.phone_norm, o.address, o.items,
  o.subtotal, o.delivery_fee, o.tip, o.total, o.notes, o.pos_order_id, o.created_at, o.updated_at,
  o.history, o.alerts, o.pos_ready_at, o.accepted_at, o.portal_ack_at, o.portal_ack_by, o.pay_gateway,
  o.is_test, o.dispatch_claimed_at::text AS dispatch_claimed_at,
  o.delivery_quote->'farZone' AS far_zone, o.delivery_quote->>'routeKm' AS route_km, o.delivery_quote->>'straightKm' AS straight_km,
  s.status AS ship_status, s.driver AS ship_driver, s.provider AS ship_provider, s.provider_ref AS ship_ref,
  s.updated_at AS ship_updated_at, s.dispatch AS ship_dispatch,
  s.arrived_at AS ship_arrived_at, s.picked_at AS ship_picked_at`;
const SHIP_JOIN = `LEFT JOIN LATERAL (
    SELECT status, driver, provider, provider_ref, updated_at, dispatch, arrived_at, picked_at
      FROM dl_shipments WHERE shop_order_no = o.order_no ORDER BY id DESC LIMIT 1) s ON TRUE`;
export const FEED_SQL = `SELECT ${ORDER_COLS} FROM shop_orders o ${SHIP_JOIN}
  WHERE o.status NOT IN ('pending_payment','expired')
    AND o.created_at > NOW() - make_interval(hours => $1::int)
  ORDER BY o.created_at DESC LIMIT 150`;
export const BY_NO_SQL = `SELECT ${ORDER_COLS} FROM shop_orders o ${SHIP_JOIN}
  WHERE o.order_no = ANY($1::text[])`;

const MAX_STREAMS = () => Math.max(1, Number(process.env.PORTAL_MAX_STREAMS || 40));
const MAX_STREAMS_PER_USER = 6;
const HEARTBEAT_MS = 20_000;
const STREAM_LIFETIME_MS = 30 * 60_000;
const SCAN_MS = 15_000;
const NEW_ORDER_POLL_MS = 60_000;

export function register(app, ctx, deps = {}) {
  const { pool, getSettingsData, requireAdmin } = ctx;
  const log = ctx.log || console;
  const env = deps.env || process.env;
  const shop = typeof deps.shop === "function" ? deps.shop : () => deps.shop || null;
  const delivery = typeof deps.delivery === "function" ? deps.delivery : () => deps.delivery || null;
  const courierOps = typeof deps.courierOps === "function" ? deps.courierOps : () => deps.courierOps || null;
  const emitOrder = deps.emitOrder || orderEvents.emitOrder;
  const subscribe = deps.subscribe || orderEvents.subscribe;
  const now = deps.now || (() => Date.now());
  const timers = deps.timers !== false; // الاختبارات بتقفل المؤقتات الدورية
  const limiter = makeLoginLimiter();
  /* سقف عام فوق سقف الـIP: الـIP جاي من هيدر (cf-connecting-ip) ينفع يتزوّر لو حد
     كلّم السيرفر مباشرة من غير Cloudflare — فالتخمين الموزّع مايبقاش بلا حدود. */
  const globalLimiter = makeLoginLimiter({ maxFails: 40, lockMs: 5 * 60_000, windowMs: 10 * 60_000 });
  // الأجهزة المسموح لها تستقبل إشعارات: هويات موجودة دلوقتي بس (موظف اتشال = جهازه يسكت)
  const allowStaff = async () => {
    const ids = await identities();
    const set = new Set(ids.staff.map((x) => x.id));
    if (ids.sharedPin) set.add("cashier");
    set.add("admin");
    return set;
  };
  const push = deps.push || makePortalPush({ pool, getSettingsData, webpush: deps.webpush, log, allowStaff });

  /* ── الجداول ── */
  let auditReady = null;
  function ensureAudit() {
    if (!auditReady) {
      auditReady = (async () => { for (const sql of AUDIT_DDL) await pool.query(sql); return true; })()
        .catch((e) => { auditReady = null; try { log.error(`[portal] audit schema failed: ${e?.message || e}`); } catch {} return false; });
    }
    return auditReady;
  }
  if (deps.ensureSchema !== false) {
    ensureAudit();
    push.ensureSchema();
    // مخزن أحداث الطلب (shop_order_events) — الخط الزمني بيقرا منه. idempotent.
    if (deps.eventStore !== false && env.PORTAL_EVENT_STORE !== "0") {
      try { orderEvents.startEventStore(pool, { log }); } catch {}
    }
  }

  /* ── الهويات (كاش ١٠ ث) ── */
  let idsCache = { at: 0, ids: null };
  async function identities(force = false) {
    if (!force && idsCache.ids && now() - idsCache.at < 10_000) return idsCache.ids;
    const s = await getSettingsData();
    idsCache = { at: now(), ids: identitiesFrom(s, env) };
    return idsCache.ids;
  }
  const secret = () => tokenSecret(env);
  /* البصمة جوّه التوكن مقروءة (base64) — من غير مفتاح كانت sha256 للرقم المشترك
     (٤ أرقام = بتتكسر فوراً) أو لمفتاح الأدمن، والتوكن بيعدّي في query الـSSE
     (سجلات البروكسي). فبنخزّنها HMAC بسر التوكن. */
  const keyPv = (pv) => crypto.createHmac("sha256", String(secret() || "")).update(`pv|${pv ?? ""}`).digest("base64url").slice(0, 22);

  /* ── التحقق ── */
  async function authenticate(c, { allowQuery = false } = {}) {
    const h = c.req.header("Authorization") || "";
    let raw = null;
    if (h.startsWith(`Bearer ${TOKEN_PREFIX}`)) raw = h.slice(7 + TOKEN_PREFIX.length);
    else if (allowQuery && c.req.query("token")) raw = String(c.req.query("token"));
    if (raw) {
      const p = verifyToken(raw, secret(), now());
      if (!p) return { res: c.json({ ok: false, error: "unauthorized" }, 401) };
      try {
        const fps = currentFingerprint(await identities(), p.sid, p.r);
        if (!fps.some((fp) => keyPv(fp) === p.pv)) return { res: c.json({ ok: false, error: "session_revoked" }, 401) };
      } catch {
        return { res: c.json({ ok: false, error: "unavailable" }, 503) };
      }
      return { user: { id: p.sid, name: p.n, role: p.r, exp: p.exp, pv: p.pv } };
    }
    // مفتاح الأدمن (أو مالك لوحة المتجر) = مدير
    if (h.startsWith("Bearer ") && typeof requireAdmin === "function") {
      try {
        const err = await requireAdmin(c);
        if (!err) return { user: { id: "admin", name: "المالك", role: "manager", exp: null, admin: true } };
      } catch { /* يقع تحت */ }
    }
    return { res: c.json({ ok: false, error: "unauthorized" }, 401) };
  }
  async function requirePortal(c, role = null, opts) {
    const a = await authenticate(c, opts);
    if (a.res) return a;
    /* حساب المطبخ مايدخلش أي مسار بورتال (فيه جوالات عملاء ومندوب) — مسارات
       /api/kitchen/* بس هي اللي بتقول kitchen:true. */
    if (a.user.role === "kitchen" && !opts?.kitchen) {
      return { res: c.json({ ok: false, error: "kitchen_only", message: "حساب المطبخ لشاشة المطبخ بس" }, 403) };
    }
    if (role === "manager" && a.user.role !== "manager") {
      return { res: c.json({ ok: false, error: "forbidden", message: "الإجراء ده للمدير بس" }, 403) };
    }
    return a;
  }

  /* ── السجل + الأحداث (مابيرميش) ── */
  function audit(user, action, orderNo, ok, detail = {}, ip = null, { emit = true } = {}) {
    try {
      ensureAudit().then(() => pool.query(
        `INSERT INTO portal_audit(staff_id, staff_name, role, action, order_no, ok, detail, ip)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [user?.id || null, user?.name || null, user?.role || null, action, orderNo || null,
          typeof ok === "boolean" ? ok : null, JSON.stringify(detail || {}), ip])).catch((e) => {
        try { log.error(`[portal] audit ${action} failed: ${e?.message || e}`); } catch {}
      });
    } catch {}
    try {
      if (orderNo && emit) {
        emitOrder("staff_action", {
          orderNo: String(orderNo), source: "portal", ok: typeof ok === "boolean" ? ok : null,
          actor: { id: user?.id, name: user?.name, role: user?.role },
          summary: undefined,
          data: { action, via: "portal", ...detail },
        });
      }
    } catch {}
  }

  /* ── تحميل الطلبات ── */
  let slaCache = { at: 0, cfg: null };
  async function slaCfg() {
    if (slaCache.cfg && now() - slaCache.at < 10_000) return slaCache.cfg;
    const settings = await getSettingsData();
    let auto = false;
    try { auto = (await delivery()?.dispatchGate?.())?.mode === "auto"; } catch {}
    const cfg = { ...((settings.delivery || {}).sla || {}), dispatchDelayMin: auto ? dispatchDelayOf(settings) : 0 };
    slaCache = { at: now(), cfg };
    return cfg;
  }
  /* أسماء الأصناف (بلاغ عمر ١٧ سبتمبر): السلة بتوصل بـproduct_id بس، فالشاشة
     كانت بتكتب رقم. بنحلّ الاسم من قايمة تاب سينس قبل ما الصف يتحوّل للعرض —
     حزام إضافي فوق الحل وقت الشيك أوت والـbackfill. أي فشل بيتبلع: الأسوأ
     إن السطر يفضل «صنف #<رقم>» زي ما كان. */
  const names = deps.names || makeNameResolver({ pool, tsstore: deps.tsstore, log });
  const withNames = async (rows) => {
    let out = rows;
    try { out = await names.fillRows(rows); } catch { out = rows; }
    /* حوادث المندوب + المهل + الـETA (courierops.js، ١٩ سبتمبر). أي فشل
       بيتبلع جوّه decorate — الشاشة تفضل شغّالة من غيرها. */
    try { const ops = courierOps(); if (ops?.decorate) out = await ops.decorate(out); } catch { /* ignore */ }
    return out;
  };
  /* الطلبات اللي اتخزّنت قبل التصليح لسه بأرقام — بنصلّحها مرة واحدة بعد
     الإقلاع بشوية (مش وقته، عشان الإقلاع مايتأخرش ولا نضرب تاب سينس وقت
     الزحمة). حقل العرض بس، والسطر اللي اسمه فعلاً مش معروف بيفضل زي ما هو. */
  if (deps.backfill !== false && timers && env.ITEM_NAMES_BACKFILL !== "0") {
    const t = setTimeout(() => {
      backfillItemNames(pool, names, { days: Number(env.ITEM_NAMES_BACKFILL_DAYS || 90), limit: 400, log })
        .catch((e) => { try { log.error(`[portal] item-name backfill failed: ${e?.message || e}`); } catch {} });
    }, Number(env.ITEM_NAMES_BACKFILL_DELAY_MS || 25_000));
    t.unref?.();
  }
  async function loadFeed(hours) {
    const rows = await withNames((await pool.query(FEED_SQL, [hours])).rows || []);
    const cfg = await slaCfg();
    const t = now();
    return rows.map((r) => toPortalOrder(r, cfg, t));
  }
  async function loadByNos(nos) {
    const list = [...new Set((nos || []).map(String))].slice(0, 100);
    if (!list.length) return { orders: [], rows: [] };
    const rows = await withNames((await pool.query(BY_NO_SQL, [list])).rows || []);
    const cfg = await slaCfg();
    const t = now();
    return { rows, orders: rows.map((r) => toPortalOrder(r, cfg, t)) };
  }
  async function loadInfo(orderNo) {
    const { orders } = await loadByNos([orderNo]);
    const o = orders[0];
    if (!o) return {};
    return { total: o.total, option: o.option, itemsCount: o.itemsCount, driverName: o.courier?.name || null, isTest: o.isTest };
  }

  /* ═══ البث الحي ═══════════════════════════════════════════════════════ */
  const hub = { clients: new Set(), sigs: new Map(), primed: false, pending: new Set(), flushTimer: null, scanTimer: null, seq: 0, scanning: false };

  function broadcast(event, data) {
    const frame = sseFrame(event, data, ++hub.seq);
    for (const cl of [...hub.clients]) cl.send(frame);
  }
  function remember(o) {
    const sig = orderSignature(o);
    const changed = hub.sigs.get(o.orderNo) !== sig;
    hub.sigs.set(o.orderNo, sig);
    if (hub.sigs.size > 1000) { // تنظيف: أقدم المفاتيح
      for (const k of [...hub.sigs.keys()].slice(0, 300)) hub.sigs.delete(k);
    }
    return changed;
  }
  async function refresh(nos) {
    try {
      const { orders } = await loadByNos(nos);
      for (const o of orders) if (remember(o) && hub.clients.size) broadcast("order", o);
    } catch (e) {
      try { log.error(`[portal] refresh failed: ${e?.message || e}`); } catch {}
    }
  }
  function scheduleRefresh(orderNo) {
    if (!orderNo || !hub.clients.size) return;
    hub.pending.add(String(orderNo));
    if (hub.flushTimer) return;
    hub.flushTimer = setTimeout(() => {
      hub.flushTimer = null;
      const nos = [...hub.pending];
      hub.pending.clear();
      refresh(nos);
    }, deps.debounceMs ?? 300);
    hub.flushTimer.unref?.();
  }
  async function scan() {
    if (hub.scanning) return;
    hub.scanning = true;
    try {
      const orders = await loadFeed(24);
      const first = !hub.primed;
      for (const o of orders) {
        const changed = remember(o);
        if (changed && !first && hub.clients.size) broadcast("order", o);
      }
      hub.primed = true;
    } catch (e) {
      try { log.error(`[portal] scan failed: ${e?.message || e}`); } catch {}
    } finally {
      hub.scanning = false;
    }
  }
  function startScan() {
    if (hub.scanTimer || !timers) return;
    hub.scanTimer = setInterval(() => { scan(); }, SCAN_MS);
    hub.scanTimer.unref?.();
  }
  function stopScanIfIdle() {
    if (hub.clients.size || !hub.scanTimer) return;
    clearInterval(hub.scanTimer);
    hub.scanTimer = null;
    hub.primed = false;
    hub.sigs.clear();
  }

  // الناقل: كل حدث طلب = تحديث مستهدف (مجمّع) + إشعار لو نوعه يستاهل
  let unsub = null;
  try {
    unsub = subscribe((evt) => {
      try { scheduleRefresh(evt?.orderNo); } catch {}
      try { push.onOrderEvent(evt, loadInfo); } catch {}
    });
  } catch (e) {
    try { log.error(`[portal] bus subscribe failed: ${e?.message || e}`); } catch {}
  }

  // احتياطي «طلب جديد»: لو الحدث راح لحاوية تانية وقت الـrollover
  async function pollNewOrders() {
    try {
      await push.ensureSchema();
      const rows = (await pool.query(
        `SELECT o.order_no FROM shop_orders o
          WHERE o.status IN ('paid','pos_created','paid_pos_failed')
            AND o.created_at > NOW() - INTERVAL '90 minutes'
            AND NOT COALESCE(o.is_test, false)
            AND NOT EXISTS (SELECT 1 FROM portal_push_log l WHERE l.order_no = o.order_no AND l.kind = 'new')
          ORDER BY o.created_at LIMIT 20`)).rows || [];
      for (const r of rows) {
        const info = await loadInfo(r.order_no).catch(() => ({}));
        if (info.isTest) continue;
        await push.notifyOrder("new", "new", r.order_no, info);
      }
      return rows.length;
    } catch (e) {
      try { log.error(`[portal] new-order poll failed: ${e?.message || e}`); } catch {}
      return 0;
    }
  }
  let pollTimer = null;
  if (timers) {
    pollTimer = setInterval(() => { pollNewOrders(); }, NEW_ORDER_POLL_MS);
    pollTimer.unref?.();
  }

  /* ═══ المسارات ═════════════════════════════════════════════════════════ */

  app.post("/api/portal/login", async (c) => {
    const ip = clientIp((n) => c.req.header(n));
    const key = `ip:${ip}`;
    const gl = globalLimiter.check("all", now());
    const lock = gl.locked ? gl : limiter.check(key, now());
    if (lock.locked) {
      return c.json({ ok: false, error: "locked", retryAfterSec: lock.retryAfterSec,
        message: `محاولات كتير غلط — جرّب تاني بعد ${Math.ceil(lock.retryAfterSec / 60)} دقيقة` }, 429);
    }
    const b = await c.req.json().catch(() => ({}));
    const sec = secret();
    if (!sec) return c.json({ ok: false, error: "not_configured" }, 503);
    let ids;
    try { ids = await identities(true); }
    catch { return c.json({ ok: false, error: "unavailable" }, 503); }
    const user = matchLogin(ids, b?.pin, b?.staffId || null);
    /* شاشة المطبخ (/kitchen/) بتبعت app:"kitchen": تقبل مطبخ + مدير (والمالك).
       البورتال مايقبلش حساب مطبخ — رقم صح بس للشاشة التانية، فمش محاولة غلط. */
    const kitchenApp = b?.app === "kitchen";
    if (user && kitchenApp && !["kitchen", "manager"].includes(user.role)) {
      return c.json({ ok: false, error: "wrong_app", message: "الرقم ده لبورتال الكاشير — شاشة المطبخ بحساب «مطبخ» أو «مدير»" }, 403);
    }
    if (user && !kitchenApp && user.role === "kitchen") {
      return c.json({ ok: false, error: "wrong_app", message: "ده حساب مطبخ — افتح شاشة المطبخ /kitchen/" }, 403);
    }
    if (!user) {
      globalLimiter.fail("all", now());
      const f = limiter.fail(key, now());
      return c.json({ ok: false, error: "wrong_pin", remaining: f.remaining, locked: f.locked }, f.locked ? 429 : 401);
    }
    limiter.success(key);
    const ttl = kitchenApp ? KITCHEN_TOKEN_TTL_MS : TOKEN_TTL_MS;
    const token = signToken({ ...user, pv: keyPv(user.pv) }, sec, now(), ttl);
    audit(user, "login", null, true, kitchenApp ? { app: "kitchen" } : {}, ip);
    return c.json({ ok: true, token, role: user.role, name: user.name, staffId: user.id,
      expiresAt: new Date(now() + ttl).toISOString() });
  });

  app.get("/api/portal/me", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    return c.json({ ok: true, staffId: a.user.id, name: a.user.name, role: a.user.role,
      expiresAt: a.user.exp ? new Date(a.user.exp).toISOString() : null });
  });

  app.post("/api/portal/logout", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    return c.json({ ok: true }); // التوكن مش متخزّن — الجهاز بيمسحه
  });

  app.get("/api/portal/orders", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    const hours = Math.min(72, Math.max(1, Math.floor(Number(c.req.query("hours")) || 24)));
    try {
      const orders = await loadFeed(hours);
      return c.json({ ok: true, now: new Date(now()).toISOString(), orders });
    } catch (e) {
      try { log.error(`[portal] feed failed: ${e?.message || e}`); } catch {}
      return c.json({ ok: false, error: "feed_failed" }, 500);
    }
  });

  app.get("/api/portal/orders/:orderNo", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    const orderNo = String(c.req.param("orderNo") || "").slice(0, 64);
    try {
      const { rows, orders } = await loadByNos([orderNo]);
      const row = rows[0];
      if (!row) return c.json({ ok: false, error: "not_found" }, 404);
      const q = async (sql, vals) => { try { return (await pool.query(sql, vals)).rows || []; } catch { return []; } };
      const events = await q(
        `SELECT at, name, source, channel, ok, actor_name, actor_role, summary, data
           FROM shop_order_events WHERE order_no=$1 ORDER BY at, id LIMIT 400`, [orderNo]);
      const shipments = await q(
        "SELECT id, provider, status, events FROM dl_shipments WHERE shop_order_no=$1 ORDER BY id LIMIT 10", [orderNo]);
      const webhooks = row.pos_order_id ? await q(
        `SELECT received_at, event, payload->'resource'->'statuses_slugs'->>'approval_status' AS approval
           FROM tsp_webhooks WHERE payload->'resource'->'order'->>'id' = $1
          ORDER BY received_at LIMIT 100`, [String(row.pos_order_id)]) : [];
      const pushLog = await push.pushLogFor(orderNo);
      const auditRows = await q(
        "SELECT at, staff_id, staff_name, role, action, ok, detail FROM portal_audit WHERE order_no=$1 ORDER BY at LIMIT 200", [orderNo]);
      const timeline = buildTimeline({ order: row, events, shipments, webhooks, pushLog, audit: auditRows });
      return c.json({ ok: true, now: new Date(now()).toISOString(), order: orders[0], timeline });
    } catch (e) {
      try { log.error(`[portal] detail ${orderNo} failed: ${e?.message || e}`); } catch {}
      return c.json({ ok: false, error: "detail_failed" }, 500);
    }
  });

  /* ── SSE ── */
  app.get("/api/portal/stream", async (c) => {
    const a = await requirePortal(c, null, { allowQuery: true }); if (a.res) return a.res;
    const user = a.user;
    if (hub.clients.size >= MAX_STREAMS()) {
      return c.json({ ok: false, error: "too_many_streams", fallback: "poll" }, 503);
    }
    const mine = [...hub.clients].filter((x) => x.user.id === user.id).length;
    if (mine >= MAX_STREAMS_PER_USER) {
      return c.json({ ok: false, error: "too_many_streams", fallback: "poll" }, 429);
    }
    const snapshot = c.req.query("snapshot") === "1";
    const enc = new TextEncoder();
    const signal = c.req.raw?.signal;
    let client = null;
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let hb = null, life = null;
        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(hb);
          clearTimeout(life);
          hub.clients.delete(client);
          try { signal?.removeEventListener?.("abort", cleanup); } catch {}
          try { controller.close(); } catch {}
          stopScanIfIdle();
        };
        client = {
          user,
          send(frame) {
            if (closed) return;
            // عميل واقف (الشبكة مابتقراش): الطابور في الذاكرة مايكبرش لما لا نهاية
            if (controller.desiredSize != null && controller.desiredSize < -200) { cleanup(); return; }
            try { controller.enqueue(enc.encode(frame)); } catch { cleanup(); }
          },
          close: cleanup,
        };
        hub.clients.add(client);
        // padding أول مرة: بعض البروكسيات مابتفلّشش أول كام KB
        client.send(`retry: 3000\n: ${" ".repeat(2048)}\n\n`);
        client.send(sseFrame("hello", { now: new Date(now()).toISOString(), role: user.role, name: user.name,
          heartbeatSec: HEARTBEAT_MS / 1000 }));
        hb = setInterval(() => {
          if (user.exp && user.exp <= now()) {
            client.send(sseFrame("expired", { reason: "token_expired" }));
            cleanup();
            return;
          }
          // الـPIN/الدور اتغيّر أو الموظف اتشال وهو فاتح البث ← يقفل (كاش الهويات ١٠ ث)
          if (user.pv) {
            identities().then((ids) => {
              if (closed) return;
              if (!currentFingerprint(ids, user.id, user.role).some((fp) => keyPv(fp) === user.pv)) {
                client.send(sseFrame("expired", { reason: "session_revoked" }));
                cleanup();
              }
            }).catch(() => {});
          }
          client.send(sseFrame("ping", { now: new Date(now()).toISOString() }));
        }, deps.heartbeatMs ?? HEARTBEAT_MS);
        hb.unref?.();
        life = setTimeout(() => { client.send(sseFrame("reconnect", { reason: "lifetime" })); cleanup(); },
          deps.streamLifetimeMs ?? STREAM_LIFETIME_MS);
        life.unref?.();
        try { signal?.addEventListener?.("abort", cleanup, { once: true }); } catch {}
        startScan();
        if (!hub.primed) scan();
        if (snapshot) {
          loadFeed(24).then((orders) => {
            for (const o of orders.slice().reverse()) client.send(sseFrame("order", o, ++hub.seq));
          }).catch(() => {});
        }
      },
      cancel() { try { client?.close(); } catch {} },
    });
    return new Response(stream, { status: 200, headers: { ...SSE_HEADERS } });
  });

  /* ── مدير: طلب مندوب الآن ── */
  const inflight = new Set();
  app.post("/api/portal/orders/:orderNo/courier", async (c) => {
    const a = await requirePortal(c, "manager"); if (a.res) return a.res;
    const user = a.user;
    const ip = clientIp((n) => c.req.header(n));
    const orderNo = String(c.req.param("orderNo") || "").slice(0, 64);
    const dl = delivery(), sh = shop();
    if (!dl || !sh) return c.json({ ok: false, error: "unavailable" }, 503);
    if (inflight.has(orderNo)) return c.json({ ok: false, error: "in_progress", message: "الطلب بيتبعت دلوقتي" }, 409);
    inflight.add(orderNo);
    try {
      /* {provider}: «بدّل الشركة» لطلب واحد (لاجلك رفضت → Flying Arrow مثلاً).
         من غيره = المزوّد الفعّال زي الأول. */
      const body = await c.req.json().catch(() => ({}));
      const wantProvider = body && body.provider ? String(body.provider).toLowerCase().slice(0, 20) : null;
      const row = await sh.getOrderRow(orderNo);
      if (!row) return c.json({ ok: false, error: "not_found" }, 404);
      if (row.option !== "delivery") return c.json({ ok: false, error: "not_delivery" }, 400);
      if (["courier_assigned", "on_the_way", "delivered"].includes(row.status)) {
        return c.json({ ok: false, error: "already_requested", status: row.status, message: "فيه كابتن على الطلب بالفعل" }, 409);
      }
      if (!["accepted", "courier_requested", "courier_cancelled"].includes(row.status)) {
        return c.json({ ok: false, error: "not_accepted", status: row.status,
          message: row.status === "pos_created" ? "اقبل الطلب في نقطة البيع الأول" : "الطلب مش في مرحلة تسمح بطلب مندوب" }, 409);
      }
      const gate = await dl.dispatchGate();
      if (gate.mode !== "auto") {
        return c.json({ ok: false, error: "manual_mode", mode: gate.mode,
          message: "المرحلة اليدوية: ادخّل الطلب على لوحة شركة التوصيل وسجّله يدوياً" }, 409);
      }
      const existing = await dl.shipmentOf(orderNo);
      if (existing && String(existing.status) !== "cancelled") {
        return c.json({ ok: false, error: "already_requested", courierStatus: existing.status, ref: existing.provider_ref || null,
          message: "المندوب اتطلب بالفعل" }, 409);
      }
      // الحجز الذري — نفس عمود الكنس (dispatch_claimed_at)
      let claimed = null;
      const c1 = await pool.query(
        `UPDATE shop_orders SET dispatch_claimed_at=NOW()
          WHERE order_no=$1 AND dispatch_claimed_at IS NULL RETURNING dispatch_claimed_at::text AS claimed`, [orderNo]);
      if (c1.rowCount) claimed = c1.rows[0].claimed;
      else {
        // محجوز قبل كده ومفيش شحنة حية: لو الحجز حديث جداً يبقى الكنس بيبعت دلوقتي
        const c2 = await pool.query(
          `UPDATE shop_orders SET dispatch_claimed_at=NOW()
            WHERE order_no=$1 AND dispatch_claimed_at IS NOT NULL
              AND dispatch_claimed_at < NOW() - INTERVAL '90 seconds'
            RETURNING dispatch_claimed_at::text AS claimed`, [orderNo]);
        if (!c2.rowCount) {
          return c.json({ ok: false, error: "in_progress", message: "الطلب بيتبعت لشركة التوصيل دلوقتي — استنى دقيقة" }, 409);
        }
        claimed = c2.rows[0].claimed;
      }
      try {
        const res = await dl.dispatch(await sh.getOrderRow(orderNo), {
          ...(wantProvider ? { provider: wantProvider } : {}),
          trigger: "portal", actor: user.name,
          /* «أنا راجعت لوحتهم وابعت تاني» — تجاوز يدوي واضح من المدير
             بعد ما القفل يكون اتحط. مش الافتراضي أبداً. */
          force: body && (body.force === true || body.force === 1 || body.force === "1"),
        });
        if (row.status !== "courier_requested") {
          await sh.setStatus(orderNo, "courier_requested", { note: `المدير ${user.name} طلب مندوب من البوابة${wantProvider ? ` (${wantProvider})` : ""}`, from: row.status, source: "portal" });
        }
        audit(user, "courier_request", orderNo, true, { provider: res?.provider || null, assigned: Boolean(res?.assigned), switched: Boolean(wantProvider) }, ip);
        // لو كان فيه رفض/إلغاء/حجز بعيد مفتوح على الطلب ← اتحلّ بالإعادة/التبديل
        try { courierOps()?.onRedispatch?.(orderNo, { provider: res?.provider || wantProvider, by: user.name, switched: Boolean(wantProvider) }); } catch {}
        scheduleRefresh(orderNo);
        return c.json({ ok: true, provider: res?.provider || null, ref: res?.faOrderId ?? null, assigned: Boolean(res?.assigned),
          note: res?.dispatch?.message || null });
      } catch (e) {
        /* الحجز بيفضل (الكنس مايعيدش لوحده — نفس السلوك القديم).
           رفض أكيد قبل/من شركة التوصيل (مفاتيح ناقصة، وضع يدوي، 4xx) ← المدير يعيد فوراً.
           أي حاجة تانية (timeout/شبكة/5xx) ممكن تكون الشركة سجّلت الطلب فعلاً وإحنا
           ماوصلناش الرد — إعادة فورية = كابتنين. فالحجز يفضل حديث (إعادة بعد ٩٠ ث)
           والرسالة بتقول للمدير يراجع لوحة الشركة الأول. */
        const st = Number(e?.status);
        /* ٢١ سبتمبر — «الطلب موجود عندهم بالفعل»: ده مش رفض، ده معناه إن
           المحاولة الأولى وصلتهم وإحنا ضيّعنا المرجع. الإعادة مستحيل
           تنجح (نفس الرد للأبد) وممكن تبقى كابتن تاني على نفس الطلب،
           فبنوقف الإعادة التلقائية والحجز بيفضل، والمدير بياخد جملة واحدة
           واضحة + زرار تجاوز. نفس الكلام للقفل والمحاولة الضايعة. */
        const STOP = ["COURIER_DUPLICATE", "DISPATCH_BLOCKED", "DISPATCH_LOST", "DISPATCH_IN_PROGRESS", "ALREADY_DISPATCHED"];
        if (STOP.includes(e?.code)) {
          audit(user, "courier_request", orderNo, false,
            { error: e.code, providerMessage: String(e?.providerMessage || "").slice(0, 160) }, ip);
          scheduleRefresh(orderNo);
          const msg = e?.code === "COURIER_DUPLICATE"
            ? "الطلب اتسجّل عند لاجلك بالفعل — ماينفعش يتبعت تاني. تابعه معاهم/كلّمهم، ولو متأكد إنه مش عندهم دوس «ابعت برغم التحذير»."
            : String(e?.message || "الإرسال متوقف لحد المراجعة");
          return c.json({ ok: false, error: e.code.toLowerCase(), code: e.code, blocked: true,
            canForce: e?.code !== "DISPATCH_IN_PROGRESS" && e?.code !== "ALREADY_DISPATCHED",
            recover: e?.recover || null, providerMessage: e?.providerMessage || null,
            message: msg }, 409);
        }
        const certain = ["COURIER_UNCONFIGURED", "MANUAL_MODE", "BAD_STAGE", "BAD_PROVIDER"].includes(e?.code)
          || (Number.isFinite(st) && st >= 400 && st < 500 && st !== 408 && st !== 409);
        if (certain) {
          pool.query(
            `UPDATE shop_orders SET dispatch_claimed_at = NOW() - INTERVAL '5 minutes'
              WHERE order_no=$1 AND dispatch_claimed_at::text = $2`, [orderNo, claimed]).catch(() => {});
        }
        audit(user, "courier_request", orderNo, false, { error: String(e?.code || e?.message || "error").slice(0, 120), uncertain: !certain }, ip);
        const base = String(e?.message || "فشل طلب المندوب").slice(0, 240);
        return c.json({ ok: false, error: "dispatch_failed", code: e?.code || null, uncertain: !certain,
          message: certain ? base : `${base} — ممكن يكون الطلب اتسجّل عند شركة التوصيل: راجع لوحتهم قبل ما تعيد (الإعادة متاحة بعد دقيقة ونص)` }, 502);
      }
    } catch (e) {
      try { log.error(`[portal] courier ${orderNo} failed: ${e?.message || e}`); } catch {}
      return c.json({ ok: false, error: "failed" }, 500);
    } finally {
      inflight.delete(orderNo);
    }
  });

  /* ── مدير: إلغاء المندوب الحالي ── */
  app.post("/api/portal/orders/:orderNo/courier/cancel", async (c) => {
    const a = await requirePortal(c, "manager"); if (a.res) return a.res;
    const user = a.user;
    const ip = clientIp((n) => c.req.header(n));
    const orderNo = String(c.req.param("orderNo") || "").slice(0, 64);
    const dl = delivery(), sh = shop();
    if (!dl || !sh) return c.json({ ok: false, error: "unavailable" }, 503);
    if (inflight.has(orderNo)) return c.json({ ok: false, error: "in_progress" }, 409);
    inflight.add(orderNo);
    try {
      const b = await c.req.json().catch(() => ({}));
      const reason = String(b?.reason || "").trim().slice(0, 160);
      const row = await sh.getOrderRow(orderNo);
      if (!row) return c.json({ ok: false, error: "not_found" }, 404);
      const shipment = await dl.shipmentOf(orderNo);
      if (!shipment || ["delivered", "cancelled"].includes(String(shipment.status))) {
        return c.json({ ok: false, error: "no_active_courier", message: "مفيش مندوب حالي على الطلب" }, 409);
      }
      if (String(shipment.status) === "picked" || ["on_the_way", "delivered"].includes(row.status)) {
        return c.json({ ok: false, error: "already_picked", message: "الكابتن استلم الطلب — الإلغاء من هنا مش مسموح" }, 409);
      }
      const why = `portal cancel by ${user.name}${reason ? `: ${reason}` : ""}`;
      let ok = false;
      if (shipment.provider === "manual") {
        await dl.manualEvent(orderNo, "cancelled", { by: `portal:${user.name}`, note: reason || null });
        ok = true;
      } else {
        const r = await dl.cancelShipment(orderNo, why);
        ok = Boolean(r);
      }
      if (!ok) {
        audit(user, "courier_cancel", orderNo, false, { reason: reason || null }, ip);
        return c.json({ ok: false, error: "cancel_failed", message: "شركة التوصيل رفضت الإلغاء أو مش متاحة — كلّمهم مباشرة" }, 502);
      }
      /* الطلب يرجع «مقبول» عشان «بنطلب لك مندوب» ماتفضلش كذبة قدام العميل.
         تحديث مباشر من غير notify (العميل مايتبعتلوش «بدأ التجهيز» تاني)،
         والحجز بيفضل: الكنس مابيبعتش كابتن جديد لوحده — المدير يطلب من البوابة. */
      if (["courier_requested", "courier_assigned"].includes(row.status)) {
        const note = `المدير ${user.name} ألغى المندوب${reason ? ` — ${reason}` : ""}`;
        const u = await pool.query(
          `UPDATE shop_orders SET status='accepted', history = history || $2::jsonb, updated_at=NOW()
            WHERE order_no=$1 AND status IN ('courier_requested','courier_assigned') RETURNING order_no`,
          [orderNo, JSON.stringify([{ at: new Date(now()).toISOString(), status: "accepted", note }])]);
        if (u.rowCount) {
          try { emitOrder("order_status", { orderNo, source: "portal", data: { from: row.status, to: "accepted", note } }); } catch {}
        }
      }
      audit(user, "courier_cancel", orderNo, true, { reason: reason || null, provider: shipment.provider || null }, ip);
      scheduleRefresh(orderNo);
      return c.json({ ok: true });
    } catch (e) {
      try { log.error(`[portal] courier cancel ${orderNo} failed: ${e?.message || e}`); } catch {}
      return c.json({ ok: false, error: "failed", message: String(e?.message || "").slice(0, 200) }, 500);
    } finally {
      inflight.delete(orderNo);
    }
  });

  /* ── الكل: «شفته» (بيسكّت الرنة على كل الأجهزة) ── */
  app.post("/api/portal/orders/:orderNo/ack", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    const orderNo = String(c.req.param("orderNo") || "").slice(0, 64);
    try {
      const r = await pool.query(
        `UPDATE shop_orders SET portal_ack_at = COALESCE(portal_ack_at, NOW()),
                portal_ack_by = COALESCE(portal_ack_by, $2)
          WHERE order_no=$1 RETURNING portal_ack_at, portal_ack_by`, [orderNo, a.user.name || a.user.id]);
      if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
      try { emitOrder("portal_ack", { orderNo, source: "portal", actor: { id: a.user.id, name: a.user.name, role: a.user.role }, data: { by: a.user.name } }); } catch {}
      audit(a.user, "ack", orderNo, true, {}, clientIp((n) => c.req.header(n)), { emit: false });
      scheduleRefresh(orderNo);
      return c.json({ ok: true, ackAt: r.rows[0].portal_ack_at, ackBy: r.rows[0].portal_ack_by });
    } catch (e) {
      return c.json({ ok: false, error: "failed" }, 500);
    }
  });

  /* ── الكل: «سلّمت الطلب للمندوب» (تسجيل بس، مابيغيّرش الحالة) ── */
  app.post("/api/portal/orders/:orderNo/handed", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    const orderNo = String(c.req.param("orderNo") || "").slice(0, 64);
    const row = await shop()?.getOrderRow?.(orderNo).catch(() => null);
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    audit(a.user, "handed_to_courier", orderNo, true, {}, clientIp((n) => c.req.header(n)));
    scheduleRefresh(orderNo);
    return c.json({ ok: true });
  });

  /* ── Push ── */
  app.get("/api/portal/push/key", async (c) => {
    const key = await push.publicKey();
    return key ? c.json({ ok: true, publicKey: key }) : c.json({ ok: false, error: "not_ready" }, 503);
  });

  app.post("/api/portal/push/subscribe", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    const b = await c.req.json().catch(() => ({}));
    if (!validSubscription(b?.subscription)) return c.json({ ok: false, error: "bad_subscription" }, 400);
    try {
      await push.subscribe({ subscription: b.subscription, deviceName: b.deviceName, userAgent: c.req.header("user-agent"), user: a.user });
      return c.json({ ok: true });
    } catch (e) {
      try { log.error(`[portal] subscribe failed: ${e?.message || e}`); } catch {}
      return c.json({ ok: false, error: "failed" }, 500);
    }
  });

  app.delete("/api/portal/push/subscribe", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    const b = await c.req.json().catch(() => ({}));
    const endpoint = b?.endpoint || b?.subscription?.endpoint || c.req.query("endpoint");
    if (!endpoint) return c.json({ ok: false, error: "endpoint_required" }, 400);
    try { return c.json({ ok: true, removed: await push.unsubscribe(endpoint, a.user.role === "manager" ? null : a.user.id) }); }
    catch { return c.json({ ok: false, error: "failed" }, 500); }
  });

  app.post("/api/portal/push/test", async (c) => {
    const a = await requirePortal(c, "manager"); if (a.res) return a.res;
    const b = await c.req.json().catch(() => ({}));
    const endpoint = b?.endpoint || b?.subscription?.endpoint || null;
    const res = await push.test(a.user, endpoint);
    return c.json({ ok: res.sent > 0, ...res });
  });

  /* ── تقارير الأونلاين (مدير) ── */
  app.get("/api/portal/reports", async (c) => {
    const a = await requirePortal(c, "manager"); if (a.res) return a.res;
    const range = parseRange(c.req.query("from"), c.req.query("to"), now());
    if (!range.ok) return c.json({ ok: false, ...range }, 400);
    try {
      const report = await buildReport(pool, range, log);
      return c.json({ ok: true, ...report });
    } catch (e) {
      try { log.error(`[portal] reports failed: ${e?.message || e}`); } catch {}
      return c.json({ ok: false, error: "report_failed" }, 500);
    }
  });

  /* ── «مش عايز رسايل» (١٧ سبتمبر ٢٠٢٦، طلب عمر) ──
     الكاشير/المدير بيسجّل رقم العميل اللي قال مايبيش عروض. نفس جدول الإيقاف
     (cms_contacts) اللي الحملات والأتمتة واسترداد السلة بيستبعدوا منه.
     الشيل مسموح بس للي اتسجّل من البوابة (غلطة كاشير) — اللي العميل أوقفه
     بنفسه من الرابط مابيرجعش غير بطلبه هو. العرض دايماً بالرقم مخفي. */
  let optoutReady = null;
  const ensureOptout = () => (optoutReady ||= pool.query(`
    CREATE TABLE IF NOT EXISTS cms_contacts (phone_norm TEXT PRIMARY KEY, optout_code TEXT UNIQUE NOT NULL, opted_out_at TIMESTAMPTZ);
    ALTER TABLE cms_contacts ADD COLUMN IF NOT EXISTS optout_source TEXT;
    ALTER TABLE cms_contacts ADD COLUMN IF NOT EXISTS optout_reason TEXT;
    ALTER TABLE cms_contacts ADD COLUMN IF NOT EXISTS optout_by TEXT;
    CREATE TABLE IF NOT EXISTS cms_optout_log (
      id SERIAL PRIMARY KEY, phone_norm TEXT NOT NULL, action TEXT NOT NULL, source TEXT, reason TEXT, actor TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE cms_optout_log ADD COLUMN IF NOT EXISTS ua TEXT;
  `).catch((e) => { optoutReady = null; throw e; }));
  const normPn = (p) => {
    const d = String(p || "").replace(/[٠-٩]/g, (x) => "٠١٢٣٤٥٦٧٨٩".indexOf(x)).replace(/\D/g, "")
      .replace(/^00/, "").replace(/^966/, "").replace(/^0/, "");
    return /^5\d{8}$/.test(d) ? d : null;
  };
  const maskPn = (pn) => `05${"•".repeat(5)}${String(pn).slice(-2)}`;

  /* تشغيل يدوي لتصليح أسماء الأصناف (للمدير) — بيتنفّذ تلقائي بعد كل نشر
     كمان. بيرجّع كام طلب وكام سطر اتصلّحوا. */
  app.post("/api/portal/item-names/backfill", async (c) => {
    const a = await requirePortal(c, "manager"); if (a.res) return a.res;
    const days = Math.min(365, Math.max(1, Number(c.req.query("days")) || 90));
    try {
      const r = await backfillItemNames(pool, names, { days, limit: 1000, log });
      return c.json({ ok: true, days, ...r, cached: names.size() });
    } catch (e) {
      try { log.error(`[portal] backfill failed: ${e?.message || e}`); } catch {}
      return c.json({ ok: false, error: "backfill_failed" }, 500);
    }
  });

  /* المنطق المشترك بين البوابة (requirePortal) واللوحة (requireAdmin، قسم
     «العملاء») — نفس القواعد بالظبط، والفرق الوحيد مين الفاعل. كل دالة بترجّع
     { status, body }. */
  const optKey = (pn) => crypto.createHash("sha1").update("optout:" + pn).digest("hex").slice(0, 12);
  const actorName = (user) => user?.name || user?.id || "—";
  async function optoutList() {
    await ensureOptout();
    const r = await pool.query(
      `SELECT phone_norm, opted_out_at, optout_source, optout_reason, optout_by FROM cms_contacts
        WHERE opted_out_at IS NOT NULL ORDER BY opted_out_at DESC LIMIT 200`);
    const total = (await pool.query("SELECT count(*)::int n FROM cms_contacts WHERE opted_out_at IS NOT NULL")).rows[0]?.n || 0;
    /* آخر التغييرات (إيقاف/رجوع/شيل) من السجل — عشان «رجع من الشيك أوت»
       (checkout_optin) و«رجّعه موظف» يبانوا كمان، مش بس الموقوفين دلوقتي.
       فشل السجل مايوقّعش القايمة. */
    let recent = [];
    try {
      recent = (await pool.query(
        `SELECT phone_norm, action, source, reason, actor, created_at FROM cms_optout_log
          WHERE action <> 'view' ORDER BY created_at DESC LIMIT 50`)).rows.map((x) => ({
        phone: maskPn(x.phone_norm), action: x.action, source: x.source || "", note: x.reason || "",
        by: x.actor || "", at: x.created_at }));
    } catch { /* السجل اختياري */ }
    return { status: 200, body: { ok: true, total, list: r.rows.map((x) => ({
      key: optKey(x.phone_norm),
      phone: maskPn(x.phone_norm), at: x.opted_out_at, source: x.optout_source || "link",
      reason: x.optout_reason || "", by: x.optout_by || "", removable: x.optout_source === "staff" })), recent } };
  }
  async function optoutAdd(user, b, ip) {
    const pn = normPn(b?.phone);
    if (!pn) return { status: 400, body: { ok: false, error: "bad_phone", message: "رقم الجوال مش صحيح" } };
    const reason = String(b?.reason || "").trim().slice(0, 120) || null;
    await ensureOptout();
    await pool.query(
      `INSERT INTO cms_contacts(phone_norm, optout_code, opted_out_at, optout_source, optout_reason, optout_by)
       VALUES ($1, substr(md5(random()::text || $1 || clock_timestamp()::text), 1, 10), NOW(), 'staff', $2, $3)
       ON CONFLICT (phone_norm) DO UPDATE SET
         opted_out_at = COALESCE(cms_contacts.opted_out_at, NOW()),
         optout_source = CASE WHEN cms_contacts.opted_out_at IS NULL THEN 'staff' ELSE cms_contacts.optout_source END,
         optout_reason = COALESCE($2, cms_contacts.optout_reason),
         optout_by = CASE WHEN cms_contacts.opted_out_at IS NULL THEN $3 ELSE cms_contacts.optout_by END
       RETURNING (xmax = 0) AS inserted`, [pn, reason, actorName(user)]);
    await pool.query("INSERT INTO cms_optout_log(phone_norm, action, source, reason, actor) VALUES ($1,'optout','staff',$2,$3)",
      [pn, reason, actorName(user)]).catch(() => {});
    audit(user, "sms_optout", null, true, { phone: maskPn(pn) }, ip, { emit: false });
    return { status: 200, body: { ok: true, phone: maskPn(pn) } };
  }
  async function optoutRemove(user, keyRaw, ip) {
    const key = String(keyRaw || "").slice(0, 20);
    await ensureOptout();
    const rows = (await pool.query("SELECT phone_norm, optout_source FROM cms_contacts WHERE opted_out_at IS NOT NULL")).rows;
    const hit = rows.find((x) => optKey(x.phone_norm) === key);
    if (!hit) return { status: 404, body: { ok: false, error: "not_found" } };
    if (hit.optout_source !== "staff") {
      return { status: 409, body: { ok: false, error: "customer_optout", message: "العميل أوقف الرسايل بنفسه من الرابط — مايرجعش غير بطلبه" } };
    }
    await pool.query("UPDATE cms_contacts SET opted_out_at=NULL, optout_source=NULL, optout_reason=NULL, optout_by=NULL WHERE phone_norm=$1", [hit.phone_norm]);
    await pool.query("INSERT INTO cms_optout_log(phone_norm, action, source, actor) VALUES ($1,'remove','staff',$2)",
      [hit.phone_norm, actorName(user)]).catch(() => {});
    audit(user, "sms_optout_remove", null, true, { phone: maskPn(hit.phone_norm) }, ip, { emit: false });
    return { status: 200, body: { ok: true } };
  }
  async function optoutResubscribe(user, b, ip) {
    const note = String(b?.note || "").trim().slice(0, 200);
    if (b?.consent !== true) return { status: 400, body: { ok: false, error: "consent_required", message: "لازم تأكد إن العميل وافق" } };
    if (note.length < 3) return { status: 400, body: { ok: false, error: "note_required", message: "اكتب ملاحظة: العميل وافق إزاي وإمتى" } };
    await ensureOptout();
    let pn = null;
    if (b?.key) {
      const key = String(b.key).slice(0, 20);
      const rows = (await pool.query("SELECT phone_norm FROM cms_contacts WHERE opted_out_at IS NOT NULL")).rows;
      pn = rows.find((x) => optKey(x.phone_norm) === key)?.phone_norm || null;
    } else pn = normPn(b?.phone);
    if (!pn) return { status: 404, body: { ok: false, error: "not_found", message: "الرقم مش موجود في قايمة الموقوفين" } };
    const r = await pool.query(
      `UPDATE cms_contacts SET opted_out_at=NULL, optout_source=NULL, optout_reason=NULL, optout_by=NULL
        WHERE phone_norm=$1 AND opted_out_at IS NOT NULL RETURNING 1`, [pn]);
    if (!r.rowCount) return { status: 409, body: { ok: false, error: "not_opted_out", message: "الرقم ده مشترك أصلاً" } };
    await pool.query("INSERT INTO cms_optout_log(phone_norm, action, source, reason, actor) VALUES ($1,'resubscribe','staff_verbal',$2,$3)",
      [pn, note, actorName(user)]).catch(() => {});
    audit(user, "sms_resubscribe", null, true, { phone: maskPn(pn), note }, ip, { emit: false });
    return { status: 200, body: { ok: true, phone: maskPn(pn) } };
  }
  const send = (c, r) => c.json(r.body, r.status);
  const ipOf = (c) => clientIp((n) => c.req.header(n));

  app.get("/api/portal/sms-optout", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    return send(c, await optoutList());
  });
  app.post("/api/portal/sms-optout", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    return send(c, await optoutAdd(a.user, await c.req.json().catch(() => ({})), ipOf(c)));
  });
  app.delete("/api/portal/sms-optout/:key", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    return send(c, await optoutRemove(a.user, c.req.param("key"), ipOf(c)));
  });
  /* «رجّع الاشتراك (العميل وافق)» — ١٧/٩: اللي أوقف بنفسه مايرجعش غير بموافقته.
     الموظف لازم يأكد إن العميل وافق شفهياً (consent=true) ويكتب ملاحظة (مين/إمتى).
     بالمفتاح (صف في القايمة) أو بالرقم (العميل قدّامه ومش في أول ٢٠٠). */
  app.post("/api/portal/sms-optout/resubscribe", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    return send(c, await optoutResubscribe(a.user, await c.req.json().catch(() => ({})), ipOf(c)));
  });

  /* نفس القايمة من لوحة المتجر (١٨/٩) — requireAdmin، وcms.js بيصنّف
     /api/cms/sms-optout «عملاء»: العرض محتاج «عرض»، والتسجيل/الإرجاع «تعديل».
     نفس الدوال اللي فوق بالحرف — الفرق الوحيد إن الفاعل عضو فريق اللوحة. */
  const dashUser = async (c) => {
    let u = null;
    try { u = await deps.cmsWhoami?.(c); } catch { /* */ }
    return { id: u?.id != null ? `cms:${u.id}` : "admin", name: u?.name || u?.username || "اللوحة", role: "dashboard" };
  };
  app.get("/api/cms/sms-optout", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return send(c, await optoutList());
  });
  app.post("/api/cms/sms-optout", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return send(c, await optoutAdd(await dashUser(c), await c.req.json().catch(() => ({})), ipOf(c)));
  });
  app.delete("/api/cms/sms-optout/:key", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return send(c, await optoutRemove(await dashUser(c), c.req.param("key"), ipOf(c)));
  });
  app.post("/api/cms/sms-optout/resubscribe", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return send(c, await optoutResubscribe(await dashUser(c), await c.req.json().catch(() => ({})), ipOf(c)));
  });

  /* أداء المندوب + أزمنة الأونلاين للوحة (تقرير المتجر ومراقب الطلبات) — نفس
     buildReport بتاع تقارير البوابة بالحرف، مفيش نسخة تانية من الاستعلامات.
     /api/cms/ops/* = قسم «الطلبات» (عرض). */
  app.get("/api/cms/ops/courier-report", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const range = parseRange(c.req.query("from"), c.req.query("to"), now());
    if (!range.ok) return c.json({ ok: false, ...range }, 400);
    try {
      const report = await buildReport(pool, range, log);
      return c.json({ ok: true, range: report.range, times: report.times, courierPerf: report.courierPerf,
        delivery: report.delivery, ...(report.partial ? { partial: report.partial } : {}) });
    } catch (e) {
      try { log.error(`[portal] courier-report failed: ${e?.message || e}`); } catch {}
      return c.json({ ok: false, error: "report_failed" }, 500);
    }
  });

  /* ── حالة البوابة (مدير) ── */
  app.get("/api/portal/health", async (c) => {
    const a = await requirePortal(c, "manager"); if (a.res) return a.res;
    let devices = [];
    try { devices = await push.devices(); } catch {}
    return c.json({ ok: true, streams: hub.clients.size, push: { ...push.stats },
      devices: devices.map((d) => ({ id: d.id, staffName: d.staff_name, role: d.role, deviceName: d.device_name,
        failCount: d.fail_count, lastOkAt: d.last_ok_at, updatedAt: d.updated_at })) });
  });

  /* ── موظفو البوابة (المالك من اللوحة — requireAdmin، قسم «الإعدادات») ── */
  app.get("/api/portal/staff", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await getSettingsData();
    const list = normStaffList(s?.portal?.staff);
    return c.json({ ok: true, staff: list.map(({ pinHash, ...x }) => x), sharedPinActive: !list.length });
  });

  app.put("/api/portal/staff", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    if (!Array.isArray(b?.staff) || b.staff.length > 50) return c.json({ ok: false, error: "bad_body" }, 400);
    const s = await getSettingsData();
    const old = new Map(normStaffList(s?.portal?.staff).map((x) => [x.id, x]));
    const next = [];
    const newPins = [];
    for (const e of b.staff) {
      const name = String(e?.name || "").trim().slice(0, 60);
      const role = ROLES.includes(e?.role) ? e.role : null;
      if (!name || !role) return c.json({ ok: false, error: "bad_staff", message: "كل موظف محتاج اسم ودور (cashier/manager/kitchen)" }, 400);
      const id = e?.id && old.has(String(e.id)) ? String(e.id) : `st_${crypto.randomBytes(4).toString("hex")}`;
      let pinHash = old.get(id)?.pinHash || null;
      if (e?.pin != null && e.pin !== "") {
        if (!validPin(e.pin)) return c.json({ ok: false, error: "bad_pin", message: "الرقم السري ٤–٨ أرقام" }, 400);
        pinHash = hashPin(String(e.pin));
        newPins.push({ id, pin: String(e.pin) });
      }
      if (!pinHash) return c.json({ ok: false, error: "pin_required", message: `${name}: محتاج رقم سري` }, 400);
      next.push({ id, name, role, pinHash });
    }
    // رقم سري واحد مايتكررش بين موظفين (الدخول بالرقم بس)
    for (const np of newPins) {
      if (next.some((x) => x.id !== np.id && verifyPin(np.pin, x.pinHash))) {
        return c.json({ ok: false, error: "duplicate_pin", message: "الرقم السري ده مستخدم لموظف تاني" }, 409);
      }
    }
    await pool.query(
      `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{portal}',
              COALESCE(data->'portal','{}'::jsonb) || $1::jsonb) WHERE id=1`,
      [JSON.stringify({ staff: next })]);
    idsCache = { at: 0, ids: null };
    return c.json({ ok: true, staff: next.map(({ pinHash, ...x }) => x) });
  });

  /* «الأصناف»: المدير يقفل/يفتح صنف خلص (soldout.js). القراية للكل. */
  const soldOut = registerSoldOut(app, {
    pool, getSettingsData, requireAdmin, requirePortal, audit, log, now, fetchMenu: deps.fetchMenu,
    cmsWho: async (c) => { try { const u = await deps.cmsWhoami?.(c); return u?.name || u?.username || null; } catch { return null; } },
  });

  return {
    soldOut,
    requirePortal, audit,
    tabsenseDown: (detail) => push.tabsenseDown(detail).catch(() => null),
    pollNewOrders, scan, refresh, loadFeed, loadInfo, push, hub, limiter, scheduleRefresh,
    stop() {
      try { unsub?.(); } catch {}
      clearInterval(pollTimer);
      clearInterval(hub.scanTimer);
      clearTimeout(hub.flushTimer);
      for (const cl of [...hub.clients]) cl.close();
    },
  };
}
