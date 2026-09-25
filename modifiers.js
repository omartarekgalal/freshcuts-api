/* ═══════════════════════════════════════════════════════════════════════════
   الإضافات على أصناف المتجر — «حشو الأطراف» للبيتزا (طلب عمر ٢٥/٩)

   ── ليه ده موجود ───────────────────────────────────────────────────────────
   القائمة الرقمية اللي المتجر بيقرا منها (`freshcuts.sa/api/menu`) **مفيهاش
   حقل إضافات خالص** — لا للبيتزا ولا لأي صنف. فالعميل أونلاين مكانش يقدر
   يطلب حشو أطراف، والكاشير في المحل يقدر. الإضافات موجودة في مكان تاني:
   **API الشركاء** (`/tp/api/v1/products`) — نفس الواحد اللي بننزّل بيه
   الطلبات على نقطة البيع.

   ── الربط بين المصدرين ─────────────────────────────────────────────────────
   `tenant_product_id = "freshcuts-" + رقم الصنف في القائمة الرقمية`
   (اتأكدنا: بيتزا بيبروني رقمها ٤٠ في المنيو و`freshcuts-40` عند الشريك).

   ── شكل الإضافة اللي تاب سينس بيقبله (مثبت على الإنتاج ٢٥/٩) ───────────────
   على سطر الشرا: `modifiers: [{ id, quantity, unit_amount }]`
     • `id`          = الرقم الخام بتاع الخيار (١٦/١٧) — زي `variant_option`
                       بالظبط. بيشتغل على المسارين (الشريك والمتجر)؛
                       الـid المقنّع بيشتغل على الشريك بس.
     • `unit_amount` = السعر **قبل الضريبة** بوحدة السطر نفسه.
     • التلاتة إجباريين — ناقص أي واحد = 422.

   ── تحذير الوحدات: المسارين مش بنفس المقياس ────────────────────────────────
   • مسار الشريك (`tspartner`)  → `multiply_factor: 100`  ⇒ هللات
   • مسار المتجر (`tsstore`)    → `MULTIPLY = 1e6`        ⇒ جزء من مليون
   ومسار المتجر **بيرفض أي فرق قرش واحد** عن سعر النظام
   («unit_amount and system price must match»). سعر الكيري الحقيقي
   2.608695652173913 — لو قرّبناه لهللات (٢٦١) وضربنا، يطلع ٢٬٦١٠٬٠٠٠
   بدل ٢٬٦٠٨٬٦٩٦ والحسبة بتترفض. علشان كده بنخزّن **السعر الخام زي ما
   الكتالوج بيديه** وبنضرب عند كل حدود لوحدها، مابنقرّبش بدري أبداً.

   مثبت على الإنتاج ٢٥/٩ على المسارين: بيتزا بيبروني ٢٩٫٠٠ →
   كيري ٣٢٫٠٠ (+٣) وموزاريلا ٣٤٫٠٠ (+٥). مطابق للمحل بالظبط.

   ── قاعدة أمان مش قابلة للتفاوض ────────────────────────────────────────────
   **السعر بيتحسب هنا من كتالوج الشريك، مش من اللي العميل بعته.** المتصفح
   بيبعت الـid بتاع الاختيار وبس. من غير كده حد يقدر يطلب حشو موزاريلا بصفر.
═══════════════════════════════════════════════════════════════════════════ */

/* الافتراضي: الإضافات مقفولة لحد ما تتفتح من اللوحة، والبيتزا بس.
   عمر ٢٥/٩: «بدون ما نقصر على اي حاجة غير البيتزا». */
export const DEFAULTS = {
  enabled: false,
  onlyItemIds: [],        // فاضية = كل صنف عنده إضافات في كتالوج الشريك
  hiddenGroupIds: [],     // مجموعات نخبّيها عن المتجر من غير ما نلمس نقطة البيع
  hideZeroOption: false,  // «بدون حشو اطراف» — نخبّيها ونخليها الافتراضي
  cacheMinutes: 10,
  /* قواعد لكل مجموعة تغلب اللي جاي من نقطة البيع (طلب عمر ٢٥/٩):
       { "<معرّف المجموعة>": { mode:"single"|"multi", required:bool, default:<id> } }
     ليه بنغلب تاب سينس: نفس مجموعة «حشو الأطراف» عندهم min/max مختلفين من
     بيتزا للتانية (٠/٣ على واحدة و١/١ على تانية) — واللي العميل بيشوفه على
     الموقع لازم يبقى قاعدة واحدة ثابتة. والمجموعات الجديدة اللي هتتضاف في
     تاب سينس بتظهر لوحدها بقواعدها الأصلية لحد ما تتحط لها قاعدة هنا. */
  groupRules: {},
};

export function cfgOf(settings) {
  const raw = ((settings || {}).shop || {}).modifiers || (settings || {}).modifiers || {};
  const c = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  c.onlyItemIds = Array.isArray(c.onlyItemIds) ? c.onlyItemIds.map(String) : [];
  c.groupRules = (c.groupRules && typeof c.groupRules === "object" && !Array.isArray(c.groupRules))
    ? c.groupRules : {};
  c.hiddenGroupIds = Array.isArray(c.hiddenGroupIds) ? c.hiddenGroupIds.map(String) : [];
  c.cacheMinutes = Math.min(120, Math.max(1, Number(c.cacheMinutes) || DEFAULTS.cacheMinutes));
  return c;
}

/* رقم الصنف في القائمة الرقمية من الـtenant_product_id بتاع الشريك.
   "freshcuts-40" → "40". أي شكل تاني → null (مابنخمّنش). */
export function menuIdOf(tenantProductId) {
  const m = /^[a-z0-9_]+-(\d+)$/i.exec(String(tenantProductId || "").trim());
  return m ? m[1] : null;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/* كتالوج الشريك → الشكل اللي المتجر بيفهمه.
   الأسعار بتتحوّل لهللات صحيحة هنا مرة واحدة — العشريات العايمة
   (2.608695652173913) مابتوصلش للمتصفح ولا للحسابات. */
export function buildCatalog(products, cfg = DEFAULTS) {
  const only = new Set(cfg.onlyItemIds || []);
  const hidden = new Set(cfg.hiddenGroupIds || []);
  const out = {};
  for (const p of products || []) {
    const menuId = menuIdOf(p && p.tenant_product_id);
    if (!menuId) continue;
    if (only.size && !only.has(menuId)) continue;
    const groups = [];
    for (const g of (p.modifiers || [])) {
      if (!g || !g.id || hidden.has(String(g.id))) continue;
      const options = (g.options || [])
        .map((o) => {
          /* الرقم الخام من tenant_modifier_option_id ("freshcuts-16" → 16).
             ده اللي بيتبعت للمسارين. */
          const tenant = Number(String(o.tenant_modifier_option_id || "").replace(/\D+/g, ""));
          return {
            id: Number.isInteger(tenant) && tenant > 0 ? tenant : null,
            partnerId: String(o.id || ""),
            name: String(o.name || "").trim(),
            localName: String(o.local_name || "").trim() || null,
            /* السعر الخام قبل الضريبة — مش مقرّب. أي تقريب هنا بيكسر
               حساب المتجر («must match»). */
            sar: num(o.price),
            /* اللي العميل بيشوفه: بالضريبة، لأقرب قرشين */
            shown: Math.round(num(o.price) * 1.15 * 100) / 100,
          };
        })
        .filter((o) => o.id && o.name);
      if (!options.length) continue;
      /* قاعدة اللوحة أولاً، وبعدين اللي نقطة البيع قالته */
      const rule = (cfg.groupRules || {})[String(g.id)] || {};
      let min = Math.max(0, Math.round(num(g.min)));
      let max = Math.max(min, Math.round(num(g.max)) || 1);
      if (rule.mode === "single") max = 1;
      else if (rule.mode === "multi" && max < 2) max = Math.max(2, Math.round(num(g.max)) || 2);
      if (rule.required === true) min = Math.max(1, min);
      else if (rule.required === false) min = 0;
      if (min > max) min = max;
      /* الافتراضي: اللي المالك اختاره، وإلا اللي نقطة البيع علّمت عليه */
      const wantDefault = rule.default != null && rule.default !== ""
        ? String(rule.default)
        : (g.defaults != null && g.defaults !== "" ? String(g.defaults) : null);
      groups.push({
        id: String(g.id),
        name: String(g.name || "").trim(),
        localName: String(g.local_name || "").trim() || null,
        min, max,
        options: cfg.hideZeroOption && min >= 1
          ? options.filter((o) => o.sar > 0)
          : options,
        /* الخيار اللي المتجر بيعلّم عليه لوحده. لازم يكون موجود فعلاً
           بعد الفلترة، وإلا الشاشة تعلّم على حاجة مش معروضة. */
        defaultId: (() => {
          const shown = cfg.hideZeroOption && min >= 1 ? options.filter((o) => o.sar > 0) : options;
          const hit = shown.find((o) => String(o.id) === wantDefault)
            || (min >= 1 ? shown.slice().sort((a, b) => a.sar - b.sar)[0] : null);
          return hit ? hit.id : null;
        })(),
      });
    }
    if (groups.length) out[menuId] = groups;
  }
  return out;
}

/* التحقق من اختيار العميل + حساب سعره من الكتالوج.
   بترجّع { ok, lines, halalas, error } — `lines` جاهزة لسطر الشريك. */
export function resolveChoice(groups, chosen) {
  /* الـid رقم في الكتالوج، والمتصفح ممكن يبعته نص. بنقارن بالنص دايماً
     عشان 16 و"16" يبقوا نفس الحاجة. */
  const picked = Array.isArray(chosen) ? [...new Set(chosen.map((x) => String(x)))] : [];
  if (!groups || !groups.length) {
    return picked.length
      ? { ok: false, error: "no_modifiers_for_item" }
      : { ok: true, lines: [], sar: 0, shown: 0, labels: [] };
  }
  const lines = [], labels = [];
  let sar = 0, shown = 0;
  const seen = new Set();
  for (const g of groups) {
    const mine = g.options.filter((o) => picked.includes(String(o.id)));
    for (const o of mine) seen.add(String(o.id));
    if (mine.length < g.min) return { ok: false, error: "modifier_required", group: g.name, min: g.min };
    if (mine.length > g.max) return { ok: false, error: "modifier_too_many", group: g.name, max: g.max };
    for (const o of mine) {
      sar += o.sar;
      shown += o.shown;
      labels.push(o.name);
      /* السعر من الكتالوج، مش من العميل. ده الفرق بين ٥ ريال و٠.
         `sar` خام — كل مسار بيضرب فيه بوحدته هو. */
      lines.push({ id: o.id, quantity: 1, sar: o.sar, name: o.name });
    }
  }
  const unknown = picked.filter((id) => !seen.has(id));
  if (unknown.length) return { ok: false, error: "unknown_modifier", ids: unknown.slice(0, 5) };
  return { ok: true, lines, sar, shown: Math.round(shown * 100) / 100, labels };
}

/* الوحدات: مكان واحد بيعرف الضرب، عشان مايتكررش غلط في مسار تالت.
   `scale` = 100 للشريك، 1e6 (MULTIPLY) للمتجر. */
export function linesFor(lines, scale) {
  return (lines || []).map((m) => ({
    id: m.id,
    quantity: Math.max(1, Math.round(Number(m.quantity) || 1)),
    unit_amount: Math.round(Number(m.sar) * scale),
  }));
}

export function register(app, ctx, deps = {}) {
  const { getSettingsData, requireAdmin, pool } = ctx;
  const log = ctx.log || console;
  const listProducts = deps.listProducts;   // من tspartner — بيرجّع كل منتجات الشريك
  const now = deps.now || (() => Date.now());

  let cache = { at: 0, catalog: null, raw: null };

  async function catalog({ force = false } = {}) {
    const settings = await getSettingsData();
    const cfg = cfgOf(settings);
    const ttl = cfg.cacheMinutes * 60_000;
    if (!force && cache.at && now() - cache.at < ttl && cache.raw) {
      return { cfg, catalog: buildCatalog(cache.raw, cfg), cached: true };
    }
    if (typeof listProducts !== "function") throw new Error("partner_products_unavailable");
    const raw = await listProducts();
    cache = { at: now(), raw };
    return { cfg, catalog: buildCatalog(raw, cfg), cached: false };
  }

  /* المتجر بيقرا من هنا. عام — مفيش فيه غير أسماء وأسعار معروضة أصلاً. */
  app.get("/api/shop/modifiers", async (c) => {
    try {
      const { cfg, catalog: cat, cached } = await catalog();
      if (!cfg.enabled) return c.json({ ok: true, enabled: false, items: {} });
      c.header("Cache-Control", `public, max-age=${cfg.cacheMinutes * 60}`);
      return c.json({ ok: true, enabled: true, cached, items: cat });
    } catch (e) {
      try { log.error(`[modifiers] catalog failed: ${e?.message || e}`); } catch {}
      /* فشل القراءة = المتجر يشتغل من غير إضافات، مايقفش. */
      return c.json({ ok: true, enabled: false, items: {}, degraded: true });
    }
  });

  /* اللوحة: الإعدادات + الكتالوج الخام عشان المالك يشوف اللي موجود فعلاً */
  app.get("/api/shop/modifiers/admin", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const { cfg, catalog: cat } = await catalog({ force: c.req.query("refresh") === "1" });
      const all = buildCatalog(cache.raw, { ...DEFAULTS, enabled: true });
      const names = new Map();
      for (const p of cache.raw || []) {
        const id = menuIdOf(p.tenant_product_id);
        if (id) names.set(id, p.name);
      }
      const groups = new Map();
      for (const [itemId, gs] of Object.entries(all)) {
        for (const g of gs) {
          if (!groups.has(g.id)) groups.set(g.id, { id: g.id, name: g.name, options: g.options, items: [] });
          groups.get(g.id).items.push({ id: itemId, name: names.get(itemId) || itemId });
        }
      }
      return c.json({ ok: true, config: cfg, liveItems: Object.keys(cat).length,
        allItems: Object.keys(all).length, groups: [...groups.values()] });
    } catch (e) {
      return c.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 502);
    }
  });

  app.post("/api/shop/modifiers/admin", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const next = cfgOf({ shop: { modifiers: b } });
    next.enabled = b.enabled === true;
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'shop' THEN data ELSE jsonb_set(data,'{shop}','{}'::jsonb,true) END,
         '{shop,modifiers}', $1::jsonb, true) WHERE id=1`, [JSON.stringify(next)]);
    cache = { at: 0, raw: cache.raw };   // الإعدادات اتغيّرت ⇒ نعيد البناء فوراً
    return c.json({ ok: true, config: next });
  });

  return {
    catalog,
    /* بيستخدمها checkout: بيدّي رقم الصنف واختيار العميل، بترجّع السعر الحقيقي */
    async resolve(menuItemId, chosenIds) {
      const { cfg, catalog: cat } = await catalog();
      if (!cfg.enabled) {
        return (chosenIds || []).length
          ? { ok: false, error: "modifiers_disabled" }
          : { ok: true, lines: [], sar: 0, shown: 0, labels: [] };
      }
      return resolveChoice(cat[String(menuItemId)] || [], chosenIds);
    },
  };
}
