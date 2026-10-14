/* ═══════════════════════════════════════════════════════════════════════════
   الوقت المتوقع الذكي — DB + الجوب الليلي + راوتات الإدارة (الحساب كله في smarteta-core.js، صافي ومتختبر).

   • الموديل بيتبني كل ليلة ٠٥:٠٠ الرياض (بعد قفل اليوم التشغيلي ٠٤:٠٠) من آخر historyDays يوم، ويتخزّن في eta_models
     (جدول صغير: المعاملات + الاختبار على التاريخ). عند الإقلاع بنقرا آخر واحد. مفيش موديل/عيّنة قليلة ⇒ COLD_START من التحليل.
   • صفحة التتبع بتسأل `smartTrackContext(row)` (الموديل + الإعدادات + مدة جوجل المحفوظة + زحمة المطبخ) — من غير أي طلب لجوجل:
     المدة من delivery_quote.driveMin (بتتحفظ وقت التسعير من نفس رد جوجل) وإلا geo_drive_cache (نفس كاش التسعير).
   • كل وعد العميل شافه بيتسجّل في eta_shown (أول وعد، آخر وعد، أول وعد بعد الاستلام، وعد الواتساب) — ومنه «دقة الوقت المتوقع».
   كل الاستعلامات هنا قراية، ماعدا eta_models / eta_shown (جداولنا).
═══════════════════════════════════════════════════════════════════════════ */
import { fitModel, backtest, activeModel, smartEtaCfg, riyadh, COLD_START, SMART_ETA_DEFAULTS, MIX_KEYS, MIX_LABELS } from "./smarteta-core.js";
import { cacheKey } from "./drivedist.js";
import { bizDaySql } from "./bizday.js";

const HISTORY_DAYS = 60;
const MODELS_KEEP = 30;

let RT = null;   // runtime: {pool, getSettingsData, learned, ...}
export const smartRuntime = () => RT;

const num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const ms = (v) => { if (v == null || v === "") return null; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };

/* ── عيّنات التعلّم ─────────────────────────────────────────────────────
   طلبات الموقع المتسلّمة (توصيل + استلام)، مش تجربة، مش طاولة، مش مجدولة. paid من history (مفيش عمود). الشحنة = آخر تسليم
   مش يدوي (الطلب اللي اتبعت مرتين بيتحسب مرة بالتسليم اللي العميل عاشه). load = طلبات نقطة البيع كلها (كل القنوات) آخر ٣٠ د قبل الدفع. */
export const SAMPLES_SQL = `
WITH o AS (
  SELECT s.order_no, s.option, s.items, s.subtotal::float8 AS subtotal, s.accepted_at, s.pos_ready_at, s.collected_at, s.created_at,
         s.address->>'latitude' AS lat1, s.address->>'longitude' AS lng1, s.address->>'lat' AS lat2, s.address->>'lng' AS lng2,
         s.delivery_quote->>'routeKm' AS route_km, s.delivery_quote->>'distanceKm' AS dist_km, s.delivery_quote->>'driveMin' AS drive_min,
         (SELECT min((h->>'at')::timestamptz)
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.history)='array' THEN s.history ELSE '[]'::jsonb END) h
           WHERE h->>'status' = 'paid' AND (h->>'at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}') AS paid_at
    FROM shop_orders s
   WHERE s.status = 'delivered' AND NOT COALESCE(s.is_test, false) AND COALESCE(s.table_no, 0) = 0 AND s.scheduled_for IS NULL
     AND s.option IN ('delivery','pickup') AND s.created_at > NOW() - make_interval(days => $1::int)
),
sh AS (
  SELECT DISTINCT ON (x.shop_order_no) x.shop_order_no, x.provider, x.created_at AS requested_at, x.assigned_at, x.arrived_at, x.picked_at, x.delivered_at, x.our_km
    FROM dl_shipments x
   WHERE x.delivered_at IS NOT NULL AND x.provider <> 'manual'
   ORDER BY x.shop_order_no, x.delivered_at DESC
)
SELECT o.*, COALESCE(o.paid_at, o.created_at) AS paid, sh.provider, sh.requested_at, sh.assigned_at, sh.arrived_at, sh.picked_at, sh.delivered_at, sh.our_km::float8 AS our_km,
       (SELECT count(*)::int FROM ts_orders t WHERE t.order_date > COALESCE(o.paid_at, o.created_at) - interval '30 minutes' AND t.order_date <= COALESCE(o.paid_at, o.created_at)
          AND COALESCE(t.order_status, 0) <> 3) AS load,
       ${bizDaySql("COALESCE(o.paid_at, o.created_at)")}::text AS biz_day
  FROM o LEFT JOIN sh ON sh.shop_order_no = o.order_no
 ORDER BY paid`;

export function latLngOf(r) {
  const lat = num(r.lat1 ?? r.lat2), lng = num(r.lng1 ?? r.lng2);
  return lat != null && lng != null && lat && lng ? { lat, lng } : null;
}
export function rowsToSamples(rows, durByKey = new Map()) {
  const out = [];
  for (const r of rows || []) {
    const paidAt = ms(r.paid);
    if (!paidAt) continue;
    if (r.option === "delivery" && !(ms(r.delivered_at) && ms(r.picked_at))) continue;
    const ll = latLngOf(r);
    const dq = num(r.drive_min);
    const dc = ll ? durByKey.get(cacheKey(ll.lat, ll.lng)) : null;
    const total = r.option === "delivery" ? (ms(r.delivered_at) - paidAt) / 60000 : null;
    if (total != null && (total <= 0 || total > 240)) continue;     // حادثة مش توصيلة (طلب ضاع / اتوقف ساعات)
    out.push({
      orderNo: r.order_no, option: r.option, provider: r.provider || null, bizDay: r.biz_day || null,
      paidAt, acceptedAt: ms(r.accepted_at), readyAt: ms(r.pos_ready_at),
      requestedAt: ms(r.requested_at), assignedAt: ms(r.assigned_at), arrivedAt: ms(r.arrived_at), pickedAt: ms(r.picked_at),
      deliveredAt: r.option === "delivery" ? ms(r.delivered_at) : null,
      items: r.items, load: Number(r.load) || 0, subtotal: num(r.subtotal),
      gMin: dq != null && dq > 0 ? dq : (dc != null && dc > 0 ? dc / 60 : null),
      routeKm: num(r.route_km) || num(r.our_km) || num(r.dist_km),
    });
  }
  return out;
}

export function register(app, ctx = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const log = ctx.log || console;
  const settings = async () => { try { return (await getSettingsData()) || {}; } catch { return {}; } };
  RT = { pool, getSettingsData: settings, learned: null, lastError: null, building: null };

  async function ensureSchema() {
    await pool.query(`CREATE TABLE IF NOT EXISTS eta_models (
      id BIGSERIAL PRIMARY KEY, built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), n INT, model JSONB NOT NULL, backtest JSONB)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS eta_shown (
      order_no TEXT PRIMARY KEY, first_at TIMESTAMPTZ, first_high TIMESTAMPTZ, first_low TIMESTAMPTZ, first_stage TEXT, first_basis TEXT,
      last_at TIMESTAMPTZ, last_high TIMESTAMPTZ, last_stage TEXT, picked_high TIMESTAMPTZ, picked_at TIMESTAMPTZ,
      wa_high TIMESTAMPTZ, wa_at TIMESTAMPTZ, model_version TEXT, updates INT NOT NULL DEFAULT 0)`);
  }
  const schema = ensureSchema().catch((e) => { log.error?.(`[smarteta] schema: ${e.message}`); });

  async function loadLatest() {
    await schema;
    const r = await pool.query("SELECT model FROM eta_models ORDER BY id DESC LIMIT 1");
    RT.learned = r.rows[0] ? r.rows[0].model : null;
    return RT.learned;
  }

  async function gatherSamples() {
    const { rows } = await pool.query(SAMPLES_SQL, [HISTORY_DAYS]);
    const keys = [...new Set(rows.map(latLngOf).filter(Boolean).map((p) => cacheKey(p.lat, p.lng)))];
    const dur = new Map();
    if (keys.length) {
      const d = await pool.query("SELECT dest_key, duration_sec FROM geo_drive_cache WHERE dest_key = ANY($1::text[])", [keys]);
      for (const x of d.rows) if (x.duration_sec != null) dur.set(x.dest_key, Number(x.duration_sec));
    }
    return rowsToSamples(rows, dur);
  }

  async function build(reason = "nightly") {
    if (RT.building) return RT.building;
    RT.building = (async () => {
      await schema;
      const st = await settings();
      const cfg = smartEtaCfg(st);
      const dispatchDelayMin = dispatchDelayFrom(st);
      const samples = await gatherSamples();
      const bizDayOf = (() => { const m = new Map(samples.map((s) => [s.paidAt, s.bizDay])); return (t) => m.get(t) || new Date(t - 3600_000).toISOString().slice(0, 10); })();
      const model = fitModel(samples, { dispatchDelayMin });
      const bt = backtest(samples, { days: 21, cfg, dispatchDelayMin, bizDayOf });
      model.backtest = bt;
      await pool.query("INSERT INTO eta_models(n, model, backtest) VALUES ($1, $2, $3)", [model.n.delivery, JSON.stringify(model), JSON.stringify(bt)]);
      await pool.query(`DELETE FROM eta_models WHERE id NOT IN (SELECT id FROM eta_models ORDER BY id DESC LIMIT ${MODELS_KEEP})`);
      RT.learned = model; RT.lastError = null;
      log.log?.(`[smarteta] ${reason}: موديل ${model.version} من ${model.n.delivery} توصيل/${model.n.prep} تحضير — اختبار ٢١ يوم: s0 ${bt.summary.s0.hitRate}، s2 ${bt.summary.s2.hitRate}`);
      return model;
    })().catch((e) => { RT.lastError = e.message; log.error?.(`[smarteta] build failed: ${e.message}`); return RT.learned; })
      .finally(() => { RT.building = null; });
    return RT.building;
  }
  RT.build = build;

  /* الجوب الليلي: ٠٥:٠٠ الرياض مرة في اليوم + عند الإقلاع لو آخر موديل أقدم من ٢٦ ساعة. */
  if (ctx.startJobs !== false) {
    const boot = setTimeout(async () => {
      try {
        const m = await loadLatest();
        if (!m || Date.now() - Date.parse(m.builtAt) > 26 * 3600_000) await build("boot");
      } catch (e) { RT.lastError = e.message; }
    }, 45_000);
    boot.unref?.();
    const t = setInterval(() => {
      const z = riyadh(Date.now());
      const sameDay = RT.learned && Date.now() - Date.parse(RT.learned.builtAt) < 20 * 3600_000;
      if (z.hour === 5 && !sameDay) build("nightly");
    }, 10 * 60_000);
    t.unref?.();
  }

  app.get("/api/delivery/smart-eta/model", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (c.req.query("refresh") === "1") await build("admin");
    else if (!RT.learned) await loadLatest().catch(() => null);
    const cfg = smartEtaCfg(await settings());
    const active = activeModel(RT.learned, cfg);
    return c.json({ ok: true, active: active.source, activeVersion: active.version, cfg, learned: RT.learned, cold: COLD_START, mixLabels: MIX_LABELS, lastError: RT.lastError });
  });

  app.get("/api/delivery/smart-eta/accuracy", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!RT.learned) await loadLatest().catch(() => null);
    const cfg = smartEtaCfg(await settings());
    const active = activeModel(RT.learned, cfg);
    let live = null;
    try { live = await accuracy(pool); } catch (e) { live = { error: e.message }; }
    return c.json({
      ok: true, live,
      backtest: RT.learned ? RT.learned.backtest || null : null,
      model: { source: active.source, version: active.version, builtAt: active.builtAt, n: active.n, window: active.window || null },
      cfg: { enabled: cfg.enabled, percentile: cfg.percentile, bufferMin: cfg.bufferMin, roundMin: cfg.roundMin },
      lastError: RT.lastError,
    });
  });

  /* «الطلب ده الوقت بتاعه جه منين» — نفس حساب صفحة التتبع بالأجزاء. */
  app.get("/api/delivery/smart-eta/explain", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = String(c.req.query("order") || "").trim().slice(0, 40);
    if (!no) return c.json({ ok: false, error: "order_required" });
    const r = await pool.query("SELECT * FROM shop_orders WHERE order_no=$1", [no]);
    if (!r.rows[0]) return c.json({ ok: false, error: "not_found" });
    const s = await pool.query("SELECT * FROM dl_shipments WHERE shop_order_no=$1 ORDER BY id DESC LIMIT 1", [no]);
    const { computeTrackEta } = await import("./tracketa.js");
    const smart = await smartTrackContext(r.rows[0]);
    const st = await settings();
    const eta = computeTrackEta({ row: r.rows[0], sh: s.rows[0] || null, settings: st, now: Date.now(), smart });
    const shown = await pool.query("SELECT * FROM eta_shown WHERE order_no=$1", [no]).catch(() => ({ rows: [] }));
    return c.json({ ok: true, eta, inputs: { gMin: smart && smart.gMin, load: smart && smart.load, model: smart && smart.model.version }, shown: shown.rows[0] || null });
  });

  return { build, loadLatest, ensureSchema: () => schema };
}

function dispatchDelayFrom(st) {
  const v = ((st || {}).delivery || {}).dispatchDelayMin;
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? 15 : Math.max(0, Math.min(90, n));
}

/* ── زحمة المطبخ دلوقتي: طلبات نقطة البيع آخر ٣٠ د (كل القنوات). كاش دقيقة. ── */
let loadCache = { at: 0, v: 0 };
async function liveLoad(pool) {
  if (Date.now() - loadCache.at < 60_000) return loadCache.v;
  try {
    /* زحمة المطبخ = طلبات نقطة البيع آخر ٣٠ د (كل القنوات، ومنها نسخ طلبات الموقع) + طلبات الموقع المفتوحة الأقدم من ٣٠ د
       (لسه مش جاهزة — مش في نافذة نقطة البيع فمابتتعدّش مرتين). */
    const r = await pool.query(`SELECT
        (SELECT count(*) FROM ts_orders WHERE order_date > NOW() - interval '30 minutes' AND COALESCE(order_status,0) <> 3)
      + (SELECT count(*) FROM shop_orders WHERE status IN ('paid','pos_created','accepted','courier_requested','courier_assigned')
           AND pos_ready_at IS NULL AND NOT COALESCE(is_test,false) AND COALESCE(table_no,0) = 0
           AND created_at <= NOW() - interval '30 minutes' AND created_at > NOW() - interval '3 hours') AS n`);
    loadCache = { at: Date.now(), v: Number(r.rows[0] && r.rows[0].n) || 0 };
  } catch { loadCache = { at: Date.now(), v: loadCache.v }; }
  return loadCache.v;
}
/* مدة جوجل المحفوظة: من التسعير (driveMin) وإلا كاش جوجل بنفس مفتاح التسعير. عمرنا ما نضرب جوجل هنا. */
const durMemo = new Map();
async function gMinOf(pool, row) {
  let q = row && row.delivery_quote;
  if (typeof q === "string") { try { q = JSON.parse(q); } catch { q = null; } }
  const dq = num(q && q.driveMin);
  if (dq != null && dq > 0) return dq;
  let a = row && row.address;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = null; } }
  const lat = num(a && (a.latitude ?? a.lat)), lng = num(a && (a.longitude ?? a.lng));
  if (lat == null || lng == null || !lat || !lng) return null;
  const k = cacheKey(lat, lng);
  if (durMemo.has(k)) return durMemo.get(k);
  let v = null;
  try { const r = await pool.query("SELECT duration_sec FROM geo_drive_cache WHERE dest_key=$1", [k]); v = r.rows[0] && r.rows[0].duration_sec != null ? Number(r.rows[0].duration_sec) / 60 : null; } catch { v = null; }
  if (durMemo.size > 3000) durMemo.clear();
  durMemo.set(k, v);
  return v;
}

/* آخر «قبل الساعة» العميل شافه (ذاكرة، وإلا eta_shown.last_high) — عشان الوقت مايرقصش بين تحديث وتاني */
const deadlineMemo = new Map();
async function prevDeadline(pool, orderNo) {
  const k = String(orderNo || "");
  if (!k) return null;
  if (deadlineMemo.has(k)) return deadlineMemo.get(k);
  let v = null;
  try { const r = await pool.query("SELECT last_high FROM eta_shown WHERE order_no=$1", [k]); v = r.rows[0] && r.rows[0].last_high ? new Date(r.rows[0].last_high).getTime() : null; } catch { v = null; }
  if (deadlineMemo.size > 5000) deadlineMemo.clear();
  deadlineMemo.set(k, v);
  return v;
}

/** اللي computeTrackEta محتاجه عشان يحسب بالموديل الذكي — null لو المفتاح مقفول أو الموديول مش متسجّل. */
export async function smartTrackContext(row, settingsData = null) {
  if (!RT || !row || row.option !== "delivery") return null;
  const st = settingsData || await RT.getSettingsData();
  const cfg = smartEtaCfg(st);
  if (!cfg.enabled) return null;
  const model = activeModel(RT.learned, cfg);
  const [gMin, load, prevAt] = await Promise.all([gMinOf(RT.pool, row), liveLoad(RT.pool), prevDeadline(RT.pool, row.order_no)]);
  return { model, cfg: { ...cfg, dispatchDelayMin: dispatchDelayFrom(st) }, gMin, load, prevAt };
}

/* ── تسجيل الوعد اللي العميل شافه ─────────────────────────────────────────
   أول وعد مابيتغيّرش (ده اللي العميل بيفتكره)، والأخير بيتحدّث. كتابة لكل طلب مرة في الدقيقة على الأكتر (أو لو المرحلة/الوعد اتغيّر). */
const shownMemo = new Map();
export function recordShownEta(orderNo, eta, source = "track") {
  if (!RT || !orderNo || !eta || !eta.promise) return;
  const key = String(orderNo);
  if (source !== "wa") deadlineMemo.set(key, Date.parse(eta.promise));
  const prev = shownMemo.get(key);
  const sig = `${eta.stage}|${eta.promise}`;
  if (source === "track" && prev && prev.sig === sig && Date.now() - prev.at < 60_000) return;
  shownMemo.set(key, { sig, at: Date.now() });
  if (shownMemo.size > 5000) shownMemo.clear();
  const high = eta.promise, low = eta.low || null, stage = eta.stage || null, basis = eta.basis || null, ver = eta.model || null;
  const picked = stage === "s2" ? high : null;
  const sql = source === "wa"
    ? `INSERT INTO eta_shown(order_no, wa_high, wa_at, model_version) VALUES ($1,$2,NOW(),$3)
       ON CONFLICT (order_no) DO UPDATE SET wa_high = COALESCE(eta_shown.wa_high, EXCLUDED.wa_high), wa_at = COALESCE(eta_shown.wa_at, NOW())`
    : `INSERT INTO eta_shown(order_no, first_at, first_high, first_low, first_stage, first_basis, last_at, last_high, last_stage, picked_high, picked_at, model_version, updates)
       VALUES ($1, NOW(), $2, $4, $5, $6, NOW(), $2, $5, $7, CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE NOW() END, $3, 1)
       ON CONFLICT (order_no) DO UPDATE SET
         first_at = COALESCE(eta_shown.first_at, NOW()), first_high = COALESCE(eta_shown.first_high, EXCLUDED.first_high),
         first_low = COALESCE(eta_shown.first_low, EXCLUDED.first_low), first_stage = COALESCE(eta_shown.first_stage, EXCLUDED.first_stage),
         first_basis = COALESCE(eta_shown.first_basis, EXCLUDED.first_basis),
         last_at = NOW(), last_high = EXCLUDED.last_high, last_stage = EXCLUDED.last_stage,
         picked_high = COALESCE(eta_shown.picked_high, EXCLUDED.picked_high), picked_at = COALESCE(eta_shown.picked_at, EXCLUDED.picked_at),
         updates = eta_shown.updates + 1`;
  const args = source === "wa" ? [key.slice(0, 40), high, ver] : [key.slice(0, 40), high, ver, low, stage, basis, picked];
  RT.pool.query(sql, args).catch(() => {});
}

/* ── دقة الوقت المتوقع: الوعد اللي اتعرض vs وقت التسليم الفعلي ──
   hit = اتسلّم قبل (أو عند) الوقت اللي اتقال. errMin = التسليم − الوعد (سالب = بدري، وده المطلوب). */
export async function accuracy(pool) {
  const q = (days) => pool.query(`
    WITH d AS (
      SELECT e.*, (SELECT max(x.delivered_at) FROM dl_shipments x WHERE x.shop_order_no = e.order_no AND x.delivered_at IS NOT NULL) AS delivered_at
        FROM eta_shown e JOIN shop_orders o ON o.order_no = e.order_no
       WHERE o.status = 'delivered' AND NOT COALESCE(o.is_test,false) AND e.first_at > NOW() - make_interval(days => $1::int)
    )
    SELECT
      count(*) FILTER (WHERE delivered_at IS NOT NULL AND first_high IS NOT NULL)::int AS n_first,
      count(*) FILTER (WHERE delivered_at <= first_high)::int AS hit_first,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (delivered_at - first_high))/60) FILTER (WHERE delivered_at IS NOT NULL AND first_high IS NOT NULL) AS err_first_p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (delivered_at - first_high))/60) FILTER (WHERE delivered_at IS NOT NULL AND first_high IS NOT NULL) AS err_first_p90,
      count(*) FILTER (WHERE delivered_at IS NOT NULL AND picked_high IS NOT NULL)::int AS n_picked,
      count(*) FILTER (WHERE delivered_at <= picked_high)::int AS hit_picked,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (delivered_at - picked_high))/60) FILTER (WHERE delivered_at IS NOT NULL AND picked_high IS NOT NULL) AS err_picked_p50,
      count(*) FILTER (WHERE delivered_at IS NOT NULL AND wa_high IS NOT NULL)::int AS n_wa,
      count(*) FILTER (WHERE delivered_at <= wa_high)::int AS hit_wa,
      count(*) FILTER (WHERE delivered_at > first_high + interval '10 minutes')::int AS late10_first
    FROM d`, [days]);
  const shape = (r) => {
    const rate = (h, n) => (n ? Math.round((h / n) * 100) / 100 : null);
    const f = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);
    return {
      first: { n: r.n_first, hit: r.hit_first, hitRate: rate(r.hit_first, r.n_first), medianErrMin: f(r.err_first_p50), p90ErrMin: f(r.err_first_p90), lateOver10: r.late10_first },
      afterPickup: { n: r.n_picked, hit: r.hit_picked, hitRate: rate(r.hit_picked, r.n_picked), medianErrMin: f(r.err_picked_p50) },
      whatsapp: { n: r.n_wa, hit: r.hit_wa, hitRate: rate(r.hit_wa, r.n_wa) },
    };
  };
  const [a, b] = await Promise.all([q(7), q(30)]);
  return { d7: shape(a.rows[0] || {}), d30: shape(b.rows[0] || {}) };
}

/* ── سطر الواتساب: «يوصلك خلال 20~30 دقيقة · قبل 9:45 م» — للرسالة الحرة جوّه النافذة بس (whatsapp.js). null = مانقولش وقت. ── */
export async function etaWaLine(orderNo) {
  if (!RT || !orderNo) return null;
  const st = await RT.getSettingsData();
  const cfg = smartEtaCfg(st);
  if (!cfg.enabled || !cfg.whatsappLine) return null;
  const r = await RT.pool.query("SELECT * FROM shop_orders WHERE order_no=$1", [String(orderNo)]);
  const row = r.rows[0];
  if (!row || row.option !== "delivery" || Number(row.table_no) > 0) return null;
  const s = await RT.pool.query("SELECT * FROM dl_shipments WHERE shop_order_no=$1 ORDER BY id DESC LIMIT 1", [row.order_no]);
  const { computeTrackEta } = await import("./tracketa.js");
  const smart = await smartTrackContext(row, st);
  if (!smart) return null;
  const eta = computeTrackEta({ row, sh: s.rows[0] || null, settings: st, now: Date.now(), smart });
  if (!eta || !eta.promise || eta.soon || !eta.window) return null;
  recordShownEta(row.order_no, eta, "track");      // نفس «قبل الساعة» اللي صفحة التتبع هتعرضه
  recordShownEta(row.order_no, eta, "wa");
  return `يوصلك خلال ${eta.window.text}`;
}

export { SMART_ETA_DEFAULTS, MIX_KEYS, MIX_LABELS };
