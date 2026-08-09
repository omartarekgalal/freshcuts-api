/* ═══════════════════════════════════════════════════════════════════════════
   TRACKING HEALTH — one honest picture of every tracking mechanism we run.

   GET /api/tracking/health?days=7      (admin)

   The rule for this file: a green tick that is not true is worse than a red
   cross. Every number below is read back from the place the event actually
   went — our own send log, or the platform's own answer that we stored at the
   time — and anything we cannot verify is reported as unverified, not as OK.

   THE FOUR PIPELINES IT REPORTS ON
     1. WEB      funnel_events — PageView/ViewContent/AddToCart/InitiateCheckout
                 /Contact/Lead/Purchase fired from order.o2m8.me. Each row's
                 `results` column holds what each platform answered, verbatim.
     2. OFFLINE  ads_events — the POS → CAPI Purchase pipeline. action_source
                 = physical_store, which is the truth about a till sale.
     3. AUDIENCES aud_audiences / aud_syncs — the retargeting segments.
     4. CATALOG  the live product feed + how many purchased line items actually
                 resolve to a product id in it.

   MET A's OWN VIEW. /{dataset}/stats never shows physical_store events, so a
   dashboard built on it would show "0 purchases" forever and be wrong. The
   surface that does see them is the dataset node itself — valid_entries,
   matched_entries and event_stats — so that is what we read, and we label it
   as Meta's own count rather than ours.
═══════════════════════════════════════════════════════════════════════════ */

import { byId, httpJson } from "./ads.js";

const PLATFORMS = ["meta", "tiktok", "snapchat"];
const WEB_EVENTS = ["PageView", "ViewContent", "AddToCart", "InitiateCheckout", "Contact", "Lead", "Purchase"];

const PLAT_AR = { meta: "ميتا", tiktok: "تيك توك", snapchat: "سناب شات" };
const EVENT_AR = {
  PageView: "زيارة صفحة", ViewContent: "شاهد صنف", AddToCart: "إضافة للسلة",
  InitiateCheckout: "بدأ الطلب", Contact: "ضغط واتساب/اتصال", Lead: "عميل محتمل",
  Purchase: "شراء",
};

const env = (k) => (process.env[k] || "").trim();

/* One row of `results` looks like {"meta":{"sent":true},"tiktok":{"error":"…"}}.
   Turn it into accepted / rejected / skipped plus the platform's own words. */
function readResult(results, platform) {
  const r = results && typeof results === "object" ? results[platform] : null;
  if (!r) return { state: "missing", error: null };
  if (r.sent) return { state: "accepted", error: null };
  if (r.skipped) return { state: "skipped", error: String(r.skipped) };
  if (r.error) return { state: "rejected", error: String(r.error) };
  return { state: "missing", error: null };
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin } = ctx;
  const adsApi = deps.ads || null;          // { matchToCatalog } — same code the payload uses
  const catalogApi = deps.catalog || null;  // { menuRows }

  /* ── Meta's own acknowledgement of the offline events ─────────────────
     Best-effort: a token problem must degrade this block, never the route. */
  async function metaDataset() {
    const pixel = env("META_PIXEL_ID") || env("META_WEB_PIXEL_ID");
    const token = env("META_CAPI_TOKEN");
    if (!pixel || !token) return { ok: false, reason: "لا يوجد META_PIXEL_ID / META_CAPI_TOKEN" };
    const ver = env("META_API_VERSION") || "v25.0";
    try {
      const url = `https://graph.facebook.com/${ver}/${pixel}` +
        `?fields=id,name,valid_entries,matched_entries,event_stats&access_token=${encodeURIComponent(token)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      const j = await res.json();
      if (!res.ok || j.error) return { ok: false, reason: j?.error?.message || `HTTP ${res.status}` };
      let stats = j.event_stats;
      if (typeof stats === "string") { try { stats = JSON.parse(stats); } catch { /* leave as text */ } }
      const valid = Number(j.valid_entries) || 0;
      const matched = Number(j.matched_entries) || 0;
      return {
        ok: true,
        datasetId: j.id, name: j.name,
        validEntries: valid,
        matchedEntries: matched,
        matchRate: valid ? Math.round((matched / valid) * 100) : null,
        eventStats: stats || null,
      };
    } catch (e) {
      return { ok: false, reason: String(e.message || e) };
    }
  }

  /* ── what Meta holds for the catalog, vs what we publish ──────────────
     Our feed serving 95 rows means nothing if Meta's copy still has 72. The
     scheduled fetch runs once a day, so a menu change is invisible to product
     ads until it does — and that gap was real and silent until this read it. */
  async function metaCatalog() {
    const token = env("META_CAPI_TOKEN");
    const catId = env("META_CATALOG_ID") || "27744296608525457";
    const feedId = env("META_CATALOG_FEED_ID") || "1392433232794606";
    if (!token) return { ok: false, reason: "لا يوجد META_CAPI_TOKEN" };
    const ver = env("META_API_VERSION") || "v25.0";
    try {
      const [cat, feed] = await Promise.all([
        fetch(`https://graph.facebook.com/${ver}/${catId}?fields=product_count&access_token=${encodeURIComponent(token)}`,
          { signal: AbortSignal.timeout(12000) }).then((r) => r.json()),
        fetch(`https://graph.facebook.com/${ver}/${feedId}?fields=schedule,latest_upload{end_time,error_count,warning_count,num_detected_items,num_persisted_items}&access_token=${encodeURIComponent(token)}`,
          { signal: AbortSignal.timeout(12000) }).then((r) => r.json()),
      ]);
      if (cat.error) return { ok: false, reason: cat.error.message };
      const up = feed.latest_upload || null;
      return {
        ok: true,
        productCount: Number(cat.product_count) || 0,
        lastUploadAt: up?.end_time || null,
        detected: up ? Number(up.num_detected_items) : null,
        persisted: up ? Number(up.num_persisted_items) : null,
        errors: up ? Number(up.error_count) : null,
        warnings: up ? Number(up.warning_count) : null,
        scheduleAr: feed.schedule
          ? `كل ${feed.schedule.interval === "DAILY" ? "يوم" : feed.schedule.interval} الساعة ${feed.schedule.hour}:00 (${feed.schedule.timezone})`
          : null,
      };
    } catch (e) { return { ok: false, reason: String(e.message || e) }; }
  }

  /* ── Meta's own verdict on each retargeting audience ──────────────────
     "ready for use" is Meta's wording, not ours; the size it reports is a
     privacy bucket, not a count.
     NB: one request per audience. The ?ids= batch form answers
     "The ids query parameter is deprecated in v26.0+" and returns a 500, so
     the batched version of this silently produced no verdict at all. */
  async function metaAudiences(ids) {
    const token = env("META_CAPI_TOKEN");
    if (!token || !ids.length) return {};
    const ver = env("META_API_VERSION") || "v25.0";
    const fields = "name,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status";
    const out = {};
    await Promise.all(ids.map(async (id) => {
      try {
        const url = `https://graph.facebook.com/${ver}/${id}?fields=${fields}&access_token=${encodeURIComponent(token)}`;
        const v = await fetch(url, { signal: AbortSignal.timeout(12000) }).then((r) => r.json());
        if (!v || v.error) return;
        out[id] = {
          deliveryStatus: v.delivery_status?.description || null,
          deliveryCode: v.delivery_status?.code ?? null,
          operationStatus: v.operation_status?.description || null,
          sizeLower: v.approximate_count_lower_bound ?? null,
          sizeUpper: v.approximate_count_upper_bound ?? null,
        };
      } catch { /* one audience failing must not blank the rest */ }
    }));
    return out;
  }

  /* ── Snapchat's own verdict on each segment ───────────────────────────
     Snap reports approximate_number_users in coarse buckets and returns 0 for
     a segment below the size it will serve to. A 0 here does NOT mean the
     upload failed — the upload log says whether it did — it means the segment
     is too small for Snap to target. Two very different facts, and the owner
     needs to be able to tell them apart. */
  async function snapAudiences(ids) {
    if (!ids.length) return {};
    try {
      const snap = byId("snapchat");
      const t = snap ? await snap.token() : null;
      if (!t) return {};
      const out = {};
      for (const id of ids) {
        const res = await httpJson(`https://adsapi.snapchat.com/v1/segments/${id}`, {
          headers: { Authorization: `Bearer ${t}` }, timeout: 10000,
        });
        const s = res.json?.segments?.[0]?.segment;
        if (!s) continue;
        out[id] = {
          status: s.status || null,
          uploadStatus: s.upload_status || null,
          approxUsers: s.approximate_number_users ?? null,
        };
      }
      return out;
    } catch { return {}; }
  }

  /* ── the web funnel, per event × per platform ─────────────────────────── */
  async function webMatrix(days) {
    const rows = await pool.query(
      `SELECT event_name, results, created_at,
              (created_at > NOW() - interval '24 hours') AS is24h,
              (phone_norm IS NOT NULL AND phone_norm <> '') AS has_phone,
              (contents IS NOT NULL) AS has_contents,
              (click_ids->>'fbc' IS NOT NULL OR click_ids->>'ttclid' IS NOT NULL
               OR click_ids->>'scid' IS NOT NULL) AS has_clickid
         FROM funnel_events
        WHERE created_at > NOW() - ($1 || ' days')::interval`, [String(days)]);

    const cells = {};       // "Event|platform" → counters
    const identity = { total: 0, withPhone: 0, withContents: 0, withClickId: 0 };
    const eventTotals = {};

    for (const row of rows.rows) {
      const name = row.event_name;
      eventTotals[name] = eventTotals[name] || { d7: 0, d1: 0 };
      eventTotals[name].d7++;
      if (row.is24h) eventTotals[name].d1++;
      identity.total++;
      if (row.has_phone) identity.withPhone++;
      if (row.has_contents) identity.withContents++;
      if (row.has_clickid) identity.withClickId++;

      for (const p of PLATFORMS) {
        const key = `${name}|${p}`;
        const c = cells[key] || (cells[key] = {
          event: name, eventAr: EVENT_AR[name] || name, platform: p, platformAr: PLAT_AR[p],
          sent24h: 0, accepted24h: 0, rejected24h: 0,
          sent7d: 0, accepted7d: 0, rejected7d: 0, skipped7d: 0,
          lastError: null, lastErrorAt: null,
        });
        const r = readResult(row.results, p);
        if (r.state === "missing") continue;
        c.sent7d++;
        if (row.is24h) c.sent24h++;
        if (r.state === "accepted") { c.accepted7d++; if (row.is24h) c.accepted24h++; }
        else if (r.state === "rejected") {
          c.rejected7d++; if (row.is24h) c.rejected24h++;
          if (!c.lastErrorAt || row.created_at > c.lastErrorAt) { c.lastError = r.error; c.lastErrorAt = row.created_at; }
        } else if (r.state === "skipped") { c.skipped7d++; }
      }
    }
    return { cells: Object.values(cells), identity, eventTotals };
  }

  /* ── the POS → CAPI offline pipeline ──────────────────────────────────── */
  async function offlineMatrix(days) {
    const r = await pool.query(
      `SELECT platform, event_name, status,
              count(*)::int AS n,
              count(*) FILTER (WHERE created_at > NOW() - interval '24 hours')::int AS n24,
              max(created_at) AS last_at
         FROM ads_events
        WHERE created_at > NOW() - ($1 || ' days')::interval
        GROUP BY 1,2,3`, [String(days)]);

    const err = await pool.query(
      `SELECT platform, event_name, response, created_at
         FROM ads_events
        WHERE status = 'failed' AND created_at > NOW() - ($1 || ' days')::interval
        ORDER BY created_at DESC LIMIT 60`, [String(days)]);
    const lastErr = new Map();
    for (const e of err.rows) {
      const k = `${e.event_name}|${e.platform}`;
      if (!lastErr.has(k)) lastErr.set(k, { text: errText(e.response), at: e.created_at });
    }

    const cells = {};
    for (const row of r.rows) {
      const k = `${row.event_name}|${row.platform}`;
      const c = cells[k] || (cells[k] = {
        event: row.event_name, eventAr: EVENT_AR[row.event_name] || row.event_name,
        platform: row.platform, platformAr: PLAT_AR[row.platform] || row.platform,
        sent24h: 0, accepted24h: 0, rejected24h: 0,
        sent7d: 0, accepted7d: 0, rejected7d: 0, skipped7d: 0, pending7d: 0,
        lastAt: null, lastError: null,
      });
      c.sent7d += row.n; c.sent24h += row.n24;
      if (row.status === "sent") { c.accepted7d += row.n; c.accepted24h += row.n24; }
      else if (row.status === "failed") { c.rejected7d += row.n; c.rejected24h += row.n24; }
      else if (row.status === "skipped") c.skipped7d += row.n;
      else if (row.status === "pending") c.pending7d += row.n;
      if (!c.lastAt || row.last_at > c.lastAt) c.lastAt = row.last_at;
      const le = lastErr.get(k);
      if (le) c.lastError = le.text;
    }
    return Object.values(cells);
  }

  function errText(response) {
    if (!response) return null;
    const r = typeof response === "string" ? safeParse(response) : response;
    if (!r) return null;
    return String(r.error || r.message || r.reason || JSON.stringify(r)).slice(0, 400);
  }
  const safeParse = (s) => { try { return JSON.parse(s); } catch { return { error: String(s).slice(0, 200) }; } };

  /* ── retargeting audiences ────────────────────────────────────────────── */
  async function audienceState() {
    let aud = { rows: [] }, syncs = { rows: [] };
    try {
      aud = await pool.query(`SELECT platform, segment, audience_id, name FROM aud_audiences`);
      syncs = await pool.query(
        `SELECT DISTINCT ON (platform, segment) platform, segment, size, status, response, created_at
           FROM aud_syncs ORDER BY platform, segment, created_at DESC`);
    } catch (e) {
      return { ok: false, reason: e.message, rows: [] };
    }
    const byKey = new Map(aud.rows.map((a) => [`${a.platform}|${a.segment}`, a]));
    const rows = syncs.rows.map((s) => {
      const a = byKey.get(`${s.platform}|${s.segment}`);
      const ageH = (Date.now() - new Date(s.created_at).getTime()) / 3600000;
      return {
        platform: s.platform, platformAr: PLAT_AR[s.platform] || s.platform,
        segment: s.segment, name: a?.name || null, audienceId: a?.audience_id || null,
        size: s.size, status: s.status,
        error: s.status === "sent" ? null : errText(s.response),
        lastSyncAt: s.created_at,
        stale: ageH > 36,                     // the sweep runs daily; 36h means it stopped
      };
    });
    // an audience that exists on a platform but has never been synced at all
    for (const a of aud.rows) {
      if (!rows.find((r) => r.platform === a.platform && r.segment === a.segment)) {
        rows.push({
          platform: a.platform, platformAr: PLAT_AR[a.platform] || a.platform,
          segment: a.segment, name: a.name, audienceId: a.audience_id,
          size: null, status: "never", error: "لم تتم أي مزامنة", lastSyncAt: null, stale: true,
        });
      }
    }
    // Each platform's own verdict, attached to the rows it belongs to.
    const idsOf = (p) => rows.filter((r) => r.platform === p && r.audienceId).map((r) => r.audienceId);
    const [mv, sv] = await Promise.all([metaAudiences(idsOf("meta")), snapAudiences(idsOf("snapchat"))]);
    for (const r of rows) {
      if (r.platform === "meta") {
        const v = r.audienceId ? mv[r.audienceId] : null;
        if (!v) continue;
        r.platformStatus = v.deliveryStatus;
        r.platformReady = v.deliveryCode === 200;
        // Meta buckets small audiences: equal bounds at 1000 means "under
        // 1000", not "exactly 1000". Never print it as if it were a count.
        r.platformSizeNote = (v.sizeLower === v.sizeUpper && v.sizeLower === 1000)
          ? "ميتا مش بتعرض رقم مضبوط للجماهير الصغيرة — بتقول «أقل من ١٠٠٠»."
          : (v.sizeLower != null ? `ميتا بتقدّرها بين ${v.sizeLower} و${v.sizeUpper}` : null);
      } else if (r.platform === "snapchat") {
        const v = r.audienceId ? sv[r.audienceId] : null;
        if (!v) continue;
        r.platformStatus = v.status === "ACTIVE" ? "الجمهور نشط عند سناب" : v.status;
        r.platformReady = v.status === "ACTIVE";
        // Snap's approximate_number_users is bucketed and it reports 0 for a
        // segment it will not serve to. But when upload_status is PROCESSING
        // a 0 may simply mean the match has not finished — two different
        // facts, and we do not have the evidence to pick between them, so we
        // say both instead of asserting the harsher one.
        const processing = v.uploadStatus && v.uploadStatus !== "COMPLETE";
        r.platformSizeNote = v.approxUsers === 0
          ? (processing
            ? `سناب لسه بتطابق القايمة (${v.uploadStatus}) وبتقول لسه صفر مستخدم قابل للاستهداف — يا إما المطابقة ما خلصتش، يا إما القايمة أصغر من الحد اللي بتوصّل عنده.`
            : "سناب بتقول صفر مستخدم قابل للاستهداف — الرفع نجح، بس القائمة أصغر من الحد اللي بتوصّل عنده.")
          : (v.approxUsers != null ? `سناب بتقدّرها بـ ~${v.approxUsers} مستخدم` : null);
        r.platformUnusable = v.approxUsers === 0;
        r.platformProcessing = !!processing;
      }
    }

    rows.sort((x, y) => (x.platform + x.segment).localeCompare(y.platform + y.segment));
    return { ok: true, rows };
  }

  /* ── catalog: does the feed exist, and do our Purchase ids match it? ──── */
  async function catalogState(days) {
    const out = {
      feedUrl: "https://freshcuts-api.o2m8.me/api/catalog/feed.csv",
      metaCatalogId: env("META_CATALOG_ID") || "27744296608525457",
      items: null, withImage: null, borrowedImage: null, error: null,
      lineItems: 0, matchedLines: 0, matchRate: null, unmatchedTop: [],
    };
    let rows = null;
    try {
      rows = catalogApi ? await catalogApi.menuRows() : null;
      if (rows) {
        out.items = rows.length;
        out.withImage = rows.filter((r) => r.image).length;
        out.borrowedImage = rows.filter((r) => r.imageFrom).length;
      }
    } catch (e) { out.error = String(e.message || e); }

    // The real question: of the item lines we actually reported as purchases,
    // how many carried a product id the catalog also publishes?
    if (adsApi?.matchToCatalog) {
      try {
        const li = await pool.query(
          `SELECT i.name, count(*)::int AS n
             FROM ts_order_items i JOIN ts_orders o ON o.order_id = i.order_id
            WHERE o.calendar_day > (NOW() AT TIME ZONE 'utc')::date - $1::int
            GROUP BY 1`, [days]);
        let total = 0, matched = 0;
        const misses = [];
        for (const r of li.rows) {
          const id = await adsApi.matchToCatalog(r.name);
          if (id === "__fee__") continue;                  // delivery fee: not a product
          total += r.n;
          if (id) matched += r.n; else misses.push({ name: r.name, n: r.n });
        }
        out.lineItems = total;
        out.matchedLines = matched;
        out.matchRate = total ? Math.round((matched / total) * 100) : null;
        out.unmatchedTop = misses.sort((a, b) => b.n - a.n).slice(0, 10);
      } catch (e) { out.error = out.error || String(e.message || e); }
    }
    out.meta = await metaCatalog();
    return out;
  }

  /* ── dedup: the same order can never be reported twice ────────────────── */
  async function dedupState(days) {
    // The unique key is the mechanism. Prove it is actually on the table.
    let keyed = false, keyName = null;
    try {
      const idx = await pool.query(
        `SELECT indexname FROM pg_indexes
          WHERE tablename = 'ads_events' AND indexdef ILIKE '%UNIQUE%'
            AND indexdef ILIKE '%order_id%' AND indexdef ILIKE '%platform%'
            AND indexdef ILIKE '%event_name%' LIMIT 1`);
      keyed = idx.rowCount > 0;
      keyName = idx.rows[0]?.indexname || null;
    } catch { /* leave false */ }

    // Both pipelines write into the same table, so a real example is one row
    // whose `request.source` says which pipeline got there first.
    let example = null, bySource = [];
    try {
      const s = await pool.query(
        `SELECT COALESCE(request->>'source','pos') AS src, count(*)::int AS n
           FROM ads_events WHERE event_name = 'Purchase'
            AND created_at > NOW() - ($1 || ' days')::interval GROUP BY 1`, [String(days)]);
      bySource = s.rows;
      const ex = await pool.query(
        `SELECT order_id, count(*)::int AS platforms, min(created_at) AS first_at
           FROM ads_events WHERE event_name = 'Purchase' AND order_id IS NOT NULL
            AND created_at > NOW() - ($1 || ' days')::interval
          GROUP BY order_id ORDER BY first_at DESC LIMIT 1`, [String(days)]);
      if (ex.rows[0]) {
        example = {
          orderId: ex.rows[0].order_id,
          rows: ex.rows[0].platforms,
          note: `طلب ${ex.rows[0].order_id} له ${ex.rows[0].platforms} صف — صف واحد لكل منصة، ` +
                `ومحاولة تانية لنفس (الطلب، المنصة، Purchase) بيرفضها المفتاح الفريد قبل ما تتبعت.`,
        };
      }
      // Anything that slipped past would show up as a duplicate. Count them.
      const dup = await pool.query(
        `SELECT count(*)::int AS n FROM (
           SELECT order_id, platform, event_name FROM ads_events
            WHERE order_id IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1) x`);
      example = example || {};
      example.duplicatesFound = dup.rows[0]?.n ?? null;
    } catch { /* best effort */ }

    return { uniqueKeyPresent: keyed, indexName: keyName, bySource, example };
  }

  /* ═══ ROUTE ════════════════════════════════════════════════════════════ */
  app.get("/api/tracking/health", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(Math.max(Number(c.req.query("days") || 7), 1), 90);

    const [web, offline, audiences, catalog, dedup, meta] = await Promise.all([
      webMatrix(days).catch((e) => ({ cells: [], identity: null, eventTotals: {}, error: String(e.message || e) })),
      offlineMatrix(days).catch(() => []),
      audienceState().catch((e) => ({ ok: false, reason: String(e.message || e), rows: [] })),
      catalogState(days).catch((e) => ({ error: String(e.message || e) })),
      dedupState(days).catch(() => ({ uniqueKeyPresent: null })),
      metaDataset(),
    ]);

    /* ── the most recent events, with what each platform answered ──────── */
    let recent = [];
    try {
      const r = await pool.query(
        `SELECT event_name, value, results, created_at, order_id,
                (phone_norm IS NOT NULL AND phone_norm <> '') AS has_phone,
                (contents IS NOT NULL) AS has_contents
           FROM funnel_events ORDER BY created_at DESC LIMIT 40`);
      recent = r.rows.map((x) => ({
        at: x.created_at, event: x.event_name, eventAr: EVENT_AR[x.event_name] || x.event_name,
        value: x.value == null ? null : Number(x.value), orderId: x.order_id,
        hasPhone: x.has_phone, hasContents: x.has_contents,
        source: "web",
        platforms: Object.fromEntries(PLATFORMS.map((p) => {
          const res = readResult(x.results, p);
          return [p, { state: res.state, error: res.error }];
        })),
      }));
    } catch { /* the table may be empty on a fresh boot */ }

    /* ── problems, in Arabic, named plainly ────────────────────────────── */
    const problems = [];

    for (const cell of web.cells || []) {
      if (cell.rejected24h > 0) {
        problems.push(`«${cell.eventAr}» على ${cell.platformAr}: ${cell.rejected24h} حدث اترفض آخر ٢٤ ساعة — ${cell.lastError || "من غير نص خطأ"}`);
      }
    }
    // A configured platform that received nothing at all is broken, not idle.
    for (const p of PLATFORMS) {
      const got = (web.cells || []).filter((x) => x.platform === p).reduce((a, x) => a + x.accepted7d, 0);
      const anyWeb = (web.cells || []).reduce((a, x) => a + x.accepted7d, 0);
      if (anyWeb > 0 && got === 0) problems.push(`${PLAT_AR[p]}: مفيش ولا حدث ويب اتقبل خلال ${days} يوم — البيكسل أو التوكن غالبًا مش مظبوط.`);
    }
    for (const cell of offline) {
      if (cell.rejected24h > 0) problems.push(`الشراء الأوفلاين على ${cell.platformAr}: ${cell.rejected24h} حدث اترفض آخر ٢٤ ساعة — ${cell.lastError || "من غير نص خطأ"}`);
    }
    const offAccepted24 = offline.reduce((a, x) => a + x.accepted24h, 0);
    if (!offAccepted24) problems.push("مفيش أي حدث شراء أوفلاين اتبعت آخر ٢٤ ساعة — تأكد إن مزامنة الطلبات شغالة.");

    for (const a of audiences.rows || []) {
      if (a.status !== "sent") problems.push(`جمهور «${a.segment}» على ${a.platformAr}: آخر مزامنة ${a.status === "never" ? "لم تحدث" : "فشلت"} — ${a.error || ""}`);
      else if (a.stale) problems.push(`جمهور «${a.segment}» على ${a.platformAr}: آخر مزامنة بقالها أكتر من ٣٦ ساعة.`);
    }

    if (catalog.error) problems.push(`الكاتالوج: ${catalog.error}`);
    if (catalog.meta?.ok && catalog.items && catalog.meta.productCount !== catalog.items) {
      problems.push(`الكاتالوج: إحنا بننشر ${catalog.items} صنف وميتا عندها ${catalog.meta.productCount} — الفيد بيتسحب مرة في اليوم، فأي تعديل في المنيو بيفضل مش ظاهر في إعلانات المنتجات لحد ما يتسحب.`);
    }
    if (catalog.meta?.ok && catalog.meta.errors) {
      problems.push(`الكاتالوج: آخر سحب للفيد فيه ${catalog.meta.errors} خطأ عند ميتا.`);
    }
    for (const a of audiences.rows || []) {
      if (a.platformReady === false) problems.push(`جمهور «${a.segment}» على ${a.platformAr}: المنصة بتقول «${a.platformStatus}».`);
      // رفع ناجح + صفر مستهدفين = القائمة أصغر من إن المنصة توصّل ليها. ده
      // مش عطل في الكود، بس لازم عمر يعرفه قبل ما يبني عليه حملة ريتارجتنج.
      if (a.platformUnusable) {
        problems.push(a.platformProcessing
          ? `جمهور «${a.segment}» على ${a.platformAr}: اترفع تمام، بس المنصة لسه بتطابق ولسه بتقول صفر مستخدم قابل للاستهداف — راجعه بعد شوية، ولو فضل صفر يبقى القائمة (${a.size}) صغيرة عليه.`
          : `جمهور «${a.segment}» على ${a.platformAr}: اترفع تمام بس المنصة بتقول مفيش مستخدمين كفاية للاستهداف — القائمة (${a.size}) صغيرة.`);
      }
    }
    if (catalog.matchRate != null && catalog.matchRate < 90) {
      problems.push(`الكاتالوج: ${catalog.matchRate}% بس من أسطر المشتريات بتوصل لمنتج في الفيد — الباقي بيوصل باسمه، والمنصة مش بتقدر تعمل بيه إعلان منتج.`);
    }
    if (dedup.uniqueKeyPresent === false) problems.push("خطر ازدواج: المفتاح الفريد على ads_events مش موجود — نفس الطلب ممكن يتبعت مرتين.");
    if (dedup.example?.duplicatesFound) problems.push(`ازدواج فعلي: ${dedup.example.duplicatesFound} حالة نفس (طلب، منصة، حدث) اتسجلت أكتر من مرة.`);

    if (web.identity && web.identity.total > 0) {
      const pct = Math.round((web.identity.withPhone / web.identity.total) * 100);
      if (pct < 10) problems.push(`جودة المطابقة ضعيفة: ${pct}% بس من أحداث الويب بتحمل رقم جوال. من غير رقم، المنصة مش بتقدر تربط الحدث بعميل.`);
    }
    if (!meta.ok) problems.push(`مش قادرين نقرا اعتراف ميتا بالأحداث: ${meta.reason}`);

    const healthy = problems.length === 0;

    return c.json({
      ok: true,
      days,
      generatedAt: new Date().toISOString(),
      healthy,
      problems,
      web: {
        cells: web.cells || [],
        eventTotals: web.eventTotals || {},
        identity: web.identity,
        expected: WEB_EVENTS,
      },
      offline: {
        cells: offline,
        note: "الشراء اللي بيتقفل في المطعم بيتبعت بـ action_source = physical_store. " +
              "ده الوصف الصح للبيع، ونتيجته إن ميتا بتقبل الحدث وتطابقه بالعميل لكن مبتنسبهوش لحملة بعينها " +
              "زي ما بتعمل مع شراء على الموقع. لو غيّرناه لـ website هيبقى كذب على المنصة — والرقم اللي هتشوفه " +
              "بعدها مش هيكون حقيقي.",
      },
      metaAcknowledgement: meta,
      audiences,
      catalog,
      dedup,
      recent,
    });
  });

  console.log("[tracking] health route ready");
}
