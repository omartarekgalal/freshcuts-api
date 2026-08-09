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
  // A dish can now sit on two menu pages: the merchandising sections ("الأكثر
  // طلباً", "العروض") deliberately repeat items that also live in their real
  // category. A catalog feed must not — Meta keys rows by `id` and rejects the
  // duplicates — so the first page a product appears on wins, and the
  // merchandising pages are read last so the row keeps its true product_type.
  const MERCH_PAGES = new Set(["Best Sellers", "الأكثر طلباً", "Offers", "العروض"]);
  const seen = new Set();
  const ordered = [...pages].sort((a, b) => {
    const am = MERCH_PAGES.has(a.title) || MERCH_PAGES.has(a.local_title) ? 1 : 0;
    const bm = MERCH_PAGES.has(b.title) || MERCH_PAGES.has(b.local_title) ? 1 : 0;
    return am - bm;
  });
  for (const p of ordered) {
    const category = p.title || p.local_title || "";
    for (const it of p.items || []) {
      const price = Number(it.retail_price != null ? it.retail_price : it.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (seen.has(String(it.id))) continue;
      seen.add(String(it.id));
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
  return fillMissingImages(rows);
}

/* Meta drops (and warns about) any product row with an empty image_link, and a
   DPA carousel cannot render a card without one. 18 of the 72 menu items — the
   by-weight grill cuts — carry no photo in TabSense. Rather than let them fall
   out of the catalog, borrow the photo of the closest sibling item: same
   category, most shared words once weight/serving words are stripped, so
   "كبدة مشوية كيلو" inherits the photo of "كبدة مشوية". If nothing in the
   category matches, any photo from that category is still truer than none. */
const WEIGHT_WORDS = /(?:^|\s)(كيلو|نصف|نص|ربع|وجبة|طبق|صحن|علبة|قطعة|حبة)(?=\s|$)/g;
const normName = (s) => String(s || "")
  .replace(/[ً-ْـ]/g, "")      // harakat + tatweel
  .replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/[ىئ]/g, "ي")
  .replace(WEIGHT_WORDS, " ")
  .replace(/[^\p{L}\p{N}\s]/gu, " ")
  .replace(/\s+/g, " ").trim();

function fillMissingImages(rows) {
  const withImage = rows.filter((r) => r.image);
  if (!withImage.length) return rows;
  for (const r of rows) {
    if (r.image) continue;
    const want = new Set(normName(r.title).split(" ").filter(Boolean));
    let best = null, bestScore = 0;
    for (const cand of withImage) {
      if (cand.category !== r.category) continue;
      const words = normName(cand.title).split(" ").filter(Boolean);
      const score = words.filter((w) => want.has(w)).length;
      if (score > bestScore) { best = cand; bestScore = score; }
    }
    if (!best) best = withImage.find((c) => c.category === r.category) || null;
    if (best) { r.image = best.image; r.imageFrom = best.id; }
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
      ownImage: rows ? rows.filter((r) => r.image && !r.imageFrom).length : 0,
      borrowedImage: rows ? rows.filter((r) => r.imageFrom).length : 0,
      stillMissingImage: rows ? rows.filter((r) => !r.image).map((r) => r.title) : [],
      lastFetch: cache.at ? new Date(cache.at).toISOString() : null,
      error: e || cache.error,
      feedUrl: "https://freshcuts-api.o2m8.me/api/catalog/feed.csv",
    });
  });

  console.log("[catalog] routes ready");
}
