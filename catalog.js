/* ═══════════════════════════════════════════════════════════════════════════
   CATALOG — live product feed for the ad platforms, generated from the real
   TABsense menu (names, prices, images) via the storefront proxy.

   GET  /api/catalog/feed.csv      Meta Commerce Manager scheduled-feed format
                                   (also accepted by Snap and TikTok catalogs)
   GET  /api/catalog/status        item count + last fetch (admin)
   POST /api/catalog/sync          force Meta to re-read the feed now (admin)

   The feed is PUBLIC by design: the platforms poll it on a schedule, and the
   menu itself is already public on order.o2m8.me. Prices update themselves —
   change a price in TabSense and every platform catalog follows on its next
   scheduled fetch. Items link to https://order.o2m8.me/#item-<id> which the
   storefront can deep-link into the item sheet.
═══════════════════════════════════════════════════════════════════════════ */

import { activeOffers, catalogOffers, publicOffer } from "./offers.js";

const STORE_BASE = process.env.CATALOG_MENU_BASE || process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa";
const BRAND = "Fresh Cuts";
const CACHE_MS = 10 * 60_000;

/* ── KEEPING META'S COPY OF THE MENU HONEST ────────────────────────────────
   Meta's scheduled feed pull runs ONCE A DAY (03:00 America/Los_Angeles), and
   the menu changes whenever someone edits it. A dish added between two pulls
   is a dish Meta has never heard of, and every event carrying its id comes
   back MUST_FIX / INVALID_CONTENT_ID.

   The 2026-08-09 case, in UTC, because it is worth not re-diagnosing:

     09:50  scheduled pull — 72 items
     16:53  menu grows to 95; "كريب ميكس لحوم" (id 1) exists for the first time
     19:08  a manual push persists all 95 items (num_persisted_items 95, 0 errors)
     21:09  a customer orders it — his InitiateCheckout and Lead are flagged
     00:42  (next day) a second InitiateCheckout, also flagged
     09:51  scheduled pull — 95 items
     16:28  another InitiateCheckout with id 1 — NOT flagged

   Note the 19:08 push: the PRODUCT existed hours before the flagged events.
   What had not caught up was Meta's event↔catalog matching index, which
   refreshes off the feed's own cadence — so the id stayed "invalid" until the
   next scheduled pull, then went clean and stayed clean. The lesson is the
   same either way: the longer a new id waits, the more events it poisons.

   So we push instead of waiting. Whenever the set of product ids in the feed
   differs from the set we last pushed, ask Meta to re-read the feed now. */
const META_FEED_ID = process.env.META_PRODUCT_FEED_ID || "1392433232794606";
const FEED_URL = process.env.CATALOG_FEED_URL || "https://freshcuts-api.o2m8.me/api/catalog/feed.csv";
const SYNC_EVERY_MS = 30 * 60_000;
let lastPush = { at: null, ids: null, upload: null, error: null, skipped: null };

/* ── DINE-IN ONLY ──────────────────────────────────────────────────────────
   Two offers are served at the table and cannot be delivered: صينية اللمة
   (100 ر.س) and بيتزا+باستا+كريب (70 ر.س). A DPA card or a catalog row that
   does not say so invites a delivery order the kitchen has to refuse — the
   worst kind of ad, because we paid for the click AND lost the customer.
   So every catalog surface carries the note, in the title and in the
   description, where no platform can crop it away entirely.

   Matched two ways so a menu edit cannot silently drop the label: by explicit
   product id (CATALOG_DINE_IN_IDS, comma separated) and by name pattern. The
   second offer is not a POS product at all today — it exists only in ad copy
   and the offers strip — so the pattern is what will catch it if it is ever
   added to the menu. */
const DINE_IN_NOTE = "داخل الصالة فقط";

/* ── العروض اللي مش أصناف في نقطة البيع ────────────────────────────────────
   عرض «بيتزا + باستا + كريب ٧٠ ر.س» مالوش صنف في TabSense — الكاشير بيخصم
   يدوي على التلات سطور لحد ما المجموع يوصل ٧٠. لكنه **عرض حقيقي معلن**،
   فلازم يبقى في الكتالوج اللي بيروح للمنصات، وبنفس ملاحظة الصالة.

   التعريف عند offers.js (اسم واحد، سعر واحد، تاريخ انتهاء واحد) وإحنا هنا
   بنقراه بس. `activeOffers()` بتسقط أي عرض عدّى تاريخه، فالصف بيختفي من
   الـfeed لوحده يوم ١ سبتمبر — ووقتها price-guard يرجع يرفض الرقم ٧٠ تاني،
   لأنه مبقاش موثّق. مفيش حد محتاج يفتكر يشيله. */
const offerRow = (o) => ({
  id: o.productId,
  title: o.catalogTitle,
  description: o.desc,
  price: Number(o.price),
  // صورة العرض نفسه. **مش** بنستعير صورة من فئة "Offers" لو ناقصة: أقرب
  // جار هناك هو صينية اللمّة، وكارت DPA بصورة صينية مشاوي على عرض بيتزا
  // وباستا وكريب كذب بصري — أهون منه صف من غير صورة.
  image: o.image || "",
  category: "Offers",
  dineIn: !!o.dineInOnly,
  isOffer: true,
});
// Dashboard-managed list (settings.catalog.dineInIds) merged over the env
// default — Omar asked to control dine-in-only items from the panel, and a
// settings edit must not need a redeploy. Refreshed by register() below.
let settingsDineIn = [];
const dineInIds = () =>
  new Set([
    ...String(process.env.CATALOG_DINE_IN_IDS ?? "121").split(","),
    ...settingsDineIn.map(String),
  ].map((s) => s.trim()).filter(Boolean));
const DINE_IN_NAME_RE = /صيني[ةه]\s*اللم[ةه]|بيتزا\s*\+\s*باستا|باستا\s*\+\s*كريب/;

export function isDineInOnly(item) {
  const name = `${item?.title || item?.name || ""} ${item?.local_name || ""}`;
  return dineInIds().has(String(item?.id ?? "")) || DINE_IN_NAME_RE.test(name);
}
const withNote = (s) => (String(s || "").includes(DINE_IN_NOTE) ? String(s) : `${String(s || "").trim()} — ${DINE_IN_NOTE}`.trim());

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
  // "Offers" outranks "Best Sellers" among the merchandising pages: the family
  // tray lives nowhere else, so whichever of the two is read first decides its
  // product_type, and "Offers" is the honest label for it.
  const MERCH_RANK = { Offers: 1, "العروض": 1, "Best Sellers": 2, "الأكثر طلباً": 2 };
  const rank = (p) => MERCH_RANK[p.title] || MERCH_RANK[p.local_title] || 0;
  const seen = new Set();
  const ordered = [...pages].sort((a, b) => rank(a) - rank(b));
  for (const p of ordered) {
    const category = p.title || p.local_title || "";
    for (const it of p.items || []) {
      const price = Number(it.retail_price != null ? it.retail_price : it.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (seen.has(String(it.id))) continue;
      seen.add(String(it.id));
      const row = {
        id: String(it.id),
        title: (it.name || it.local_name || "").trim(),
        description: (it.description || it.local_description || it.name || "").trim().slice(0, 500),
        price,
        image: it.image || "",
        category,
      };
      if (isDineInOnly({ ...it, title: row.title })) {
        row.dineIn = true;
        row.title = withNote(row.title).slice(0, 200);
        row.description = withNote(row.description).slice(0, 500);
      }
      rows.push(row);
    }
  }
  // العروض المسجّلة والشغّالة النهاردة بتتحط بعد أصناف المنيو عشان تاخد صورة
  // مستعارة من فئة "Offers" لو موجودة (ميتا بترفض صف من غير صورة).
  // catalogOffers() مش activeOffers(): صينية اللمة عرض شغّال لكنه **صنف في
  // المنيو** أصلاً (id 121)، فصف تاني ليه هنا = id مكرر في الـfeed.
  for (const o of catalogOffers()) {
    const r = offerRow(o);
    r.title = withNote(r.title).slice(0, 200);
    r.description = withNote(r.description).slice(0, 500);
    rows.push(r);
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
    if (r.image || r.isOffer) continue;
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

/* Ask Meta to fetch the feed now. `force` skips the "did anything change?"
   test — the scheduled sweep uses the test, the admin route does not. */
export async function syncCatalog({ force = false } = {}) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token || !META_FEED_ID) {
    lastPush = { ...lastPush, skipped: "no META_CAPI_TOKEN / META_PRODUCT_FEED_ID" };
    return lastPush;
  }
  let rows;
  try { rows = await getRows(); }
  catch (e) {
    lastPush = { ...lastPush, error: `menu unavailable: ${e.message}` };
    return lastPush;
  }

  // The id SET is what the catalog keys on, so that is what decides a push.
  // A price change rides along on the next sweep; a missing id costs events.
  const ids = rows.map((r) => String(r.id)).sort().join(",");
  if (!force && ids === lastPush.ids) {
    lastPush = { ...lastPush, skipped: "unchanged", error: null };
    return lastPush;
  }

  const ver = process.env.META_API_VERSION || "v21.0";
  try {
    const res = await fetch(`https://graph.facebook.com/${ver}/${META_FEED_ID}/uploads`, {
      method: "POST",
      body: new URLSearchParams({ url: FEED_URL, access_token: token }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
    lastPush = { at: new Date().toISOString(), ids, upload: j?.id || null, error: null, skipped: null };
    console.log(`[catalog] pushed ${rows.length} items to Meta (upload ${j?.id})`);
  } catch (e) {
    // Keep lastPush.ids unchanged so the next sweep retries this same change.
    lastPush = { ...lastPush, error: String(e.message || e), at: new Date().toISOString() };
    console.error("[catalog] push failed:", lastPush.error);
  }
  return lastPush;
}

export function register(app, ctx) {
  const { requireAdmin, getSettingsData } = ctx;

  // keep the dine-in list in step with the dashboard (5-minute refresh, and
  // a fresh read on every /dine-in request below)
  async function refreshDineIn() {
    try {
      const list = (await getSettingsData()).catalog?.dineInIds;
      if (Array.isArray(list)) settingsDineIn = list;
      else if (typeof list === "string") settingsDineIn = list.split(",");
    } catch { /* keep the last known list */ }
  }
  refreshDineIn();
  setInterval(refreshDineIn, 5 * 60_000);

  app.get("/api/catalog/feed.csv", async (c) => {
    let rows;
    try { rows = await getRows(); }
    catch (e) { return c.text(`# feed unavailable: ${e.message}`, 503); }
    const header = "id,title,description,availability,condition,price,link,image_link,brand,product_type";
    const lines = rows.map((r) => [
      q(r.id), q(r.title), q(r.description), "in stock", "new",
      q(`${r.price.toFixed(2)} SAR`),
      q(`${STORE_BASE}/#item-${r.id}`),
      q(r.image), q(BRAND), q(r.category),
    ].join(","));
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Cache-Control", "public, max-age=600");
    return c.body([header, ...lines].join("\n"));
  });

  /* Which products may NOT be delivered. Public: the storefront's browser
     reads it to badge those dishes and to warn before a delivery order is
     sent. One source of truth with the feed above — a dish cannot be labelled
     dine-in in the catalog and unlabelled on the site. */
  app.get("/api/catalog/dine-in", async (c) => {
    await refreshDineIn(); // the storefront must see a panel edit immediately
    let ids = [...dineInIds()];
    try {
      const rows = await getRows();
      ids = [...new Set([...ids, ...rows.filter((r) => r.dineIn).map((r) => r.id)])];
    } catch { /* fall back to the configured ids */ }
    c.header("Cache-Control", "public, max-age=300");
    // العروض المسجّلة بترجع كمان: مش أصناف في المنيو فمالهاش id تتبادج بيه،
    // لكن المتجر محتاج يعرضها في شريط العروض بنفس ملاحظة الصالة — ومن نفس
    // المصدر، عشان ما يبقاش فيه صنف مكتوب عليه صالة في الكتالوج وأونلاين
    // على الموقع.
    const now = new Date();
    return c.json({
      ok: true, note: DINE_IN_NOTE, ids,
      offers: activeOffers(now).map((o) => publicOffer(o, now)),
    });
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
      dineInOnly: rows ? rows.filter((r) => r.dineIn).map((r) => ({ id: r.id, title: r.title })) : [],
      stillMissingImage: rows ? rows.filter((r) => !r.image).map((r) => r.title) : [],
      lastFetch: cache.at ? new Date(cache.at).toISOString() : null,
      error: e || cache.error,
      feedUrl: FEED_URL,
      metaPush: lastPush,
    });
  });

  /* Force a push. Use after a menu edit rather than waiting for the sweep. */
  app.post("/api/catalog/sync", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await syncCatalog({ force: true });
    return c.json({ ok: !r.error, ...r });
  });

  // Boot push, then every 30 minutes — a new dish is advertisable within the
  // half hour instead of being un-matchable until 03:00 the next morning.
  setTimeout(() => { syncCatalog().catch(() => {}); }, 20_000);
  const timer = setInterval(() => { syncCatalog().catch(() => {}); }, SYNC_EVERY_MS);
  if (timer.unref) timer.unref();

  console.log("[catalog] routes ready");
}
