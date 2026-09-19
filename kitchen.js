/* ═══════════════════════════════════════════════════════════════════════════
   KITCHEN — شاشة المطبخ (/kitchen/ في الداشبورد) للمطعم كله (١٩ سبتمبر).
   عمر: «بورتال المطبخ … للمطعم كله مش بس طلبات المتجر … على شاشة كبيرة جوه
   المطبخ بشكل يفيد التشغيل».

   المسارات (دخول بـPIN دور «مطبخ» أو «مدير» — من /api/portal/login مع app:kitchen):
     GET  /api/kitchen/me
     GET  /api/kitchen/board          ← الشاشة بتسأل كل ~٤ ث (اللوحة متكاشة ٢ ث)
     POST /api/kitchen/orders/:key/stage {stage}  ← تقديم محلي (مابيلمسش تاب سينس)
     GET/PUT /api/kitchen/config      ← مدير/المالك: SLA + المحطات + التقديم

   المنطق كله في kitchen-core.js. هنا: القراية من الداتابيز + استطلاع API الشريك
   + كاش الأقسام/خيارات الطلب + سجل التقديم (kitchen_bumps).
   أي خطأ هنا بيتبلع — المطبخ عمره ما يوقّف طلب ولا دفع ولا مندوب.
═══════════════════════════════════════════════════════════════════════════ */

import * as orderEvents from "./order-events.js";
import { soldOutOf } from "./soldout.js";
import {
  normConfig, buildBoard, publicConfig, validBump, isStage, STAGE_AR, CHANNELS, normName,
} from "./kitchen-core.js";

export const KITCHEN_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS kitchen_bumps (
    order_key TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    by_id TEXT,
    by_name TEXT,
    history JSONB NOT NULL DEFAULT '[]'::jsonb
  )`,
  `CREATE INDEX IF NOT EXISTS kitchen_bumps_at_idx ON kitchen_bumps(at DESC)`,
  // الشاشة بتقرا آخر كام ساعة بس — من غير فهرس كل سؤال كان هيمسح الجدول كله
  `CREATE TABLE IF NOT EXISTS tsp_webhooks (id BIGSERIAL PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), event TEXT, payload JSONB)`,
  `CREATE INDEX IF NOT EXISTS tsp_webhooks_received_idx ON tsp_webhooks(received_at)`,
]);

/* آخر نسخة من كل طلب في آخر N ساعة + أول مرة شفناه */
export const WEBHOOK_SQL = `
  WITH w AS (
    SELECT id, received_at, payload->'resource'->'order'->>'id' AS oid
      FROM tsp_webhooks
     WHERE received_at > NOW() - make_interval(hours => $1::int)
       AND payload->'resource'->'order'->>'id' IS NOT NULL
  ), f AS (SELECT oid, MIN(received_at) AS first_at, MAX(id) AS last_id FROM w GROUP BY oid)
  SELECT f.oid, f.first_at, t.received_at AS last_at,
         t.payload->'resource'->'order' AS o,
         t.payload->'resource'->'statuses_slugs' AS st
    FROM f JOIN tsp_webhooks t ON t.id = f.last_id
   ORDER BY f.first_at DESC LIMIT 300`;

export const SHOP_SQL = `
  SELECT o.order_no, o.status, o.option, o.items, o.notes, o.address, o.pos_order_id,
         o.created_at, o.updated_at, o.pos_ready_at, o.accepted_at, o.is_test,
         o.delivery_quote->'farZone' AS far_zone,
         s.status AS ship_status, s.arrived_at AS ship_arrived_at, s.picked_at AS ship_picked_at
    FROM shop_orders o
    LEFT JOIN LATERAL (
      SELECT status, arrived_at, picked_at FROM dl_shipments
       WHERE shop_order_no = o.order_no ORDER BY id DESC LIMIT 1) s ON TRUE
   WHERE o.created_at > NOW() - make_interval(hours => $1::int)
     AND o.status NOT IN ('pending_payment','expired')
     AND NOT COALESCE(o.is_test, false)
   ORDER BY o.created_at DESC LIMIT 200`;

const BOARD_TTL_MS = 2_000;
const POLL_MS = () => Math.max(8_000, Number(process.env.KITCHEN_POLL_MS || 15_000));
const POLL_BACKOFF_MS = 60_000;
const META_TTL_MS = 60 * 60_000;

export function register(app, ctx, deps = {}) {
  const { pool, getSettingsData, requireAdmin } = ctx;
  const log = ctx.log || console;
  const now = deps.now || (() => Date.now());
  const portal = typeof deps.portal === "function" ? deps.portal : () => deps.portal || null;
  const tsp = typeof deps.tsp === "function" ? deps.tsp : () => deps.tsp || null;
  const emitOrder = deps.emitOrder || orderEvents.emitOrder;

  let ready = null;
  function ensureSchema() {
    if (!ready) {
      ready = (async () => { for (const sql of KITCHEN_DDL) await pool.query(sql); return true; })()
        .catch((e) => { ready = null; try { log.error(`[kitchen] schema failed: ${e?.message || e}`); } catch {} return false; });
    }
    return ready;
  }
  if (deps.ensureSchema !== false) ensureSchema();

  /* ── الدخول: نفس توكن البورتال، والمسار بيقول kitchen:true ── */
  async function requireKitchen(c, { manager = false } = {}) {
    const p = portal();
    if (p?.requirePortal) {
      const a = await p.requirePortal(c, manager ? "manager" : null, { kitchen: true });
      if (a.res) return a;
      if (!manager && !["kitchen", "manager"].includes(a.user.role)) {
        return { res: c.json({ ok: false, error: "forbidden", message: "شاشة المطبخ لحساب «مطبخ» أو «مدير»" }, 403) };
      }
      return a;
    }
    // من غير البورتال (اختبارات): مفتاح الأدمن بس
    const err = typeof requireAdmin === "function" ? await requireAdmin(c) : c.json({ ok: false }, 401);
    if (err) return { res: err };
    return { user: { id: "admin", name: "المالك", role: "manager" } };
  }

  /* ── الإعدادات ── */
  async function config() {
    try { return normConfig((await getSettingsData())?.kitchen); } catch { return normConfig({}); }
  }

  /* ── أقسام المنيو + خيارات الطلب من API الشريك (كاش ساعة) ── */
  const meta = { at: 0, catMap: {}, prodCat: {}, optionNames: {}, categories: [], products: [], loading: null };
  async function loadMeta() {
    if (meta.at && now() - meta.at < META_TTL_MS) return meta;
    if (meta.loading) return meta.loading;
    const api = tsp()?.api;
    if (!api) return meta;
    meta.loading = (async () => {
      try {
        const catMap = {};
        for (let page = 1; page <= 5; page++) {
          const r = await api(`/categories?page=${page}`);
          for (const c of r?.data || []) if (c?.id) catMap[c.id] = String(c.name || "").trim();
          const last = Number(r?.meta?.last_page || 1);
          if (page >= last) break;
        }
        const optionNames = {};
        const oo = await api("/order-options");
        for (const o of oo?.data || []) if (o?.id) optionNames[o.id] = String(o.name || "");
        // الكتالوج: صنف → قسم (عشان أصناف المتجر تتربط بنفس المحطة) + قايمة لشاشة الربط
        const prodCat = {};
        const products = [];
        for (let page = 1; page <= 5; page++) {
          const r = await api(`/products?per_page=100&page=${page}`);
          for (const pr of r?.data || []) {
            const name = String(pr?.name || "").trim();
            if (!name) continue;
            if (pr.category_id) prodCat[normName(name)] = pr.category_id;
            products.push({ name, categoryId: pr.category_id || null });
          }
          if (page >= Number(r?.meta?.last_page || 1)) break;
        }
        const count = {};
        for (const pr of products) if (pr.categoryId) count[pr.categoryId] = (count[pr.categoryId] || 0) + 1;
        const categories = Object.entries(catMap).map(([id, name]) => ({ id, name, products: count[id] || 0 }));
        Object.assign(meta, { at: now(), catMap, prodCat, optionNames, categories, products });
      } catch (e) {
        meta.at = now() - META_TTL_MS + 5 * 60_000; // نعيد بعد ٥ دقايق
        try { log.error(`[kitchen] meta failed: ${e?.message || e}`); } catch {}
      } finally { meta.loading = null; }
      return meta;
    })();
    return meta.loading;
  }

  /* ── استطلاع API الشريك: حزام فوق الـwebhook، وبيشتغل بس والشاشة مفتوحة ── */
  const poll = { at: 0, okAt: null, error: null, orders: new Map(), running: false, nextAt: 0 };
  async function runPoll() {
    const api = tsp()?.api;
    if (!api || poll.running || now() < poll.nextAt) return;
    poll.running = true;
    poll.at = now();
    try {
      const r = await api("/orders?per_page=30");
      const cutoff = now() - 12 * 3600_000;
      for (const o of r?.data || []) {
        if (!o?.id) continue;
        const prev = poll.orders.get(String(o.id));
        poll.orders.set(String(o.id), { order: o, firstSeenAt: prev?.firstSeenAt || new Date(now()).toISOString(), lastAt: new Date(now()).toISOString() });
      }
      for (const [id, v] of poll.orders) if (Date.parse(v.lastAt) < cutoff) poll.orders.delete(id);
      poll.okAt = new Date(now()).toISOString();
      poll.error = null;
      poll.nextAt = now() + POLL_MS();
    } catch (e) {
      poll.error = String(e?.code || e?.status || e?.message || e).slice(0, 80);
      poll.nextAt = now() + POLL_BACKOFF_MS; // ٤٢٩/شبكة: نهدّى — طلبات المتجر أهم من الشاشة
    } finally { poll.running = false; }
  }

  /* ── التقديم المحلي ── */
  async function loadBumps(hours) {
    try {
      await ensureSchema();
      const rows = (await pool.query(
        "SELECT order_key, stage, at, by_name FROM kitchen_bumps WHERE at > NOW() - make_interval(hours => $1::int)", [hours])).rows || [];
      return new Map(rows.map((r) => [r.order_key, { stage: r.stage, at: r.at, by: r.by_name }]));
    } catch { return new Map(); }
  }

  /* ── بناء اللوحة (كاش قصير — كل الشاشات بتشارك نفس البناء) ── */
  let cache = { at: 0, data: null, building: null };
  async function build() {
    const cfg = await config();
    const hours = cfg.windowHours;
    const q = async (sql, vals) => { try { return (await pool.query(sql, vals)).rows || []; } catch (e) { try { log.error(`[kitchen] query failed: ${e?.message || e}`); } catch {} return null; } };
    runPoll().catch(() => {}); // مابنستناهوش — نتيجته بتدخل البناء الجاي
    const [wh, shop, lastWh, bumps, m, settings] = await Promise.all([
      q(WEBHOOK_SQL, [hours]), q(SHOP_SQL, [hours]),
      q("SELECT MAX(received_at) AS at FROM tsp_webhooks WHERE received_at > NOW() - INTERVAL '2 days'"),
      loadBumps(hours + 2),
      Promise.race([loadMeta(), new Promise((r) => setTimeout(() => r(meta), 1500))]),
      getSettingsData().catch(() => ({})),
    ]);
    // دمج: webhook + الاستطلاع (الأحدث يكسب؛ أول ظهور = الأقدم)
    const byId = new Map();
    for (const r of wh || []) {
      byId.set(String(r.oid), { order: r.o, slugs: r.st || {}, firstSeenAt: r.first_at, lastAt: r.last_at, via: "webhook" });
    }
    const since = now() - hours * 3600_000;
    for (const [id, p] of poll.orders) {
      const created = Date.parse(String(p.order?.created_at || "").replace(" ", "T") + "Z");
      if (Number.isFinite(created) && created < since) continue;
      const cur = byId.get(id);
      if (!cur) { byId.set(id, { order: p.order, slugs: {}, firstSeenAt: p.firstSeenAt, lastAt: p.lastAt, via: "poll" }); continue; }
      const pu = Date.parse(String(p.order?.updated_at || "").replace(" ", "T") + "Z");
      const cu = Date.parse(String(cur.order?.updated_at || "").replace(" ", "T") + "Z");
      if (Number.isFinite(pu) && Number.isFinite(cu) && pu > cu) byId.set(id, { ...cur, order: p.order, slugs: {}, lastAt: p.lastAt, via: "poll" });
      if (Date.parse(p.firstSeenAt) < Date.parse(cur.firstSeenAt)) byId.get(id).firstSeenAt = p.firstSeenAt;
    }
    const orders = buildBoard({
      tsOrders: [...byId.values()], shopRows: shop || [], bumps, catMap: m.catMap || {}, prodCat: m.prodCat || {},
      optionNames: m.optionNames || {}, cfg, now: now(),
    });
    const soldOut = Object.entries(soldOutOf(settings, now())).map(([id, e]) => ({ id, name: e.name || `صنف #${id}`, until: e.until || null }));
    return {
      ok: true,
      now: new Date(now()).toISOString(),
      orders,
      soldOut,
      config: publicConfig(cfg),
      sync: {
        webhookAt: lastWh?.[0]?.at ? new Date(lastWh[0].at).toISOString() : null,
        pollAt: poll.okAt,
        pollError: poll.error,
        partner: Boolean(tsp()?.api),
        dbOk: wh !== null && shop !== null,
      },
    };
  }
  async function board() {
    if (cache.data && now() - cache.at < BOARD_TTL_MS) return cache.data;
    if (cache.building) return cache.building;
    cache.building = build().then((d) => { cache = { at: now(), data: d, building: null }; return d; })
      .catch((e) => { cache.building = null; throw e; });
    return cache.building;
  }

  /* ═══ المسارات ═══ */
  app.get("/api/kitchen/me", async (c) => {
    const a = await requireKitchen(c); if (a.res) return a.res;
    return c.json({ ok: true, staffId: a.user.id, name: a.user.name, role: a.user.role,
      expiresAt: a.user.exp ? new Date(a.user.exp).toISOString() : null });
  });

  app.get("/api/kitchen/board", async (c) => {
    const a = await requireKitchen(c); if (a.res) return a.res;
    try {
      const d = await board();
      return c.json({ ...d, me: { name: a.user.name, role: a.user.role } });
    } catch (e) {
      try { log.error(`[kitchen] board failed: ${e?.message || e}`); } catch {}
      // ٢٠٠ مع ok:false: Cloudflare بيبلع الـ5xx والشاشة لازم تعرف السبب
      return c.json({ ok: false, error: "board_failed" });
    }
  });

  app.post("/api/kitchen/orders/:key/stage", async (c) => {
    const a = await requireKitchen(c); if (a.res) return a.res;
    const cfg = await config();
    if (!cfg.allowBump) return c.json({ ok: false, error: "bump_disabled", message: "التقديم مقفول من الإعدادات — الشاشة للعرض بس" }, 403);
    const key = String(c.req.param("key") || "").slice(0, 80);
    if (!/^(ts|shop):[A-Za-z0-9_-]{1,64}$/.test(key)) return c.json({ ok: false, error: "bad_key" }, 400);
    const b = await c.req.json().catch(() => ({}));
    const stage = String(b?.stage || "");
    if (!isStage(stage)) return c.json({ ok: false, error: "bad_stage" }, 400);
    let d;
    try { d = await board(); } catch { return c.json({ ok: false, error: "unavailable" }, 503); }
    const o = (d.orders || []).find((x) => x.key === key);
    if (o && !validBump(o.sourceStage, stage)) {
      return c.json({ ok: false, error: "behind_source", message: `الطلب ${STAGE_AR[o.sourceStage]} على نقطة البيع — مايرجعش لورا` }, 409);
    }
    try {
      await ensureSchema();
      const entry = { stage, at: new Date(now()).toISOString(), by: a.user.name || null };
      await pool.query(
        `INSERT INTO kitchen_bumps(order_key, stage, at, by_id, by_name, history)
         VALUES ($1,$2,NOW(),$3,$4,jsonb_build_array($5::jsonb))
         ON CONFLICT (order_key) DO UPDATE SET stage=$2, at=NOW(), by_id=$3, by_name=$4,
           history = (kitchen_bumps.history || jsonb_build_array($5::jsonb))`,
        [key, stage, a.user.id || null, a.user.name || null, JSON.stringify(entry)]);
    } catch (e) {
      try { log.error(`[kitchen] bump failed: ${e?.message || e}`); } catch {}
      return c.json({ ok: false, error: "failed" }, 500);
    }
    cache = { at: 0, data: null, building: null };
    // طلب متجرنا: السطر يبان في الخط الزمني بتاع البورتال (للكاشير) — من غير أي تغيير حالة
    if (key.startsWith("shop:") && (stage === "ready" || stage === "prep")) {
      try {
        emitOrder("staff_action", {
          orderNo: key.slice(5), source: "kitchen", ok: true,
          actor: { id: a.user.id, name: a.user.name, role: a.user.role },
          summary: stage === "ready" ? "المطبخ: الطلب جاهز ✅" : "المطبخ: بدأ التحضير",
          data: { action: stage === "ready" ? "kitchen_ready" : "kitchen_prep", via: "kitchen" },
        });
      } catch {}
    }
    try { portal()?.audit?.(a.user, "kitchen_stage", null, true, { key, stage }, null, { emit: false }); } catch {} // مش على الطلب — الحدث فوق هو اللي بيظهر في الخط الزمني
    return c.json({ ok: true, key, stage });
  });

  app.get("/api/kitchen/config", async (c) => {
    const a = await requireKitchen(c, { manager: true }); if (a.res) return a.res;
    const cfg = await config();
    const m = await Promise.race([loadMeta(), new Promise((r) => setTimeout(() => r(meta), 2500))]);
    return c.json({ ok: true, config: cfg, categories: m.categories || [], products: m.products || [], channels: CHANNELS });
  });

  app.put("/api/kitchen/config", async (c) => {
    const a = await requireKitchen(c, { manager: true }); if (a.res) return a.res;
    const b = await c.req.json().catch(() => ({}));
    const cfg = normConfig(b?.config || b);
    try {
      await pool.query(
        `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{kitchen}', $1::jsonb) WHERE id=1`,
        [JSON.stringify(cfg)]);
    } catch (e) {
      return c.json({ ok: false, error: "failed" }, 500);
    }
    cache = { at: 0, data: null, building: null };
    try { portal()?.audit?.(a.user, "kitchen_config", null, true, { slaAmberMin: cfg.slaAmberMin, slaRedMin: cfg.slaRedMin, allowBump: cfg.allowBump }, null, { emit: false }); } catch {}
    return c.json({ ok: true, config: cfg });
  });

  return { board, build, runPoll, loadMeta, config, poll, meta };
}
