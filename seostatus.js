/* ═══════════════════════════════════════════════════════════════════════════
   🔎 حالة الـSEO — مصدر واحد تقراه اللوحة وتكتب فيه جلسة الـSEO (٢٦/٩)

   قاعدة عمر: «اي حاجة جديدة نكتشفها حدث لوحة التحكم بما يتناسب معاها حتى
   الـSEO برده». فالاكتشافات والقرارات والخطة بتتخزّن هنا (settings.seoStatus)
   مش في المحادثة بس، وشاشة «🔎 جوجل والبحث» بتعرضها.

   فيه نوعين من الأرقام ومابنخلطهمش:
     • `status` — اللي اتقاس يدوياً وله تاريخ (Search Console، التقرير). بيتكتب
       من هنا بـPOST، وكل بند بيحمل `at` بتاعه.
     • `live`   — فحوص بتتعمل دلوقتي على الموقع الحيّ (الـsitemap، البيانات
       المنظّمة، HEAD). كاش ١٠ دقايق عشان الشاشة ماتضربش الموقع كل فتحة.

   المسار تحت /api/cms/growth ⇒ صلاحية «النمو» (cms.js PATH_SECTIONS).
═══════════════════════════════════════════════════════════════════════════ */

const KEY = "seoStatus";
const MAX_BYTES = 120_000;
const LIVE_TTL = 10 * 60 * 1000;
const SITE = (process.env.STOREFRONT_URL || "https://freshcuts.sa").replace(/\/+$/, "");

/* صفحة صنف = /menu/<قسم>/<صنف> (أو /en/…). صفحة القسم /menu/<قسم> مش صنف. */
export function isItemPath(url) {
  const p = String(url || "").replace(/^https?:\/\/[^/]+/, "").replace(/^\/en(?=\/)/, "");
  return /^\/menu\/[^/]+\/[^/]+\/?$/.test(p);
}

export function sitemapStats(xml) {
  const locs = [...String(xml || "").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  return { urls: locs.length, itemPages: locs.filter(isItemPath).length };
}

export function ldHasAggregateRating(html) {
  const blocks = [...String(html || "").matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  return blocks.some((m) => /"aggregateRating"/.test(m[1]));
}

/* دمج: المفاتيح اللي في الطلب بتستبدل القديمة (قوائم كاملة، مش عنصر عنصر) —
   أبسط وأوضح لجلسة بتكتب الحالة كلها مرة واحدة. `null` بيشيل المفتاح. */
export function mergeStatus(cur, patch, now = new Date().toISOString()) {
  const out = { ...(cur || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "updatedAt") continue;
    if (v === null) delete out[k]; else out[k] = v;
  }
  out.updatedAt = now;
  return out;
}

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const log = ctx.log || console;
  let live = { at: 0, data: null };

  async function get(url, opts = {}) {
    return fetch(url, { ...opts, signal: AbortSignal.timeout(9000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FreshCutsSEOCheck/1.0)", ...(opts.headers || {}) } });
  }

  async function liveChecks(force = false) {
    if (!force && live.data && Date.now() - live.at < LIVE_TTL) return live.data;
    const out = { checkedAt: new Date().toISOString(), site: SITE };
    try {
      const s = sitemapStats(await (await get(`${SITE}/sitemap.xml`)).text());
      out.sitemapUrls = s.urls; out.itemPagesInSitemap = s.itemPages;
    } catch (e) { out.sitemapError = String(e?.message || e).slice(0, 120); }
    try {
      const h = await (await get(`${SITE}/`)).text();
      out.homeAggregateRating = ldHasAggregateRating(h);
      out.homeTextBlock = /id="seoHome"/.test(h);
    } catch (e) { out.homeError = String(e?.message || e).slice(0, 120); }
    try { out.headStatus = (await get(`${SITE}/menu`, { method: "HEAD" })).status; } catch {}
    try { out.menuSlash = (await get(`${SITE}/menu/`, { redirect: "manual" })).status; } catch {}
    live = { at: Date.now(), data: out };
    return out;
  }

  app.get("/api/cms/growth/seo", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const status = ((await getSettingsData()) || {})[KEY] || null;
    return c.json({ ok: true, status, live: await liveChecks(c.req.query("fresh") === "1") });
  });

  app.post("/api/cms/growth/seo", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b;
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    if (!b || typeof b !== "object" || Array.isArray(b)) return c.json({ ok: false, error: "bad_body" }, 400);
    const cur = ((await getSettingsData()) || {})[KEY] || {};
    const next = mergeStatus(cur, b);
    const js = JSON.stringify(next);
    if (js.length > MAX_BYTES) return c.json({ ok: false, error: "too_large", bytes: js.length }, 413);
    await pool.query(`UPDATE settings SET data = jsonb_set(data, '{${KEY}}', $1::jsonb, true) WHERE id=1`, [js]);
    try { log.info?.(`[seostatus] updated keys: ${Object.keys(b).join(",")}`); } catch {}
    return c.json({ ok: true, status: next });
  });
}
