/* ═══════════════════════════════════════════════════════════════════════════
   TTCATALOG — كتالوج تيك توك «Fresh Cuts Menu» زي ميتا وسناب (١٩/٩)

   الكتالوج بيعيش في الـBusiness Center (bc_id 7656866792596701200 «شركة فريش
   كاتس») — نوع ECOM، السعودية، ريال. اتعمل من الـAPI (catalog/create) بتوكن
   ttconnect (صلاحية DPA catalog management).

   مصدرين للمنتجات، نفس المعرّفات:
     ١. رفع مباشر من هنا (catalog/product/upload) — أول ما الـboot، وكل ٣٠ دقيقة
        لو طقم المعرّفات اتغيّر، وكل ٦ ساعات إجباري عشان الأسعار. المنتجات اللي
        اختفت من الفيد بتتمسح (catalog/product/delete).
     ٢. feed مجدول يومي (٤:٣٠ الرياض) على /api/catalog/tiktok.csv — شبكة أمان لو
        السيرفر ده وقف. نفس صفوف feed.csv بتاع ميتا بس بعناوين أعمدة تيك توك
        (sku_id بدل id).

   المعرّفات = نفس id بتاع feed.csv = نفس content_id اللي pixels.js بيبعته لتيك
   توك (catId: رقم صنف نقطة البيع، وحزم b:<slug> بتتحوّل لرقم المنتج). فالإعلانات
   الديناميكية هتطابق الأحداث بالكتالوج من غير أي تحويل.

   الحالة في ads_guard_state k='tt_catalog' (catalogId/feedId/آخر مزامنة/أخطاء)،
   وadconnect بيعرضها تحت تيك توك.

   ربط الكتالوج بحساب الإعلانات 7659708684223578119: لازم حساب الإعلانات يبقى
   أصل (asset) في نفس الـBC وياخد صلاحية على الكتالوج — ده من شاشة الـBC
   (صلاحيات bc/* مش في تطبيقنا)، شوف bindingHint تحت.
═══════════════════════════════════════════════════════════════════════════ */
import { TT_API, ttMktToken, ttAdvertiserId } from "./ttconnect.js";
import { adFeedRows, catalogLink } from "./catalog.js";

const env = (k) => (process.env[k] || "").trim();
export const ttBcId = () => env("TIKTOK_BC_ID") || "7656866792596701200";
export const CATALOG_NAME = "Fresh Cuts Menu";
const API_BASE = env("PUBLIC_API_URL") || "https://freshcuts-api.o2m8.me";
export const TT_FEED_URL = env("TIKTOK_CATALOG_FEED_URL") || `${API_BASE}/api/catalog/tiktok.csv`;
const BRAND = "Fresh Cuts";
/* Google taxonomy 422 = Food, Beverages & Tobacco > Food Items — من غيره تيك توك بتحط تحذير على كل منتج. */
const GPC = "422";
const K = "tt_catalog";
const SYNC_EVERY_MS = 30 * 60_000;
const FORCE_EVERY_MS = 6 * 3600e3;
const BATCH = 500;

export const bindingHint = (bc = ttBcId(), adv = ttAdvertiserId() || "7659708684223578119") =>
  `business.tiktok.com/manage/overview?org_id=${bc} ← «الأصول» (Assets) ← «حسابات الإعلانات»: لو ${adv} مش موجود دوس «إضافة» ← «طلب وصول/إضافة حساب موجود» بالـID ده. ` +
  `بعدها «الأصول» ← «الكتالوجات» ← ${CATALOG_NAME} ← «تعيين حسابات إعلانية» ← اختار ${adv} (صلاحية Admin/إنشاء إعلانات) ← حفظ.`;

/* ── pure (unit-tested) ──────────────────────────────────────────────── */
export function toTtProduct(r) {
  const title = String(r.title || "").trim().slice(0, 150);
  return {
    sku_id: String(r.id),
    title,
    description: String(r.description || title).trim().slice(0, 5000) || title,
    availability: "IN_STOCK",
    brand: BRAND,
    image_url: r.image,
    price_info: { price: Math.round(Number(r.price) * 100) / 100 },
    landing_page: { landing_page_url: catalogLink(r) },
    product_detail: { condition: "NEW" },
    google_product_category: GPC,
  };
}
const q = (s) => `"${String(s ?? "").replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;
export function ttCsv(rows) {
  const header = "sku_id,title,description,availability,condition,price,link,image_link,brand,product_type,google_product_category";
  return [header, ...rows.map((r) => [
    q(r.id), q(r.title), q(r.description || r.title), "in stock", "new",
    q(`${Number(r.price).toFixed(2)} SAR`), q(catalogLink(r)), q(r.image), q(BRAND), q(r.category), GPC,
  ].join(","))].join("\n");
}
/** ids اللي لازم تتمسح = كانت مرفوعة ومبقتش في الفيد. */
export const removedIds = (prev, cur) => { const s = new Set(cur.map(String)); return (prev || []).map(String).filter((x) => !s.has(x)); };

/* ── تيك توك ─────────────────────────────────────────────────────────── */
async function tt(method, path, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(TT_API + path, { method, signal: ctl.signal,
      headers: { "Access-Token": ttMktToken(), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => null);
    return j || { code: -1, message: `HTTP ${r.status}` };
  } catch (e) { return { code: -1, message: String(e.message || e) }; }
  finally { clearTimeout(t); }
}
const errOf = (j) => `${String(j?.message || "").slice(0, 200)} (code ${j?.code})`;

export function register(app, ctx) {
  const { pool } = ctx;
  let ready = null;
  const ensure = () => (ready ||= pool.query(`CREATE TABLE IF NOT EXISTS ads_guard_state (k TEXT PRIMARY KEY, v JSONB, updated_at TIMESTAMPTZ DEFAULT now())`).catch((e) => { ready = null; throw e; }));
  async function load() { await ensure(); return (await pool.query(`SELECT v FROM ads_guard_state WHERE k=$1`, [K])).rows[0]?.v || {}; }
  async function save(v) {
    await ensure();
    const u = await pool.query(`UPDATE ads_guard_state SET v=$2, updated_at=now() WHERE k=$1`, [K, JSON.stringify(v)]);
    if (!u.rowCount) await pool.query(`INSERT INTO ads_guard_state(k, v, updated_at) VALUES ($1,$2,now())`, [K, JSON.stringify(v)]);
  }

  let running = null;
  async function ensureCatalog(st, bc) {
    if (env("TIKTOK_CATALOG_ID")) st.catalogId = env("TIKTOK_CATALOG_ID");
    if (!st.catalogId) {
      const l = await tt("GET", `/catalog/get/?bc_id=${bc}&page_size=100`);
      if (l.code !== 0) throw new Error(`catalog/get: ${errOf(l)}`);
      const hit = (l.data?.list || []).find((c) => c.catalog_name === CATALOG_NAME);
      if (hit) st.catalogId = hit.catalog_id;
      else {
        const c = await tt("POST", "/catalog/create/", { bc_id: bc, catalog_type: "ECOM", name: CATALOG_NAME, catalog_conf: { region_code: "SA", currency: "SAR" } });
        if (c.code !== 0 || !c.data?.catalog_id) throw new Error(`catalog/create: ${errOf(c)}`);
        st.catalogId = c.data.catalog_id;
      }
    }
    if (!st.feedId) {
      const f = await tt("GET", `/catalog/feed/get/?bc_id=${bc}&catalog_id=${st.catalogId}`);
      const hit = (f.data?.feed_list || [])[0];
      if (hit) st.feedId = hit.feed_id;
      else {
        const c = await tt("POST", "/catalog/feed/create/", { bc_id: bc, catalog_id: st.catalogId, feed_name: "Fresh Cuts menu feed (daily)", update_mode: "OVERWRITE",
          schedule_param: { source: { uri: TT_FEED_URL }, interval_type: "DAILY", interval_count: 1, timezone: "Asia/Riyadh", hour: 4, minute: 30 } });
        if (c.code === 0) st.feedId = c.data?.feed_id || null;
      }
    }
  }

  async function doSync({ force = false } = {}) {
    const st = await load();
    const bc = ttBcId(); st.bcId = bc;
    if (!ttMktToken()) { st.skipped = "no TikTok marketing token"; await save(st); return st; }
    try {
      await ensureCatalog(st, bc);
      const rows = (await adFeedRows()).filter((r) => r.image && Number(r.price) > 0);
      const ids = rows.map((r) => String(r.id)).sort();
      const stale = !st.lastSyncAt || Date.now() - Date.parse(st.lastSyncAt) > FORCE_EVERY_MS;
      if (!force && !stale && ids.join(",") === (st.ids || []).join(",") && !st.error) { st.skipped = "unchanged"; await save(st); return st; }
      const logs = [];
      for (let i = 0; i < rows.length; i += BATCH) {
        const u = await tt("POST", "/catalog/product/upload/", { bc_id: bc, catalog_id: st.catalogId, ...(st.feedId ? { feed_id: st.feedId } : {}), products: rows.slice(i, i + BATCH).map(toTtProduct) });
        if (u.code !== 0) throw new Error(`product/upload: ${errOf(u)}`);
        logs.push(u.data?.feed_log_id);
      }
      const gone = removedIds(st.ids, ids);
      if (gone.length) {
        const d = await tt("POST", "/catalog/product/delete/", { bc_id: bc, catalog_id: st.catalogId, sku_ids: gone });
        st.lastDelete = { at: new Date().toISOString(), ids: gone, ok: d.code === 0, error: d.code === 0 ? null : errOf(d) };
      }
      Object.assign(st, { ids, uploaded: rows.length, lastSyncAt: new Date().toISOString(), feedLogIds: logs, error: null, skipped: null });
    } catch (e) {
      Object.assign(st, { error: String(e.message || e).slice(0, 300), errorAt: new Date().toISOString() });
      console.error("[ttcatalog]", st.error);
    }
    await save(st);
    return st;
  }
  const sync = (o) => (running ||= doSync(o).finally(() => { running = null; }));

  /** للحالة: عدد المنتجات عند تيك توك + آخر لوج رفع + حالة الـfeed المجدول. */
  async function status() {
    const st = await load();
    const bc = st.bcId || ttBcId();
    const out = { configured: Boolean(st.catalogId), bcId: bc, catalogId: st.catalogId || null, feedId: st.feedId || null, feedUrl: TT_FEED_URL,
      uploaded: st.uploaded ?? null, lastSyncAt: st.lastSyncAt || null, error: st.error || null, advertiserId: ttAdvertiserId() || null, bindingHint: bindingHint(bc) };
    if (!st.catalogId || !ttMktToken()) return out;
    const [p, f, lg] = await Promise.all([
      tt("GET", `/catalog/product/get/?bc_id=${bc}&catalog_id=${st.catalogId}&page_size=1`),
      tt("GET", `/catalog/feed/get/?bc_id=${bc}&catalog_id=${st.catalogId}`),
      st.feedLogIds?.length ? tt("GET", `/catalog/product/log/?bc_id=${bc}&catalog_id=${st.catalogId}&feed_log_id=${st.feedLogIds[st.feedLogIds.length - 1]}`) : null,
    ]);
    out.products = p.code === 0 ? (p.data?.page_info?.total_number ?? null) : null;
    if (p.code !== 0) out.productsError = errOf(p);
    const fd = (f.data?.feed_list || [])[0];
    if (fd) out.feed = { status: fd.status, nextUpdate: fd.next_update_time, products: fd.number_of_products, uri: fd.last_update_param?.uri };
    const l = lg?.data?.product_feed_log;
    if (l) out.lastUpload = { status: l.status, add: l.add_count, update: l.update_count, delete: l.delete_count, errors: l.error_count, warnings: l.warn_count, end: l.end_time };
    return out;
  }

  app.get("/api/catalog/tiktok.csv", async (c) => {
    let rows;
    try { rows = (await adFeedRows()).filter((r) => r.image && Number(r.price) > 0); }
    catch (e) { return c.text(`# feed unavailable: ${e.message}`, 503); }
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Cache-Control", "public, max-age=600");
    return c.body(ttCsv(rows));
  });

  app.get("/api/catalog/tiktok/status", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return err;
    try { return c.json({ ok: true, ...(await status()) }); } catch (e) { return c.json({ ok: false, error: String(e.message || e) }, 500); }
  });
  app.post("/api/catalog/tiktok/sync", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return err;
    const r = await sync({ force: true });
    return c.json({ ok: !r.error, ...r, ids: undefined, count: (r.ids || []).length });
  });

  if (env("TT_CATALOG_SCHEDULER") !== "0") {
    const t = setTimeout(() => { sync().catch(() => {}); setInterval(() => sync().catch(() => {}), SYNC_EVERY_MS).unref?.(); }, 60_000);
    t.unref?.();
  }
  api = { sync, status };
  return api;
}

let api = null;
/** لـadconnect: حالة الكتالوج أو null لو الموديول مش متسجّل. */
export async function ttCatalogStatus() { return api ? api.status() : null; }
