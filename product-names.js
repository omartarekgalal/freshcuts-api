/* ═══════════════════════════════════════════════════════════════════════════
   PRODUCT NAMES — محلّل أسماء الأصناف (بلاغ عمر ١٧ سبتمبر ٢٠٢٦:
   «ف البورتال مش كل الاصناف بتظهر باسمها بعضها بيظهر برقم»).

   السبب: سلة المتصفح بتبعت {product_id, quantity, unit_amount} وبس. الاسم
   عمره ما اتخزّن في shop_orders.items إلا لسطور الباقة (السيرفر هو اللي
   بيوسّعها فبيعرف الاسم). فالشاشة كانت بتكتب «منتج ١٠٥» — رقم داخلي مالوش
   معنى للكاشير ولا للمطبخ.

   الحل: المصدر الوحيد للأسماء = قايمة تاب سينس (نفس مصدر الأسعار). بنبني
   منها فهرس، بنخزّنه في ts_product_names عشان يعيش بعد إعادة التشغيل ولو
   تاب سينس وقعت، وبنستعمله في ٣ أماكن:
     • الشيك أوت  — الاسم بيتخزّن مع الطلب وقت إنشاءه (المصدر الصح)
     • backfill   — الطلبات القديمة/المفتوحة بتتصلّح مرة واحدة
     • البورتال   — أي اسم لسه ناقص بيتحل وقت القراية

   الأوزان (ثلث/نصف/كيلو): variant_name بييجي من المتصفح غالباً، ولو ناقص
   بنجيبه من تفاصيل الصنف (stores/…/products/{id}) اللي فيها variant.options.
   مافيش أي فلوس هنا — أسماء عرض بس.
═══════════════════════════════════════════════════════════════════════════ */

import * as tsstoreDefault from "./tsstore.js";

export const NAMES_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ts_product_names (
    product_id TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    variants   JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
]);

const MENU_TTL_MS = 10 * 60_000;
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 120);

/* أي سطر محتاج اسم؟ (سطور الباقة بيوصلها اسمها من التوسيع) */
export const needsName = (it) =>
  Boolean(it && typeof it === "object" && it.product_id != null
    && !String(it.name ?? it.product_name ?? "").trim());

export function makeNameResolver({ pool, tsstore = tsstoreDefault, log = console } = {}) {
  /* الفهرس في الذاكرة: product_id → {name, variants:{optionId:name}} */
  const byId = new Map();
  let ready = null;          // تحميل أول مرة من الداتابيز
  let menuAt = 0;            // آخر مرة قرينا القايمة
  let schema = null;

  const ensureSchema = () => (schema ||= (async () => {
    for (const sql of NAMES_DDL) await pool.query(sql);
    return true;
  })().catch((e) => {
    schema = null;
    try { log.error(`[product-names] schema failed: ${e?.message || e}`); } catch {}
    return false;
  }));

  async function loadFromDb() {
    try {
      if (!(await ensureSchema())) return;
      const rows = (await pool.query("SELECT product_id, name, variants FROM ts_product_names")).rows || [];
      for (const r of rows) {
        byId.set(String(r.product_id), { name: clean(r.name), variants: r.variants || {} });
      }
    } catch (e) {
      try { log.error(`[product-names] load failed: ${e?.message || e}`); } catch {}
    }
  }

  async function save(id, entry) {
    try {
      if (!(await ensureSchema())) return;
      await pool.query(
        `INSERT INTO ts_product_names(product_id, name, variants, updated_at)
         VALUES ($1,$2,$3::jsonb,NOW())
         ON CONFLICT (product_id) DO UPDATE
           SET name = EXCLUDED.name,
               variants = ts_product_names.variants || EXCLUDED.variants,
               updated_at = NOW()`,
        [String(id), entry.name, JSON.stringify(entry.variants || {})]);
    } catch (e) {
      try { log.error(`[product-names] save ${id} failed: ${e?.message || e}`); } catch {}
    }
  }

  /* قراية القايمة: بتديّنا اسم كل صنف. بتفشل بهدوء — الفهرس القديم بيفضل
     شغّال، وأسوأ حاجة هتحصل إن صنف جديد يفضل برقمه لحد الدورة الجاية. */
  async function refreshMenu(force = false) {
    if (!force && Date.now() - menuAt < MENU_TTL_MS) return;
    menuAt = Date.now();
    let menu = null;
    try { menu = await tsstore.fetchMenu("1"); }
    catch (e) { try { log.error(`[product-names] menu fetch failed: ${e?.message || e}`); } catch {} return; }
    for (const p of menu?.pages || []) {
      for (const it of p.items || []) {
        const id = String(it?.id ?? "");
        const name = clean(it?.name || it?.local_name);
        if (!id || !name) continue;
        const old = byId.get(id);
        if (old && old.name === name) continue;
        const entry = { name, variants: old?.variants || {} };
        byId.set(id, entry);
        save(id, entry);
      }
    }
  }

  /* اسم الوزن/الحجم من تفاصيل الصنف — مكالمة واحدة لكل صنف، والنتيجة بتتخزّن. */
  const variantPending = new Map();
  const variantsAsked = new Set();   // صنف سألنا عنه خلاص — حتى لو طلع من غير أوزان
  async function loadVariants(id) {
    const k = String(id);
    if (variantPending.has(k)) return variantPending.get(k);
    if (variantsAsked.has(k)) return byId.get(k) || null;
    variantsAsked.add(k);
    const p = (async () => {
      try {
        const r = await tsstore.callStore(`stores/${tsstore.STORE()}/products/${k}`, { branchId: "1" });
        const d = r?.data;
        if (!d || d.id == null) return null;
        const variants = {};
        for (const o of (d.variant && Array.isArray(d.variant.options) ? d.variant.options : [])) {
          if (o?.id != null && clean(o.name)) variants[String(o.id)] = clean(o.name);
        }
        const entry = { name: clean(d.name || d.local_name) || byId.get(k)?.name || "", variants };
        if (!entry.name) return null;
        byId.set(k, entry);
        save(k, entry);
        return entry;
      } catch { variantsAsked.delete(k); return null; }   // فشل مؤقت: نجرّب تاني بعدين
      finally { variantPending.delete(k); }
    })();
    variantPending.set(k, p);
    return p;
  }

  async function init() {
    if (!ready) ready = loadFromDb().then(() => refreshMenu(true));
    return ready;
  }

  /* الواجهة الأساسية: بتاخد مصفوفة سطور وترجّع نسخة بالأسماء مكمّلة.
     عمرها ما ترمي، وعمرها ما تلمس أي حقل غير name/variant_name. */
  async function fillNames(items, { allowNetwork = true } = {}) {
    if (!Array.isArray(items) || !items.length) return { items, filled: 0 };
    const missing = items.filter(needsName);
    const needVariant = items.filter((it) => it && it.variant_option_id != null
      && !String(it.variant_name ?? "").trim());
    if (!missing.length && !needVariant.length) return { items, filled: 0 };
    if (allowNetwork) {
      try { await init(); await refreshMenu(); } catch { /* الفهرس القديم يكفي */ }
      const unknown = [...new Set(missing.filter((it) => !byId.get(String(it.product_id))?.name)
        .map((it) => String(it.product_id)))].slice(0, 10);
      // الأوزان اللي عندنا اسمها أصلاً مابنسألش عنها تاني
      const needOpts = [...new Set(needVariant
        .filter((it) => !byId.get(String(it.product_id))?.variants?.[String(it.variant_option_id)])
        .map((it) => String(it.product_id)))].slice(0, 10);
      await Promise.all([...new Set([...unknown, ...needOpts])].map((id) => loadVariants(id)));
    }
    let filled = 0;
    const out = items.map((it) => {
      if (!it || typeof it !== "object") return it;
      const e = byId.get(String(it.product_id));
      if (!e) return it;
      const patch = {};
      if (needsName(it) && e.name) patch.name = e.name;
      if (it.variant_option_id != null && !String(it.variant_name ?? "").trim()) {
        const vn = e.variants?.[String(it.variant_option_id)];
        if (vn) patch.variant_name = vn;
      }
      if (!Object.keys(patch).length) return it;
      filled++;
      return { ...it, ...patch };
    });
    return { items: out, filled };
  }

  /* نفس الحكاية بس لصف طلب كامل (بيرجّع الصف نفسه لو مفيش تغيير) */
  async function fillRow(row, opts) {
    if (!row || !Array.isArray(row.items)) return row;
    const { items, filled } = await fillNames(row.items, opts);
    return filled ? { ...row, items } : row;
  }

  async function fillRows(rows, opts) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    const need = rows.some((r) => Array.isArray(r?.items) && r.items.some(needsName));
    if (!need) return rows;
    const out = [];
    for (const r of rows) out.push(await fillRow(r, opts));
    return out;
  }

  const size = () => byId.size;
  const nameOf = (id) => byId.get(String(id))?.name || null;

  return { init, refreshMenu, fillNames, fillRow, fillRows, nameOf, size, ensureSchema, _byId: byId };
}

/* ═══════════════════════════════════════════════════════════════════════════
   BACKFILL — الطلبات اللي اتخزّنت من غير أسماء.

   بنعدّل حقل العرض بس (name/variant_name جوّه items). الأسعار والكميات
   وأي حاجة ليها علاقة بفلوس مابتتلمسش خالص، والسطر اللي مالوش اسم معروف
   بيفضل زي ما هو (الشاشة بتعرضه «صنف #<رقم>»).
═══════════════════════════════════════════════════════════════════════════ */
export async function backfillItemNames(pool, resolver, { days = 60, limit = 500, log = console } = {}) {
  const out = { scanned: 0, updated: 0, lines: 0, failed: 0 };
  let rows = [];
  try {
    rows = (await pool.query(
      `SELECT order_no, items FROM shop_orders
        WHERE created_at > NOW() - make_interval(days => $1::int)
          AND jsonb_typeof(items) = 'array'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(items) it
                       WHERE it->>'product_id' IS NOT NULL
                         AND COALESCE(NULLIF(trim(it->>'name'),''), NULLIF(trim(it->>'product_name'),'')) IS NULL)
        ORDER BY created_at DESC LIMIT $2::int`, [String(days), String(limit)])).rows || [];
  } catch (e) {
    try { log.error(`[product-names] backfill query failed: ${e?.message || e}`); } catch {}
    return { ...out, error: "query_failed" };
  }
  out.scanned = rows.length;
  if (!rows.length) return out;
  try { await resolver.init(); } catch { /* الفهرس الموجود يكفي */ }
  for (const r of rows) {
    try {
      const { items, filled } = await resolver.fillNames(r.items);
      if (!filled) continue;
      await pool.query("UPDATE shop_orders SET items = $2::jsonb WHERE order_no = $1",
        [r.order_no, JSON.stringify(items)]);
      out.updated++;
      out.lines += filled;
    } catch (e) {
      out.failed++;
      try { log.error(`[product-names] backfill ${r.order_no} failed: ${e?.message || e}`); } catch {}
    }
  }
  try { log.log?.(`[product-names] backfill: ${out.updated}/${out.scanned} طلب، ${out.lines} سطر`); } catch {}
  return out;
}
