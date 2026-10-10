/* ═══════════════════════════════════════════════════════════════════════════
   🛵 شريط التوصيل المجاني (settings.freeBar) — ١٠/١٠/٢٠٢٦

   المتجر بيعرض شريط تقدّم في السلة: «فاضل X ر.س وتاخد التوصيل مجاناً» ←
   «🎉 التوصيل مجاني». **الحدود نفسها مش هنا**: الحد الأدنى من كوبون FIRST
   (shop_coupons.min_total) وسلّم الرسوم من سياسة التوصيل (feeByTotal) — الاتنين
   بيتعدّلوا من اللوحة أصلاً. هنا مفاتيح الشريط ونصوصه بس.

   «كل الإعدادات في اللوحة»: مفيش ولا رقم/نص في env. الافتراضي في الكود،
   والمالك بيعدّل من «المنطقة والرسوم» ← «شريط التوصيل المجاني».
     GET /api/shop/storefront      → freeBar (عام، كامل دايماً بالافتراضيات)
     GET/PUT /api/delivery/free-bar → اللوحة (قسم «التوصيل»)
   المفتاح في SERVER_OWNED_PATHS: الـPUT الكامل للإعدادات مابيدوسش عليه.

   {x} = الفرق بالريال، {fee} = الرسم بعد الشريحة الجاية، {min} = حد FIRST —
   المتجر هو اللي بيبدّلهم.
═══════════════════════════════════════════════════════════════════════════ */

export const FREEBAR_TEXT_MAX = 80;
export const FREEBAR_DEFAULTS = {
  enabled: true,    // مفتاح الشريط كله
  autoFirst: true,  // أول طلب توصيل: الهدف = حد FIRST، والكود بيتطبّق لوحده لما يوصله
  maxGap: 60,       // «التوصيل المجاني» بيبان كهدف لو الفرق ≤ ده (ر.س)؛ أبعد من كده بنعرض الشريحة الجاية
  suggest: true,    // اقتراح صنف واحد يقفل الفرق
  texts: {
    gapAr: "فاضل {x} ر.س وتاخد التوصيل مجاناً", gapEn: "{x} SAR away from free delivery",
    tierAr: "زوّد {x} ر.س والتوصيل ينزل لـ{fee} ر.س", tierEn: "Add {x} SAR and delivery drops to {fee} SAR",
    doneAr: "🎉 التوصيل مجاني", doneEn: "🎉 Free delivery unlocked",
    firstAr: "أول طلب توصيل — من {min} ر.س", firstEn: "First delivery order — from {min} SAR",
    addAr: "ضيف", addEn: "Add",
  },
};
export const FREEBAR_TEXT_KEYS = Object.keys(FREEBAR_DEFAULTS.texts);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/* نص سطر واحد: من غير حروف تحكم/سطور جديدة ولا < > (المتجر بيحطه كنص، ده حزام تاني)، ≤ ٨٠ حرف */
export function cleanBarText(v) {
  if (typeof v !== "string") return "";
  const one = v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(one).slice(0, FREEBAR_TEXT_MAX).join("").trim();
}

/* الإعدادات الفعلية: المحفوظ فوق الافتراضي، وكل قيمة في مدى آمن. بترجع كائن كامل دايماً. */
export function freeBarCfg(settings) {
  const raw = isObj(settings) && isObj(settings.freeBar) ? settings.freeBar : {};
  const bool = (k) => (typeof raw[k] === "boolean" ? raw[k] : FREEBAR_DEFAULTS[k]);
  const n = Number(raw.maxGap);
  const savedTexts = isObj(raw.texts) ? raw.texts : {};
  const texts = {};
  for (const k of FREEBAR_TEXT_KEYS) texts[k] = cleanBarText(savedTexts[k]) || FREEBAR_DEFAULTS.texts[k];
  return {
    enabled: bool("enabled"), autoFirst: bool("autoFirst"),
    maxGap: raw.maxGap === null || raw.maxGap === "" || raw.maxGap === undefined || !Number.isFinite(n)
      ? FREEBAR_DEFAULTS.maxGap : Math.min(300, Math.max(0, Math.round(n))),
    suggest: bool("suggest"),
    texts,
  };
}

/* اللي بيتخزّن: المفاتيح كاملة + النصوص المختلفة عن الافتراضي بس (فلو الافتراضي
   اتحسّن في نسخة جاية، اللي ماعدّلش نص بياخده). */
export function freeBarStored(cfg) {
  const texts = {};
  for (const k of FREEBAR_TEXT_KEYS) if (cfg.texts[k] !== FREEBAR_DEFAULTS.texts[k]) texts[k] = cfg.texts[k];
  return { enabled: cfg.enabled, autoFirst: cfg.autoFirst, maxGap: cfg.maxGap, suggest: cfg.suggest, texts };
}

/* دمج جسم الطلب (جزئي) فوق المحفوظ. نص فاضي = «رجّع الافتراضي». */
export function mergeFreeBar(saved, body) {
  const s = isObj(saved) ? saved : {};
  const b = isObj(body) ? body : {};
  const next = { ...s };
  for (const k of ["enabled", "autoFirst", "suggest"]) if (typeof b[k] === "boolean") next[k] = b[k];
  if (b.maxGap !== undefined) next.maxGap = b.maxGap;
  if (isObj(b.texts)) {
    next.texts = { ...(isObj(s.texts) ? s.texts : {}) };
    for (const k of FREEBAR_TEXT_KEYS) if (k in b.texts) next.texts[k] = b.texts[k];
  }
  return freeBarCfg({ freeBar: next });
}

/* أخطاء الجسم اللي نرفضها بدل ما نصلّحها بالسكات */
export function freeBarErrors(body) {
  const errs = [];
  if (!isObj(body)) return ["bad body"];
  for (const k of ["enabled", "autoFirst", "suggest"]) if (k in body && typeof body[k] !== "boolean") errs.push(`${k} must be boolean`);
  if ("maxGap" in body && !Number.isFinite(Number(body.maxGap))) errs.push("maxGap must be a number");
  if ("texts" in body && !isObj(body.texts)) errs.push("texts must be an object");
  return errs;
}

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;

  app.get("/api/delivery/free-bar", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await getSettingsData();
    /* الحدود الحقيقية (للعرض في المعاينة بس — التعديل في «الكوبونات» و«المنطقة والرسوم») */
    let first = null, ladder = null;
    try {
      const x = (await pool.query(
        "SELECT min_total, free_delivery, active, expires_at FROM shop_coupons WHERE upper(code)='FIRST' LIMIT 1")).rows[0];
      if (x) first = { minTotal: Number(x.min_total) || 0, freeDelivery: x.free_delivery === true,
        active: x.active !== false && (!x.expires_at || new Date(x.expires_at) > new Date()) };
    } catch { /* الجدول لسه مااتعملش */ }
    try {
      const p = (await pool.query("SELECT config FROM dl_policies WHERE active ORDER BY priority DESC, id LIMIT 1")).rows[0];
      const l = p && p.config && Array.isArray(p.config.feeByTotal) ? p.config.feeByTotal : null;
      if (l) ladder = l.filter((t) => t && t.over != null && t.fee != null)
        .map((t) => ({ over: Number(t.over), fee: Number(t.fee) })).sort((a, b) => a.over - b.over);
    } catch { /* مفيش سياسة */ }
    return c.json({ ok: true, config: freeBarCfg(s), defaults: FREEBAR_DEFAULTS, textMax: FREEBAR_TEXT_MAX, first, ladder });
  });

  app.put("/api/delivery/free-bar", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b;
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const errs = freeBarErrors(b);
    if (errs.length) return c.json({ ok: false, error: errs[0], errors: errs }, 400);
    const saved = ((await getSettingsData()) || {}).freeBar;
    const next = mergeFreeBar(saved, b);
    await pool.query(
      `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{freeBar}', $1::jsonb, true) WHERE id=1`,
      [jb(freeBarStored(next))]);
    try { if (typeof ctx.auditNote === "function") await ctx.auditNote(c, "شريط التوصيل المجاني"); } catch { /* السجل مايوقفش الحفظ */ }
    return c.json({ ok: true, config: next });
  });

  return { freeBarCfg };
}
