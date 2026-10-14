/* ═══════════════════════════════════════════════════════════════════════════
   HUNGERSTATION CONTROL — إتاحة الأصناف في هنقرستيشن من لوحتنا (٢٠٢٦-١٠-١٤)

   نفس فكرة keeta_control.js. اللي هنا اتجرّب على المحل الحقيقي بس (١٤/١٠،
   يوزر hestoriamarketing، صنف «دوريتوس» 126034765):
     • القراية: GET {GDP}/platforms/HS_SA/vendors/<id>/catalogs (الأقسام + العدّادات)
                GET …/catalogs/<cat>/categories/<catId>/products?locale=ar-SA
     • الإتاحة: PUT {GDP}/platforms/HS_SA/vendors/<id>/catalogs/products/<pid>/availability
                {available, schedules?, context:"MENU_UPDATE"} → 202، والحالة بتبقى
                REQUESTED وبعدين COMMITTED.
       schedules زي البوابة نفسها (حزمة menu-management-v2):
         ساعات   → [{action:"ENABLE", type:"AT_TIMESTAMP", timestamp:ISO من غير ملّي}]
         الفتح الجاي → [{action:"ENABLE", type:"NEXT_BUSINESS_DAY"}]
         لحد ما أفتحه → من غير schedules
   الدخول نفس دخول portals.js (POST /api/1/auth/form، توكن ١٤ يوم). الـGDP host
   بيقبل نفس التوكن. العروض (vfd-offer-api) لأ — محتاجة توكن بوابة الشركاء.
   الأسعار مش هنا: المنيو جاي من «Catalog Importer» (FeedUs).
═══════════════════════════════════════════════════════════════════════════ */

import { controlSettings } from "./keeta_control.js";

const AUTH = (process.env.HS_API_BASE || "https://vendor-api-sa.me.restaurant-partners.com").replace(/\/$/, "");
const GDP = (process.env.HS_GDP_BASE || "https://vendor-api-gdp-sa.me.restaurant-partners.com/api/5").replace(/\/$/, "");
const PLATFORM = process.env.HS_GLOBAL_ENTITY || "HS_SA";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const vendorId = () => process.env.HS_VENDOR_ID || "";
const configured = () => !!(process.env.HS_EMAIL && process.env.HS_PASSWORD && vendorId());

/* ── pure helpers (اتختبروا في hs-control.test.mjs) ── */

/** until → schedules بنفس شكل بوابة هنقرستيشن. undefined = لحد ما حد يفتحه. */
export function hsSchedules(until, nowMs = Date.now()) {
  if (until === "manual" || until === null) return undefined;
  if (until === "open" || until === undefined || until === "") return [{ action: "ENABLE", type: "NEXT_BUSINESS_DAY" }];
  const rel = { "30m": 30, "1h": 60, "3h": 180 }[until];
  let t;
  if (rel) t = nowMs + rel * 60_000;
  else {
    t = Date.parse(String(until));
    if (!Number.isFinite(t)) throw new Error("وقت الرجوع مش مفهوم");
    if (t <= nowMs + 60_000) throw new Error("وقت الرجوع لازم يكون بعد دقيقة على الأقل");
    if (t > nowMs + 60 * 86400_000) throw new Error("وقت الرجوع أبعد من ٦٠ يوم — استخدم «لحد ما أرجّعه بنفسي»");
  }
  const d = new Date(t); d.setUTCMilliseconds(0);
  return [{ action: "ENABLE", type: "AT_TIMESTAMP", timestamp: d.toISOString().replace(".000Z", "Z") }];
}

export function hsItemView(p, categoryName = null) {
  const av = p.availability || {};
  const sch = (av.schedules || [])[0] || null;
  return {
    id: String(p.id),
    name: p.name || null,
    categoryId: p.category?.id ? String(p.category.id) : null,
    category: categoryName,
    available: av.available !== false,
    pending: av.status === "REQUESTED",
    backAt: av.available === false && sch?.type === "AT_TIMESTAMP" ? sch.timestamp : null,
    backAtNextOpen: av.available === false && sch?.type === "NEXT_BUSINESS_DAY",
    price: Number(p.unitPrice) || null,
    picture: (p.images || [])[0]?.url || null,
  };
}

/* ── transport ── */
const tok = { value: null, at: 0 };
function headers(extra = {}) {
  return {
    "User-Agent": UA, Accept: "application/json", "Accept-Language": "ar-SA",
    "x-global-entity-id": PLATFORM, "x-platform-vendor-id": vendorId(),
    "x-vendor-id": process.env.HS_LPV_ID || "", "x-rps-device": process.env.HS_DEVICE_UUID || "WEB|freshcuts-server",
    "x-rps-client-app-name": "vendor-web", ...extra,
  };
}
async function token(force = false) {
  if (!force && tok.value && Date.now() - tok.at < 10 * 86400_000) return tok.value;
  const r = await fetch(`${AUTH}/api/1/auth/form`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({ username: process.env.HS_EMAIL || "", password: process.env.HS_PASSWORD || "" }),
  });
  if (!r.ok) throw new Error(`تعذر الدخول على هنقرستيشن (HTTP ${r.status}) — راجع HS_EMAIL/HS_PASSWORD`);
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error("هنقرستيشن مارجّعتش توكن الدخول");
  tok.value = j.token; tok.at = Date.now();
  return tok.value;
}
async function hs(path, { method = "GET", body } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(GDP + path, {
      method,
      headers: headers({ Authorization: `Bearer ${await token(attempt > 0)}`, ...(body ? { "Content-Type": "application/json" } : {}) }),
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;   // التوكن مات أو حماية — نجرّب دخول جديد مرة
    const text = await res.text();
    if (!res.ok) throw new Error(`هنقرستيشن رفضت (HTTP ${res.status}): ${text.slice(0, 160)}`);
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  }
  throw new Error("هنقرستيشن رفضت الدخول مرتين — غالباً حماية البوابة، جرّب كمان شوية");
}

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, auditNote } = ctx;
  const vpath = () => `/platforms/${PLATFORM}/vendors/${vendorId()}`;

  async function logAction(c, action, summary, request, result, ok, verified) {
    let auditId = null;
    try { const p = c.get("cmsAudit"); auditId = p ? await p : null; } catch { /* */ }
    await pool.query(
      `INSERT INTO keeta_actions(audit_id, action, summary, request, result, ok, verified) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [auditId, action, summary, JSON.stringify(request ?? null), JSON.stringify(result ?? null), !!ok, verified ?? null]
    ).catch((e) => console.error("[hs-control] log:", e.message));
    await auditNote?.(c, `هنقرستيشن: ${summary}`);
  }

  let cache = null;
  async function readMenu(force = false) {
    if (!force && cache && Date.now() - cache.at < 20_000) return cache;
    const cat = await hs(`${vpath()}/catalogs`);
    const catalog = (cat?.catalogs || [])[0];
    if (!catalog) throw new Error("مفيش منيو في هنقرستيشن");
    const cats = (catalog.categories || []).map((k) => ({
      id: String(k.id), name: (k.names || []).find((n) => n.locale === "ar-SA")?.value || k.name,
      count: k.totalProductCount ?? null, off: k.disabledProductCount ?? 0,
    }));
    const items = [];
    for (let i = 0; i < cats.length; i += 3) {   // ٣ في المرة — مانضغطش على البوابة
      const part = await Promise.all(cats.slice(i, i + 3).map((k) =>
        hs(`${vpath()}/catalogs/${catalog.id}/categories/${k.id}/products?locale=ar-SA`).then((list) => (list || []).map((p) => hsItemView(p, k.name)))));
      part.forEach((x) => items.push(...x));
    }
    cache = { at: Date.now(), catalogId: String(catalog.id), cats, items, byId: new Map(items.map((x) => [x.id, x])) };
    return cache;
  }

  async function settle(read, done, waits = [1500, 2500, 3000]) {
    let last = null;
    for (let i = 0; i <= waits.length; i++) {
      last = await read().catch(() => null);
      if (last && done(last)) return { value: last, ok: true };
      if (i < waits.length) await new Promise((r) => setTimeout(r, waits[i]));
    }
    return { value: last, ok: false };
  }

  async function guard(c) {
    const err = await requireAdmin(c); if (err) return err;
    if (!configured()) return c.json({ ok: false, error: "هنقرستيشن غير مربوطة على السيرفر (HS_EMAIL/HS_PASSWORD/HS_VENDOR_ID)" });
    return null;
  }

  app.get("/api/hs/control/state", async (c) => {
    const g = await guard(c); if (g) return g;
    try {
      const [menu, settings, actions] = await Promise.all([
        readMenu(c.req.query("fresh") === "1"), getSettingsData(),
        pool.query(
          `SELECT k.id, k.at, k.action, k.summary, k.ok, k.verified, a.actor_name AS actor
             FROM keeta_actions k LEFT JOIN cms_audit a ON a.id = k.audit_id
            ORDER BY k.id DESC LIMIT 40`).then((r) => r.rows).catch(() => []),
      ]);
      return c.json({ ok: true, control: controlSettings(settings), categories: menu.cats, items: menu.items, promos: [], actions, readAt: new Date().toISOString() });
    } catch (e) { return c.json({ ok: false, error: e.message }); }
  });

  app.post("/api/hs/control/availability", async (c) => {
    const g = await guard(c); if (g) return g;
    const b = await c.req.json().catch(() => ({}));
    const cfg = controlSettings(await getSettingsData());
    if (!cfg.enabled) return c.json({ ok: false, error: "التحكم في التطبيقات مقفول من الإعدادات" });
    const ids = [...new Set((b.productIds || []).map(String).filter((x) => /^\d{3,}$/.test(x)))];
    if (!ids.length) return c.json({ ok: false, error: "اختار صنف واحد على الأقل" });
    if (ids.length > cfg.maxItemsPerAction) return c.json({ ok: false, error: `أكتر من ${cfg.maxItemsPerAction} صنف في مرة واحدة` });
    const available = b.available === true;
    try {
      const menu = await readMenu(true);
      const unknown = ids.filter((id) => !menu.byId.has(id));
      if (unknown.length) return c.json({ ok: false, error: `أصناف مش في منيو هنقرستيشن: ${unknown.join(", ")}` });
      const schedules = available ? undefined : hsSchedules(b.until);
      const body = { available, ...(schedules ? { schedules } : {}), context: "MENU_UPDATE" };
      const names = ids.map((id) => menu.byId.get(id).name);
      const errors = [];
      for (const id of ids) {
        try { await hs(`${vpath()}/catalogs/products/${id}/availability`, { method: "PUT", body }); }
        catch (e) { errors.push({ id, error: e.message }); }
      }
      const settled = await settle(() => readMenu(true), (m) => ids.every((id) => m.byId.get(id)?.available === available));
      const after = settled.value;
      const changed = after ? ids.filter((id) => after.byId.get(id)?.available === available) : [];
      const missed = ids.filter((id) => !changed.includes(id));
      const verified = settled.ok && !errors.length;
      const when = available ? "" : schedules?.[0]?.type === "AT_TIMESTAMP" ? ` لحد ${schedules[0].timestamp}` : schedules ? " لحد الفتح الجاي" : " لحد ما يتفتح";
      await logAction(c, available ? "hs_item_on" : "hs_item_off", `${available ? "متاح" : "غير متاح"}${when}: ${names.join("، ")}`,
        { ids, names, body }, { errors, changed, missed }, verified, verified);
      return c.json({ ok: verified, applied: true, verified, changed, missed, errors,
        error: verified ? null : errors.length ? errors[0].error : "هنقرستيشن ردّت بس الحالة ماتغيّرتش لكل الأصناف بعد ١٠ ثواني — حدّث بعد دقيقة" });
    } catch (e) { return c.json({ ok: false, error: e.message }); }
  });

  console.log("[hs-control] routes ready");
}
