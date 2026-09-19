/* ═══════════════════════════════════════════════════════════════════════════
   KITCHEN CORE — شاشة المطبخ (KDS) للمطعم كله، مش طلبات المتجر بس (١٩ سبتمبر).
   منطق صافي (مفيش DB ولا شبكة) — كله بيتجرّب في kitchen-core.test.mjs.

   المصادر (الأسرع الأول):
     ١) tsp_webhooks — تاب سينس بيبعت order-updated/order-paid لكل طلبات الفرع:
        الصالة والتيك أواي (created/table) + تطبيقات التوصيل عبر فيدس (external +
        source_channel) + طلبات متجرنا (freshcuts_online). الخارجي بيوصل خلال
        ~١٠ ث من إنشائه (قياس ١٩ سبتمبر: p50 ٩.٨ث، p90 ٢١ث). طلب الكاونتر بيوصل
        وقت الدفع (عادة ~٢٠ ث)، وطلب الطاولة وقت الحساب بس (~٥٠ د بعد الفتح).
     ٢) استطلاع API الشريك GET /orders (أحدث الطلبات) كل ~١٥ ث وشاشة مفتوحة —
        حزام فوق الـwebhook لو إشعار ضاع.
     ٣) shop_orders — طلبات متجرنا من لحظة الدفع (قبل ما تنزل نقطة البيع كمان)،
        ومعاها الباقات متجمّعة، ملاحظة العميل، «اتركه عند الباب»، المشوار البعيد،
        وحالة المندوب (وصل/استلم).

   المراحل: new جديد → prep بيتحضّر → ready جاهز → done اتسلّم.
   المرحلة الفعلية = الأبعد بين (المصدر) و(تقديم المطبخ المحلي) — التقديم
   محلي بس، مابيكتبش في تاب سينس (API الشريك مافيهوش تغيير حالة آمن).

   الخصوصية: مفيش جوال ولا اسم عميل ولا عنوان يطلع للشاشة. ملاحظات نقطة البيع
   لطلبات المتجر فيها «الاسم · +966…» في الآخر — بتتشال، وأي رقم طويل بيتمسح.
═══════════════════════════════════════════════════════════════════════════ */

import { itemsOf, farZoneOf } from "./portal-core.js";
import { leaveAtDoor } from "./couriers.js";

export const STAGES = Object.freeze(["new", "prep", "ready", "done"]);
export const STAGE_AR = Object.freeze({ new: "جديد", prep: "بيتحضّر", ready: "جاهز", done: "اتسلّم" });
const rank = (s) => STAGES.indexOf(s);
export const laterStage = (a, b) => (rank(b) > rank(a) ? b : a);
export const isStage = (s) => STAGES.includes(s);

/* ── الإعدادات (settings.kitchen) ────────────────────────────────────────── */

/* محطات المطبخ (عمر ١٩ سبتمبر): ٥ النهارده وبتتغيّر — كلها بتتعدّل من اللوحة
   (إضافة/اسم/ترتيب + ربط أقسام تاب سينس وأصناف بعينها). الصنف اللي مالوش
   محطة بيروح «غير محدد» ظاهر، مش بيتخبّى. categories = اسم القسم أو الـid بتاعه
   في تاب سينس (الأقسام ليها أسماء مكررة ومضللة — «Crepes» فيه الإضافات). */
export const UNMAPPED = "_none";
export const DEFAULT_STATIONS = Object.freeze([
  { id: "grill", name: "مشاوي وحواوشي ووجبات", categories: ["وجبات", "سندوتشات", "برجر", "طاسات"], products: [] },
  { id: "crepe", name: "كريب", categories: ["كريبات"], products: [] },
  { id: "pizza", name: "بيتزا", categories: ["بيتزا"], products: [] },
  { id: "pasta", name: "باستا", categories: ["باستا"], products: [] },
  // eQr8vxoyBE = قسم «Crepes» في تاب سينس وفيه (جبنة/حشو أطراف/شوربة) — إضافات
  { id: "sides", name: "مقبلات وإضافات", categories: ["مقبلات", "مشروبات", "eQr8vxoyBE"], products: [] },
]);

export const DEFAULT_CONFIG = Object.freeze({
  slaAmberMin: 10,      // أخضر أقل من كده
  slaRedMin: 20,        // أحمر من كده وطالع
  doneKeepMin: 10,      // «اتسلّم» بيفضل ظاهر كام دقيقة
  staleMin: 90,         // طلب مالوش تحديث من ساعة ونص = بيختفي (الكاونتر اللي محدش قدّمه)
  lateArrivalMin: 20,   // طلب صالة/طاولة وصلنا بعد فتحه بـ٢٠ د = اتقدّم خلاص (وصل وقت الحساب)
  windowHours: 8,
  allowBump: true,      // التقديم المحلي (مابيلمسش تاب سينس)
  stations: DEFAULT_STATIONS,
  hideCategories: ["رسوم التوصيل"],
});

const clampInt = (v, lo, hi, def) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
};
const strList = (v, max = 60) => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim().slice(0, 60)).filter(Boolean).slice(0, max) : null);

export function normConfig(raw) {
  const k = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const d = DEFAULT_CONFIG;
  let stations = d.stations;
  if (Array.isArray(k.stations)) {
    const seen = new Set();
    const list = [];
    for (const s of k.stations.slice(0, 12)) {
      const id = String(s?.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20);
      const name = String(s?.name || "").trim().slice(0, 30);
      if (!id || !name || seen.has(id) || id === "all") continue;
      seen.add(id);
      list.push({ id, name, categories: strList(s.categories, 80) || [], products: strList(s.products, 300) || [], keywords: strList(s.keywords) || [] });
    }
    stations = list; // قايمة فاضية مسموحة = كله «غير محدد» (الشاشة بتعرض الكل)
  }
  const amber = clampInt(k.slaAmberMin, 1, 120, d.slaAmberMin);
  let red = clampInt(k.slaRedMin, 2, 240, d.slaRedMin);
  if (red <= amber) red = amber + 1;
  return {
    slaAmberMin: amber,
    slaRedMin: red,
    doneKeepMin: clampInt(k.doneKeepMin, 0, 120, d.doneKeepMin),
    staleMin: clampInt(k.staleMin, 15, 600, d.staleMin),
    lateArrivalMin: clampInt(k.lateArrivalMin, 5, 240, d.lateArrivalMin),
    windowHours: clampInt(k.windowHours, 2, 24, d.windowHours),
    allowBump: k.allowBump !== false,
    stations,
    hideCategories: strList(k.hideCategories) || d.hideCategories.slice(),
  };
}

/* ── القنوات ─────────────────────────────────────────────────────────────── */

export const CHANNELS = Object.freeze({
  dine_in: { label: "صالة", color: "#0f766e" },
  takeaway: { label: "تيك أواي", color: "#475569" },
  own_delivery: { label: "توصيل المطعم", color: "#7c3aed" },
  store_delivery: { label: "متجر توصيل", color: "#D0202A" },
  store_pickup: { label: "متجر استلام", color: "#e11d48" },
  keeta: { label: "كيتا", color: "#f59e0b" },
  hungerstation: { label: "هنقرستيشن", color: "#facc15" },
  jahez: { label: "جاهز", color: "#dc2626" },
  ninja: { label: "نينجا", color: "#16a34a" },
  toyou: { label: "تويو", color: "#ea580c" },
  mrsool: { label: "مرسول", color: "#0ea5e9" },
  careem: { label: "كريم", color: "#22c55e" },
  talabat: { label: "طلبات", color: "#f97316" },
  app: { label: "تطبيق توصيل", color: "#64748b" },
});
export const channelInfo = (key) => ({ key, ...(CHANNELS[key] || CHANNELS.app) });

const APP_ALIASES = [
  [/keeta|كيتا/i, "keeta"], [/hunger|هنقر/i, "hungerstation"], [/jahez|جاهز/i, "jahez"],
  [/ninja|نينجا/i, "ninja"], [/to\s*you|تويو/i, "toyou"], [/mrsool|مرسول/i, "mrsool"],
  [/careem|كريم/i, "careem"], [/talabat|طلبات/i, "talabat"],
];
export function appChannel(sourceChannel) {
  const s = String(sourceChannel || "");
  for (const [re, key] of APP_ALIASES) if (re.test(s)) return key;
  return "app";
}

/* طلب تاب سينس (شكل الـwebhook/الـAPI) → مفتاح القناة */
export function channelOfTs(o, optionName = "", shopOption = null) {
  const ext = o?.orders_external || null;
  const type = String(o?.order_type_name || "").toLowerCase();
  const src = String(ext?.source_channel || "").toLowerCase();
  if (src === "freshcuts_online" || String(ext?.source || "").toLowerCase() === "freshcuts") {
    if (shopOption === "pickup") return "store_pickup";
    if (shopOption === "delivery") return "store_delivery";
    return /استلام/.test(String(o?.meta?.notes || "")) ? "store_pickup" : "store_delivery";
  }
  if (type === "external" || ext) return appChannel(ext?.source_channel || ext?.source);
  if (type === "table") return "dine_in";
  const opt = String(optionName || "");
  if (/dine|صالة|محلي/i.test(opt)) return "dine_in";
  if (/deliver|توصيل/i.test(opt)) return "own_delivery";
  return "takeaway";
}

/* ── الملاحظات والخصوصية ─────────────────────────────────────────────────── */

const PHONE_RE = /\+?\d[\d\s\-]{6,}\d/g;
/* ملاحظة نقطة البيع لطلب المتجر: «… — الاسم · +9665…». الذيل ده بيتشال كله. */
export function cleanNote(raw) {
  let s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const tail = s.lastIndexOf(" — ");
  if (tail >= 0 && /·/.test(s.slice(tail))) s = s.slice(0, tail);
  s = s.replace(PHONE_RE, "").replace(/\s{2,}/g, " ").replace(/[\s·\-—]+$/g, "").trim();
  return s ? s.slice(0, 300) : null;
}

const ALLERGY_RE = /حساسي|حساسيه|allerg|gluten|جلوتين|لاكتوز|lactose|فول سوداني|peanut|مكسرات|nuts?\b/i;
const ATTN_RE = /بدون|من غير|مش عايز|no\s|without|سبايسي|spicy|حار|زيادة|extra|مكان|بدل|قلل|less|well done|عند الباب/i;
/* 2 = حساسية (أحمر)، 1 = تعديل على الصنف (أصفر)، 0 = عادي */
export function noteLevel(note) {
  const s = String(note || "");
  if (!s) return 0;
  if (ALLERGY_RE.test(s)) return 2;
  if (ATTN_RE.test(s)) return 1;
  return 1; // أي ملاحظة مكتوبة = الطباخ لازم يقراها
}

/* ── المحطات ─────────────────────────────────────────────────────────────── */

const norm = (s) => String(s || "").replace(/[ًٌٍَُِّْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").toLowerCase().trim();
/* الأولوية: صنف بعينه ← قسم (id أو اسم) ← كلمات (اختياري) ← null = «غير محدد» */
export function stationOf(item, cfg) {
  const stations = cfg?.stations || DEFAULT_STATIONS;
  const name = norm(item?.name);
  if (name) {
    for (const st of stations) if ((st.products || []).some((p) => norm(p) === name)) return st.id;
  }
  const catId = String(item?.categoryId || "");
  const cat = norm(item?.category);
  if (catId || cat) {
    for (const st of stations) {
      if ((st.categories || []).some((c) => (catId && String(c) === catId) || (cat && norm(c) === cat))) return st.id;
    }
  }
  if (name) {
    for (const st of stations) if ((st.keywords || []).some((k) => k && name.includes(norm(k)))) return st.id;
  }
  return null;
}
export const normName = (s) => norm(s);

/* ── الأصناف ─────────────────────────────────────────────────────────────── */

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const txt = (v, n = 120) => { const s = String(v ?? "").trim(); return s ? s.slice(0, n) : null; };

/* purchases بتاعة تاب سينس → سطور المطبخ. الإضافات (modifiers) = مكوّنات
   متزاحة تحت الصنف (زي «حشو أطراف كيري» أو مكوّنات صينية العروض). */
export function itemsFromPurchases(purchases, catMap = {}, cfg = DEFAULT_CONFIG) {
  const hideIds = new Set((cfg.hideCategories || []).map(String));
  if (!Array.isArray(purchases)) return [];
  const hide = new Set((cfg.hideCategories || []).map(norm));
  const out = [];
  for (const p of purchases.slice(0, 80)) {
    if (!p || typeof p !== "object") continue;
    const name = txt(p.name || p.local_name || p.purchase_product?.name) || "صنف";
    const category = txt(p.category?.name || catMap[p.category_id] || null, 60);
    if ((category && hide.has(norm(category))) || (p.category_id && hideIds.has(String(p.category_id)))) continue;
    if (/رسوم التوصيل|delivery fee|رسوم خدمة/i.test(name)) continue;
    const it = {
      name,
      qty: num(p.quantity) ?? 1,
      variant: txt(p.variant_option?.name, 40),
      note: cleanNote(p.meta?.notes ?? p.notes ?? null),
      category,
      categoryId: txt(p.category_id, 40),
      mods: (Array.isArray(p.modifiers) ? p.modifiers : []).slice(0, 20).map((m) => ({
        name: txt(m?.name || m?.local_name, 80) || "إضافة",
        qty: num(m?.quantity) ?? 1,
      })),
    };
    it.station = stationOf(it, cfg);
    it.noteLevel = noteLevel(it.note);
    out.push(it);
  }
  return out;
}

/* أصناف طلب المتجر (shop_orders.items) → نفس الشكل، والباقة عنوان + مكوّنات */
/* prodCat: {اسم_منظّف: category_id} من كتالوج الشريك — عشان صنف المتجر
   (اللي مالوش قسم) يتربط بنفس محطة نسخته على نقطة البيع. */
export function itemsFromShop(items, cfg = DEFAULT_CONFIG, { catMap = {}, prodCat = {} } = {}) {
  const rows = itemsOf(items);
  const withCat = (name) => {
    const categoryId = prodCat[norm(name)] || null;
    return { name, categoryId, category: categoryId ? catMap[categoryId] || null : null };
  };
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (r.kind === "component" && cur && cur.bundle) {
      const [cn] = String(r.name).split(" — ");
      const st = stationOf(withCat(cn), cfg);
      cur.mods.push({ name: r.name, qty: r.qty, note: r.note ? cleanNote(r.note) : null, station: st });
      if (!cur.station) cur.station = st;
      continue;
    }
    const [base, variant] = String(r.name).split(" — ");
    const it = {
      ...withCat(base), qty: r.qty, variant: variant || null, note: cleanNote(r.note),
      mods: [], bundle: r.kind === "bundle",
    };
    it.station = r.kind === "bundle" ? null : stationOf(it, cfg);
    it.noteLevel = noteLevel(it.note);
    out.push(it);
    cur = it;
  }
  for (const it of out) if (it.bundle && it.mods.some((m) => m.note)) it.noteLevel = Math.max(it.noteLevel, 1);
  return out;
}

/* ── الوقت ───────────────────────────────────────────────────────────────── */

/* تاب سينس بيكتب created_at من غير منطقة ("2026-09-18 22:52:18") وهي UTC */
export function tsTime(o) {
  const t = Number(o?.timestamp);
  if (Number.isFinite(t) && t > 1e9 && t < 1e11) return new Date(t * 1000).toISOString();
  const s = String(o?.created_at || "").trim();
  if (!s) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const isoOf = (v) => { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

/* ── المراحل من كل مصدر ──────────────────────────────────────────────────── */

const DEAD_RE = /void|cancel|reject|refund|return/i;
export function tsIsDead(o, slugs = {}) {
  const a = String(slugs?.approval_status || o?.orders_external?.approval_status || "");
  if (DEAD_RE.test(a)) return true;
  if (DEAD_RE.test(String(o?.order_status_name || slugs?.order_status || ""))) return true;
  if (DEAD_RE.test(String(o?.order_type_name || ""))) return true;
  if (String(o?.sales_or_return || "").toLowerCase() === "return") return true;
  return false;
}

/* طلب تاب سينس: الخارجي بيمشي بالـapproval، الكاونتر/الطاولة مالهمش حالة مطبخ */
export function stageFromTs(o, slugs = {}, { firstSeenAt = null, cfg = DEFAULT_CONFIG } = {}) {
  const ext = o?.orders_external;
  const a = String(slugs?.approval_status || ext?.approval_status || "").toLowerCase();
  const os = String(slugs?.order_status || o?.order_status_name || "").toLowerCase();
  const external = String(o?.order_type_name || "").toLowerCase() === "external" || Boolean(ext);
  if (external) {
    if (a.includes("deliver") || a.includes("complete") || a.includes("picked")) return "done";
    if (a.includes("ready")) return "ready";
    if (a.includes("accept") || a.includes("prepar") || a.includes("process")) return "prep";
    if (!a && os === "completed") return "done";
    return "new";
  }
  /* صالة/تيك أواي: الـwebhook بيوصل وقت الدفع. لو وصلنا بعد الفتح بكتير
     (طاولة اتحاسبت بعد ما أكلت) الأكل خرج خلاص — مانرنّش عليه كطلب جديد. */
  const created = ms(tsTime(o));
  const seen = ms(firstSeenAt);
  if (Number.isFinite(created) && Number.isFinite(seen) && seen - created > cfg.lateArrivalMin * 60_000) return "done";
  return "new";
}

/* طلب المتجر (shop_orders) */
export function stageFromShop(r) {
  const st = String(r?.status || "");
  if (["pending_payment", "expired", "rejected_refunded", "refund_failed", "cancelled"].includes(st)) return null;
  if (["on_the_way", "delivered", "collected"].includes(st)) return "done";
  const ship = String(r?.ship_status || "");
  if (ship === "picked" || ship === "delivered" || r?.ship_picked_at) return "done";
  if (r?.pos_ready_at) return "ready";
  if (["accepted", "courier_requested", "courier_assigned"].includes(st)) return "prep";
  return "new"; // paid / pos_created / paid_pos_failed / courier_cancelled
}

export const COURIER_AR = Object.freeze({
  pending: "بندوّر على مندوب", assigned: "المندوب جاي", arrived: "🏪 المندوب وصل — مستني",
  picked: "📦 المندوب استلم", delivered: "اتوصّل", cancelled: "المندوب اتلغى",
});
export function courierOf(r) {
  if (!r?.ship_status) return null;
  let s = String(r.ship_status);
  if (r.ship_picked_at || s === "picked") s = "picked";
  else if (r.ship_arrived_at && s !== "delivered" && s !== "cancelled") s = "arrived";
  return { status: s, label: COURIER_AR[s] || s, arrivedAt: isoOf(r.ship_arrived_at), pickedAt: isoOf(r.ship_picked_at) };
}

/* رقم قصير للشاشة */
export function shortRef(o) {
  const ext = o?.orders_external || {};
  const extNo = txt(ext.external_order_number || ext.external_order_id, 40);
  const src = String(ext.source_channel || "").toLowerCase();
  if (extNo && src !== "freshcuts_online") return extNo.length > 6 ? extNo.slice(-6) : extNo;
  const r = o?.receipt?.number ?? null;
  if (r != null && r !== "") return String(r);
  const f = o?.receipt?.formatted_no;
  if (f) return String(f).slice(-4);
  return String(o?.reference_id || o?.id || "").slice(-5);
}

/* ── بناء اللوحة ─────────────────────────────────────────────────────────── */

/* tsOrders: [{ order, slugs, firstSeenAt, lastAt, via }]
   shopRows: صفوف shop_orders + آخر شحنة
   bumps: Map<key,{stage,at,by}>
   بترجّع طلبات جاهزة للعرض (الترتيب: الأقدم الأول جوّه كل مرحلة). */
export function buildBoard({ tsOrders = [], shopRows = [], bumps = new Map(), catMap = {}, prodCat = {}, optionNames = {}, cfg = DEFAULT_CONFIG, now = Date.now() } = {}) {
  const out = [];
  const shopByPos = new Map();
  for (const r of shopRows) if (r?.pos_order_id) shopByPos.set(String(r.pos_order_id), r);
  const shopTs = new Map(); // order_no → نسخة تاب سينس بتاعته (أسرع في «جاهز»)
  const bumpOf = (key) => (bumps instanceof Map ? bumps.get(key) : bumps?.[key]) || null;

  const finish = (o) => {
    const b = bumpOf(o.key);
    let stage = o.sourceStage;
    let stageAt = o.sourceAt;
    if (b && isStage(b.stage) && rank(b.stage) > rank(stage)) { stage = b.stage; stageAt = isoOf(b.at) || stageAt; }
    o.stage = stage;
    o.stageAt = stageAt;
    o.bump = b ? { stage: b.stage, at: isoOf(b.at), by: b.by || null } : null;
    const created = ms(o.createdAt);
    const age = Number.isFinite(created) ? (now - created) / 60_000 : 0;
    if (stage === "done") {
      const doneAt = ms(stageAt) || created;
      if (!Number.isFinite(doneAt) || (now - doneAt) / 60_000 > cfg.doneKeepMin) return;
    } else if (age > cfg.staleMin && !(b && now - ms(isoOf(b.at)) < cfg.staleMin * 60_000)) {
      return; // مابقاش ليه تحديث من ساعة ونص — غالباً اتقدّم ومحدش ضغط
    }
    /* محطات الطلب + «غير محدد» لو فيه صنف مالوش محطة (عنوان الباقة مش صنف،
       وإضافات نقطة البيع تبع صنفها) */
    const sts = new Set();
    for (const i of o.items) {
      if (i.bundle) { for (const m of i.mods || []) sts.add(m.station || UNMAPPED); if (!(i.mods || []).length) sts.add(UNMAPPED); }
      else sts.add(i.station || UNMAPPED);
    }
    o.stations = [...sts];
    o.itemsCount = o.items.reduce((a, i) => a + (i.bundle ? 0 : Number(i.qty) || 0) + (i.bundle ? i.mods.reduce((x, m) => x + (Number(m.qty) || 0), 0) : 0), 0);
    o.flags.allergy = o.items.some((i) => i.noteLevel >= 2 || i.mods?.some((m) => noteLevel(m.note) >= 2)) || o.notes.some((n) => n.level >= 2);
    out.push(o);
  };

  for (const t of tsOrders) {
    const o = t?.order;
    if (!o || !o.id) continue;
    const slugs = t.slugs || {};
    const shop = shopByPos.get(String(o.id)) || null;
    if (shop) { shopTs.set(shop.order_no, t); continue; } // طلب متجرنا — بيتبني من shop_orders تحت
    if (tsIsDead(o, slugs)) continue;
    const channel = channelOfTs(o, optionNames[o.order_option_id] || "", null);
    const firstSeenAt = isoOf(t.firstSeenAt);
    const notes = [];
    const n = cleanNote(o.meta?.notes);
    if (n) notes.push({ text: n, level: noteLevel(n) });
    const tables = (Array.isArray(o.tables) ? o.tables : []).map((x) => txt(x?.name, 20)).filter(Boolean);
    const sourceStage = stageFromTs(o, slugs, { firstSeenAt, cfg });
    finish({
      key: `ts:${o.id}`,
      source: "pos",
      ref: shortRef(o),
      channel: channelInfo(channel),
      createdAt: tsTime(o) || firstSeenAt,
      firstSeenAt,
      sourceStage,
      sourceAt: sourceStage !== "new" ? isoOf(t.lastAt) : null,
      table: tables.join("، ") || null,
      items: itemsFromPurchases(o.purchases, catMap, cfg),
      notes,
      flags: {},
      courier: null,
      via: t.via || "webhook",
    });
  }

  for (const r of shopRows) {
    if (!r || r.is_test === true) continue;
    let sourceStage = stageFromShop(r);
    if (!sourceStage) continue;
    /* نفس الطلب على نقطة البيع: الـwebhook بيوصل قبل كنسة المتجر — ناخد الأبعد */
    const tw = shopTs.get(r.order_no) || null;
    let tsAt = null;
    if (tw?.order) {
      if (tsIsDead(tw.order, tw.slugs || {})) continue;
      const tsStage = stageFromTs(tw.order, tw.slugs || {}, { cfg });
      if (rank(tsStage) > rank(sourceStage)) { sourceStage = tsStage; tsAt = isoOf(tw.lastAt); }
    }
    const addr = r.address && typeof r.address === "object" ? r.address : null;
    const delivery = r.option === "delivery";
    const notes = [];
    const n = cleanNote(r.notes);
    if (n) notes.push({ text: n, level: noteLevel(n) });
    const door = delivery && leaveAtDoor(addr);
    const far = farZoneOf(r.far_zone);
    const courier = delivery ? courierOf(r) : null;
    let sourceAt = tsAt;
    if (tsAt) { /* من تاب سينس */ }
    else if (sourceStage === "ready") sourceAt = isoOf(r.pos_ready_at);
    else if (sourceStage === "done") sourceAt = isoOf(r.ship_picked_at) || isoOf(r.updated_at);
    else if (sourceStage === "prep") sourceAt = isoOf(r.accepted_at);
    finish({
      key: `shop:${r.order_no}`,
      source: "store",
      ref: String(r.order_no || "").slice(-4),
      orderNo: r.order_no,
      posRef: tw?.order ? shortRef(tw.order) : null,
      channel: channelInfo(delivery ? "store_delivery" : "store_pickup"),
      createdAt: isoOf(r.created_at),
      firstSeenAt: isoOf(r.created_at),
      sourceStage,
      sourceAt,
      table: null,
      items: itemsFromShop(r.items, cfg, { catMap, prodCat }),
      notes,
      flags: { leaveAtDoor: Boolean(door), farZone: far ? { km: far.km } : null, inPos: Boolean(r.pos_order_id), posFailed: r.status === "paid_pos_failed" },
      courier,
      via: "store",
    });
  }

  out.sort((a, b) => (ms(a.createdAt) || 0) - (ms(b.createdAt) || 0));
  return out;
}

/* نسخة عامة من الإعدادات للشاشة */
export function publicConfig(cfg) {
  return {
    slaAmberMin: cfg.slaAmberMin, slaRedMin: cfg.slaRedMin, doneKeepMin: cfg.doneKeepMin,
    allowBump: cfg.allowBump,
    stations: cfg.stations.map((s) => ({ id: s.id, name: s.name })),
    unmapped: UNMAPPED,
  };
}

/* تقديم/ترجيع مرحلة: الجديد لازم يكون بعد المصدر (مايرجعش لورا المصدر) */
export function validBump(currentSource, target) {
  if (!isStage(target)) return false;
  return rank(target) >= rank(currentSource);
}
