/* ═══════════════════════════════════════════════════════════════════════════
   KEETA CONTROL — تحكم كيتا من لوحتنا (٢٠٢٦-١٠-٠٧)

   طلب عمر: «نربط بوابة كيتا ونتحكم في المنيو والأصناف والعروض» — والأسعار
   هو بيعدّلها من فيدأس (المحل «متجر API» في كيتا، وتعديل السعر من البوابة
   بيرجع 207000116 «لا تدعم هذه الميزة متاجر API حاليًا»).

   اللي هنا هو اللي اتجرّب على المحل الحقيقي بس (٧/١٠، يوزر الـAPI الفرعي):
     • متاح / غير متاح لصنف أو أكتر — POST /api/sailorProduct/spu/w/batchUpdateSpuStatus
         مقفول: {idList, status:0, spuChoiceGroupList:[{spuId, choiceGroupIdList:[]}],
                 onShelfTime:<ms يرجع لوحده> أو 0 = لحد ما حد يفتحه, businessTime:false, shopId}
         مفتوح: {idList, status:1, spuChoiceGroupList:[], shopId}
       ⚠ {spuIdList, status} بيرجع code 0 «success» ومابيعملش أي حاجة — لذلك
         كل كتابة هنا بتتأكد بإعادة القراءة، ومابنصدّقش «success».
     • عرض صنف ترويجي (actTypeId 18) — act-batch-check ثم act-batch-save
       (الشكل من حزمة البوابة نفسها: module 685 `fe` + myPromotion `W`).
       discountValue = نسبة الخصم نفسها ("20" = -20%) زي ما act-detail بيرجعها.
     • إنهاء عرض — act-batch-terminate {transferCnDiscount:false, actIds}.

   كل كتابة: صلاحية «المنتجات/تعديل» (cms.js) + مفتاح تشغيل من اللوحة
   (settings.keeta.control.enabled — قاعدة «كل الإعدادات من اللوحة»، مش env)
   + سطر في keeta_actions فيه الطلب والنتيجة والتحقق، وسطر في سجل النشاط.
═══════════════════════════════════════════════════════════════════════════ */

import { keetaCall, KeetaError, configured } from "./keeta.js";
import { nextOpening } from "./soldout.js";

const SHOP_ID = Number(process.env.KEETA_SHOP_ID || "1430391221");

export const DEFAULT_CONTROL = {
  enabled: true,            // المالك يقفل الكتابة كلها من اللوحة بزرار واحد
  maxDiscountPercent: 50,   // حارس غلطة الكتابة: ٥٠٠ بدل ٥٠
  maxItemsPerAction: 40,    // المنيو كله ٧٦ صنف — أكتر من كده في ضغطة واحدة غالباً غلط
};

export function controlSettings(settings) {
  const s = settings?.keeta?.control || {};
  const n = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return {
    enabled: s.enabled !== false,
    maxDiscountPercent: n(s.maxDiscountPercent, DEFAULT_CONTROL.maxDiscountPercent, 1, 90),
    maxItemsPerAction: n(s.maxItemsPerAction, DEFAULT_CONTROL.maxItemsPerAction, 1, 200),
  };
}

/* ── الإتاحة ─────────────────────────────────────────────────────────────
   until: "30m" | "1h" | "3h" | "open" (أول فتح جاي حسب مواعيد المحل) |
          "manual" (لحد ما حد يفتحه = 0) | ISO.  الناتج ms أو 0.            */
export function untilToMs(until, { hours = null, nowMs = Date.now() } = {}) {
  if (until === "manual" || until === 0 || until === null) return 0;
  const rel = { "30m": 30, "1h": 60, "3h": 180 }[until];
  if (rel) return nowMs + rel * 60_000;
  if (until === "open" || until === undefined || until === "") return Date.parse(nextOpening(hours, nowMs));
  const t = Date.parse(String(until));
  if (!Number.isFinite(t)) throw new Error("وقت الرجوع مش مفهوم");
  if (t <= nowMs + 60_000) throw new Error("وقت الرجوع لازم يكون بعد دقيقة على الأقل");
  if (t > nowMs + 60 * 86400_000) throw new Error("وقت الرجوع أبعد من ٦٠ يوم — استخدم «لحد ما أفتحه»");
  return t;
}

export function availabilityBody(spuIds, available, onShelfMs, shopId = SHOP_ID) {
  const idList = spuIds.map(Number);
  if (available) return { idList, status: 1, spuChoiceGroupList: [], shopId };
  return {
    idList,
    status: 0,
    spuChoiceGroupList: idList.map((spuId) => ({ spuId, choiceGroupIdList: [] })),
    onShelfTime: onShelfMs,
    businessTime: false,
    shopId,
  };
}

/* ── العروض ──────────────────────────────────────────────────────────────
   سعر العرض بيتحسب من سعر التوصيل في المنيو بنفس تقريب البوابة (قرشين).  */
export const actPriceOf = (price, percent) => Math.round(Number(price) * (100 - Number(percent))) / 100;

export function promoBody({ items, menuById, startSec, endSec, autoRenew = false, orderLimit = -1, shopId = SHOP_ID }) {
  const spuActSaveParam = items.map(({ spuId, percent }) => {
    const spu = menuById.get(Number(spuId));
    if (!spu) throw new Error(`الصنف ${spuId} مش في منيو كيتا`);
    const skus = (spu.skuList || []).filter((k) => k && k.id != null && Number(k.price) > 0);
    if (!skus.length) throw new Error(`«${spu.name}» مالوش سعر توصيل`);
    return {
      shopId,
      spuId: Number(spuId),
      name: spu.name,
      orderLimit: Number(orderLimit) > 0 ? Number(orderLimit) : -1,
      benefitType: 5,
      skuPriceType: 2,
      autoDelayType: autoRenew ? 1 : 0,
      needConfirm: 0,
      transferCnDiscount: false,
      skuActInfoList: skus.map((k) => ({
        spuId: Number(spuId),
        skuId: k.id,
        originalPrice: String(k.price),
        actPrice: String(actPriceOf(k.price, percent)),
        discountValue: String(Number(percent)),
        dailyLimit: 0,
      })),
    };
  });
  return {
    transferCnDiscount: false,
    baseActInfo: {
      userGetMode: "delivery",
      actTypeId: 18,
      startTime: startSec,
      endTime: endSec,
      specifyTimePeriod: 0,
      period: "00:00-23:59",
      weeksTime: "1,2,3,4,5,6,7",
      isAgree: 1,
      benefitType: 5,
      isAutoDelay: !!autoRenew,
      needConfirm: 0,
      userType: 1,
    },
    spuActSaveParam,
  };
}

/* pictureList عناصره {picUrl,isMaster} (زي ما البوابة بتقراها) — أحياناً نص. */
export function pictureOf(list) {
  const arr = Array.isArray(list) ? list : [];
  const p = arr.find((x) => x && x.isMaster) || arr[0];
  const url = typeof p === "string" ? p : p?.picUrl || p?.url || null;
  return url ? String(url).replace(/^http:\/\//, "https://") : null;
}

/* "بيتزا تشيكن ديناميت:\t-20%" → { name, percent } */
export function parseRule(desc) {
  const s = String(desc || "").replace(/[‎‏؜]/g, "");
  const m = s.match(/^(.*?):\s*-?\s*(\d+(?:\.\d+)?)\s*%/);
  if (!m) return { name: s.trim() || null, percent: null };
  return { name: m[1].trim(), percent: Number(m[2]) };
}

export function normaliseAct(a) {
  const b = a.actBaseInfo || {};
  const t = a.actTime || {};
  const rules = (a.benefitRuleDescs || []).map(parseRule);
  return {
    id: b.actId,
    type: b.actTypeDoc || null,
    status: b.actStandardStatus,
    statusLabel: b.actStandardStatusDoc || null,
    channel: b.userGetMode || null,
    audience: b.userTypeDoc || null,
    rules,
    names: rules.map((r) => r.name).filter(Boolean),
    percent: rules.length === 1 ? rules[0].percent : null,
    dates: t.dateRangeDesc || null,
    startSec: t.startTime ?? null,
    endSec: t.endTime ?? null,
    autoRenew: t.autoDelayType === 1,
    canEnd: (a.activityOperations || []).some((o) => o.type === 2 && o.isAllowed === 1),
  };
}

/* ═══════════════════════════════════════════════════════════════════════ */

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, isOwner, auditNote } = ctx;

  pool.query(`
    CREATE TABLE IF NOT EXISTS keeta_actions (
      id SERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      audit_id INTEGER,
      action TEXT NOT NULL,
      summary TEXT,
      request JSONB,
      result JSONB,
      ok BOOLEAN NOT NULL DEFAULT FALSE,
      verified BOOLEAN
    )`).catch((e) => console.error("[keeta-control] table:", e.message));

  const fail = (c, e) => {
    if (e instanceof KeetaError) {
      // 200 + ok:false — Cloudflare بيبدّل أي 5xx بصفحته فبتضيع رسالة كيتا
      return c.json({ ok: false, expired: e.expired, error: e.message, code: e.code ?? null });
    }
    return c.json({ ok: false, error: e.message });
  };

  async function logAction(c, action, summary, request, result, ok, verified) {
    let auditId = null;
    try { const p = c.get("cmsAudit"); auditId = p ? await p : null; } catch { /* */ }
    await pool.query(
      `INSERT INTO keeta_actions(audit_id, action, summary, request, result, ok, verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [auditId, action, summary, JSON.stringify(request ?? null), JSON.stringify(result ?? null), !!ok, verified ?? null]
    ).catch((e) => console.error("[keeta-control] log:", e.message));
    await auditNote?.(c, `كيتا: ${summary}`);
  }

  /* ── قراءات (كاش قصير — اللوحة بتتحدّث بعد كل كتابة) ── */
  let menuCache = null;
  async function readMenu(force = false) {
    if (!force && menuCache && Date.now() - menuCache.at < 20_000) return menuCache;
    const [cats, spu] = await Promise.all([
      keetaCall("/api/sailorProduct/shopCategory/r/listShopCategory", { shopId: SHOP_ID }),
      keetaCall("/api/sailorProduct/spu/r/listSpu", { shopId: SHOP_ID, status: -1, entryType: [] }),
    ]);
    const list = spu?.spuList || [];
    menuCache = { at: Date.now(), cats: cats || [], list, byId: new Map(list.map((s) => [Number(s.id), s])) };
    return menuCache;
  }

  async function readPromos(statuses = [1, 2]) {
    const rows = [];
    for (let page = 1; page <= 10; page++) {
      const d = await keetaCall("/api/marketing/merchant/promotion/single-shop/act-list", {
        transferCnDiscount: false, actStandardStatus: statuses, shopId: SHOP_ID, pageNum: page, pageSize: 50,
      });
      const list = d?.actSimpleList || [];
      rows.push(...list);
      if (list.length < 50 || rows.length >= (d?.totalNum ?? 0)) break;
    }
    return rows.map(normaliseAct);
  }

  const itemView = (s, catNames) => {
    const sku = (s.skuList || [])[0] || {};
    const sale = s.onSaleDetail || null;
    return {
      id: Number(s.id),
      name: s.name,
      categoryIds: s.shopCategoryIdList || [],
      category: (s.shopCategoryIdList || []).map((id) => catNames.get(id)).filter(Boolean).join(" / ") || null,
      available: s.status === 1,
      backAt: s.status === 1 ? null : (Number(s.onShelfTime) > 0 ? new Date(Number(s.onShelfTime)).toISOString() : null),
      price: Number(sku.price) || null,
      pickPrice: Number(sku.pickPrice) || null,
      skuCount: (s.skuList || []).length,
      promo: sale && sale.deliveryOnSaleStatus === 1
        ? { percent: sale.minDeliveryDiscount ?? null, priceOnSale: sale.minPriceOnSale || null,
            to: sale.deliveryOnSaleEndTime ? new Date(sale.deliveryOnSaleEndTime).toISOString() : null }
        : null,
      picture: pictureOf(s.pictureList),
      code: s.openItemCode || null,
    };
  };

  async function guard(c, { owner = false } = {}) {
    const err = await requireAdmin(c); if (err) return err;
    if (owner && !(await isOwner(c))) return c.json({ ok: false, error: "المالك بس" }, 403);
    if (!configured()) return c.json({ ok: false, expired: true, error: "كيتا غير مربوطة على السيرفر" });
    return null;
  }

  /* ── الحالة كلها في نداء واحد ── */
  app.get("/api/keeta/control/state", async (c) => {
    const g = await guard(c); if (g) return g;
    try {
      const settings = await getSettingsData();
      const [menu, promos, actions] = await Promise.all([
        readMenu(c.req.query("fresh") === "1"),
        readPromos(),
        pool.query(
          `SELECT k.id, k.at, k.action, k.summary, k.ok, k.verified, a.actor_name AS actor
             FROM keeta_actions k LEFT JOIN cms_audit a ON a.id = k.audit_id
            ORDER BY k.id DESC LIMIT 40`).then((r) => r.rows).catch(() => []),
      ]);
      const catNames = new Map(menu.cats.map((x) => [x.id, x.name]));
      return c.json({
        ok: true,
        control: controlSettings(settings),
        categories: menu.cats.map((x) => ({ id: x.id, name: x.name, count: x.spuCount ?? null })),
        items: menu.list.map((s) => itemView(s, catNames)),
        promos,
        actions,
        readAt: new Date().toISOString(),
      });
    } catch (e) { return fail(c, e); }
  });

  /* ── متاح / غير متاح ── */
  app.post("/api/keeta/control/availability", async (c) => {
    const g = await guard(c); if (g) return g;
    const b = await c.req.json().catch(() => ({}));
    const settings = await getSettingsData();
    const cfg = controlSettings(settings);
    if (!cfg.enabled) return c.json({ ok: false, error: "التحكم في كيتا مقفول من الإعدادات" });
    const ids = [...new Set((b.spuIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!ids.length) return c.json({ ok: false, error: "اختار صنف واحد على الأقل" });
    if (ids.length > cfg.maxItemsPerAction) return c.json({ ok: false, error: `أكتر من ${cfg.maxItemsPerAction} صنف في مرة واحدة` });
    const available = b.available === true;
    try {
      const menu = await readMenu(true);
      const unknown = ids.filter((id) => !menu.byId.has(id));
      if (unknown.length) return c.json({ ok: false, error: `أصناف مش في منيو كيتا: ${unknown.join(", ")}` });
      const onShelf = available ? null : untilToMs(b.until, { hours: settings.hours });
      const body = availabilityBody(ids, available, onShelf);
      const before = Object.fromEntries(ids.map((id) => [id, menu.byId.get(id).status]));
      const names = ids.map((id) => menu.byId.get(id).name);
      let keeta = null, error = null;
      try { keeta = await keetaCall("/api/sailorProduct/spu/w/batchUpdateSpuStatus", body); }
      catch (e) { error = e; }
      // «success» لوحده مش دليل — نقرا تاني ونقارن
      const after = await readMenu(true).catch(() => null);
      const want = available ? 1 : 0;
      const changed = after ? ids.filter((id) => after.byId.get(id)?.status === want) : [];
      const missed = ids.filter((id) => !changed.includes(id));
      const verified = !!after && missed.length === 0;
      const summary = `${available ? "متاح" : "غير متاح"}${available ? "" : onShelf ? ` لحد ${new Date(onShelf).toISOString()}` : " لحد ما يتفتح"}: ${names.join("، ")}`;
      await logAction(c, available ? "item_on" : "item_off", summary,
        { ids, names, before, body }, { keeta, error: error?.message || null, changed, missed }, !error && verified, verified);
      if (error) return fail(c, error);
      return c.json({ ok: verified, applied: true, verified, changed, missed,
        error: verified ? null : "كيتا ردّت بنجاح بس الحالة ماتغيّرتش لكل الأصناف — راجع السجل" });
    } catch (e) { return fail(c, e); }
  });

  /* ── عرض صنف ترويجي جديد ── */
  app.post("/api/keeta/control/promos", async (c) => {
    const g = await guard(c); if (g) return g;
    const b = await c.req.json().catch(() => ({}));
    const settings = await getSettingsData();
    const cfg = controlSettings(settings);
    if (!cfg.enabled) return c.json({ ok: false, error: "التحكم في كيتا مقفول من الإعدادات" });
    const items = (b.items || []).map((x) => ({ spuId: Number(x.spuId), percent: Number(x.percent) }));
    if (!items.length) return c.json({ ok: false, error: "اختار صنف واحد على الأقل" });
    if (items.length > cfg.maxItemsPerAction) return c.json({ ok: false, error: `أكتر من ${cfg.maxItemsPerAction} صنف في مرة واحدة` });
    const bad = items.find((x) => !Number.isInteger(x.percent) || x.percent < 1 || x.percent > cfg.maxDiscountPercent);
    if (bad) return c.json({ ok: false, error: `نسبة الخصم لازم رقم صحيح من ١ لـ${cfg.maxDiscountPercent}%` });
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = b.start ? Math.floor(Date.parse(b.start) / 1000) : nowSec;
    const endSec = b.end ? Math.floor(Date.parse(b.end) / 1000) : NaN;
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return c.json({ ok: false, error: "تاريخ البداية/النهاية مش مفهوم" });
    if (endSec <= Math.max(startSec, nowSec) + 600) return c.json({ ok: false, error: "النهاية لازم بعد البداية بـ١٠ دقايق على الأقل" });
    if (endSec - startSec > 366 * 86400) return c.json({ ok: false, error: "أطول مدة سنة" });
    try {
      const menu = await readMenu(true);
      const body = promoBody({ items, menuById: menu.byId, startSec, endSec, autoRenew: !!b.autoRenew, orderLimit: b.orderLimit });
      const names = body.spuActSaveParam.map((x) => `${x.name} -${items.find((i) => i.spuId === x.spuId).percent}%`);
      const check = await keetaCall("/api/marketing/merchant/promotion/single-shop/act-batch-check", body);
      const rejected = (Array.isArray(check) ? check : []).filter((r) => r && r.codeSuccess === false);
      if (rejected.length) {
        return c.json({ ok: false, stage: "check", error: "كيتا رفضت بعض الأصناف",
          rejected: rejected.map((r) => ({ spuId: r.spuId, name: r.spuName, message: r.i18nMsg || r.errorMsg })) });
      }
      if (b.dryRun) return c.json({ ok: true, dryRun: true, check, body });
      const beforeIds = new Set((await readPromos().catch(() => [])).map((p) => p.id));
      let keeta = null, error = null;
      try { keeta = await keetaCall("/api/marketing/merchant/promotion/single-shop/act-batch-save", body); }
      catch (e) { error = e; }
      const after = await readPromos().catch(() => null);
      const created = after ? after.filter((p) => !beforeIds.has(p.id) && p.names.some((n) => names.some((x) => x.startsWith(n)))) : [];
      const verified = !!after && created.length >= items.length;
      const summary = `عرض جديد: ${names.join("، ")}`;
      await logAction(c, "promo_create", summary, { items, body },
        { keeta, error: error?.message || null, created: created.map((p) => p.id) }, !error && verified, verified);
      if (error) return fail(c, error);
      menuCache = null;
      return c.json({ ok: verified, applied: true, verified, created,
        error: verified ? null : "كيتا ردّت بس العرض لسه مش ظاهر في القائمة — حدّث بعد دقيقة وراجع السجل" });
    } catch (e) { return fail(c, e); }
  });

  /* ── إنهاء عروض ── (مالوش رجوع: العرض المنتهي مابيرجعش، بيتعمل من جديد) */
  app.post("/api/keeta/control/promos/end", async (c) => {
    const g = await guard(c); if (g) return g;
    const b = await c.req.json().catch(() => ({}));
    const cfg = controlSettings(await getSettingsData());
    if (!cfg.enabled) return c.json({ ok: false, error: "التحكم في كيتا مقفول من الإعدادات" });
    const actIds = [...new Set((b.actIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!actIds.length) return c.json({ ok: false, error: "اختار عرض واحد على الأقل" });
    if (actIds.length > cfg.maxItemsPerAction) return c.json({ ok: false, error: `أكتر من ${cfg.maxItemsPerAction} عرض في مرة واحدة` });
    try {
      const running = await readPromos();
      const byId = new Map(running.map((p) => [p.id, p]));
      const missing = actIds.filter((id) => !byId.has(id));
      if (missing.length) return c.json({ ok: false, error: `عروض مش شغّالة أو مش موجودة: ${missing.join(", ")}` });
      const blocked = actIds.filter((id) => !byId.get(id).canEnd);
      if (blocked.length) return c.json({ ok: false, error: `كيتا مش سامحة بإنهاء: ${blocked.map((id) => byId.get(id).names.join("/")).join("، ")}` });
      const body = { transferCnDiscount: false, actIds };
      let keeta = null, error = null;
      try { keeta = await keetaCall("/api/marketing/merchant/promotion/single-shop/act-batch-terminate", body); }
      catch (e) { error = e; }
      const after = await readPromos().catch(() => null);
      const stillRunning = after ? actIds.filter((id) => after.some((p) => p.id === id)) : actIds;
      const verified = !!after && stillRunning.length === 0;
      const summary = `إنهاء عروض: ${actIds.map((id) => { const p = byId.get(id); return `${p.names.join("/")} ${p.percent != null ? `-${p.percent}%` : ""}`.trim(); }).join("، ")}`;
      await logAction(c, "promo_end", summary,
        { actIds, before: actIds.map((id) => byId.get(id)), body }, { keeta, error: error?.message || null, stillRunning }, !error && verified, verified);
      if (error) return fail(c, error);
      menuCache = null;
      return c.json({ ok: verified, applied: true, verified, stillRunning,
        error: verified ? null : "كيتا ردّت بس بعض العروض لسه ظاهرة شغّالة — حدّث بعد دقيقة" });
    } catch (e) { return fail(c, e); }
  });

  /* ── سجل كامل (بالطلب والنتيجة) ── */
  app.get("/api/keeta/control/log", async (c) => {
    const g = await guard(c); if (g) return g;
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
    const r = await pool.query(
      `SELECT k.*, a.actor_name AS actor FROM keeta_actions k LEFT JOIN cms_audit a ON a.id = k.audit_id
        ORDER BY k.id DESC LIMIT $1`, [limit]).catch(() => ({ rows: [] }));
    return c.json({ ok: true, actions: r.rows });
  });

  /* ── إعدادات التحكم (المالك) ── */
  app.put("/api/keeta/control/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "المالك بس" }, 403);
    const b = await c.req.json().catch(() => ({}));
    const next = controlSettings({ keeta: { control: { ...controlSettings(await getSettingsData()), ...b } } });
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'keeta' THEN data ELSE jsonb_set(data, '{keeta}', '{}'::jsonb, true) END,
         '{keeta,control}', $1::jsonb, true) WHERE id=1`, [JSON.stringify(next)]);
    await auditNote?.(c, `كيتا: إعدادات التحكم ${JSON.stringify(next)}`);
    return c.json({ ok: true, control: next });
  });

  console.log("[keeta-control] routes ready");
}
