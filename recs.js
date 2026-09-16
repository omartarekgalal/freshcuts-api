/* ═══════════════════════════════════════════════════════════════════════════
   RECS — «تحب تضيف؟» محرّك الاقتراحات للسلة الجديدة (checkout2)

   قرار المالك: الاقتراحات لازم تتغيّر حسب سلوك العملاء الحقيقي — في المطعم
   وأونلاين وتاريخ الطلبات كله — مش قايمة ثابتة.

   ── من فين بتيجي البيانات ─────────────────────────────────────────────────
     • ts_order_items + ts_orders  (نقطة البيع) — سطور بالاسم بس، مالهاش رقم
       صنف. بنربط الاسم برقم صنف المتجر من المنيو الحية (catalog.menuRows)
       بمطابقة عربية موحّدة (تشكيل/ألف/تاء مربوطة/مقاسات). الاسم اللي ما
       يتطابقش بيتساب برّه — مفيش صنف مخترع.
         Created / Table / (فاضي)  → in_store
         External                  → apps
         QR-Menu Orders            → online
         Refund / Void / Parked / Void QR-Menu Orders → مستبعدة
       طلبات المتجر اللي نزلت نقطة البيع (shop_orders.pos_order_id) بتتشال من
       هنا عشان ما تتعدّش مرتين.
     • shop_orders.items (طلبات الموقع المدفوعة) — فيها product_id لكل سطر
       → online. سطور الباقات بتتشال: مكوّنات الباقة ثابتة، فاقترانها مش
       سلوك عميل.

   ── الجدول المحسوب مسبقاً ─────────────────────────────────────────────────
   rec_pairs (a_id → b_id): together + وزنه، تقسيم المصدر، confidence =
   P(b|a)، lift، last_seen. rec_items: شعبية كل صنف + لقطة من المنيو (احتياطي
   لو المنيو الحية مش متاحة). rec_meta: وقت البناء والأرقام.
   بيتبني كل ليلة (٤ الفجر بتوقيت الرياض) وعند الإقلاع لو عمره > ٢٤ ساعة.
   الطلبات الأحدث من weightRecentDays وزنها ١، والأقدم وزنها بينزل للنص كل
   weightRecentDays (أقل حاجة ٠٫٢).

   ── التقييم لسلة ──────────────────────────────────────────────────────────
   لكل مرشّح: أقوى اقتران مع أي صنف في السلة + ٣٠٪ من باقي الاقترانات، والـ
   lift ≤ 1 (صدفة) بياخد ربع الوزن. بعدين دفعة شخصية من إضافات العميل نفسه
   (طلبات الموقع + نقطة البيع بجواله)، بعدين الأشهر الرخيص كتكملة، والمثبّت
   أولاً، والمستبعد برّه، وسقف السعر، ومن غير تكرار، وlimit.

   ── المسارات ──────────────────────────────────────────────────────────────
   GET  /api/shop/recommendations?items=&option=&limit=   عام — مابيرجّعش 5xx
   GET  /api/cms/recommendations/settings                  (المنتجات: عرض)
   PUT  /api/cms/recommendations/settings                  (المنتجات: تعديل)
   GET  /api/cms/recommendations/preview?product_id=       (المنتجات: عرض)
   POST /api/cms/recommendations/rebuild                   (المنتجات: تعديل)

   الأداء: الرد العام من الذاكرة (الجدول محمّل مرة + المنيو لقطة بتتجدد في
   الخلفية)؛ الجزء الشخصي ليه سقف ١٠٠ms وكاش ١٠ دقايق لكل توكن.
═══════════════════════════════════════════════════════════════════════════ */

import { menuRows as catalogMenuRows } from "./catalog.js";
import { hiddenOfferItemIds, OFFERS, offerState } from "./offers.js";
import * as tsstore from "./tsstore.js";

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  maxPrice: 15,
  limit: 6,
  pinned: [],
  excluded: [],
  weightRecentDays: 90,
  personalBoost: true,
});

// حالات طلب الموقع اللي اتدفع فعلاً — نفس قايمة cms.js
export const PAID_STATUSES = ["paid", "pos_created", "accepted", "courier_requested", "courier_assigned", "on_the_way", "delivered"];
const PAID_SQL = `(${PAID_STATUSES.map((s) => `'${s}'`).join(",")})`;

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const OFFER_PAGES = new Set(["offers", "العروض"]);
const DRINK_RE = /مياه|مياة|ماء|water|soft\s*drink|مشروب|بيبسي|pepsi|كولا|cola|عصير|juice|سفن|seven|ميرندا|mirinda|شاي|tea|قهوه|قهوة|coffee/i;
const HISTORY_DAYS = 365;
const MIN_TOGETHER = 2;
const PERSONAL_TIMEOUT_MS = 100;
const MENU_TTL_MS = 5 * 60_000;
const MODEL_TTL_MS = 10 * 60_000;
const SETTINGS_TTL_MS = 30_000;
const PERSONAL_TTL_MS = 10 * 60_000;
const SESSION_DAYS = 180; // نفس نافذة accounts.js

/* ═══ دوال صافية (متجرّبة في recs.test.mjs) ═════════════════════════════ */

const clampInt = (v, lo, hi, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const idList = (v, max) => {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const out = [];
  for (const x of arr) {
    const s = String(x ?? "").trim();
    if (ID_RE.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

export function normalizeSettings(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  const price = Number(r.maxPrice);
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    maxPrice: Number.isFinite(price) && price > 0 ? Math.min(1000, Math.round(price * 100) / 100) : d.maxPrice,
    limit: clampInt(r.limit, 1, 12, d.limit),
    pinned: "pinned" in r ? idList(r.pinned, 20) : [],
    excluded: "excluded" in r ? idList(r.excluded, 300) : [],
    weightRecentDays: clampInt(r.weightRecentDays, 7, 365, d.weightRecentDays),
    personalBoost: typeof r.personalBoost === "boolean" ? r.personalBoost : d.personalBoost,
  };
}

/* توحيد الاسم — نفس قواعد menuplan.norm + شيل ملاحظة الصالة اللي الكتالوج
   بيلزقها في آخر الاسم. */
export const normName = (s) => String(s || "")
  .replace(/داخل\s+الصال[ةه]\s+فقط/g, " ")
  .replace(/[ً-ْـ]/g, "")
  .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/[ىئ]/g, "ي").replace(/ؤ/g, "و")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/* الاسم من غير كلمات الوزن/الحجم — «كبدة كيلو» و«كبدة نص» نفس الطبق،
   فلو واحد في السلة التاني مايتقترحش. */
const SIZE_WORDS = /(?:^|\s)(كيلو|نصف|نص|ربع|ثلث|وجبه|طبق|صحن|علبه|قطعه|حبه|صغير|وسط|كبير|عائلي|small|medium|large|kg)(?=\s|$)/g;
export const baseName = (s) => normName(s).replace(SIZE_WORDS, " ").replace(/\d+(\s*\d+)*/g, " ").replace(/\s+/g, " ").trim();

const rowName = (r) => String(r?.title || r?.name || "").trim();

/* اسم سطر نقطة البيع → رقم صنف المتجر (أو null).
   مطابقة تامة → الاسم قبل « - » (المقاسات والحشو) → أطول اسم منيو السطر
   بيبدأ بيه → احتواء (للأسماء ٧ حروف وأكتر). */
export function makeResolver(menuRows, aliases = []) {
  const byNorm = new Map();
  const add = (name, id) => {
    const k = normName(name);
    if (k && id != null && !byNorm.has(k)) byNorm.set(k, String(id));
  };
  for (const r of menuRows || []) if (r && !r.isOffer) add(rowName(r), r.id);
  for (const [name, id] of aliases || []) add(name, id);
  const keys = [...byNorm.keys()].sort((a, b) => b.length - a.length);
  const cache = new Map();
  return (raw) => {
    const n = normName(raw);
    if (!n) return null;
    if (cache.has(n)) return cache.get(n);
    let hit = byNorm.get(n) || byNorm.get(normName(String(raw).split(" - ")[0])) || null;
    if (!hit) for (const k of keys) { if (n.startsWith(k + " ")) { hit = byNorm.get(k); break; } }
    if (!hit) for (const k of keys) { if (k.length >= 7 && n.includes(k)) { hit = byNorm.get(k); break; } }
    cache.set(n, hit);
    return hit;
  };
}

/* order_type → مصدر، أو null = مستبعد */
export function sourceOfType(t) {
  const s = String(t ?? "").trim();
  if (/void|refund|parked/i.test(s)) return null;
  if (/qr/i.test(s)) return "online";
  if (/^external$/i.test(s)) return "apps";
  return "in_store"; // Created / Table / فاضي
}

export function recencyWeight(ageDays, recentDays = DEFAULT_SETTINGS.weightRecentDays) {
  const D = Math.max(1, Number(recentDays) || DEFAULT_SETTINGS.weightRecentDays);
  const a = Math.max(0, Number(ageDays) || 0);
  if (a <= D) return 1;
  return Math.max(0.2, Math.pow(0.5, (a - D) / D));
}

/* ids الأصناف العادية في shop_orders.items (من غير سطور الباقات) */
export function shopItemIds(items) {
  let arr = items;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = []; } }
  const out = new Set();
  for (const it of Array.isArray(arr) ? arr : []) {
    if (!it || typeof it !== "object" || it.bundle || it.bundle_line) continue;
    const id = it.product_id ?? it.productId;
    if (id != null && ID_RE.test(String(id))) out.add(String(id));
  }
  return out;
}

/* orders: [{ source, at: Date|string, ids: Set<string> }]
   → { pairs: [directed a→b], items: [per product], orders, totalWeight } */
export function buildPairs(orders, { now = new Date(), weightRecentDays = DEFAULT_SETTINGS.weightRecentDays, minTogether = MIN_TOGETHER } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const items = new Map();
  const pairs = new Map();
  let W = 0, N = 0;
  const bump = (o, src, at) => {
    o.n++; o[src] = (o[src] || 0) + 1;
    if (at && (!o.last || at > o.last)) o.last = at;
  };
  for (const ord of orders || []) {
    const ids = [...new Set([...(ord?.ids || [])].map(String))].sort();
    if (!ids.length) continue;
    const src = ["in_store", "apps", "online"].includes(ord.source) ? ord.source : "in_store";
    const atMs = ord.at instanceof Date ? ord.at.getTime() : Date.parse(ord.at);
    const at = Number.isFinite(atMs) ? atMs : null;
    const w = at == null ? 1 : recencyWeight((nowMs - at) / 86400000, weightRecentDays);
    W += w; N++;
    for (const id of ids) {
      let it = items.get(id);
      if (!it) items.set(id, (it = { n: 0, w: 0, in_store: 0, apps: 0, online: 0, last: null }));
      it.w += w; bump(it, src, at);
    }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const key = ids[i] + "\u0001" + ids[j];
      let p = pairs.get(key);
      if (!p) pairs.set(key, (p = { n: 0, w: 0, in_store: 0, apps: 0, online: 0, last: null }));
      p.w += w; bump(p, src, at);
    }
  }
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  const out = [];
  for (const [key, p] of pairs) {
    if (p.n < minTogether) continue;
    const [a, b] = key.split("\u0001");
    const A = items.get(a), B = items.get(b);
    const lift = A.w > 0 && B.w > 0 ? (p.w * W) / (A.w * B.w) : 0;
    const base = { together: p.n, together_w: r4(p.w), in_store: p.in_store, apps: p.apps, online: p.online, lift: r4(lift), last_seen: iso(p.last) };
    out.push({ a_id: a, b_id: b, confidence: r4(A.w ? p.w / A.w : 0), ...base });
    out.push({ a_id: b, b_id: a, confidence: r4(B.w ? p.w / B.w : 0), ...base });
  }
  const itemRows = [...items.entries()].map(([id, it]) => ({
    product_id: id, orders: it.n, orders_w: r4(it.w), in_store: it.in_store, apps: it.apps, online: it.online, last_seen: iso(it.last),
  }));
  return { pairs: out, items: itemRows, orders: N, totalWeight: r4(W) };
}
function r4(n) { return Math.round(Number(n) * 10000) / 10000; }

/* قوة اقتران واحد: الثقة × الـlift، مع انكماش للعينات الصغيرة. الـlift ≤ 1
   معناه صدفة (الصنفين بيتباعوا كتير وخلاص) فبياخد ربع الوزن. */
export function pairScore(p) {
  const n = Number(p.together) || 0;
  const lift = Number(p.lift) || 0;
  const conf = Number(p.confidence) || 0;
  const shrink = n / (n + 5);
  const liftFactor = lift > 1 ? Math.min(lift, 6) : lift * 0.25;
  return shrink * conf * liftFactor;
}

/* المرشّح ينفع يتعرض؟ بيرجّع null لو ينفع، أو سبب المنع. */
export function blockReason(id, { menu, settings, cartIds, cartBases, hidden }) {
  const m = menu.get(String(id));
  if (!m) return "not_on_menu";
  if (cartIds.has(String(id))) return "in_cart";
  if (m.isOffer || OFFER_PAGES.has(String(m.category || "").trim().toLowerCase())) return "offer";
  if (m.dineIn) return "dine_in_only";
  if (hidden && hidden.has(String(id))) return "hidden";
  if ((settings.excluded || []).includes(String(id))) return "excluded";
  const price = Number(m.price);
  if (!(price > 0)) return "no_price";
  if (price > settings.maxPrice) return "above_max_price";
  if (cartBases && cartBases.has(baseName(m.name))) return "same_dish_in_cart";
  return null;
}

/* model: { byA: Map<a, pair[]>, items: Map<id, itemStats> }
   menu:  Map<id, {id,name,price,image,category,dineIn,isOffer}>
   personal: Map<id, ordersCount> | null */
export function scoreCart({ cartIds = [], model, menu, settings: rawSettings, personal = null, hidden = new Set(), limit } = {}) {
  const settings = normalizeSettings(rawSettings);
  const lim = clampInt(limit ?? settings.limit, 1, 12, settings.limit);
  const cart = new Set((cartIds || []).map(String));
  const cartBases = new Set();
  for (const id of cart) { const m = menu.get(id); if (m) cartBases.add(baseName(m.name)); }
  const ctx = { menu, settings, cartIds: cart, cartBases, hidden };
  const ok = (id) => blockReason(id, ctx) == null;

  const cands = new Map();
  const cand = (id) => {
    let c = cands.get(id);
    if (!c) cands.set(id, (c = { id, pairMax: 0, pairSum: 0, personal: 0, popular: 0 }));
    return c;
  };
  for (const a of cart) {
    for (const p of model?.byA?.get(a) || []) {
      const b = String(p.b_id);
      if (!ok(b)) continue;
      const s = pairScore(p);
      if (!(s > 0)) continue;
      const c = cand(b);
      c.pairSum += s;
      if (s > c.pairMax) c.pairMax = s;
    }
  }
  if (personal && settings.personalBoost) {
    for (const [id, count] of personal) {
      if (!ok(id)) continue;
      cand(String(id)).personal = 0.4 * Math.min(Number(count) || 0, 4) / 4;
    }
  }
  const scored = [...cands.values()].map((c) => {
    const pair = c.pairMax + 0.3 * (c.pairSum - c.pairMax);
    return { id: c.id, score: pair + c.personal, reason: c.personal > pair ? "personal" : "pair" };
  }).filter((c) => c.score > 0).sort((x, y) => y.score - x.score || String(x.id).localeCompare(String(y.id)));

  // الأشهر الرخيص — تكملة بس
  const popular = [...(model?.items?.values?.() || [])]
    .filter((it) => ok(String(it.product_id)) && !cands.has(String(it.product_id)))
    .sort((x, y) => (Number(y.orders_w) || 0) - (Number(x.orders_w) || 0) || String(x.product_id).localeCompare(String(y.product_id)))
    .map((it) => ({ id: String(it.product_id), reason: "popular" }));

  const picked = [];
  const seen = new Set();
  const seenBase = new Set();
  const take = (id, reason) => {
    if (picked.length >= lim || seen.has(id) || !ok(id)) return false;
    const m = menu.get(id);
    const b = baseName(m.name);
    if (b && seenBase.has(b)) return false;
    seen.add(id); if (b) seenBase.add(b);
    picked.push({ id, reason });
    return true;
  };
  for (const id of settings.pinned) take(String(id), "pinned");

  // مشروبين بالكتير في الجولة الأولى — صف كله مياه وبيبسي مش اقتراح
  const isDrink = (id) => DRINK_RE.test(menu.get(id)?.name || "");
  const ordered = [...scored, ...popular];
  let drinks = picked.filter((p) => isDrink(p.id)).length;
  const deferred = [];
  for (const c of ordered) {
    if (picked.length >= lim) break;
    if (isDrink(c.id)) {
      if (drinks >= 2) { deferred.push(c); continue; }
      if (take(c.id, c.reason)) drinks++;
    } else take(c.id, c.reason);
  }
  for (const c of deferred) { if (picked.length >= lim) break; take(c.id, c.reason); }

  return picked.map(({ id, reason }) => {
    const m = menu.get(id);
    return { product_id: id, name: m.name, price: Number(m.price), image: m.image || "", reason };
  });
}

/* صف كتالوج → صف منيو داخلي */
export function menuMapOf(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r || r.id == null) continue;
    const id = String(r.id);
    if (map.has(id)) continue; // صف المنيو الحقيقي بيسبق صف العرض
    map.set(id, {
      id,
      name: rowName(r).replace(/\s*[—-]\s*داخل\s+الصال[ةه]\s+فقط\s*$/, "").trim(),
      price: Number(r.price) || 0,
      image: r.image || "",
      category: r.category || "",
      dineIn: !!r.dineIn,
      isOffer: !!r.isOffer,
    });
  }
  return map;
}

/* ═══ التسجيل ════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;
  const menuRowsFn = deps.menuRows || catalogMenuRows;
  const rawMenuFn = deps.rawMenu === undefined ? () => tsstore.fetchMenu("1") : deps.rawMenu;
  const hiddenOffersFn = deps.hiddenOfferIds || hiddenOfferItemIds;
  const now = deps.now || (() => new Date());
  const J = jb || ((v) => JSON.stringify(v));

  const state = {
    model: null, modelAt: 0, modelLoading: null,
    menu: null, menuAt: 0, menuLoading: null, resolver: null, aliases: [],
    settingsData: null, settingsAt: 0,
    building: null, lastBuild: null, lastError: null,
    personal: new Map(),
  };

  /* ── schema ─────────────────────────────────────────────────────────── */
  const schemaReady = pool.query(`
    CREATE TABLE IF NOT EXISTS rec_pairs (
      a_id TEXT NOT NULL,
      b_id TEXT NOT NULL,
      together INT NOT NULL DEFAULT 0,
      together_w DOUBLE PRECISION NOT NULL DEFAULT 0,
      in_store INT NOT NULL DEFAULT 0,
      apps INT NOT NULL DEFAULT 0,
      online INT NOT NULL DEFAULT 0,
      confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
      lift DOUBLE PRECISION NOT NULL DEFAULT 0,
      last_seen TIMESTAMPTZ,
      built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (a_id, b_id)
    );
    CREATE TABLE IF NOT EXISTS rec_items (
      product_id TEXT PRIMARY KEY,
      name TEXT,
      price NUMERIC,
      image TEXT,
      category TEXT,
      dine_in BOOLEAN NOT NULL DEFAULT FALSE,
      orders INT NOT NULL DEFAULT 0,
      orders_w DOUBLE PRECISION NOT NULL DEFAULT 0,
      in_store INT NOT NULL DEFAULT 0,
      apps INT NOT NULL DEFAULT 0,
      online INT NOT NULL DEFAULT 0,
      last_seen TIMESTAMPTZ,
      built_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS rec_meta (
      id INT PRIMARY KEY,
      built_at TIMESTAMPTZ,
      stats JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `).then(() => { console.log("[recs] schema ready"); return true; })
    .catch((e) => { console.error("[recs] schema failed:", e.message); return false; });

  /* ── settings (كاش ٣٠ ثانية) ─────────────────────────────────────────── */
  async function settingsData(force = false) {
    if (!force && state.settingsData && Date.now() - state.settingsAt < SETTINGS_TTL_MS) return state.settingsData;
    const d = (await getSettingsData()) || {};
    state.settingsData = d; state.settingsAt = Date.now();
    return d;
  }
  const recSettingsOf = (d) => normalizeSettings(d?.shop?.recommendations);
  const hiddenOf = (d) => {
    const s = new Set(((d?.catalog || {}).hiddenIds || []).map(String));
    try { for (const id of hiddenOffersFn(now())) s.add(String(id)); } catch { /* السجل مش متاح */ }
    // نفس قاعدة المتجر (loadStoppedOffers): عرض موقوف/منتهي ⇒ صنفه (productId) مايتعرضش
    try {
      for (const o of deps.offers || OFFERS) {
        const pid = String(o?.productId ?? "");
        const st = offerState(o, now()).status;
        if (/^\d+$/.test(pid) && (st === "disabled" || st === "ended")) s.add(pid);
      }
    } catch { /* السجل مش متاح */ }
    return s;
  };

  /* ── المنيو الحية (لقطة في الذاكرة) ──────────────────────────────────── */
  async function refreshMenu() {
    if (state.menuLoading) return state.menuLoading;
    state.menuLoading = (async () => {
      const rows = await menuRowsFn();
      if (!Array.isArray(rows) || !rows.length) throw new Error("empty menu");
      state.menu = menuMapOf(rows);
      state.resolver = makeResolver(rows, state.aliases);
      state.menuRowsList = rows;
      state.menuAt = Date.now();
      return state.menu;
    })().catch((e) => { console.error("[recs] menu refresh failed:", e.message); return state.menu; })
      .finally(() => { state.menuLoading = null; });
    return state.menuLoading;
  }
  /* بيرجّع فوراً: اللقطة الحية لو موجودة، وإلا لقطة rec_items من آخر بناء. */
  function currentMenu() {
    if (!state.menu || Date.now() - state.menuAt > MENU_TTL_MS) refreshMenu();
    if (state.menu) return state.menu;
    const fb = new Map();
    for (const it of state.model?.items?.values() || []) {
      if (!it.name) continue;
      fb.set(String(it.product_id), {
        id: String(it.product_id), name: it.name, price: Number(it.price) || 0, image: it.image || "",
        category: it.category || "", dineIn: !!it.dine_in, isOffer: false,
      });
    }
    return fb;
  }

  /* ── الموديل من الجدول (في الذاكرة) ──────────────────────────────────── */
  async function loadModel(force = false) {
    if (!force && state.model && Date.now() - state.modelAt < MODEL_TTL_MS) return state.model;
    if (state.modelLoading) return state.modelLoading;
    state.modelLoading = (async () => {
      const [p, i, m] = await Promise.all([
        pool.query(`SELECT a_id, b_id, together, together_w, in_store, apps, online, confidence, lift, last_seen FROM rec_pairs`),
        pool.query(`SELECT product_id, name, price, image, category, dine_in, orders, orders_w, in_store, apps, online, last_seen FROM rec_items`),
        pool.query(`SELECT built_at, stats FROM rec_meta WHERE id=1`),
      ]);
      const byA = new Map();
      for (const r of p.rows) {
        const row = {
          a_id: String(r.a_id), b_id: String(r.b_id), together: Number(r.together) || 0, together_w: Number(r.together_w) || 0,
          in_store: Number(r.in_store) || 0, apps: Number(r.apps) || 0, online: Number(r.online) || 0,
          confidence: Number(r.confidence) || 0, lift: Number(r.lift) || 0, last_seen: r.last_seen,
        };
        if (!byA.has(row.a_id)) byA.set(row.a_id, []);
        byA.get(row.a_id).push(row);
      }
      for (const list of byA.values()) list.sort((x, y) => pairScore(y) - pairScore(x));
      const items = new Map(i.rows.map((r) => [String(r.product_id), { ...r, product_id: String(r.product_id) }]));
      const meta = m.rows[0] || null;
      state.model = { byA, items, pairs: p.rows.length, builtAt: meta?.built_at || null, stats: meta?.stats || {} };
      state.modelAt = Date.now();
      return state.model;
    })().finally(() => { state.modelLoading = null; });
    return state.modelLoading;
  }

  /* ── البناء ──────────────────────────────────────────────────────────── */
  async function build({ reason = "manual" } = {}) {
    if (state.building) return state.building;
    state.building = (async () => {
      const t0 = Date.now();
      await schemaReady;
      const d = await settingsData(true);
      const cfg = recSettingsOf(d);

      const rows = await menuRowsFn();
      if (!Array.isArray(rows) || !rows.length) throw new Error("menu unavailable — kept the previous table");
      // أسماء إنجليزي من منيو تاب سينس الخام (Water / Mix Grill Meal) — أحسن مجهود
      const menuIds = new Set(rows.filter((r) => !r.isOffer).map((r) => String(r.id)));
      let aliases = [];
      if (rawMenuFn) {
        try {
          const raw = await Promise.race([rawMenuFn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000).unref?.())]);
          for (const p of raw?.pages || []) for (const it of p.items || []) {
            if (!menuIds.has(String(it.id))) continue;
            for (const nm of [it.name, it.local_name]) if (nm) aliases.push([nm, String(it.id)]);
          }
        } catch (e) { console.warn("[recs] raw menu aliases skipped:", e.message); }
      }
      state.aliases = aliases;
      const resolve = makeResolver(rows, aliases);
      const menu = menuMapOf(rows);
      state.menu = menu; state.resolver = resolve; state.menuAt = Date.now();

      const days = Math.max(HISTORY_DAYS, cfg.weightRecentDays * 2);
      const ts = await pool.query(
        `SELECT i.order_id, i.name, o.order_type, COALESCE(o.order_date, o.calendar_day::timestamptz) AS at
           FROM ts_order_items i
           JOIN ts_orders o ON o.order_id = i.order_id
          WHERE COALESCE(o.order_type, '') NOT IN ('Refund','Void','Parked','Void QR-Menu Orders')
            AND COALESCE(o.order_type, '') !~* '(void|refund|parked)'
            AND COALESCE(o.order_date, o.calendar_day::timestamptz) >= NOW() - make_interval(days => $1::int)
            AND NOT EXISTS (SELECT 1 FROM shop_orders s WHERE s.pos_order_id = o.order_id)`,
        [days]);
      const shop = await pool.query(
        `SELECT order_no, items, created_at FROM shop_orders
          WHERE status IN ${PAID_SQL} AND created_at >= NOW() - make_interval(days => $1::int)`,
        [days]);

      const orders = new Map();
      let lines = 0, matched = 0;
      const unmatched = new Map();
      for (const r of ts.rows) {
        const src = sourceOfType(r.order_type);
        if (!src) continue;
        lines++;
        const id = resolve(r.name);
        if (!id || !menuIds.has(id)) { unmatched.set(r.name, (unmatched.get(r.name) || 0) + 1); continue; }
        matched++;
        const key = "ts:" + r.order_id;
        let o = orders.get(key);
        if (!o) orders.set(key, (o = { source: src, at: r.at, ids: new Set() }));
        o.ids.add(id);
      }
      let shopOrders = 0;
      for (const r of shop.rows) {
        const ids = [...shopItemIds(r.items)].filter((id) => menuIds.has(id));
        if (!ids.length) continue;
        shopOrders++;
        orders.set("shop:" + r.order_no, { source: "online", at: r.created_at, ids: new Set(ids) });
      }

      const B = buildPairs([...orders.values()], { now: now(), weightRecentDays: cfg.weightRecentDays });
      const builtAt = now().toISOString();
      const stats = {
        reason, ms: 0, orders: B.orders, shopOrders, posLines: lines, posLinesMatched: matched,
        matchPct: lines ? Math.round(1000 * matched / lines) / 10 : 0,
        pairs: B.pairs.length, items: B.items.length, weightRecentDays: cfg.weightRecentDays,
        unmatched: [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, n]) => ({ name, lines: n })),
      };

      const client = typeof pool.connect === "function" ? await pool.connect() : pool;
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM rec_pairs");
        for (let k = 0; k < B.pairs.length; k += 1000) {
          const ch = B.pairs.slice(k, k + 1000);
          const col = (f) => ch.map((p) => p[f]);
          await client.query(
            `INSERT INTO rec_pairs (a_id, b_id, together, together_w, in_store, apps, online, confidence, lift, last_seen, built_at)
             SELECT a, b, t, tw, s1, s2, s3, cf, lf, ls, $11::timestamptz
               FROM unnest($1::text[], $2::text[], $3::int[], $4::float8[], $5::int[], $6::int[], $7::int[], $8::float8[], $9::float8[], $10::timestamptz[])
                 AS x(a, b, t, tw, s1, s2, s3, cf, lf, ls)`,
            [col("a_id"), col("b_id"), col("together"), col("together_w"), col("in_store"), col("apps"), col("online"),
              col("confidence"), col("lift"), col("last_seen"), builtAt]);
        }
        await client.query("DELETE FROM rec_items");
        for (let k = 0; k < B.items.length; k += 1000) {
          const ch = B.items.slice(k, k + 1000);
          const col = (f) => ch.map((p) => p[f]);
          const mcol = (f) => ch.map((p) => menu.get(p.product_id)?.[f] ?? null);
          await client.query(
            `INSERT INTO rec_items (product_id, name, price, image, category, dine_in, orders, orders_w, in_store, apps, online, last_seen, built_at)
             SELECT id, nm, pr, im, ct, di, o, ow, s1, s2, s3, ls, $13::timestamptz
               FROM unnest($1::text[], $2::text[], $3::numeric[], $4::text[], $5::text[], $6::bool[], $7::int[], $8::float8[],
                           $9::int[], $10::int[], $11::int[], $12::timestamptz[])
                 AS x(id, nm, pr, im, ct, di, o, ow, s1, s2, s3, ls)`,
            [col("product_id"), mcol("name"), mcol("price"), mcol("image"), mcol("category"), ch.map((p) => !!menu.get(p.product_id)?.dineIn),
              col("orders"), col("orders_w"), col("in_store"), col("apps"), col("online"), col("last_seen"), builtAt]);
        }
        stats.ms = Date.now() - t0;
        await client.query(
          `INSERT INTO rec_meta (id, built_at, stats) VALUES (1, $1::timestamptz, $2::jsonb)
           ON CONFLICT (id) DO UPDATE SET built_at=EXCLUDED.built_at, stats=EXCLUDED.stats`,
          [builtAt, J(stats)]);
        await client.query("COMMIT");
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      } finally {
        if (client !== pool && typeof client.release === "function") client.release();
      }

      state.lastBuild = { at: builtAt, ...stats };
      state.lastError = null;
      state.personal.clear();
      await loadModel(true);
      console.log(`[recs] built (${reason}): ${B.orders} orders, ${B.pairs.length} pairs, match ${stats.matchPct}% in ${stats.ms}ms`);
      return state.lastBuild;
    })().catch((e) => {
      state.lastError = { at: new Date().toISOString(), message: String(e.message || e) };
      console.error("[recs] build failed:", state.lastError.message);
      throw e;
    }).finally(() => { state.building = null; });
    return state.building;
  }

  async function builtAgeHours() {
    const r = await pool.query("SELECT built_at FROM rec_meta WHERE id=1");
    const at = r.rows[0]?.built_at ? Date.parse(r.rows[0].built_at) : NaN;
    return Number.isFinite(at) ? (now().getTime() - at) / 3600000 : Infinity;
  }

  /* ── الجدولة: كل ليلة ٤ الفجر (الرياض) + عند الإقلاع لو قديم ─────────── */
  if (deps.schedule !== false) {
    const unref = (t) => (t && typeof t.unref === "function" ? t.unref() : t);
    unref(setTimeout(async () => {
      if (!(await schemaReady)) return;
      loadModel().catch(() => {});
      refreshMenu();
      try {
        if ((await builtAgeHours()) > 24) await build({ reason: "boot-stale" });
      } catch { /* اتسجّل في build */ }
    }, 90_000));
    unref(setInterval(async () => {
      const riyadhHour = new Date(now().getTime() + 3 * 3600000).getUTCHours();
      if (riyadhHour !== 4) return;
      try {
        if ((await builtAgeHours()) > 20) await build({ reason: "nightly" });
      } catch { /* اتسجّل في build */ }
    }, 30 * 60_000));
  }

  /* ── العميل المسجّل: إضافاته هو ────────────────────────────────────── */
  async function personalFor(c) {
    const h = c.req.header("Authorization") || "";
    const mt = h.match(/^Bearer cust:([a-f0-9]{48,96})$/i);
    if (!mt) return null;
    const tok = mt[1];
    const hit = state.personal.get(tok);
    if (hit && Date.now() - hit.at < PERSONAL_TTL_MS) return hit.map;
    const s = await pool.query(
      `SELECT phone_norm FROM acct_sessions WHERE token=$1 AND last_seen_at > NOW() - INTERVAL '${SESSION_DAYS} days'`, [tok]);
    const phone = s.rows[0]?.phone_norm;
    let map = null;
    if (phone) {
      const [shopR, tsR] = await Promise.all([
        pool.query(
          `SELECT order_no, items FROM shop_orders WHERE phone_norm=$1 AND status IN ${PAID_SQL}
            ORDER BY created_at DESC LIMIT 40`, [phone]),
        pool.query(
          `SELECT i.order_id, i.name FROM ts_orders o
             JOIN ts_order_items i ON i.order_id = o.order_id
            WHERE o.customer_id IN (SELECT customer_id FROM ts_customers WHERE phone_norm=$1)
              AND COALESCE(o.order_type, '') !~* '(void|refund|parked)'
            ORDER BY o.order_date DESC NULLS LAST LIMIT 300`, [phone]),
      ]);
      const per = new Map(); // id → Set(order keys)
      const add = (id, key) => { if (!per.has(id)) per.set(id, new Set()); per.get(id).add(key); };
      for (const r of shopR.rows) for (const id of shopItemIds(r.items)) add(id, "s" + r.order_no);
      const resolve = state.resolver;
      if (resolve) for (const r of tsR.rows) { const id = resolve(r.name); if (id) add(id, "t" + r.order_id); }
      map = new Map([...per.entries()].map(([id, set]) => [id, set.size]));
    }
    if (state.personal.size > 5000) state.personal.clear();
    state.personal.set(tok, { at: Date.now(), map });
    return map;
  }
  const withTimeout = (p, ms) => Promise.race([
    p.catch(() => null),
    new Promise((res) => { const t = setTimeout(() => res(null), ms); t?.unref?.(); }),
  ]);

  /* ── GET /api/shop/recommendations (عام) ─────────────────────────────── */
  app.get("/api/shop/recommendations", async (c) => {
    try {
      const d = await settingsData();
      const cfg = recSettingsOf(d);
      if (!cfg.enabled) return c.json({ ok: true, items: [] });
      const cartIds = idList(String(c.req.query("items") || ""), 40);
      const limitQ = String(c.req.query("limit") ?? "").trim();
      const limit = limitQ ? clampInt(limitQ, 1, 12, cfg.limit) : cfg.limit;
      const model = state.model || await withTimeout(loadModel(), 120) || { byA: new Map(), items: new Map() };
      if (Date.now() - state.modelAt > MODEL_TTL_MS) loadModel().catch(() => {});
      let menu = currentMenu();
      if (!menu.size && state.menuLoading) menu = (await withTimeout(state.menuLoading, 120)) || menu;
      const personal = cfg.personalBoost ? await withTimeout(personalFor(c), PERSONAL_TIMEOUT_MS) : null;
      const items = scoreCart({ cartIds, model, menu, settings: cfg, personal, hidden: hiddenOf(d), limit });
      c.header("Cache-Control", c.req.header("Authorization") ? "private, no-store" : "public, max-age=60");
      c.header("Vary", "Authorization");
      return c.json({ ok: true, items });
    } catch (e) {
      console.error("[recs] recommendations failed:", e.message);
      return c.json({ ok: false, items: [] }, 200);
    }
  });

  /* ── admin ────────────────────────────────────────────────────────────── */
  const buildInfo = () => ({
    builtAt: state.model?.builtAt || state.lastBuild?.at || null,
    pairs: state.model?.pairs ?? null,
    items: state.model?.items?.size ?? null,
    stats: state.model?.stats || state.lastBuild || null,
    building: !!state.building,
    lastError: state.lastError,
  });

  app.get("/api/cms/recommendations/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const d = await settingsData(true);
      try { await loadModel(); } catch { /* الجدول لسه مااتبناش */ }
      return c.json({ ok: true, settings: recSettingsOf(d), defaults: DEFAULT_SETTINGS, model: buildInfo() });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  app.put("/api/cms/recommendations/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b;
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    if (!b || typeof b !== "object" || Array.isArray(b)) return c.json({ ok: false, error: "bad body" }, 400);
    const d = await settingsData(true);
    const cur = recSettingsOf(d);
    const next = normalizeSettings({ ...cur, ...b });
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN jsonb_typeof(data->'shop') = 'object' THEN data ELSE jsonb_set(data, '{shop}', '{}'::jsonb, true) END,
         '{shop,recommendations}', $1::jsonb, true) WHERE id=1`, [J(next)]);
    state.settingsData = null; state.settingsAt = 0; state.personal.clear();
    let rebuilding = false;
    if (next.weightRecentDays !== cur.weightRecentDays) {
      rebuilding = true;
      build({ reason: "settings" }).catch(() => {});
    }
    return c.json({ ok: true, settings: next, rebuilding });
  });

  app.get("/api/cms/recommendations/preview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const pid = String(c.req.query("product_id") || "").trim();
    if (!ID_RE.test(pid)) return c.json({ ok: false, error: "product_id required" }, 400);
    try {
      const d = await settingsData();
      const cfg = recSettingsOf(d);
      const model = await loadModel();
      let menu = currentMenu();
      if (state.menuLoading) menu = (await withTimeout(state.menuLoading, 3000)) || menu;
      const hidden = hiddenOf(d);
      const ctxB = { menu, settings: cfg, cartIds: new Set([pid]), cartBases: new Set(menu.get(pid) ? [baseName(menu.get(pid).name)] : []), hidden };
      const nameOf = (id) => menu.get(id)?.name || model.items.get(id)?.name || null;
      const pairs = (model.byA.get(pid) || []).slice(0, 25).map((p) => {
        const m = menu.get(p.b_id);
        const blockedBy = blockReason(p.b_id, ctxB);
        return {
          product_id: p.b_id, name: nameOf(p.b_id), price: m ? Number(m.price) : (model.items.get(p.b_id)?.price != null ? Number(model.items.get(p.b_id).price) : null),
          image: m?.image || "", score: r4(pairScore(p)), together: p.together, together_w: p.together_w,
          lift: p.lift, confidencePct: Math.round(p.confidence * 1000) / 10,
          sources: { in_store: p.in_store, apps: p.apps, online: p.online },
          last_seen: p.last_seen, eligible: blockedBy == null, blockedBy,
        };
      });
      const it = model.items.get(pid);
      return c.json({
        ok: true,
        product: { product_id: pid, name: nameOf(pid), price: menu.get(pid) ? Number(menu.get(pid).price) : null,
          orders: it ? Number(it.orders) : 0,
          sources: it ? { in_store: Number(it.in_store), apps: Number(it.apps), online: Number(it.online) } : null },
        pairs,
        wouldShow: scoreCart({ cartIds: [pid], model, menu, settings: cfg, hidden }),
        settings: cfg,
        model: buildInfo(),
      });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  app.post("/api/cms/recommendations/rebuild", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const r = await build({ reason: "admin" });
      return c.json({ ok: true, build: r, model: buildInfo() });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e), model: buildInfo() }, 500);
    }
  });

  return { build, loadModel, refreshMenu, state };
}
