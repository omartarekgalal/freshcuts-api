/* ═══════════════════════════════════════════════════════════════════════════
   🛍 سلات جاهزة للإعلانات (cart_presets) — ١٠/١٠/٢٠٢٦

   الإعلان بيقول «عشا البيت بـ٨٩»؛ العميل يضغط ويلاقي السلة دي نفسها جاهزة،
   مش منيو يدوّر فيه. نفس صفحة استرداد السلة بالظبط — freshcuts.sa/c/<code>:
   البروكسي بينادي POST /api/carts/restore/:code/open (بيعدّ الفتحة ويبني رابط
   الهبوط)، والمتجر بينادي GET /api/carts/restore/:code ويبني السلة. فمفيش أي
   تعديل في المتجر: carts.js بيسأل cart_recovery الأول، ولو الكود مش هناك
   بيسأل هنا.

   الفرق عن رابط الاسترداد: السلة الجاهزة **بتتفتح للأبد ولأي حد** (مفيش جوال،
   مفيش صلاحية ٧ أيام، مفيش «اتطلبت»)، والكوبون بيتحط دايماً لو متحدد — المتجر
   والسيرفر هما اللي بيتأكدوا من الأهلية وقت الدفع.

   السلة نفسها: items = [{id,q}] من المنيو (كفاية للأصناف العادية)، أو cart_raw
   = لقطة طبق الأصل من المتجر (باقات/أوزان/اختيارات) — بتتاخد بـ«التقاط من سلة
   محفوظة»: المالك يبني السلة على المتجر الحقيقي برقمه، وإحنا ناخد آخر لقطة
   من shop_carts.

   روابط الحملات: /l/<slug> بهدف «سلة جاهزة» (cms.js) بيهبط على نفس السلة
   بـUTM الرابط وfc_link بتاعه، فحارس الإعلانات والتقارير شغّالين زي ما هم.
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import * as tsstore from "./tsstore.js";

export const PRESET_CODE_RE = /^[a-z0-9]{6,16}$/;
export const PRESET_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/; // نفس قاعدة cms_links.slug
const COUPON_RE = /^[A-Z0-9_-]{2,40}$/;
const PAID_SQL = "status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')";

export const PRESETS_DDL = `
  CREATE TABLE IF NOT EXISTS cart_presets (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    title TEXT,
    title_en TEXT,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    cart_raw JSONB,
    subtotal NUMERIC NOT NULL DEFAULT 0,
    coupon TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    link_slug TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    opens INT NOT NULL DEFAULT 0,
    last_open_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by TEXT
  );
`;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clip = (v, n) => {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? Array.from(s).slice(0, n).join("") : null;
};

export const newPresetCode = () =>
  crypto.randomBytes(6).toString("base64url").replace(/[-_]/g, "").toLowerCase().slice(0, 8).padEnd(8, "x");

/* [{id,q}] نضيفة: معرّف نصي، كمية ١–٩٩، من غير تكرار (المكرر بيتجمع)، ٦٠ سطر بالكتير.
   n/p (الاسم والسعر وقت الحفظ) اختياريين — للعرض في اللوحة بس، المتجر بيقرا من المنيو. */
export function cleanPresetItems(items) {
  const out = [];
  const at = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!isObj(it)) continue;
    const id = String(it.id ?? "").trim().slice(0, 200);
    if (!id) continue;
    const q = Math.min(99, Math.max(1, Math.round(Number(it.q ?? it.qty) || 1)));
    if (at.has(id)) { const row = out[at.get(id)]; row.q = Math.min(99, row.q + q); continue; }
    const row = { id, q };
    const n = clip(it.n ?? it.name, 60);
    if (n) row.n = n;
    const p = Number(it.p ?? it.price);
    if (Number.isFinite(p) && p >= 0) row.p = Math.round(p * 100) / 100;
    at.set(id, out.length);
    out.push(row);
    if (out.length >= 60) break;
  }
  return out;
}

/* جسم الإنشاء/التعديل → حقول نضيفة أو خطأ واحد واضح. code فاضي = السيرفر يولّد. */
export function presetBody(b) {
  if (!isObj(b)) return { error: "bad_body" };
  const name = clip(b.name, 80);
  if (!name) return { error: "name_required" };
  const code = String(b.code ?? "").trim().toLowerCase();
  if (code && !PRESET_CODE_RE.test(code)) return { error: "bad_code" };
  const coupon = String(b.coupon ?? "").trim().toUpperCase();
  if (coupon && !COUPON_RE.test(coupon)) return { error: "bad_coupon" };
  const link_slug = String(b.link_slug ?? "").trim().toLowerCase();
  if (link_slug && !PRESET_SLUG_RE.test(link_slug)) return { error: "bad_link_slug" };
  const items = cleanPresetItems(b.items);
  const sub = Number(b.subtotal);
  return {
    value: {
      name, code: code || null,
      title: clip(b.title, 80), title_en: clip(b.title_en, 80),
      items, coupon: coupon || null,
      utm_source: clip(b.utm_source, 30), utm_medium: clip(b.utm_medium, 30),
      utm_campaign: clip(b.utm_campaign, 80), utm_content: clip(b.utm_content, 80),
      link_slug: link_slug || null,
      active: b.active !== false,
      subtotal: Number.isFinite(sub) && sub >= 0 ? Math.round(sub * 100) / 100 : 0,
    },
  };
}

/* رابط الهبوط: /?cart=<code>[&c=<coupon>][&utm_…][&fc_link=<slug>] */
export function presetLandingUrl(p) {
  const q = new URLSearchParams();
  q.set("cart", p.code);
  if (p.coupon) q.set("c", p.coupon);
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content"]) if (p[k]) q.set(k, p[k]);
  if (p.link_slug) q.set("fc_link", p.link_slug);
  return "/?" + q.toString();
}

/* رد GET /api/carts/restore/:code للسلة الجاهزة — نفس شكل رد الاسترداد + preset/title */
export function presetRestorePayload(p) {
  const raw = isObj(p.cart_raw) && Object.keys(p.cart_raw).length ? p.cart_raw : null;
  return {
    ok: true, items: Array.isArray(p.items) ? p.items : [], raw, option: "delivery",
    preset: true, title: p.title || "", title_en: p.title_en || "",
    subtotal: Number(p.subtotal) || 0, ordered: false,
  };
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, jb, normPhone } = ctx;
  const rawCart = deps.rawCart || ((raw) => (isObj(raw) ? JSON.stringify(raw) : null));
  const storeBase = () => (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");

  /* معرّفات المنيو (كاش ٥ دقايق) — للتحذير بس، عمرها ما بتمنع الحفظ:
     المتجر بيشيل اللي مش متاح وقت الفتح (reconcileCart). */
  let _ids = { at: 0, set: null };
  async function menuIds() {
    if (typeof deps.menuIds === "function") return deps.menuIds();
    if (_ids.set && Date.now() - _ids.at < 300_000) return _ids.set;
    const menu = await tsstore.fetchMenu("1");
    const set = new Set();
    for (const pg of menu?.pages || []) for (const it of pg.items || []) set.add(String(it.id));
    if (!set.size) return null;
    _ids = { at: Date.now(), set };
    return set;
  }
  async function unknownIds(items) {
    try {
      const set = await menuIds();
      if (!set || !set.size) return [];
      return items.map((i) => i.id).filter((id) => /^\d+$/.test(id) && !set.has(id));
    } catch { return []; }
  }

  const who = async (c) => {
    try { if (typeof deps.who === "function") return (await deps.who(c)) || null; } catch { /* */ }
    return null;
  };

  /* ── اللي carts.js بينده عليه من مساري الاسترداد العامّين ── */
  async function openPreset(code) {
    const r = await pool.query(
      `UPDATE cart_presets SET opens = opens + 1, last_open_at = NOW()
        WHERE code=$1 AND active
        RETURNING code, coupon, utm_source, utm_medium, utm_campaign, utm_content, link_slug`, [code]);
    return r.rows[0] ? presetLandingUrl(r.rows[0]) : null;
  }
  async function restorePreset(code) {
    const r = await pool.query(
      `SELECT items, cart_raw, title, title_en, subtotal FROM cart_presets WHERE code=$1 AND active`, [code]);
    return r.rows[0] ? presetRestorePayload(r.rows[0]) : null;
  }
  async function codeTaken(code) {
    const r = await pool.query("SELECT 1 FROM cart_presets WHERE code=$1 LIMIT 1", [code]);
    return r.rowCount > 0;
  }

  /* كود حر = مش مستخدم في سلة جاهزة تانية ولا في رابط استرداد (أي عمر) */
  async function codeFree(code, exceptId) {
    const [a, b] = await Promise.all([
      pool.query("SELECT id FROM cart_presets WHERE code=$1 LIMIT 1", [code]),
      pool.query("SELECT 1 FROM cart_recovery WHERE code=$1 LIMIT 1", [code]),
    ]);
    if (b.rowCount) return false;
    return !a.rowCount || (exceptId != null && Number(a.rows[0].id) === Number(exceptId));
  }
  async function freshCode() {
    for (let i = 0; i < 8; i++) { const c = newPresetCode(); if (await codeFree(c)) return c; }
    throw new Error("code collision");
  }

  /* cart_raw من الجسم: undefined = ماتلمسش، null/{} = امسح، كائن = اقصّه زي لقطة المتجر */
  function rawFromBody(b) {
    if (!("cart_raw" in b)) return { touch: false };
    if (!isObj(b.cart_raw) || !Object.keys(b.cart_raw).length) return { touch: true, value: null };
    const txt = rawCart(b.cart_raw);
    if (!txt) return { error: "cart_raw_too_big" };
    return { touch: true, value: txt };
  }

  const ERR_STATUS = { code_taken: 409 };
  const fail = (c, error) => c.json({ ok: false, error }, ERR_STATUS[error] || 400);

  app.get("/api/carts/presets", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query("SELECT * FROM cart_presets ORDER BY active DESC, created_at DESC")).rows;
    /* الطلبات المنسوبة: بـfc_link — سلَج السلة نفسها + أي رابط حملة هدفه السلة دي.
       shop_orders_attr_link_idx موجود، فده استعلام واحد رخيص لكل القايمة. */
    const viaLinks = new Map(); // code → [slug]
    try {
      const l = await pool.query("SELECT slug, target_id, active, clicks FROM cms_links WHERE target_type='cart'");
      for (const x of l.rows) {
        const k = String(x.target_id || "").toLowerCase();
        if (!viaLinks.has(k)) viaLinks.set(k, []);
        viaLinks.get(k).push({ slug: x.slug, active: x.active, clicks: Number(x.clicks) || 0 });
      }
    } catch { /* cms_links لسه مااتعملش */ }
    const slugsOf = (p) => [...new Set([p.link_slug, ...(viaLinks.get(p.code) || []).map((x) => x.slug)].filter(Boolean))];
    const allSlugs = [...new Set(rows.flatMap(slugsOf))];
    const bySlug = new Map();
    if (allSlugs.length) {
      try {
        const o = await pool.query(
          `SELECT attribution->>'fc_link' AS slug, count(*)::int AS n, COALESCE(sum(total),0)::float AS revenue
             FROM shop_orders WHERE attribution->>'fc_link' = ANY($1::text[]) AND ${PAID_SQL} GROUP BY 1`, [allSlugs]);
        for (const x of o.rows) bySlug.set(x.slug, x);
      } catch { /* من غير طلبات — الفتحات كفاية */ }
    }
    let coupons = [];
    try {
      coupons = (await pool.query(
        `SELECT code, min_total, free_delivery, percent, active, expires_at FROM shop_coupons ORDER BY code`)).rows
        .map((x) => ({ code: String(x.code).toUpperCase(), minTotal: Number(x.min_total) || 0,
          freeDelivery: x.free_delivery === true, percent: Number(x.percent) || 0,
          active: x.active !== false && (!x.expires_at || new Date(x.expires_at) > new Date()) }));
    } catch { /* */ }
    return c.json({
      ok: true, store: storeBase(), coupons,
      presets: rows.map((p) => {
        const slugs = slugsOf(p);
        return {
          ...p, subtotal: Number(p.subtotal) || 0, hasRaw: isObj(p.cart_raw) && Object.keys(p.cart_raw).length > 0,
          url: `${storeBase()}/c/${p.code}`, links: viaLinks.get(p.code) || [],
          // null = مفيش سلَج نقدر ننسب بيه (حط «سلَج الرابط» أو اعمل رابط حملة هدفه السلة)
          orders: slugs.length ? slugs.reduce((t, s) => t + (bySlug.get(s)?.n || 0), 0) : null,
          revenue: slugs.length ? Math.round(slugs.reduce((t, s) => t + (bySlug.get(s)?.revenue || 0), 0)) : null,
        };
      }),
    });
  });

  app.post("/api/carts/presets", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b;
    try { b = await c.req.json(); } catch { return fail(c, "bad_json"); }
    const { value: x, error } = presetBody(b);
    if (error) return fail(c, error);
    const raw = rawFromBody(b);
    if (raw.error) return fail(c, raw.error);
    if (!x.items.length && !raw.value) return fail(c, "empty_cart");
    let code = x.code;
    if (code) { if (!(await codeFree(code))) return fail(c, "code_taken"); }
    else code = await freshCode();
    try {
      const r = await pool.query(
        `INSERT INTO cart_presets(code, name, title, title_en, items, cart_raw, subtotal, coupon,
                                  utm_source, utm_medium, utm_campaign, utm_content, link_slug, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [code, x.name, x.title, x.title_en, jb(x.items), raw.value || null, x.subtotal, x.coupon,
         x.utm_source, x.utm_medium, x.utm_campaign, x.utm_content, x.link_slug, x.active, await who(c)]);
      return c.json({ ok: true, preset: r.rows[0], url: `${storeBase()}/c/${code}`, unknownIds: await unknownIds(x.items) });
    } catch (e) {
      if (String(e.message).includes("duplicate")) return fail(c, "code_taken");
      throw e;
    }
  });

  app.put("/api/carts/presets/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return fail(c, "bad_id");
    let b;
    try { b = await c.req.json(); } catch { return fail(c, "bad_json"); }
    if (!isObj(b)) return fail(c, "bad_body");
    // زرار التشغيل/الإيقاف في القايمة
    if (Object.keys(b).length === 1 && typeof b.active === "boolean") {
      const r = await pool.query("UPDATE cart_presets SET active=$2, updated_at=NOW() WHERE id=$1 RETURNING *", [id, b.active]);
      if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
      return c.json({ ok: true, preset: r.rows[0] });
    }
    const cur = (await pool.query("SELECT * FROM cart_presets WHERE id=$1", [id])).rows[0];
    if (!cur) return c.json({ ok: false, error: "not_found" }, 404);
    const { value: x, error } = presetBody(b);
    if (error) return fail(c, error);
    const raw = rawFromBody(b);
    if (raw.error) return fail(c, raw.error);
    const keepsRaw = raw.touch ? Boolean(raw.value) : isObj(cur.cart_raw) && Object.keys(cur.cart_raw).length > 0;
    if (!x.items.length && !keepsRaw) return fail(c, "empty_cart");
    const code = x.code || cur.code;
    if (code !== cur.code && !(await codeFree(code, id))) return fail(c, "code_taken");
    try {
      const r = await pool.query(
        `UPDATE cart_presets SET code=$2, name=$3, title=$4, title_en=$5, items=$6,
                cart_raw = CASE WHEN $7::boolean THEN $8::jsonb ELSE cart_raw END,
                subtotal=$9, coupon=$10, utm_source=$11, utm_medium=$12, utm_campaign=$13, utm_content=$14,
                link_slug=$15, active=$16, updated_at=NOW()
          WHERE id=$1 RETURNING *`,
        [id, code, x.name, x.title, x.title_en, jb(x.items), raw.touch, raw.touch ? raw.value : null, x.subtotal, x.coupon,
         x.utm_source, x.utm_medium, x.utm_campaign, x.utm_content, x.link_slug, x.active]);
      return c.json({ ok: true, preset: r.rows[0], url: `${storeBase()}/c/${code}`, unknownIds: await unknownIds(x.items) });
    } catch (e) {
      if (String(e.message).includes("duplicate")) return fail(c, "code_taken");
      throw e;
    }
  });

  app.delete("/api/carts/presets/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return fail(c, "bad_id");
    const r = await pool.query("DELETE FROM cart_presets WHERE id=$1", [id]);
    return c.json({ ok: true, deleted: r.rowCount || 0 });
  });

  /* «التقاط من سلة محفوظة»: آخر لقطة سلة لجوال (أو جهاز) من shop_carts.
     POST مش GET عشان الجوال مايبقاش في الرابط/اللوجات. بترجّع السلة بس — الحفظ
     بيحصل من POST /api/carts/presets بعد ما المالك يراجعها. */
  app.post("/api/carts/presets/capture", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b;
    try { b = await c.req.json(); } catch { return fail(c, "bad_json"); }
    if (!isObj(b)) return fail(c, "bad_body");
    const device = String(b.device || b.deviceId || "").trim().slice(0, 64);
    const phone = b.phone ? String(normPhone(b.phone) || "") : "";
    let row = null;
    const cols = "device_id, items, cart_raw, subtotal, item_count, option, stage, updated_at";
    if (device) {
      if (!/^[a-z0-9_-]{8,64}$/i.test(device)) return fail(c, "bad_device");
      row = (await pool.query(`SELECT ${cols} FROM shop_carts WHERE device_id=$1 AND item_count > 0`, [device])).rows[0];
    } else {
      if (!/^5\d{8}$/.test(phone)) return fail(c, "bad_phone");
      // اللي فيها لقطة خام الأول (هي اللي بترجّع الباقات والأوزان)، وبعدين الأحدث
      row = (await pool.query(
        `SELECT ${cols} FROM shop_carts WHERE phone_norm=$1 AND item_count > 0
          ORDER BY (cart_raw IS NOT NULL) DESC, updated_at DESC LIMIT 1`, [phone])).rows[0];
    }
    if (!row) return c.json({ ok: false, error: "no_cart" }, 404);
    const hasRaw = isObj(row.cart_raw) && Object.keys(row.cart_raw).length > 0;
    return c.json({
      ok: true,
      cart: {
        items: cleanPresetItems(row.items), cart_raw: hasRaw ? row.cart_raw : null, hasRaw,
        subtotal: Number(row.subtotal) || 0, itemCount: Number(row.item_count) || 0,
        option: row.option || null, stage: row.stage || null, updatedAt: row.updated_at,
      },
    });
  });

  return { openPreset, restorePreset, codeTaken };
}
