/* ═══════════════════════════════════════════════════════════════════════════
   SOLD OUT — «خلص النهارده»: المدير يقفل صنف من البورتال لما يخلص في المطبخ.

   - مختلف عن hiddenIds: الصنف المقفول **بيفضل ظاهر** في المتجر بشارة «خلص»
     بس مايتطلبش. الإخفاء قرار تسويقي، «خلص» قرار تشغيل يومي.
   - المخزن: settings.catalog.soldOut = { "<productId>": { at, by, until } }
     until = ISO (يرجع لوحده عند أول فتح) أو null (مقفول لحد ما حد يفتحه).
     العنصر اللي until بتاعه عدّى بيتعامل كأنه مش موجود (مفيش كرون).
   - الإنفاذ على السيرفر: الشيك أوت (shop.js) وتوسيع الباقات (cms.js) بيرفضوا
     قبل أي جلسة دفع. المتجر بيشوف sold_out من catalog-overlay.
═══════════════════════════════════════════════════════════════════════════ */

const RIYADH_OFFSET_MS = 3 * 3600_000; // الرياض UTC+3 ثابت (مفيش توقيت صيفي)
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const hhmm = (s) => { const [h, m] = String(s || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };

/* أول «فتح» بعد اللحظة دي حسب settings.hours — ولو المواعيد مش متعرّفة: ١٢:٠٠ الرياض. */
export function nextOpening(hours, nowMs = Date.now()) {
  const local = new Date(nowMs + RIYADH_OFFSET_MS); // حقول UTC = الوقت المحلي
  const dayStartLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const useHours = hours && hours.enabled !== false && hours.days;
  for (let i = 0; i < 9; i++) {
    const dow = (local.getUTCDay() + i) % 7;
    let openMin = 12 * 60;
    if (useHours) {
      const d = hours.days[DAYS[dow]];
      if (!d || d.closed || !d.open) continue;
      openMin = hhmm(d.open);
    }
    const at = dayStartLocal + i * 86400_000 + openMin * 60_000 - RIYADH_OFFSET_MS;
    if (at > nowMs + 60_000) return new Date(at).toISOString();
  }
  // مواعيد كلها مقفولة؟ بكرة ١٢ كحد أمان — مانسيبش صنف مقفول للأبد بالغلط
  return new Date(dayStartLocal + 86400_000 + 12 * 3600_000 - RIYADH_OFFSET_MS).toISOString();
}

/* الخريطة الفعّالة بس (اللي until بتاعها لسه ماجاش). */
export function activeSoldOut(map, nowMs = Date.now()) {
  const out = {};
  if (!map || typeof map !== "object" || Array.isArray(map)) return out;
  for (const [id, e] of Object.entries(map)) {
    if (!e || typeof e !== "object") continue;
    if (e.until && Date.parse(e.until) <= nowMs) continue;
    out[String(id)] = { at: e.at || null, by: e.by || null, until: e.until || null, name: e.name || null };
  }
  return out;
}

export const soldOutOf = (settings, nowMs = Date.now()) => activeSoldOut(settings?.catalog?.soldOut, nowMs);

/* سطور السلة (بعد توسيع الباقات) اللي فيها صنف خلصان. */
export function soldOutLines(items, active) {
  const bad = [];
  const seen = new Set();
  for (const it of items || []) {
    const id = String(it?.product_id ?? "");
    if (!id || !active[id] || seen.has(id)) continue;
    seen.add(id);
    bad.push({ product_id: Number(id), name: it.name || active[id].name || null });
  }
  return bad;
}

export const soldOutMessage = (names) => {
  const n = (names || []).filter(Boolean);
  return n.length
    ? `للأسف ${n.join("، ")} خلص النهارده 🙏 — شيله من السلة وكمّل طلبك.`
    : "فيه صنف في سلتك خلص النهارده 🙏 — شيله من السلة وكمّل طلبك.";
};

/* المخزن: قراءة/كتابة settings.catalog.soldOut. الكتابة ذرّية على مفتاح واحد
   (jsonb_set / #-) عشان تعديلين في نفس اللحظة مايمسحوش بعض. */
export function makeSoldOutStore({ pool, getSettingsData, now = () => Date.now(), onChange = () => {} }) {
  async function active() { return soldOutOf(await getSettingsData(), now()); }
  async function set(productId, { soldOut, until = "reopen_next_open", by = null, name = null } = {}) {
    const id = String(productId ?? "").trim();
    if (!/^\d{1,12}$/.test(id)) return { ok: false, error: "bad_product_id" };
    if (soldOut) {
      const s = await getSettingsData();
      const untilIso = until === null || until === "manual" ? null
        : (typeof until === "string" && until !== "reopen_next_open" && !Number.isNaN(Date.parse(until)) && Date.parse(until) > now()
          ? new Date(Date.parse(until)).toISOString()
          : nextOpening(s?.hours, now()));
      const entry = { at: new Date(now()).toISOString(), by: by ? String(by).slice(0, 60) : null, until: untilIso,
        name: name ? String(name).slice(0, 80) : null };
      await pool.query(
        `UPDATE settings SET data = jsonb_set(
           jsonb_set(
             CASE WHEN data ? 'catalog' THEN data ELSE jsonb_set(data,'{catalog}','{}'::jsonb,true) END,
             '{catalog,soldOut}', COALESCE(data->'catalog'->'soldOut','{}'::jsonb), true),
           ARRAY['catalog','soldOut',$1::text], $2::jsonb, true) WHERE id=1`, [id, JSON.stringify(entry)]);
      try { onChange(); } catch {}
      return { ok: true, productId: id, soldOut: true, entry };
    }
    await pool.query(
      `UPDATE settings SET data = data #- ARRAY['catalog','soldOut',$1::text] WHERE id=1`, [id]);
    try { onChange(); } catch {}
    return { ok: true, productId: id, soldOut: false, entry: null };
  }
  return { active, set };
}

/* قايمة الأصناف مجمّعة بالأقسام (نفس منيو المتجر) + حالة «خلص». */
export function groupMenu(menuJson, active) {
  const pages = menuJson?.data?.pages || [];
  const MERCH = /best|الأكثر|offers|العروض/i;
  const rank = (p) => (MERCH.test(`${p.title || ""} ${p.local_title || ""}`) ? 1 : 0);
  const seen = new Set();
  const groups = [];
  for (const p of [...pages].sort((a, b) => rank(a) - rank(b))) {
    const items = [];
    for (const it of p.items || []) {
      const id = String(it.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const so = active[id] || null;
      items.push({
        id, name: it.name || it.local_name || "", name_en: it.local_name || "",
        image: it.image || "", price: Number(it.retail_price != null ? it.retail_price : it.price) || 0,
        soldOut: !!so, soldOutAt: so?.at || null, soldOutBy: so?.by || null, soldOutUntil: so?.until || null,
      });
    }
    if (items.length) groups.push({ category: p.local_title || p.title || "", items });
  }
  return groups;
}

/* المسارات: البورتال (مدير، أو كاشير لو settings.portal.cashierCanSoldOut) + اللوحة. */
export function register(app, { pool, getSettingsData, requireAdmin, requirePortal, audit, cmsWho, onChange, log = console, fetchMenu, now }) {
  const store = makeSoldOutStore({ pool, getSettingsData, now, onChange });
  const STORE_BASE = () => (process.env.CATALOG_MENU_BASE || process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
  let menuCache = { at: 0, json: null };
  const getMenu = fetchMenu || (async () => {
    if (menuCache.json && Date.now() - menuCache.at < 60_000) return menuCache.json;
    const r = await fetch(`${STORE_BASE()}/api/menu?branch_id=1&raw=1`, {
      signal: AbortSignal.timeout(15000), headers: { "User-Agent": "freshcuts-soldout" } });
    if (!r.ok) throw new Error(`menu HTTP ${r.status}`);
    menuCache = { at: Date.now(), json: await r.json() };
    return menuCache.json;
  });

  async function listPayload() {
    const act = await store.active();
    let groups = [];
    let menuError = null;
    try { groups = groupMenu(await getMenu(), act); } catch (e) { menuError = e.message; }
    const names = Object.fromEntries(groups.flatMap((g) => g.items.map((i) => [i.id, i.name])));
    const closed = Object.entries(act).map(([id, e]) => ({ id, ...e, name: names[id] || e.name || `#${id}` }));
    return { ok: true, groups, closed, count: closed.length, menuError };
  }
  async function change(body, by) {
    const soldOut = body?.soldOut === true;
    const until = body?.until === null || body?.until === "manual" ? null : (body?.until || "reopen_next_open");
    return store.set(body?.productId, { soldOut, until, by, name: body?.name || null });
  }

  async function portalGate(c) {
    const s = await getSettingsData();
    const cashierOk = !!(s?.portal && s.portal.cashierCanSoldOut);
    return requirePortal(c, cashierOk ? null : "manager");
  }

  app.get("/api/portal/menu-availability", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res; // القراية للكل (الكاشير يعرف إيه خلص)
    const p = await listPayload();
    const s = await getSettingsData();
    p.canEdit = a.user.role === "manager" || !!(s?.portal && s.portal.cashierCanSoldOut);
    return c.json(p);
  });
  app.post("/api/portal/menu-availability", async (c) => {
    const a = await portalGate(c); if (a.res) return a.res;
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const r = await change(b, a.user.name);
    if (!r.ok) return c.json(r, 400);
    try { audit?.(a.user, r.soldOut ? "item_sold_out" : "item_reopened", null, true, { productId: r.productId, name: b.name ? String(b.name).slice(0, 80) : null, until: r.entry?.until ?? null }); } catch {}
    try { log.log?.(`[soldout] ${a.user.name} ${r.soldOut ? "closed" : "reopened"} ${r.productId}`); } catch {}
    return c.json(r);
  });
  // اللوحة (المالك/الفريق) — نفس المنطق
  app.get("/api/cms/menu-availability", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ...(await listPayload()), canEdit: true });
  });
  app.post("/api/cms/menu-availability", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const by = (cmsWho ? await cmsWho(c).catch(() => null) : null) || "المالك";
    const r = await change(b, by);
    if (!r.ok) return c.json(r, 400);
    try { audit?.({ id: "dashboard", name: by, role: "dashboard" }, r.soldOut ? "item_sold_out" : "item_reopened", null, true, { productId: r.productId, via: "dashboard", until: r.entry?.until ?? null }); } catch {}
    return c.json(r);
  });
  return store;
}
