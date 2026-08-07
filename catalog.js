/* ═══════════════════════════════════════════════════════════════════════════
   CATALOG — live product feed for the ad platforms, generated from the real
   TABsense menu (names, prices, images) via the storefront proxy.

   GET /api/catalog/feed.csv       Meta Commerce Manager scheduled-feed format
                                   (also accepted by Snap and TikTok catalogs)
   GET /api/catalog/status         item count + last fetch (admin)

   The feed is PUBLIC by design: the platforms poll it on a schedule, and the
   menu itself is already public on order.o2m8.me. Prices update themselves —
   change a price in TabSense and every platform catalog follows on its next
   scheduled fetch. Items link to https://order.o2m8.me/#item-<id> which the
   storefront can deep-link into the item sheet.
═══════════════════════════════════════════════════════════════════════════ */

const STORE_BASE = process.env.CATALOG_MENU_BASE || "https://order.o2m8.me";
const BRAND = "Fresh Cuts";
const CACHE_MS = 10 * 60_000;

let cache = { at: 0, rows: null, error: null };

async function fetchMenu() {
  const res = await fetch(`${STORE_BASE}/api/menu?branch_id=1`, {
    headers: { "User-Agent": "freshcuts-catalog" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`menu fetch HTTP ${res.status}`);
  const j = await res.json();
  const pages = j?.data?.pages || [];
  const rows = [];
  for (const p of pages) {
    const category = p.title || p.local_title || "";
    for (const it of p.items || []) {
      const price = Number(it.retail_price != null ? it.retail_price : it.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      rows.push({
        id: String(it.id),
        title: (it.name || it.local_name || "").trim(),
        description: (it.description || it.local_description || it.name || "").trim().slice(0, 500),
        price,
        image: it.image || "",
        category,
      });
    }
  }
  return rows;
}

async function getRows() {
  if (cache.rows && Date.now() - cache.at < CACHE_MS) return cache.rows;
  try {
    cache = { at: Date.now(), rows: await fetchMenu(), error: null };
  } catch (e) {
    cache.error = String(e.message || e);
    if (!cache.rows) throw e;         // no stale copy to fall back on
  }
  return cache.rows;
}

// CSV per Meta's product-feed spec. Quotes doubled, commas safe.
const q = (s) => `"${String(s ?? "").replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;

/** Menu rows for other modules (ads.js maps order-item names → catalog ids so
 *  the platforms can tie a purchase to the exact product in the feed). */
export async function menuRows() {
  return getRows();
}

export function register(app, ctx) {
  const { requireAdmin } = ctx;

  app.get("/api/catalog/feed.csv", async (c) => {
    let rows;
    try { rows = await getRows(); }
    catch (e) { return c.text(`# feed unavailable: ${e.message}`, 503); }
    const header = "id,title,description,availability,condition,price,link,image_link,brand,product_type";
    const lines = rows.map((r) => [
      q(r.id), q(r.title), q(r.description), "in stock", "new",
      q(`${r.price.toFixed(2)} SAR`),
      q(`https://order.o2m8.me/#item-${r.id}`),
      q(r.image), q(BRAND), q(r.category),
    ].join(","));
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Cache-Control", "public, max-age=600");
    return c.body([header, ...lines].join("\n"));
  });

  app.get("/api/catalog/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let rows = null, e = null;
    try { rows = await getRows(); } catch (x) { e = String(x.message || x); }
    return c.json({
      ok: !e,
      items: rows ? rows.length : 0,
      withImage: rows ? rows.filter((r) => r.image).length : 0,
      lastFetch: cache.at ? new Date(cache.at).toISOString() : null,
      error: e || cache.error,
      feedUrl: "https://freshcuts-api.o2m8.me/api/catalog/feed.csv",
    });
  });

  console.log("[catalog] routes ready");
}
