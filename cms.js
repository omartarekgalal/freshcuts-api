/* ═══════════════════════════════════════════════════════════════════════════
   CMS — فريق لوحة المتجر: مستخدمين، أدوار، صلاحيات، وسجل نشاط (2026-09-11)

   قرار عمر: «فريق كامل بأدوار» من أول يوم — تسويق، عمليات، محاسبة، مطبخ —
   وكل واحد يشوف اللي يخصّه بس.

   الفكرة الأساسية: كل موديول قديم محمي بـ requireAdmin اللي كان بيقبل مفتاح
   أدمن واحد مشترك. بدل ما نعدّل ٤٠ موديول، index.js بقى بينده الهوكس هنا:
     • مفتاح الأدمن القديم  → بيعدّي زي ما هو (المالك) + سطر في السجل.
     • توكن فريق  cms:<id>:<hex> → بنجيب المستخدم، نعرف «قسم» المسار من
       PATH_SECTIONS، ونقارن بصلاحية دوره: GET/HEAD محتاجة «عرض»، أي كتابة
       محتاجة «تعديل». غير كده 403 واضحة فيها القسم والصلاحية المطلوبة.
   مستخدم دوره «مالك» = أدمن كامل حتى في المسارات القديمة اللي بتقرا getAuth
   مباشرة (السفراء/الكاشير): جلساته محفوظة في الذاكرة ومتحمّلة وقت الإقلاع،
   فـ getAuth المتزامنة تقدر تتعرّف عليه (isOwnerSync).

   المسارات اللي مش متصنّفة بتقع على «الإعدادات» (المالك بس) — الرفض هو
   الافتراضي، فأي موديول جديد مايتفتحش لدور غلط بالغلط.

   الباسوردات scrypt بملح لكل مستخدم، والجلسات مخزّنة كـ sha256 بس — التوكن
   نفسه مايتحفظش في الداتابيز. السجل بيكتب المسار والطريقة بس، من غير الجسم،
   عشان مايتسجّلش باسورد ولا بيانات حساسة.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import * as smsRules from "./smsrules.js";
import { promisify } from "node:util";
// نفس قواعد الهوية والقناة اللي المؤشرات بتستخدمها — مفيش نسخة تانية
import { IDENT_SQL, SALES_ONLY, deliverySql, WEBSITE_SQL } from "./analytics.js";
// نفس قواعد الـSLA بتاعة الـwatchdog — لوحة التشغيل مابتكتبش كتاب قواعد تاني
import { slaCheck, DEFAULT_SLA } from "./shop.js";
import { isBotRequest } from "./botfilter.js";
// قواعد الباقات (توزيع السعر والتوسيع) — صافية ومتجرّبة أوفلاين في bundles.test.mjs
import * as bundlesLib from "./bundles.js";
import { LEGACY_MULTIPLY } from "./money.js";
// كتالوج تاب سينس: الأسعار الحقيقية للباقات (العميل مابيبعتش سعر أبداً)
import * as tsstore from "./tsstore.js";
// سجل العروض الحي (جدول offer_registry) — نفس المصدر اللي الكتالوج والمتجر بيقروا منه
import {
  OFFERS, offerById, publicOffer, saveOffer, offersSource, riyadhDay, EDITABLE_OFFER_FIELDS,
  // يوم الشغل (٤ الفجر) — باسم تاني لأن register فيها riyadhDay محلية بمعنى يوم التقويم
  SAVINGS_RE, riyadhDay as bizDay,
} from "./offers.js";

const scryptAsync = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const CACHE_MS = 10 * 60 * 1000;

export const SECTIONS = [
  { id: "home", label: "الرئيسية", icon: "📈" },
  { id: "growth", label: "النمو والاكتساب", icon: "🚀" },
  { id: "orders", label: "الطلبات", icon: "🧾" },
  { id: "products", label: "المنتجات", icon: "🍔" },
  { id: "customers", label: "العملاء", icon: "👥" },
  { id: "discounts", label: "الخصومات", icon: "🎟" },
  { id: "delivery", label: "التوصيل", icon: "🛵" },
  { id: "analytics", label: "التحليلات", icon: "📊" },
  { id: "finance", label: "المالية", icon: "💰" },
  { id: "settings", label: "الإعدادات والفريق", icon: "⚙️" },
];
const SECTION_IDS = SECTIONS.map((s) => s.id);

export const ROLES = [
  { id: "owner", label: "المالك", hint: "كل حاجة — تعديل كامل، مايتقلّش" },
  { id: "marketing", label: "تسويق", hint: "النمو والإعلانات والمنتجات والعملاء والخصومات" },
  { id: "operations", label: "عمليات", hint: "الطلبات والتوصيل" },
  { id: "accounting", label: "محاسبة", hint: "المالية + عرض الأرقام" },
  { id: "kitchen", label: "مطبخ / كاشير", hint: "الطلبات وحالاتها بس" },
];
const ROLE_IDS = ROLES.map((r) => r.id);

const E = "edit", V = "view", N = "none";
const LEVELS = [N, V, E];
const all = (lvl) => Object.fromEntries(SECTION_IDS.map((s) => [s, lvl]));

export const DEFAULT_PERMS = {
  owner: all(E),
  marketing: { home: V, growth: E, orders: V, products: E, customers: E, discounts: E, delivery: N, analytics: V, finance: N, settings: N },
  operations: { home: V, growth: N, orders: E, products: V, customers: V, discounts: V, delivery: E, analytics: V, finance: N, settings: N },
  accounting: { home: V, growth: V, orders: V, products: N, customers: N, discounts: V, delivery: V, analytics: V, finance: E, settings: N },
  kitchen: { home: N, growth: N, orders: E, products: N, customers: N, discounts: N, delivery: V, analytics: N, finance: N, settings: N },
};

/* مسار → قسم. أول تطابق بيكسب، والترتيب مقصود: المحدد قبل العام
   (keeta-payouts مالية قبل keeta تحليلات، coupons خصومات قبل shop). */
const PATH_SECTIONS = [
  [/^\/api\/cms\/(users|roles|audit)/, "settings"],
  [/^\/api\/cms\/home/, "home"],
  // البحث في اللوحة (Ctrl+K) وتسجيل التنقّل — تسجيل مسبق (خطة ٢٠٢٦-٠٩ §٤-٦)
  [/^\/api\/cms\/(search|nav-event)/, "home"],
  // صفحات البحث للعروض (freshcuts.sa/offers/<slug>) — نفس قسم العرض نفسه
  [/^\/api\/cms\/offer-pages/, "products"],
  // العروض والباقات جوّه «المنتجات»: نفس صلاحية تعريف الباقة وتعديل العرض
  // recommendations = إعدادات ومعاينة «تحب تضيف؟» (recs.js)
  [/^\/api\/cms\/(products|catalog|collections|bundles|offers|recommendations)/, "products"],
  [/^\/api\/cms\/(growth|links)/, "growth"],
  // sms-optout = قايمة «مش عايز رسايل» (نفس دوال البوابة، portal.js)
  [/^\/api\/cms\/(customers|segments|loyalty|campaigns|flows|reviews|sms-optout)/, "customers"],
  [/^\/api\/cms\/(analytics|exec)/, "analytics"],
  [/^\/api\/cms\/(ops|sla)/, "orders"],
  [/^\/api\/(shop\/coupons|discounts)/, "discounts"],
  [/^\/api\/(finance|keeta-payouts|costing|staff-meals|staff_meals|pay\/|influencer-payments)/, "finance"],
  [/^\/api\/delivery/, "delivery"],
  [/^\/api\/groups/, "customers"],
  // الاسترجاع فلوس بتخرج → «المالية»، ولازم يسبق سطر shop/orders العام
  // (غير كده دور المطبخ اللي عنده orders: edit كان يقدر يرجّع فلوس)
  [/^\/api\/(shop|cms)\/orders\/[^/]+\/refund$/, "finance"],
  /* تسجيل مسبق لمسارات الموجات الجاية (خطة ٢٠٢٦-٠٩ §٤-٦) — الأدق قبل العام،
     وكلهم بعد سطر الاسترجاع عشان cms/orders/<n>/refund يفضل «مالية». */
  [/^\/api\/cms\/orders\/[^/]+\/courier\//, "delivery"],
  [/^\/api\/cms\/(orders|order-views)/, "orders"],
  [/^\/api\/journey\/customer/, "customers"],
  [/^\/api\/journey\/order/, "orders"],
  [/^\/api\/journey\/settings/, "settings"],
  [/^\/api\/journey/, "analytics"],
  [/^\/api\/portal\/(summary|issues|devices)/, "orders"],
  // «طلبات نقطة البيع» (index.js: /api/manager/orders + /api/manager/order/:id/items)
  // — قراءة بس من كاش تاب سينس. كانت بتقع على «الإعدادات» فأي دور غير المالك 403.
  [/^\/api\/manager\//, "orders"],
  [/^\/api\/app\//, "growth"],
  [/^\/api\/(shop\/(orders|board|summary)|day\b|day\/|staff\/|cashier|chef|notifications)/, "orders"],
  // «منتظرين الفتح» — نفس قسم السلات المتروكة (نمو): استرداد طلب ضايع
  [/^\/api\/(cms\/)?openwait/, "growth"],
  [/^\/api\/(ads|autopilot|attribution|funnel|audiences|retargeting|retarget|marketing|content|social|promo|catalog|tracking|offers|carts|menuplan|scorecard|ai\/|chat)/, "growth"],
  [/^\/api\/(customers|account\/admin)/, "customers"],
  [/^\/api\/(analytics|reports|insights|keeta-reports|hungerstation|ninja|keeta\b|keeta\/)/, "analytics"],
];
export function sectionOf(path) {
  for (const [re, s] of PATH_SECTIONS) if (re.test(path)) return s;
  return "settings";
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

async function hashPassword(plain, salt) {
  const buf = await scryptAsync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${buf.toString("hex")}`;
}
async function verifyPassword(plain, salt, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 5 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  let want;
  try { want = Buffer.from(parts[4], "hex"); } catch { return false; }
  let got;
  try { got = await scryptAsync(String(plain), salt, want.length, { N, r, p }); } catch { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const rl = new Map();
function loginLimited(ip) {
  const now = Date.now(), slot = rl.get(ip);
  if (!slot || now - slot.start > 15 * 60_000) { rl.set(ip, { start: now, n: 1 }); return false; }
  slot.n++;
  if (rl.size > 5000) rl.clear();
  return slot.n > 10;
}

/* ═══ صفحات البحث للعروض (offer_pages) — تحقق صافي ═══════════════════════
   متجرّب أوفلاين في offerpages.test.mjs. قواعد رسالة ٩٦: الرقم هو الرسالة،
   ممنوع «وفّر/خصم/٪» بالعربي والإنجليزي، وممنوع إيموجي العلم. */
export const OFFER_PAGE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
export const OFFER_PAGE_LIMITS = {
  seo_title: 70, seo_title_en: 70, meta: 170, meta_en: 170, h1: 90, h1_en: 90,
  title_en: 120, desc_en: 600, faqMax: 8, faqQ: 200, faqA: 800,
};
const OFFER_PAGE_TEXT = ["h1", "h1_en", "seo_title", "seo_title_en", "meta", "meta_en", "title_en", "desc_en"];
const OFFER_PAGE_IMAGES = ["image_web", "image_wide", "image_og"];
const OFFER_PAGE_NUMBERED = ["h1", "h1_en", "seo_title", "seo_title_en", "meta", "meta_en"];
export const EN_SAVINGS_RE = /\b(save|saves|saved|saving|savings|discount|discounts|discounted|off|percent)\b|%/i;
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]/u;
const okPageImage = (u) => /^(https:\/\/|\/static\/)[^\s"'<>]+$/i.test(u);
const latinDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/* existing = صف offer_pages الحالي (أو null). بترجّع
   { ok, row, changed, warnings } أو { ok:false, status, error, message }. */
export function validateOfferPagePatch(existing, body, { price = null, slugLocked = false } = {}) {
  const bad = (status, error, message) => ({ ok: false, status, error, message });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(400, "bad_body", "البيانات مش صحيحة.");
  const b = body;
  const cur = existing || {};
  const row = {
    slug: cur.slug || null,
    ...Object.fromEntries(OFFER_PAGE_TEXT.map((k) => [k, cur[k] || null])),
    ...Object.fromEntries(OFFER_PAGE_IMAGES.map((k) => [k, cur[k] || null])),
    faq: Array.isArray(cur.faq) ? cur.faq : [],
    sort: Number(cur.sort) || 0,
    indexable: cur.indexable !== false,
  };

  if ("slug" in b) {
    const slug = typeof b.slug === "string" ? b.slug.trim() : "";
    if (!OFFER_PAGE_SLUG_RE.test(slug)) {
      return bad(400, "bad_slug", "الرابط لازم يبقى حروف إنجليزي صغيرة وأرقام وشَرطة (-) بس، لحد ٦٠ حرف — مثلاً kilo-grills-96.");
    }
    if (slugLocked && cur.slug && slug !== cur.slug) {
      return bad(409, "slug_locked", "الرابط اتنشر خلاص — تغييره بيكسر الروابط القديمة.");
    }
    row.slug = slug;
  }
  if (!row.slug) return bad(400, "slug_required", "لازم تحدد رابط للصفحة (slug).");

  for (const k of OFFER_PAGE_TEXT) {
    if (!(k in b)) continue;
    if (b[k] != null && typeof b[k] !== "string") return bad(400, "bad_field", `«${k}» لازم يبقى نص.`);
    const v = String(b[k] ?? "").trim();
    if (v.length > OFFER_PAGE_LIMITS[k]) return bad(400, "too_long", `«${k}» أطول من ${OFFER_PAGE_LIMITS[k]} حرف.`);
    row[k] = v || null;
  }
  for (const k of OFFER_PAGE_IMAGES) {
    if (!(k in b)) continue;
    const v = b[k] == null ? "" : typeof b[k] === "string" ? b[k].trim() : null;
    if (v === null || (v && (v.length > 500 || !okPageImage(v)))) {
      return bad(400, "bad_image", `«${k}» لازم يبدأ بـ https:// أو /static/.`);
    }
    row[k] = v || null;
  }
  if ("faq" in b) {
    if (!Array.isArray(b.faq)) return bad(400, "bad_faq", "الأسئلة لازم تبقى قايمة.");
    const faq = [];
    for (const f of b.faq) {
      if (!f || typeof f !== "object") return bad(400, "bad_faq", "سؤال مش صحيح.");
      const t = (x) => (typeof x === "string" ? x.trim() : x == null ? "" : null);
      const item = { q: t(f.q), a: t(f.a), q_en: t(f.q_en), a_en: t(f.a_en) };
      if (Object.values(item).some((x) => x === null)) return bad(400, "bad_faq", "السؤال والإجابة لازم يبقوا نص.");
      if (!item.q && !item.a && !item.q_en && !item.a_en) continue;
      if (!item.q || !item.a) return bad(400, "faq_incomplete", "كل سؤال محتاج سؤال وإجابة بالعربي.");
      if ([item.q, item.q_en].some((x) => x.length > OFFER_PAGE_LIMITS.faqQ)
        || [item.a, item.a_en].some((x) => x.length > OFFER_PAGE_LIMITS.faqA)) {
        return bad(400, "too_long", `السؤال لحد ${OFFER_PAGE_LIMITS.faqQ} حرف والإجابة لحد ${OFFER_PAGE_LIMITS.faqA}.`);
      }
      faq.push(item);
    }
    if (faq.length > OFFER_PAGE_LIMITS.faqMax) return bad(400, "faq_too_many", `أقصى حاجة ${OFFER_PAGE_LIMITS.faqMax} أسئلة.`);
    row.faq = faq;
  }
  if ("sort" in b) {
    const n = Number(b.sort);
    if (!Number.isInteger(n) || Math.abs(n) > 10000) return bad(400, "bad_sort", "الترتيب لازم يبقى رقم صحيح.");
    row.sort = n;
  }
  if ("indexable" in b) {
    if (typeof b.indexable !== "boolean") return bad(400, "bad_indexable", "«indexable» لازم true أو false.");
    row.indexable = b.indexable;
  }

  // قواعد الرسالة على كل النصوص (العربي والإنجليزي والأسئلة)
  const texts = [
    ...OFFER_PAGE_TEXT.map((k) => row[k]),
    ...row.faq.flatMap((f) => [f.q, f.a, f.q_en, f.a_en]),
  ].filter(Boolean);
  if (texts.some((t) => FLAG_RE.test(t))) {
    return bad(400, "flag_forbidden", "ممنوع إيموجي العلم في نصوص العروض.");
  }
  // التشكيل والتطويل («وفِّر»، «خـصم») مايعدّوش من الفلتر: بنشيلهم قبل الفحص
  const bare = (t) => String(t).replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ​-‏]/g, "");
  if (texts.some((t) => [t, bare(t)].some((x) => SAVINGS_RE.test(x) || EN_SAVINGS_RE.test(x)))) {
    return bad(400, "savings_claim_forbidden",
      "النص فيه كلام عن توفير/خصم/نسبة (أو save/discount/off/%). ممنوع على العروض دي: الرسالة هي الرقم ٩٦ بس.");
  }

  const warnings = [];
  for (const k of OFFER_PAGE_NUMBERED) {
    const nums = (latinDigits(row[k] || "").match(/\d+(?:[.,]\d+)?/g) || []).filter((x) => price == null || Number(x.replace(",", ".")) !== Number(price));
    if (nums.length) warnings.push(`«${k}» فيه رقم (${[...new Set(nums)].join("، ")}) غير سعر العرض — اتأكد إنه مش سعر قديم.`);
  }
  const keys = ["slug", ...OFFER_PAGE_TEXT, ...OFFER_PAGE_IMAGES, "faq", "sort", "indexable"];
  const before = existing
    ? { ...row, ...Object.fromEntries(keys.map((k) => [k, k === "faq" ? (Array.isArray(cur.faq) ? cur.faq : [])
      : k === "sort" ? Number(cur.sort) || 0 : k === "indexable" ? cur.indexable !== false : cur[k] || null])) }
    : {};
  const changed = keys.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(row[k] ?? null));
  return { ok: true, row, changed, warnings };
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb, DEFAULT_DELIVERY_APPS } = ctx;

  /* جلسات في الذاكرة: token_hash → { user, exp }. مليانة وقت الإقلاع بكل
     الجلسات السارية، فـ isOwnerSync بتشتغل حتى بعد أي نشر/إعادة تشغيل. */
  const sessions = new Map();

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cms_users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'marketing',
        pass_salt TEXT NOT NULL,
        pass_hash TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        must_change BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS cms_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INT NOT NULL REFERENCES cms_users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS cms_sessions_user_idx ON cms_sessions(user_id);
      CREATE TABLE IF NOT EXISTS cms_audit (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_id INT,
        actor_name TEXT,
        role TEXT,
        method TEXT,
        path TEXT,
        section TEXT,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS cms_audit_at_idx ON cms_audit(at DESC);
      -- الطبقة التسويقية فوق كتالوج تاب سينس (الأسماء والأسعار منهم، مابنلمسهاش)
      CREATE TABLE IF NOT EXISTS cms_products (
        product_id TEXT PRIMARY KEY,
        image TEXT,
        description TEXT,
        description_en TEXT,
        badge TEXT,
        seo_title TEXT,
        seo_description TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT
      );
      CREATE TABLE IF NOT EXISTS cms_collections (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        name_en TEXT,
        product_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        sort INT NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- روابط الحملات: freshcuts.sa/l/<slug>
      -- «باقة بخيارات» (2026-09-12): باقة بسعر واحد متعرّفة **عندنا**، بتنزل
      -- نقطة البيع كمنتجات حقيقية بأسعار موزّعة — عشان الريسبي يفضل مظبوط
      -- ومانعملش منتج جديد في نقطة البيع. القواعد في bundles.js.
      CREATE TABLE IF NOT EXISTS cms_bundles (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        name_en TEXT,
        description TEXT,
        image TEXT,
        badge TEXT,
        price NUMERIC NOT NULL DEFAULT 0,     -- سعر العميل شامل الضريبة
        slots JSONB NOT NULL DEFAULT '[]'::jsonb,
        order_kinds JSONB NOT NULL DEFAULT '["delivery","pickup","dine_in"]'::jsonb,
        active BOOLEAN NOT NULL DEFAULT FALSE, -- مسوّدة بالافتراضي — مايظهرش غير بقرار
        sort INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT
      );
      CREATE TABLE IF NOT EXISTS cms_links (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        label TEXT,
        target_type TEXT NOT NULL DEFAULT 'home',
        target_id TEXT,
        coupon TEXT,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        clicks INT NOT NULL DEFAULT 0,
        last_click_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by TEXT
      );
      -- الحملات: رسالة لشريحة (إشعار مجاني أو SMS تسويقي)
      CREATE TABLE IF NOT EXISTS cms_campaigns (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        segment TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'push',
        message TEXT NOT NULL,
        coupon TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        audience INT,
        sent INT NOT NULL DEFAULT 0,
        failed INT NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        sent_by TEXT,
        last_error TEXT
      );
      -- كود إلغاء الاشتراك لكل رقم (شرط هيئة الاتصالات لرسائل الإعلانات)
      CREATE TABLE IF NOT EXISTS cms_contacts (
        phone_norm TEXT PRIMARY KEY,
        optout_code TEXT UNIQUE NOT NULL,
        opted_out_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS cms_sms_daily (
        day DATE PRIMARY KEY,
        n INT NOT NULL DEFAULT 0
      );
      -- دفتر مكافآت الولاء: مكافأة واحدة لكل (رقم، رقم المكافأة) — مفيش تكرار
      CREATE TABLE IF NOT EXISTS cms_loyalty (
        phone_norm TEXT NOT NULL,
        reward_no INT NOT NULL,
        coupon TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (phone_norm, reward_no)
      );
      -- الأتمتة: رسالة للي «بيدخل» شريحة (مش للموجودين فيها — دول بالحملات)
      CREATE TABLE IF NOT EXISTS cms_flows (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        segment TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'push',
        message TEXT NOT NULL,
        coupon TEXT,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        sent_total INT NOT NULL DEFAULT 0,
        last_run_at TIMESTAMPTZ,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- مين جوّه الشريحة دلوقتي (عشان نعرف مين «دخل» من آخر دورة)
      CREATE TABLE IF NOT EXISTS cms_flow_members (
        flow_id INT NOT NULL,
        phone_norm TEXT NOT NULL,
        entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (flow_id, phone_norm)
      );
      CREATE TABLE IF NOT EXISTS cms_flow_log (
        flow_id INT NOT NULL,
        phone_norm TEXT NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cms_flow_log_idx ON cms_flow_log(phone_norm, sent_at DESC);
      -- ١٧ سبتمبر: جدولة الحملة + holdout + دفتر لكل مستلم (نتيجة ونسب وفاصل ٢١ يوم)
      ALTER TABLE cms_campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
      ALTER TABLE cms_campaigns ADD COLUMN IF NOT EXISTS confirm_audience INT;
      ALTER TABLE cms_campaigns ADD COLUMN IF NOT EXISTS holdout_pct INT NOT NULL DEFAULT 0;
      ALTER TABLE cms_campaigns ADD COLUMN IF NOT EXISTS cost NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE cms_campaigns ADD COLUMN IF NOT EXISTS excluded JSONB;
      CREATE TABLE IF NOT EXISTS cms_campaign_sends (
        campaign_id INT NOT NULL,
        phone_norm TEXT NOT NULL,
        status TEXT NOT NULL,            -- sent | failed | holdout
        msg_id TEXT,
        parts INT NOT NULL DEFAULT 0,
        cost NUMERIC NOT NULL DEFAULT 0,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (campaign_id, phone_norm)
      );
      ALTER TABLE cms_contacts ADD COLUMN IF NOT EXISTS optout_source TEXT;
      ALTER TABLE cms_contacts ADD COLUMN IF NOT EXISTS optout_reason TEXT;
      ALTER TABLE cms_contacts ADD COLUMN IF NOT EXISTS optout_by TEXT;
      CREATE TABLE IF NOT EXISTS cms_optout_log (
        id SERIAL PRIMARY KEY, phone_norm TEXT NOT NULL, action TEXT NOT NULL, source TEXT, reason TEXT, actor TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      ALTER TABLE cms_optout_log ADD COLUMN IF NOT EXISTS ua TEXT;
      CREATE INDEX IF NOT EXISTS cms_campaign_sends_phone_idx ON cms_campaign_sends(phone_norm, created_at DESC);
    `);
    /* ربط الباقة بالعرض (٢٠٢٦-٠٩-١٢). الزرع مرة واحدة بس (cms_migrations)
       عشان لو المالك غيّر الربط بعدين، الإقلاع مايرجّعهوش. INSERT والـUPDATE
       في جملة واحدة: يا الاتنين يحصلوا يا ولا واحد. */
    await pool.query(`
      ALTER TABLE cms_bundles ADD COLUMN IF NOT EXISTS offer_id TEXT;
      CREATE TABLE IF NOT EXISTS cms_migrations (id TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    `);
    await pool.query(`
      WITH m AS (INSERT INTO cms_migrations(id) VALUES ('bundle_offer_link_v1') ON CONFLICT DO NOTHING RETURNING id)
      UPDATE cms_bundles
         SET offer_id = CASE slug WHEN 'national96-grill' THEN 'nd96_kilo' WHEN 'national96-box' THEN 'nd96_box' END
       WHERE slug IN ('national96-grill', 'national96-box') AND offer_id IS NULL
         AND EXISTS (SELECT 1 FROM m)`);
    /* صفحات البحث للعروض (مسار ٠١، ٢٠٢٦-٠٩): جدول منفصل عن offer_registry عن
       قصد — السجل ومنطق تحققه مابيتلمسوش. الـslug بيتقفل بعد أول ظهور live
       (published_at). محاط بـtry عشان أي فشل هنا مايوقفش تحميل جلسات الفريق. */
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS offer_pages (
          offer_id     TEXT PRIMARY KEY,
          slug         TEXT UNIQUE NOT NULL
                       CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$'),
          h1           TEXT, h1_en        TEXT,
          seo_title    TEXT, seo_title_en TEXT,
          meta         TEXT, meta_en      TEXT,
          title_en     TEXT, desc_en      TEXT,
          image_web    TEXT, image_wide   TEXT, image_og TEXT,
          faq          JSONB NOT NULL DEFAULT '[]'::jsonb,
          sort         INT NOT NULL DEFAULT 0,
          indexable    BOOLEAN NOT NULL DEFAULT TRUE,
          published_at TIMESTAMPTZ,
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by   TEXT
        )`);
      await pool.query(`
        WITH m AS (INSERT INTO cms_migrations(id) VALUES ('offer-pages-v1') ON CONFLICT DO NOTHING RETURNING id)
        INSERT INTO offer_pages(offer_id, slug, sort, updated_by)
        SELECT v.offer_id, v.slug, v.sort, 'seed'
          FROM (VALUES ('nd96_kilo', 'kilo-grills-96', 0), ('nd96_box', 'national-day-box-96', 1)) AS v(offer_id, slug, sort)
         WHERE EXISTS (SELECT 1 FROM m)
        ON CONFLICT DO NOTHING`);
    } catch (e) { console.error("[cms] offer_pages schema failed:", e.message); }
    const r = await pool.query(
      `SELECT s.token_hash, s.expires_at, u.id, u.username, u.name, u.role, u.active
         FROM cms_sessions s JOIN cms_users u ON u.id = s.user_id
        WHERE s.expires_at > NOW() AND u.active`);
    for (const row of r.rows) {
      sessions.set(row.token_hash, { user: publicUser(row), exp: Date.now() + CACHE_MS });
    }
    await pool.query("DELETE FROM cms_sessions WHERE expires_at < NOW()");
  }
  ensureSchema()
    .then(() => console.log(`[cms] schema ready — ${sessions.size} live team session(s)`))
    .catch((e) => console.error("[cms] schema failed:", e.message));

  const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role });
  const OWNER_KEY = { id: 0, username: "admin", name: "المالك", role: "owner", adminKey: true };

  /* الصلاحيات الفعلية: الافتراضي + تعديلات المالك (settings.data.cms.perms).
     المالك دايماً «تعديل» في كل حاجة — مفيش حد يقدر يقفل الباب على نفسه. */
  let permsCache = { at: 0, perms: null };
  async function effectivePerms() {
    if (permsCache.perms && Date.now() - permsCache.at < 30_000) return permsCache.perms;
    const over = (((await getSettingsData()) || {}).cms || {}).perms || {};
    const out = {};
    for (const role of ROLE_IDS) {
      const base = { ...DEFAULT_PERMS[role] };
      for (const s of SECTION_IDS) {
        const v = over?.[role]?.[s];
        if (LEVELS.includes(v)) base[s] = v;
      }
      out[role] = role === "owner" ? all(E) : base;
    }
    permsCache = { at: Date.now(), perms: out };
    return out;
  }

  const bearer = (c) => {
    const h = c.req.header("Authorization") || "";
    return h.startsWith("Bearer ") ? h.slice(7) : "";
  };

  async function sessionUser(token) {
    if (!token || !token.startsWith("cms:")) return null;
    const th = sha(token);
    const hit = sessions.get(th);
    if (hit && hit.exp > Date.now()) return hit.user;
    const r = await pool.query(
      `SELECT u.id, u.username, u.name, u.role, u.active, s.expires_at
         FROM cms_sessions s JOIN cms_users u ON u.id = s.user_id
        WHERE s.token_hash = $1`, [th]);
    const row = r.rows[0];
    if (!row || !row.active || new Date(row.expires_at) < new Date()) { sessions.delete(th); return null; }
    const user = publicUser(row);
    sessions.set(th, { user, exp: Date.now() + CACHE_MS });
    pool.query("UPDATE cms_sessions SET last_seen_at=NOW() WHERE token_hash=$1", [th]).catch(() => {});
    return user;
  }

  function isOwnerSync(token) {
    const hit = sessions.get(sha(token));
    return Boolean(hit && hit.user.role === "owner");
  }

  const isWrite = (c) => !["GET", "HEAD", "OPTIONS"].includes(c.req.method);

  /* بترجّع promise برقم السطر — الهوك بيحطه على الطلب (c.set)، والمسار اللي
     عايز يكتب «إيه اللي اتغيّر» بيكمّل نفس السطر بـ auditNote بدل سطر تاني. */
  function writeAudit(actor, c, section, note) {
    return pool.query(
      `INSERT INTO cms_audit(actor_id, actor_name, role, method, path, section, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [actor.id || null, actor.name || null, actor.role || null, c.req.method,
       String(c.req.path).slice(0, 300), section, note || null])
      .then((r) => r.rows[0]?.id || null)
      .catch(() => null);
  }
  const stashAudit = (c, p) => { try { c.set("cmsAudit", p); } catch { /* */ } };
  async function auditNote(c, note) {
    try {
      const p = c.get("cmsAudit");
      const id = p ? await p : null;
      if (id) await pool.query("UPDATE cms_audit SET note=$2 WHERE id=$1", [id, String(note || "").slice(0, 500)]);
    } catch { /* السجل مايوقعش الحفظ */ }
  }

  /* هوك requireAdmin: رجوع true = مسموح، Response = رفض، null = مش توكن فريق. */
  async function resolve(c) {
    const token = bearer(c);
    if (!token.startsWith("cms:")) return null;
    const user = await sessionUser(token);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const section = sectionOf(c.req.path);
    const need = isWrite(c) ? E : V;
    const level = (await effectivePerms())[user.role]?.[section] || N;
    const ok = level === E || (level === V && need === V);
    if (!ok) {
      return c.json({ error: "forbidden", section, need,
        message: `دورك (${user.role}) مالوش صلاحية ${need === E ? "تعديل" : "عرض"} في «${section}»` }, 403);
    }
    if (need === E) stashAudit(c, writeAudit(user, c, section));
    return true;
  }

  /* مفتاح الأدمن (أو مالك الفريق) عدّى — نسجّل الكتابات بس. */
  function auditHook(c, auth) {
    if (!isWrite(c)) return;
    const token = bearer(c);
    const hit = auth && auth.cms ? sessions.get(sha(token)) : null;
    const actor = hit ? hit.user : { id: null, name: "المالك (مفتاح الأدمن)", role: "owner" };
    stashAudit(c, writeAudit(actor, c, sectionOf(c.req.path)));
  }

  ctx.setCmsHooks?.({ resolve, audit: auditHook, isOwnerSync });

  /* مين أنا؟ — الشِل بيناديها أول ما يفتح (وده كمان بيسخّن الجلسة). */
  async function whoami(c) {
    const token = bearer(c);
    if (!token) return null;
    const auth = (await requireAdmin(c)) === null;
    const user = await sessionUser(token);
    if (user) return user;
    return auth ? OWNER_KEY : null;
  }

  app.get("/api/cms/me", async (c) => {
    const token = bearer(c);
    let user = token.startsWith("cms:") ? await sessionUser(token) : null;
    if (!user) {
      const denied = await requireAdmin(c);
      if (denied) return denied;
      user = OWNER_KEY;
    }
    const perms = (await effectivePerms())[user.role] || all(N);
    const dailyTarget = Number((((await getSettingsData()) || {}).cms || {}).dailyTarget) || 200;
    return c.json({ ok: true, user, perms, sections: SECTIONS, roles: ROLES, dailyTarget });
  });

  app.post("/api/cms/login", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (loginLimited(ip)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const username = String(b.username || "").trim().toLowerCase();
    const r = await pool.query("SELECT * FROM cms_users WHERE lower(username)=$1", [username]);
    const u = r.rows[0];
    // نفس الرد للمستخدم الغلط والباسورد الغلط — مانقولش أنهي فيهم.
    if (!u || !u.active || !(await verifyPassword(b.password || "", u.pass_salt, u.pass_hash))) {
      return c.json({ ok: false, error: "invalid_credentials" }, 401);
    }
    const token = `cms:${u.id}:${crypto.randomBytes(32).toString("hex")}`;
    const th = sha(token);
    await pool.query(
      `INSERT INTO cms_sessions(token_hash, user_id, expires_at, user_agent)
       VALUES ($1,$2,NOW() + INTERVAL '${SESSION_DAYS} days',$3)`,
      [th, u.id, String(c.req.header("user-agent") || "").slice(0, 200)]);
    await pool.query("UPDATE cms_users SET last_login_at=NOW() WHERE id=$1", [u.id]);
    const user = publicUser(u);
    sessions.set(th, { user, exp: Date.now() + CACHE_MS });
    writeAudit(user, c, "settings", "login");
    return c.json({ ok: true, token, user, mustChange: u.must_change });
  });

  app.post("/api/cms/logout", async (c) => {
    const token = bearer(c);
    if (token.startsWith("cms:")) {
      const th = sha(token);
      sessions.delete(th);
      await pool.query("DELETE FROM cms_sessions WHERE token_hash=$1", [th]).catch(() => {});
    }
    return c.json({ ok: true });
  });

  app.post("/api/cms/password", async (c) => {
    const user = await sessionUser(bearer(c));
    if (!user) return c.json({ ok: false, error: "team_account_only" }, 401);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const next = String(b.next || "");
    if (next.length < 8) return c.json({ ok: false, error: "password_too_short" }, 400);
    const u = (await pool.query("SELECT * FROM cms_users WHERE id=$1", [user.id])).rows[0];
    if (!u || !(await verifyPassword(b.current || "", u.pass_salt, u.pass_hash))) {
      return c.json({ ok: false, error: "wrong_current" }, 401);
    }
    const salt = crypto.randomBytes(16).toString("hex");
    await pool.query("UPDATE cms_users SET pass_salt=$2, pass_hash=$3, must_change=FALSE WHERE id=$1",
      [u.id, salt, await hashPassword(next, salt)]);
    writeAudit(user, c, "settings", "password_changed");
    return c.json({ ok: true });
  });

  /* ── إدارة الفريق (قسم الإعدادات = المالك افتراضياً) ── */
  app.get("/api/cms/users", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      `SELECT u.id, u.username, u.name, u.role, u.active, u.must_change, u.created_at, u.last_login_at,
              (SELECT count(*)::int FROM cms_sessions s WHERE s.user_id=u.id AND s.expires_at > NOW()) AS live_sessions
         FROM cms_users u ORDER BY u.active DESC, u.created_at`)).rows;
    return c.json({ ok: true, users: rows, roles: ROLES });
  });

  app.post("/api/cms/users", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const username = String(b.username || "").trim().toLowerCase();
    const name = String(b.name || "").trim().slice(0, 60);
    const role = ROLE_IDS.includes(b.role) ? b.role : null;
    const password = String(b.password || "");
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return c.json({ ok: false, error: "bad_username" }, 400);
    if (!name || !role) return c.json({ ok: false, error: "name_and_role_required" }, 400);
    if (password.length < 8) return c.json({ ok: false, error: "password_too_short" }, 400);
    const salt = crypto.randomBytes(16).toString("hex");
    try {
      const r = await pool.query(
        `INSERT INTO cms_users(username, name, role, pass_salt, pass_hash, must_change)
         VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id, username, name, role, active, must_change, created_at`,
        [username, name, role, salt, await hashPassword(password, salt)]);
      return c.json({ ok: true, user: r.rows[0] });
    } catch (e) {
      if (String(e.message).includes("duplicate")) return c.json({ ok: false, error: "username_taken" }, 409);
      throw e;
    }
  });

  app.put("/api/cms/users/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const sets = [], vals = [id];
    if (b.name != null) { vals.push(String(b.name).trim().slice(0, 60)); sets.push(`name=$${vals.length}`); }
    if (b.role != null) {
      if (!ROLE_IDS.includes(b.role)) return c.json({ ok: false, error: "bad_role" }, 400);
      vals.push(b.role); sets.push(`role=$${vals.length}`);
    }
    if (b.active != null) { vals.push(b.active === true); sets.push(`active=$${vals.length}`); }
    if (b.password) {
      if (String(b.password).length < 8) return c.json({ ok: false, error: "password_too_short" }, 400);
      const salt = crypto.randomBytes(16).toString("hex");
      vals.push(salt); sets.push(`pass_salt=$${vals.length}`);
      vals.push(await hashPassword(b.password, salt)); sets.push(`pass_hash=$${vals.length}`);
      sets.push("must_change=TRUE");
    }
    if (!sets.length) return c.json({ ok: false, error: "nothing_to_update" }, 400);
    const r = await pool.query(
      `UPDATE cms_users SET ${sets.join(", ")} WHERE id=$1
       RETURNING id, username, name, role, active, must_change`, vals);
    if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
    // دور اتغيّر / حساب اتقفل / باسورد اتغيّر → الجلسات القديمة بتسقط فوراً
    if (b.role != null || b.active === false || b.password) {
      await pool.query("DELETE FROM cms_sessions WHERE user_id=$1", [id]);
      for (const [th, s] of sessions) if (s.user.id === id) sessions.delete(th);
    }
    return c.json({ ok: true, user: r.rows[0] });
  });

  app.delete("/api/cms/users/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    await pool.query("DELETE FROM cms_users WHERE id=$1", [id]);
    for (const [th, s] of sessions) if (s.user.id === id) sessions.delete(th);
    return c.json({ ok: true });
  });

  app.get("/api/cms/roles", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, roles: ROLES, sections: SECTIONS, defaults: DEFAULT_PERMS, perms: await effectivePerms() });
  });

  app.put("/api/cms/roles", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const clean = {};
    for (const role of ROLE_IDS) {
      if (role === "owner") continue;
      clean[role] = {};
      for (const s of SECTION_IDS) {
        const v = b?.perms?.[role]?.[s];
        clean[role][s] = LEVELS.includes(v) ? v : DEFAULT_PERMS[role][s];
      }
    }
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'cms' THEN data ELSE jsonb_set(data,'{cms}','{}'::jsonb,true) END,
         '{cms,perms}', $1::jsonb, true) WHERE id=1`, [jb(clean)]);
    permsCache = { at: 0, perms: null };
    return c.json({ ok: true, perms: await effectivePerms() });
  });

  app.get("/api/cms/audit", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
    const rows = (await pool.query(
      `SELECT id, at, actor_id, actor_name, role, method, path, section, note
         FROM cms_audit ORDER BY at DESC LIMIT $1`, [limit])).rows;
    return c.json({ ok: true, rows });
  });

  /* ═══ المرحلة ٢: المنتجات (طبقة تسويقية) + التجميعات + روابط الحملات ═══

     المنتجات: تاب سينس هو المصدر للأسماء والأسعار. إحنا بنخزّن «اللبس» بس
     (صورة/وصف/شارة/SEO)، والبروكسي بيدمجه في /api/menu — فبيوصل للموقع
     ولكتالوج ميتا (catalog.js بيقرا من هناك) في نفس الوقت.
     الإخفاء بيتكتب في settings.catalog.hiddenIds — نفس المكان اللي المتجر
     بيقرا منه أصلاً، عشان مايبقاش فيه مفتاحين إخفاء بيتخانقوا. */
  const STORE_BASE = () => (process.env.CATALOG_MENU_BASE || process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
  const clip = (v, n) => { const s = String(v ?? "").trim(); return s ? s.slice(0, n) : null; };
  const okImage = (u) => !u || /^https:\/\/[^\s"'<>]+$/i.test(u);
  const who = async (c) => {
    const t = bearer(c);
    if (t.startsWith("cms:")) { const u = await sessionUser(t); if (u) return u.name; }
    return "المالك";
  };

  // المنيو الخام من البروكسي (raw=1 = من غير طبقتنا) — كاش دقيقة
  let rawMenu = { at: 0, items: null };
  async function menuItems() {
    if (rawMenu.items && Date.now() - rawMenu.at < 60_000) return rawMenu.items;
    const r = await fetch(`${STORE_BASE()}/api/menu?branch_id=1&raw=1`, {
      signal: AbortSignal.timeout(15000), headers: { "User-Agent": "freshcuts-cms" } });
    if (!r.ok) throw new Error(`menu HTTP ${r.status}`);
    const pages = (await r.json())?.data?.pages || [];
    // صفحات «الأكثر طلباً/العروض» بتكرر أصناف موجودة في قسمها الحقيقي — نقرا
    // الأقسام الحقيقية الأول عشان الصنف ياخد قسمه الصح.
    const MERCH = /best|الأكثر|offers|العروض/i;
    const rank = (p) => (MERCH.test(`${p.title || ""} ${p.local_title || ""}`) ? 1 : 0);
    const seen = new Set(), items = [];
    for (const p of [...pages].sort((a, b) => rank(a) - rank(b))) {
      const category = p.local_title || p.title || "";
      for (const it of p.items || []) {
        const id = String(it.id);
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({
          id, name: it.name || it.local_name || "", name_en: it.local_name || "", category,
          price: Number(it.retail_price != null ? it.retail_price : it.price) || 0,
          image: it.image || "", description: it.description || "", description_en: it.local_description || "",
        });
      }
    }
    rawMenu = { at: Date.now(), items };
    return items;
  }

  let overlayCache = { at: 0, data: null };
  const bustOverlay = () => { overlayCache = { at: 0, data: null }; };
  async function buildOverlay() {
    if (overlayCache.data && Date.now() - overlayCache.at < 30_000) return overlayCache.data;
    const [p, cl] = await Promise.all([
      pool.query("SELECT product_id, image, description, description_en, badge FROM cms_products"),
      pool.query("SELECT id, name, name_en, product_ids FROM cms_collections WHERE active ORDER BY sort, id"),
    ]);
    const items = {};
    for (const r of p.rows) {
      const o = {};
      if (r.image) o.image = r.image;
      if (r.description) o.description = r.description;
      if (r.description_en) o.description_en = r.description_en;
      if (r.badge) o.badge = r.badge;
      if (Object.keys(o).length) items[r.product_id] = o;
    }
    const collections = cl.rows.map((r) => ({
      id: r.id, name: r.name, name_en: r.name_en || "", product_ids: (r.product_ids || []).map(String) }));
    overlayCache = { at: Date.now(), data: { ok: true, items, collections } };
    return overlayCache.data;
  }

  // عام عن قصد: البروكسي بيقراه من غير توكن ويدمجه في /api/menu.
  app.get("/api/cms/catalog-overlay", async (c) => {
    try { return c.json(await buildOverlay()); }
    catch (e) { return c.json({ ok: false, items: {}, collections: [], error: e.message }); }
  });

  app.get("/api/cms/products", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let items;
    try { items = await menuItems(); }
    catch (e) { return c.json({ ok: false, error: "menu_unavailable", message: e.message, items: [], collections: [] }); }
    const [ov, cl, s] = await Promise.all([
      pool.query("SELECT * FROM cms_products"),
      pool.query("SELECT * FROM cms_collections ORDER BY sort, id"),
      getSettingsData(),
    ]);
    const byId = Object.fromEntries(ov.rows.map((r) => [r.product_id, r]));
    const hidden = new Set(((s?.catalog || {}).hiddenIds || []).map(String));
    return c.json({
      ok: true,
      items: items.map((it) => {
        const o = byId[it.id];
        return {
          ...it, hidden: hidden.has(it.id),
          overlay: o ? {
            image: o.image || "", description: o.description || "", description_en: o.description_en || "",
            badge: o.badge || "", seo_title: o.seo_title || "", seo_description: o.seo_description || "",
          } : null,
        };
      }),
      collections: cl.rows.map((r) => ({ ...r, product_ids: (r.product_ids || []).map(String) })),
    });
  });

  app.put("/api/cms/products/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = String(c.req.param("id")).slice(0, 64);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const f = {
      image: clip(b.image, 500), description: clip(b.description, 600), description_en: clip(b.description_en, 600),
      badge: clip(b.badge, 40), seo_title: clip(b.seo_title, 120), seo_description: clip(b.seo_description, 300),
    };
    if (!okImage(f.image)) return c.json({ ok: false, error: "bad_image_url" }, 400);
    if (Object.values(f).some(Boolean)) {
      await pool.query(
        `INSERT INTO cms_products(product_id, image, description, description_en, badge, seo_title, seo_description, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8)
         ON CONFLICT (product_id) DO UPDATE SET image=$2, description=$3, description_en=$4, badge=$5,
           seo_title=$6, seo_description=$7, updated_at=NOW(), updated_by=$8`,
        [id, f.image, f.description, f.description_en, f.badge, f.seo_title, f.seo_description, await who(c)]);
    } else {
      // كل الحقول فاضية = رجوع كامل لتاب سينس
      await pool.query("DELETE FROM cms_products WHERE product_id=$1", [id]);
    }
    if (typeof b.hidden === "boolean") {
      const s = await getSettingsData();
      const cur = new Set(((s?.catalog || {}).hiddenIds || []).map(String));
      if (b.hidden) cur.add(id); else cur.delete(id);
      await pool.query(
        `UPDATE settings SET data = jsonb_set(
           CASE WHEN data ? 'catalog' THEN data ELSE jsonb_set(data,'{catalog}','{}'::jsonb,true) END,
           '{catalog,hiddenIds}', $1::jsonb, true) WHERE id=1`, [jb([...cur])]);
    }
    bustOverlay();
    return c.json({ ok: true });
  });

  const cleanIds = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).slice(0, 64)).filter(Boolean).slice(0, 60);
  app.post("/api/cms/collections", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const name = clip(b.name, 60);
    if (!name) return c.json({ ok: false, error: "name_required" }, 400);
    const r = await pool.query(
      `INSERT INTO cms_collections(name, name_en, product_ids, sort, active) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, clip(b.name_en, 60), jb(cleanIds(b.product_ids)), Number(b.sort) || 0, b.active !== false]);
    bustOverlay();
    return c.json({ ok: true, collection: r.rows[0] });
  });
  app.put("/api/cms/collections/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const name = clip(b.name, 60);
    if (!name) return c.json({ ok: false, error: "name_required" }, 400);
    const r = await pool.query(
      `UPDATE cms_collections SET name=$2, name_en=$3, product_ids=$4, sort=$5, active=$6, updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [Number(c.req.param("id")), name, clip(b.name_en, 60), jb(cleanIds(b.product_ids)), Number(b.sort) || 0, b.active !== false]);
    if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
    bustOverlay();
    return c.json({ ok: true, collection: r.rows[0] });
  });
  app.delete("/api/cms/collections/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM cms_collections WHERE id=$1", [Number(c.req.param("id"))]);
    bustOverlay();
    return c.json({ ok: true });
  });

  /* ═════════════════════════════════════════════════════════════════════════
     الباقات «باقة بخيارات» — التعريف والتوسيع والتقارير

     الباقة بتتعرّف من اللوحة (من غير نشر)، ولما تتطلب بنوسّعها لمنتجاتها
     الحقيقية بأسعار موزّعة تجمع على سعر الباقة بالظبط — فنقطة البيع بتستقبل
     أصناف عادية، وكل صنف بيستهلك الريسبي بتاعه، ومفيش منتج باقة جديد.

     السعر مصدره **هنا دايماً**: العميل بيبعت الاختيارات بس، والسيرفر بيوسّع
     ويسعّر. أي سعر جاي من المتصفح مابيتصدّقش أبداً.
  ═════════════════════════════════════════════════════════════════════════ */

  /* ── أسعار الكتالوج الحقيقية (قبل الضريبة) ──────────────────────────────
     مهم: باقة ممكن تحتوي صنف **مش على المنيو** — «بيبسي لتر» (١٣٢) و«طبق أرز
     بسمتي» (١٢٣) الاتنين خارج صفحات المنيو عن قصد (اتأكدنا بالمجسّ 2026-09-12).
     فمصدر السعر هو **تفاصيل الصنف** (stores/…/products/{id}) مش المنيو؛
     المنيو بيدّينا الصورة وبس. من غير كده الباقتين كانوا هيتكسروا في صمت. */
  // deps.tsstore: للاختبارات بس (أوفلاين) — الإنتاج بيستعمل tsstore الحقيقي
  const ts = deps.tsstore || tsstore;
  let _menuIdx = { at: 0, byId: null };
  const _prod = new Map(); // productId → {name, priceEx, priceIncl, taxId, variants[]} | null
  async function menuIndex() {
    if (_menuIdx.byId && Date.now() - _menuIdx.at < 300_000) return _menuIdx.byId;
    const menu = await ts.fetchMenu("1");
    const byId = new Map();
    for (const p of menu?.pages || [])
      for (const it of p.items || [])
        if (!byId.has(String(it.id))) byId.set(String(it.id), it);
    _menuIdx = { at: Date.now(), byId };
    return byId;
  }
  async function productDetail(productId) {
    const k = String(productId);
    if (_prod.has(k)) return _prod.get(k);
    let out = null;
    try {
      const r = await ts.callStore(`stores/${ts.STORE()}/products/${k}`, { branchId: "1" });
      const d = r?.data;
      if (d && d.id != null) {
        const raw = d.variant;
        out = {
          id: k, name: d.name || d.local_name || "",
          priceEx: Number(d.price != null ? d.price : d.retail_price) || 0,
          priceIncl: Number(d.retail_price != null ? d.retail_price : d.price) || 0,
          taxId: d.tax_id ?? 1,
          variants: (raw && Array.isArray(raw.options) ? raw.options : []).map((o) => ({
            id: Number(o.id), name: o.name || "",
            priceEx: Number(o.price) || 0, priceIncl: Number(o.retail_price) || 0,
          })),
        };
      }
    } catch (e) { out = null; }
    // الفشل المؤقت مايتخزّنش — تاب سينس ممكن تكون واقعة لحظة واحدة بس
    if (out) _prod.set(k, out);
    return out;
  }
  const productIdsOf = (slots) => {
    const ids = new Set();
    for (const s of slots || []) {
      if (s.type === "choice") for (const ch of s.choices || []) ids.add(ch.product_id);
      else if (s.product_id) ids.add(s.product_id);
    }
    return [...ids];
  };

  /* الدالة اللي bundles.expandBundle بتستخدمها: (productId, variantId) → سعر.
     بترجّع null لو الصنف أو الوزن مش موجود — وساعتها الباقة بتترفض بدل ما
     تتسعّر بسعر مخترع. بنحمّل كل التفاصيل مقدماً عشان الدالة الصافية متزامنة. */
  async function makeResolver(bundle) {
    await Promise.all(productIdsOf(bundle.slots).map((p) => productDetail(p)));
    return (productId, variantId) => {
      const d = _prod.get(String(productId));
      if (!d) return null;
      if (!variantId) return { name: d.name, priceEx: d.priceEx, taxId: d.taxId };
      const opt = d.variants.find((o) => o.id === Number(variantId));
      if (!opt) return null; // الوزن اتشال ⇒ نفشل بصوت عالي
      return { name: d.name, variantName: opt.name, priceEx: opt.priceEx, taxId: d.taxId };
    };
  }

  function bundleRow(r) {
    return {
      id: r.id, slug: r.slug, name: r.name, name_en: r.name_en || "",
      description: r.description || "", image: r.image || "", badge: r.badge || "",
      price: Number(r.price) || 0, slots: r.slots || [],
      order_kinds: bundlesLib.normalizeKinds(r.order_kinds),
      active: r.active, sort: r.sort, updated_at: r.updated_at, updated_by: r.updated_by || "",
      offer_id: r.offer_id || null,
    };
  }

  /* ── الباقة ↔ العرض: حساب واحد لـ«هل تتطلب؟» ─────────────────────────────
     المتجر (/api/shop/bundles) والشيك أوت (expand) واللوحة بينادوا نفس
     الدالة — bundlesLib.bundleAvailability — بحالة العرض من السجل الحي. */
  const offerFor = (b, now = new Date()) => {
    if (!b || !b.offer_id) return null;
    const o = offerById(b.offer_id);
    return o ? publicOffer(o, now) : null;
  };
  const availabilityOf = (b, now = new Date()) => bundlesLib.bundleAvailability(b, offerFor(b, now));

  const r2m = (x) => Math.round(x * 100) / 100;
  const inclOf = (units) => r2m(units * (1 + bundlesLib.VAT_RATE) / bundlesLib.MULTIPLY);
  function menuInclOf(productId, variantId) {
    const d = _prod.get(String(productId));
    if (!d) return null;
    if (!variantId) return d.priceIncl;
    const o = d.variants.find((v) => v.id === Number(variantId));
    return o ? o.priceIncl : null;
  }

  function bundleErrorAr(ex, slots) {
    const slot = (slots || []).find((s) => s.key === ex.slot);
    const sl = slot ? `«${slot.label || slot.key}»` : "";
    const nm = ex.product_id ? `«${_prod.get(String(ex.product_id))?.name || `صنف ${ex.product_id}`}»` : "";
    switch (ex.error) {
      case "product_unavailable":
        return `الصنف ${nm} في خانة ${sl} مش موجود في تاب سينس أو الوزن بتاعه اتشال — الباقة مش هتتسعّر.`;
      case "choice_required": return `لازم اختيار في الخانات: ${(ex.missing || []).join("، ")}`;
      case "choice_not_allowed": return `الاختيار ${nm} مش من ضمن خانة ${sl}.`;
      case "bundle_has_no_slots": return "الباقة مفيهاش خانات.";
      case "distribution_mismatch": return "توزيع السعر مطلعش مضبوط على الهللة — الباقة اتمنعت. بلّغ المطوّر.";
      default: return `الباقة مش قابلة للتسعير (${ex.error}).`;
    }
  }

  /* التسعير الكامل: التركيبة الأساسية (أول اختيار في كل خانة) + كل اختيار في
     كل خانة لوحده. قبل كده التفعيل كان بيجرّب أول اختيار بس — يعني صنف
     اتشال من تاني خانة كان هيعدّي التفعيل ويفشل عند العميل. */
  async function priceCheck(b) {
    const probe = { slug: b.slug || "probe", name: b.name || "", price: b.price, slots: b.slots || [] };
    if (!(Number(probe.price) > 0)) return { ok: false, error: "price_required", message: "سعر الباقة مطلوب." };
    if (!probe.slots.length) return { ok: false, error: "bundle_has_no_slots", message: "الباقة مفيهاش خانات." };
    let resolve;
    try { resolve = await makeResolver(probe); }
    catch (e) { return { ok: false, error: "catalog_unavailable", message: "تعذر قراءة أسعار تاب سينس دلوقتي — جرّب تاني بعد دقيقة." }; }
    const pickOf = (ch) => ({ product_id: ch.product_id, variant_option_id: ch.variant_option_id });
    const base = {};
    for (const s of probe.slots) if (s.type === "choice") base[s.key] = pickOf(s.choices[0]);
    const fmt = (ex) => ({
      lines: ex.lines.map((l) => ({
        slot: l.bundle_slot, product_id: String(l.product_id), name: l.name,
        variant_name: l.variant_name || null, quantity: l.quantity,
        line_incl: inclOf(l.unit_amount * l.quantity),
        menu_incl: menuInclOf(l.product_id, l.variant_option_id),
      })),
      total_incl: inclOf(ex.totalEx),
    });
    const ex0 = bundlesLib.expandBundle(probe, base, 1, resolve);
    if (!ex0.ok) return { ok: false, error: ex0.error, detail: ex0, message: bundleErrorAr(ex0, probe.slots) };
    const choiceShares = {};
    const problems = [];
    for (const s of probe.slots) {
      if (s.type !== "choice") continue;
      choiceShares[s.key] = s.choices.map((ch) => {
        const ex = bundlesLib.expandBundle(probe, { ...base, [s.key]: pickOf(ch) }, 1, resolve);
        const row = { product_id: ch.product_id, variant_option_id: ch.variant_option_id || null,
          name: _prod.get(String(ch.product_id))?.name || `صنف ${ch.product_id}`,
          variant_name: ch.variant_option_id
            ? (_prod.get(String(ch.product_id))?.variants.find((v) => v.id === Number(ch.variant_option_id))?.name || null) : null,
          menu_incl: menuInclOf(ch.product_id, ch.variant_option_id) };
        if (!ex.ok) {
          const message = bundleErrorAr(ex, probe.slots);
          problems.push(message);
          return { ...row, ok: false, message };
        }
        const mine = ex.lines.filter((l) => l.bundle_slot === s.key);
        return { ...row, ok: true, share_incl: inclOf(mine.reduce((a, l) => a + l.unit_amount * l.quantity, 0)) };
      });
    }
    if (problems.length) {
      return { ok: false, error: "product_unavailable", message: problems[0], problems, base: fmt(ex0), choiceShares };
    }
    return { ok: true, base: fmt(ex0), choiceShares };
  }

  /* الباقة المربوطة بعرض لازم يبقى سعرها = سعر العرض: السعر المعلن في
     الكتالوج والإعلانات والشريط جاي من العرض، ومايصحّش العميل يشوف ٩٦ في
     الإعلان ويدفع رقم تاني. */
  function linkCheck(f) {
    if (!f.offer_id) return null;
    const o = offerById(f.offer_id);
    if (!o) return { ok: false, error: "unknown_offer", message: `العرض «${f.offer_id}» مش موجود في سجل العروض.` };
    if (Number(o.price) !== Number(f.price)) {
      return { ok: false, error: "price_mismatch_offer",
        message: `الباقة مربوطة بعرض «${o.title}» سعره ${o.price} ر.س — سعر الباقة (${f.price}) لازم يبقى نفس الرقم، لأن ده السعر المعلن في الكتالوج والإعلانات.` };
    }
    return null;
  }
  async function getBundle(idOrSlug) {
    const s = String(idOrSlug);
    const r = await pool.query(
      /^\d+$/.test(s) ? "SELECT * FROM cms_bundles WHERE id=$1" : "SELECT * FROM cms_bundles WHERE slug=$1",
      [/^\d+$/.test(s) ? Number(s) : s]);
    return r.rows[0] ? bundleRow(r.rows[0]) : null;
  }

  /* ── لوحة التحكم: تعريف وتعديل الباقات من غير نشر ─────────────────────── */
  app.get("/api/cms/bundles", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query("SELECT * FROM cms_bundles ORDER BY sort, id");
    const list = r.rows.map(bundleRow);
    // نرفق أسماء المنتجات عشان اللوحة تعرض كلام مفهوم من غير نداء تاني
    let names = {};
    try {
      const ids = [...new Set(list.flatMap((b) => productIdsOf(b.slots)))];
      await Promise.all(ids.map((p) => productDetail(p)));
      for (const id of ids) { const d = _prod.get(String(id)); if (d) names[String(id)] = d.name; }
    } catch (e) { names = {}; }
    // معاينة التسعير لكل باقة (كل اختيار في كل خانة) + هل تتطلب دلوقتي ولي لأ
    const now = new Date();
    const preview = {}, availability = {};
    for (const b of list) {
      try { preview[b.slug] = await priceCheck(b); }
      catch (e) { preview[b.slug] = { ok: false, error: "preview_failed", message: `تعذر حساب المعاينة: ${e.message}` }; }
      availability[b.slug] = availabilityOf(b, now);
    }
    const offers = OFFERS.map((o) => {
      const p = publicOffer(o, now);
      return { id: p.id, title: p.title, price: p.price, status: p.status, statusLabel: p.statusLabel,
        from: p.from, until: p.until, untilProvisional: p.untilProvisional, channels: p.channels, dineInOnly: p.dineInOnly };
    });
    return c.json({ ok: true, bundles: list, productNames: names, preview, availability, offers });
  });

  /* معاينة مسودة قبل الحفظ — GET عشان المعاينة مش تعديل ومايتسجّلش في السجل.
     ?draft=<JSON {price, slots, offer_id}> */
  app.get("/api/cms/bundles/preview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let d = {};
    try { d = JSON.parse(c.req.query("draft") || "{}"); }
    catch { return c.json({ ok: false, error: "bad_draft", message: "بيانات المعاينة مش مفهومة." }); }
    const f = bundleBody(d || {});
    const warnings = [];
    const link = linkCheck(f);
    if (link) warnings.push(link.message);
    try {
      return c.json({ ...(await priceCheck({ ...f, slug: "preview" })), warnings,
        availability: availabilityOf({ ...f, active: true }) });
    } catch (e) {
      return c.json({ ok: false, error: "preview_failed", message: e.message, warnings });
    }
  });

  // كتالوج مبسّط للوحة: المنتجات + أوزانها، عشان بناء الخانات بالضغط
  app.get("/api/cms/bundles/catalog", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const byId = await menuIndex();
      const ids = [...byId.keys()];
      // بنجيب تفاصيل كل صنف (فيها الأوزان والسعر الصافي) على دفعات صغيرة
      for (let i = 0; i < ids.length; i += 8) await Promise.all(ids.slice(i, i + 8).map((p) => productDetail(p)));
      const items = ids.map((id) => {
        const d = _prod.get(id); if (!d) return null;
        return { id, name: d.name, price_incl: d.priceIncl, price_ex: d.priceEx,
          image: (byId.get(id) || {}).image || "",
          category: "", variants: d.variants.map((o) => ({ id: o.id, name: o.name, price_incl: o.priceIncl })) };
      }).filter(Boolean);
      // الأصناف اللي برّه المنيو (زي بيبسي لتر ١٣٢) بتتضاف لو اتسألنا عنها
      const extra = String(c.req.query("extra") || "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
      for (const id of extra) {
        if (items.some((x) => x.id === id)) continue;
        const d = await productDetail(id);
        if (d) items.push({ id, name: d.name, price_incl: d.priceIncl, price_ex: d.priceEx, image: "",
          category: "خارج المنيو", variants: d.variants.map((o) => ({ id: o.id, name: o.name, price_incl: o.priceIncl })) });
      }
      return c.json({ ok: true, items });
    } catch (e) {
      return c.json({ ok: false, error: "catalog_unavailable", message: e.message, items: [] });
    }
  });

  const slugOkB = (s) => /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(s);
  function bundleBody(b) {
    return {
      name: clip(b.name, 80), name_en: clip(b.name_en, 80), description: clip(b.description, 600),
      image: clip(b.image, 500), badge: clip(b.badge, 40),
      price: Math.max(0, Math.round((Number(b.price) || 0) * 100) / 100),
      slots: bundlesLib.normalizeSlots(b.slots),
      order_kinds: bundlesLib.normalizeKinds(b.order_kinds),
      active: b.active === true, sort: Number(b.sort) || 0,
      offer_id: clip(b.offer_id, 40),
    };
  }

  const BUNDLE_MSG = {
    bad_slug: "المعرّف (slug) لازم حروف إنجليزي صغيرة وأرقام وشرطة بس.",
    name_required: "اسم الباقة مطلوب.",
    bad_image_url: "رابط الصورة لازم يبدأ بـ https://",
    price_required: "سعر الباقة مطلوب.",
    slots_required: "الباقة محتاجة خانة واحدة على الأقل (وكل خانة اختيار محتاجة منتج واحد على الأقل).",
    slug_taken: "المعرّف ده مستعمل لباقة تانية.",
  };
  const bundleFail = (c, error, status = 400, extra = {}) =>
    c.json({ ok: false, error, message: BUNDLE_MSG[error] || error, ...extra }, status);

  // تفعيل باقة لازم تكون قابلة للتسعير بكل اختياراتها — مانسمحش بباقة حيّة بتفشل عند الطلب
  async function activationBlock(f) {
    const pc = await priceCheck(f);
    if (pc.ok) return null;
    return { ok: false, error: "not_priceable", message: `مينفعش تتفعّل: ${pc.message}`, detail: pc };
  }

  function bundleChangeNote(before, after) {
    const parts = [];
    const cmp = (k, label, fmt = (v) => v) => {
      if (JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null)) {
        parts.push(`${label} ${fmt(before?.[k] ?? "—")}→${fmt(after?.[k] ?? "—")}`);
      }
    };
    cmp("name", "الاسم"); cmp("price", "السعر"); cmp("active", "مفعّلة");
    cmp("offer_id", "العرض"); cmp("image", "الصورة", (v) => (v ? "صورة" : "—"));
    cmp("description", "الوصف", () => "…");
    const shape = (slots) => (slots || []).map((s) => `${s.key}:${s.type === "choice" ? (s.choices || []).length + "اختيار" : s.product_id}`).join(" ");
    if (shape(before?.slots) !== shape(after?.slots)) parts.push(`الخانات ${shape(before?.slots) || "—"}→${shape(after?.slots)}`);
    return parts.length ? parts.join("، ") : "حفظ من غير تغيير";
  }

  app.post("/api/cms/bundles", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const slug = String(b.slug || "").trim().toLowerCase();
    if (!slugOkB(slug)) return bundleFail(c, "bad_slug");
    const f = bundleBody(b);
    if (!f.name) return bundleFail(c, "name_required");
    if (!okImage(f.image)) return bundleFail(c, "bad_image_url");
    if (!(f.price > 0)) return bundleFail(c, "price_required");
    if (!f.slots.length) return bundleFail(c, "slots_required");
    const link = linkCheck(f);
    if (link) return c.json(link, 400);
    if (f.active) { const blk = await activationBlock({ ...f, slug }); if (blk) return c.json(blk, 422); }
    try {
      const r = await pool.query(
        `INSERT INTO cms_bundles(slug,name,name_en,description,image,badge,price,slots,order_kinds,active,sort,updated_by,offer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [slug, f.name, f.name_en, f.description, f.image, f.badge, f.price,
         jb(f.slots), jb(f.order_kinds), f.active, f.sort, await who(c), f.offer_id]);
      const bundle = bundleRow(r.rows[0]);
      auditNote(c, `باقة جديدة ${slug}: ${bundleChangeNote(null, bundle)}`);
      return c.json({ ok: true, bundle, availability: availabilityOf(bundle) });
    } catch (e) {
      if (e.code === "23505") return bundleFail(c, "slug_taken", 409);
      throw e;
    }
  });

  app.put("/api/cms/bundles/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const before = await getBundle(Number(c.req.param("id")));
    if (!before) return c.json({ ok: false, error: "not_found", message: "الباقة مش موجودة." }, 404);
    const f = bundleBody(b);
    if (!f.name) return bundleFail(c, "name_required");
    if (!okImage(f.image)) return bundleFail(c, "bad_image_url");
    if (!(f.price > 0)) return bundleFail(c, "price_required");
    if (!f.slots.length) return bundleFail(c, "slots_required");
    const link = linkCheck(f);
    if (link) return c.json(link, 400);
    if (f.active) { const blk = await activationBlock({ ...f, slug: before.slug }); if (blk) return c.json(blk, 422); }
    const r = await pool.query(
      `UPDATE cms_bundles SET name=$2,name_en=$3,description=$4,image=$5,badge=$6,price=$7,
         slots=$8,order_kinds=$9,active=$10,sort=$11,updated_at=NOW(),updated_by=$12,offer_id=$13
       WHERE id=$1 RETURNING *`,
      [before.id, f.name, f.name_en, f.description, f.image, f.badge, f.price,
       jb(f.slots), jb(f.order_kinds), f.active, f.sort, await who(c), f.offer_id]);
    if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
    const bundle = bundleRow(r.rows[0]);
    auditNote(c, `باقة ${bundle.slug}: ${bundleChangeNote(before, bundle)}`);
    const availability = availabilityOf(bundle);
    const warnings = bundle.active && !availability.orderable
      ? [`الباقة اتفعّلت بس مش هتظهر للعميل دلوقتي: ${availability.reasons.map((x) => x.message).join("، ")}`] : [];
    return c.json({ ok: true, bundle, availability, warnings });
  });

  app.delete("/api/cms/bundles/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const before = await getBundle(Number(c.req.param("id")));
    await pool.query("DELETE FROM cms_bundles WHERE id=$1", [Number(c.req.param("id"))]);
    if (before) auditNote(c, `حذف باقة ${before.slug} (${before.name})`);
    return c.json({ ok: true });
  });

  /* ═══ العروض — التحكم من اللوحة (السجل الحي في offers.js) ═══════════════
     الحالة والتواريخ والاسم والنص والقنوات. السعر، اسم الكتالوج، ومنع
     «التوفير» ومنع تطبيقات التوصيل مقفولين في الكود ومايتعدّلوش من هنا. */
  async function offersPayload(now = new Date()) {
    let meta = new Map();
    try {
      meta = new Map((await pool.query("SELECT id, updated_at, updated_by FROM offer_registry")).rows.map((r) => [r.id, r]));
    } catch { /* الجدول لسه ماتعملش — الشاشة بتقول source=seed */ }
    const linked = (await pool.query("SELECT * FROM cms_bundles WHERE offer_id IS NOT NULL ORDER BY sort, id")).rows.map(bundleRow);
    return OFFERS.map((o) => {
      const p = publicOffer(o, now);
      const m = meta.get(o.id);
      return {
        ...p,
        locked: { price: o.price, catalogTitle: o.catalogTitle, savingsClaim: false, deliveryApps: false },
        updatedAt: m?.updated_at || null,
        updatedBy: m?.updated_by || null,
        bundles: linked.filter((b) => b.offer_id === o.id).map((b) => ({
          id: b.id, slug: b.slug, name: b.name, price: b.price, active: b.active,
          availability: availabilityOf(b, now),
        })),
      };
    });
  }

  app.get("/api/cms/offers", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const now = new Date();
    return c.json({ ok: true, today: riyadhDay(now), ...offersSource(), editable: EDITABLE_OFFER_FIELDS,
      offers: await offersPayload(now) });
  });

  app.put("/api/cms/offers/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const id = c.req.param("id");
    if (!offerById(id)) return c.json({ ok: false, error: "unknown_offer", message: "عرض غير معروف." }, 404);
    // مانحفظش فوق نسخة البذرة — لو الجدول ماتقراش، الحفظ ممكن يمسح تعديل سابق
    if (offersSource().source !== "db") {
      return c.json({ ok: false, error: "registry_not_loaded",
        message: "سجل العروض لسه ماتحمّلش من الداتابيز — الحفظ اتمنع عشان مانكتبش فوق تعديل سابق. جرّب بعد دقيقة." }, 409);
    }
    const r = await saveOffer(pool, id, b, await who(c));
    if (!r.ok) return c.json(r, 400);
    const fmt = (v) => (v == null ? "—" : typeof v === "object"
      ? Object.entries(v).filter(([, x]) => x === true).map(([k]) => k).join("+") || "—" : String(v));
    auditNote(c, r.changed.length
      ? `عرض ${id}: ${r.changed.map((k) => `${k} ${fmt(r.before[k])}→${fmt(r.after[k])}`).join("، ")}`
      : `عرض ${id}: حفظ من غير تغيير`);
    const now = new Date();
    const offer = (await offersPayload(now)).find((o) => o.id === id);
    const warnings = [];
    if (offer.expired) warnings.push(`تاريخ النهاية (${offer.until}) عدّى — العرض وقف في كل مكان.`);
    return c.json({ ok: true, offer, changed: r.changed, warnings });
  });

  /* ── تلبيس الباقة: أسماء وصور وأسعار الأصناف الحقيقية ─────────────────────
     دالة واحدة لـ/api/shop/bundles و/api/shop/offers-page — مفيش نسخة تانية.
     بترجّع null لو أي خانة اتكسرت (صنف أو وزن اتشال): الباقة المكسورة
     مابتتعرضش أبداً — أحسن من طلب بيفشل. */
  async function dressSlots(b, menu) {
    // تفاصيل كل صنف (سعر + أوزان) — بتشتغل كمان للأصناف اللي برّه المنيو
    await Promise.all(productIdsOf(b.slots).map((p) => productDetail(p)));
    const dress = (productId, variantId, label) => {
      const d = _prod.get(String(productId));
      if (!d) return null; // صنف مش موجود ⇒ مايتعرضش
      const opt = variantId && d.variants.find((o) => o.id === Number(variantId));
      if (variantId && !opt) return null;
      return {
        product_id: String(productId), variant_option_id: variantId || null,
        name: label || d.name, variant_name: opt ? opt.name : null,
        image: (menu.get(String(productId)) || {}).image || "",
        price_incl: opt ? opt.priceIncl : d.priceIncl,
      };
    };
    const slots = [];
    for (const s of b.slots) {
      if (s.type === "choice") {
        const choices = s.choices.map((ch) => dress(ch.product_id, ch.variant_option_id, ch.label)).filter(Boolean);
        if (!choices.length) return null;
        slots.push({ key: s.key, label: s.label, type: "choice", quantity: s.quantity, choices });
      } else {
        const item = dress(s.product_id, s.variant_option_id, "");
        if (!item) return null;
        slots.push({ key: s.key, label: s.label, type: "fixed", quantity: s.quantity, item });
      }
    }
    return slots;
  }

  /* ── عام: المتجر بيقرا الباقات المفعّلة بس ────────────────────────────── */
  app.get("/api/shop/bundles", async (c) => {
    const kind = String(c.req.query("option") || "").trim();
    try {
      const r = await pool.query("SELECT * FROM cms_bundles WHERE active ORDER BY sort, id");
      const out = [];
      const now = new Date();
      // العرض المربوط موقوف/مابدأش/انتهى ⇒ الباقة مابتتعرضش. القنوات من العرض.
      // الفلترة قبل قراءة المنيو: مفيش باقة تتطلب ⇒ مفيش نداء لتاب سينس أصلاً.
      const live = r.rows.map(bundleRow).map((b) => ({ b, av: availabilityOf(b, now) })).filter((x) => x.av.orderable);
      const menu = live.length ? await menuIndex() : new Map();
      for (const { b, av } of live) {
        b.order_kinds = av.kinds;
        if (kind && !b.order_kinds.includes(kind)) continue;
        const slots = await dressSlots(b, menu);
        if (!slots) continue; // باقة مكسورة مابتتعرضش أبداً — أحسن من طلب بيفشل
        // offer_id (مسار ٠١): المتجر بيربط الباقة بعرضها من هنا بدل جدول مكتوب في app.js
        out.push({ slug: b.slug, name: b.name, name_en: b.name_en, description: b.description,
          image: b.image, badge: b.badge, price: b.price, order_kinds: b.order_kinds, offer_id: b.offer_id || null, slots });
      }
      return c.json({ ok: true, bundles: out });
    } catch (e) {
      // ٢٠٠ مقصود: كلاودفلير بيبلع الـ5xx، والمتجر لازم يفضل شغّال من غير باقات
      return c.json({ ok: false, error: "bundles_unavailable", message: e.message, bundles: [] });
    }
  });

  /* ═══ صفحة العروض لمحركات البحث — freshcuts.sa/offers (مسار ٠١) ══════════

     المتجر (seo.py) بيرندر /offers و/offers/<slug> من الرد ده بس. القواعد:
       • العروض الـlive بس (بيوم شغل الرياض + ٤ الفجر، من offerState).
       • order_kinds = delivery/pickup بس — مفيش «صالة» أونلاين.
       • مفيش price_incl ولا compareAt ولا note القديم («داخل الصالة فقط»):
         سعر المكوّن جنب ٩٦ بيتقري «قيمته كذا»، يعني ادعاء توفير غير مباشر.
       • onlineOnly = !channels.dineIn (البوكس). عرض أونلاين بس باقته مش قابلة
         للطلب بيتشال من الرد — مالوش مكان تاني يتطلب منه.
       • دايماً HTTP 200 (كلاودفلير بيبلع الـ5xx) و ok:false عند أي خطأ.
     الـslug بيتقفل أول ما العرض يظهر live (published_at). */
  const PUBLIC_KINDS = ["delivery", "pickup"];
  const isoOf = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const OFFERS_SITE = () => (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
  async function offerPageRows() {
    return new Map((await pool.query("SELECT * FROM offer_pages")).rows.map((r) => [String(r.offer_id), r]));
  }
  // ختم أول ظهور live — fire-and-forget: فشل الختم مايوقعش الصفحة العامة
  function stampPublished(offerId) {
    try {
      Promise.resolve(pool.query(
        "UPDATE offer_pages SET published_at = NOW() WHERE offer_id = $1 AND published_at IS NULL", [offerId]))
        .catch(() => {});
    } catch { /* */ }
  }
  const publicPick = (x) => ({ product_id: x.product_id, name: x.name, variant_name: x.variant_name, image: x.image });
  const publicSlot = (s) => (s.type === "choice"
    ? { key: s.key, label: s.label, type: "choice", quantity: s.quantity, choices: s.choices.map(publicPick) }
    : { key: s.key, label: s.label, type: "fixed", quantity: s.quantity, item: publicPick(s.item) });
  const pageSeo = (p) => ({
    h1: p.h1 || null, h1_en: p.h1_en || null, seo_title: p.seo_title || null, seo_title_en: p.seo_title_en || null,
    meta: p.meta || null, meta_en: p.meta_en || null,
    faq: Array.isArray(p.faq) ? p.faq : [], indexable: p.indexable !== false,
  });
  const channelsOf = (p) => {
    const ch = p.channels || { dineIn: true, takeaway: !p.dineInOnly, delivery: !p.dineInOnly };
    return { dineIn: ch.dineIn === true, takeaway: ch.takeaway === true, delivery: ch.delivery === true, deliveryApps: false };
  };

  async function offersPagePayload(now = new Date()) {
    const pages = await offerPageRows();
    const regAt = new Map((await pool.query("SELECT id, updated_at FROM offer_registry")).rows
      .map((r) => [String(r.id), r.updated_at]));
    const linked = (await pool.query("SELECT * FROM cms_bundles WHERE offer_id IS NOT NULL ORDER BY sort, id")).rows.map(bundleRow);
    let menu = null;
    let lastmod = 0;
    const out = [];
    for (const o of OFFERS) {
      const page = pages.get(o.id);
      if (!page || !page.slug) continue; // عرض من غير صفحة = مالوش رابط
      const p = publicOffer(o, now);
      if (p.status !== "live") continue;
      const channels = channelsOf(p);
      const onlineOnly = !channels.dineIn;
      let offerMod = 0;
      const bump = (v) => { const t = Date.parse(isoOf(v) || ""); if (t > offerMod) offerMod = t; };
      let bundle = null;
      for (const b of linked.filter((x) => x.offer_id === o.id)) {
        const av = availabilityOf(b, now);
        const kinds = av.kinds.filter((k) => PUBLIC_KINDS.includes(k));
        if (!av.orderable || !kinds.length) continue;
        // المنيو للصور بس — لو تاب سينس واقعة الصفحة تفضل شغّالة من غير صور
        if (!menu) menu = await menuIndex().catch(() => new Map());
        const slots = await dressSlots(b, menu);
        if (!slots) continue;
        bundle = { slug: b.slug, name: b.name, name_en: b.name_en, description: b.description, image: b.image,
          order_kinds: kinds, slots: slots.map(publicSlot) };
        bump(b.updated_at);
        break;
      }
      const orderableOnline = Boolean(bundle);
      if (onlineOnly && !orderableOnline) continue;
      if (!page.published_at) stampPublished(o.id);
      bump(regAt.get(o.id));
      bump(page.updated_at);
      if (offerMod > lastmod) lastmod = offerMod;
      out.push({
        id: o.id, slug: page.slug, sort: Number(page.sort) || 0, status: p.status,
        title: p.title, desc: p.desc || "", title_en: page.title_en || "", desc_en: page.desc_en || "",
        components: p.components || [], excludes: p.excludes || [],
        price: p.price, currency: p.currency || "SAR", priceRole: p.priceRole || "price",
        from: p.from || null, until: p.until, untilProvisional: !!p.untilProvisional, untilText: p.untilText,
        channels, onlineOnly, orderableOnline, bundle,
        seo: pageSeo(page),
        images: { web: page.image_web || null, wide: page.image_wide || null, og: page.image_og || null },
        updated_at: offerMod ? new Date(offerMod).toISOString() : null,
      });
    }
    out.sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { ok: true, today: bizDay(now), lastmod: lastmod ? new Date(lastmod).toISOString() : null, offers: out };
  }

  app.get("/api/shop/offers-page", async (c) => {
    try {
      const body = await offersPagePayload(new Date());
      c.header("Cache-Control", "public, max-age=60");
      return c.json(body);
    } catch (e) {
      console.error("[cms] offers-page failed:", e.message);
      c.header("Cache-Control", "no-store");
      return c.json({ ok: false, error: "offers_page_unavailable", offers: [] });
    }
  });

  /* اللوحة: صفحة البحث لكل عرض (حتى اللي مالوش صف لسه). الـslug مقفول لو
     العرض اتنشر مرة (published_at) أو شغّال دلوقتي. */
  const slugLockedOf = (page, p) => Boolean(page && (page.published_at || p.status === "live"));
  function offerPageView(o, page, now) {
    const p = publicOffer(o, now);
    return {
      offer_id: o.id, title: p.title, status: p.status, statusLabel: p.statusLabel,
      from: p.from || null, until: p.until, untilProvisional: !!p.untilProvisional, price: p.price,
      onlineOnly: !channelsOf(p).dineIn,
      page: page ? {
        slug: page.slug, title_en: page.title_en || null, desc_en: page.desc_en || null, ...pageSeo(page),
        image_web: page.image_web || null, image_wide: page.image_wide || null, image_og: page.image_og || null,
        sort: Number(page.sort) || 0, updated_at: isoOf(page.updated_at), updated_by: page.updated_by || null,
      } : null,
      published_at: isoOf(page?.published_at),
      slugLocked: slugLockedOf(page, p),
      url: page ? `${OFFERS_SITE()}/offers/${page.slug}` : null,
    };
  }

  app.get("/api/cms/offer-pages", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const now = new Date();
    try {
      const pages = await offerPageRows();
      return c.json({ ok: true, today: bizDay(now), site: OFFERS_SITE(), limits: OFFER_PAGE_LIMITS,
        pages: OFFERS.map((o) => offerPageView(o, pages.get(o.id) || null, now)) });
    } catch (e) {
      // كلاودفلير بيبلع الـ5xx — اللوحة تشوف رسالة بدل صفحة خطأ
      console.error("[cms] offer-pages list failed:", e.message);
      return c.json({ ok: false, error: "offer_pages_unavailable", message: "صفحات البحث مش متاحة دلوقتي.", pages: [] });
    }
  });

  app.put("/api/cms/offer-pages/:offerId", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const id = c.req.param("offerId");
    const o = offerById(id);
    if (!o) return c.json({ ok: false, error: "unknown_offer", message: "عرض غير معروف." }, 404);
    const now = new Date();
    const cur = (await pool.query("SELECT * FROM offer_pages WHERE offer_id=$1", [id])).rows[0] || null;
    const locked = slugLockedOf(cur, publicOffer(o, now));
    const v = validateOfferPagePatch(cur, b, { price: o.price, slugLocked: locked });
    if (!v.ok) return c.json({ ok: false, error: v.error, message: v.message }, v.status);
    const r = v.row;
    let saved;
    try {
      /* الـWHERE في الـUPDATE حارس تاني ضد السباق: لو الصفحة اتنشرت بين
         القراءة والحفظ، تغيير الـslug مايعدّيش. */
      const res = await pool.query(
        `INSERT INTO offer_pages (offer_id, slug, h1, h1_en, seo_title, seo_title_en, meta, meta_en, title_en, desc_en,
                                 image_web, image_wide, image_og, faq, sort, indexable, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,NOW(),$17)
         ON CONFLICT (offer_id) DO UPDATE SET
           slug=EXCLUDED.slug, h1=EXCLUDED.h1, h1_en=EXCLUDED.h1_en, seo_title=EXCLUDED.seo_title,
           seo_title_en=EXCLUDED.seo_title_en, meta=EXCLUDED.meta, meta_en=EXCLUDED.meta_en,
           title_en=EXCLUDED.title_en, desc_en=EXCLUDED.desc_en, image_web=EXCLUDED.image_web,
           image_wide=EXCLUDED.image_wide, image_og=EXCLUDED.image_og, faq=EXCLUDED.faq, sort=EXCLUDED.sort,
           indexable=EXCLUDED.indexable, updated_at=NOW(), updated_by=EXCLUDED.updated_by
         WHERE offer_pages.published_at IS NULL OR offer_pages.slug = EXCLUDED.slug
         RETURNING *`,
        [id, r.slug, r.h1, r.h1_en, r.seo_title, r.seo_title_en, r.meta, r.meta_en, r.title_en, r.desc_en,
         r.image_web, r.image_wide, r.image_og, jb(r.faq), r.sort, r.indexable, await who(c)]);
      saved = res.rows[0];
    } catch (e) {
      if (e.code === "23505" || /duplicate|unique/i.test(String(e.message))) {
        return c.json({ ok: false, error: "slug_taken", message: "الرابط ده مستخدم لعرض تاني." }, 409);
      }
      if (e.code === "23514") return c.json({ ok: false, error: "bad_slug", message: "الرابط مش صحيح." }, 400);
      throw e;
    }
    if (!saved) {
      return c.json({ ok: false, error: "slug_locked", message: "الرابط اتنشر خلاص — تغييره بيكسر الروابط القديمة." }, 409);
    }
    auditNote(c, v.changed.length
      ? `صفحة بحث ${id}: ${v.changed.map((k) => (k === "slug" && cur?.slug ? `slug ${cur.slug}→${r.slug}` : k)).join("، ")}`
      : `صفحة بحث ${id}: حفظ من غير تغيير`);
    return c.json({ ok: true, page: offerPageView(o, saved, now), changed: v.changed, warnings: v.warnings });
  });

  /* التوسيع — المصدر الوحيد للحقيقة. المتجر بينده عليه للمعاينة، والـcheckout
     بينده على **نفس** الدالة، فاللي العميل شافه هو اللي اتحسب بالظبط. */
  async function expand(slug, choices, quantity, orderKind) {
    const b = await getBundle(slug);
    if (!b) return { ok: false, error: "bundle_not_found" };
    // نفس حساب المتجر واللوحة: الباقة مسودة، أو عرضها موقوف/مابدأش/انتهى ⇒ مرفوضة
    const av = availabilityOf(b);
    if (!av.orderable) {
      const draft = av.reasons.every((x) => x.code === "bundle_draft");
      return { ok: false, error: draft ? "bundle_inactive" : "offer_not_active",
        reasons: av.reasons, message: av.reasons.map((x) => x.message).join("، ") };
    }
    if (orderKind && !av.kinds.includes(orderKind)) return { ok: false, error: "bundle_not_available_for_option", kinds: av.kinds };
    const resolve = await makeResolver(b);
    return bundlesLib.expandBundle(b, choices, quantity, resolve);
  }

  app.post("/api/shop/bundles/expand", async (c) => {
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    try {
      const r = await expand(String(b.slug || ""), b.choices || {}, b.quantity || 1, b.option || null);
      if (!r.ok) return c.json(r, 200); // ٢٠٠ عشان الخطأ الحقيقي يوصل للمتصفح
      /* السطور بترجع بوحدة الفلوس اللي المتصفح طلبها: السلة بتجمعها مع حساب
         تاب سينس في نفس الإجمالي، فلو الوحدتين اختلفوا سعر الباقة يبان غلط
         ×١٠٠٠. نسخة قديمة مكاشّة مابتبعتش الحقل ⇒ النانو القديم. (الدفع
         بيعيد التوسيع على السيرفر، فالمحصّل صح في كل الحالات.) */
      const mfOut = Number(b.multiply_factor) > 0 ? Number(b.multiply_factor) : LEGACY_MULTIPLY;
      const lines = mfOut === bundlesLib.MULTIPLY ? r.lines
        : r.lines.map((l) => ({ ...l, unit_amount: Math.round(l.unit_amount * mfOut / bundlesLib.MULTIPLY) }));
      return c.json({ ok: true, lines, picks: r.picks, quantity: r.quantity, multiply_factor: mfOut,
        total_incl: Math.round(r.totalEx * 1.15 / bundlesLib.MULTIPLY * 100) / 100 });
    } catch (e) { return c.json({ ok: false, error: "expand_failed", message: e.message }); }
  });

  /* ── التقارير: كام باقة اتباعت، وأنهي اختيار العملاء بيحبوه ───────────────
     بتتحسب من shop_orders مباشرة (مصدر الحقيقة) — مفيش جدول تاني ممكن
     يختلف معاه. بنعدّ سطور الباقة الفريدة (bundle_line) مش عدد المكوّنات. */
  app.get("/api/cms/bundles/report", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(365, Math.max(1, Number(c.req.query("days")) || 30));
    const PAID = "('paid','pos_created','accepted','courier_requested','courier_assigned','on_the_way','delivered')";
    const sold = await pool.query(
      `SELECT it->>'bundle' AS slug,
              max(it->>'bundle_name') AS name,
              count(DISTINCT it->>'bundle_line')::int AS sold,
              count(DISTINCT o.order_no)::int AS orders
         FROM shop_orders o, LATERAL jsonb_array_elements(o.items) it
        WHERE o.created_at > NOW() - ($1 || ' days')::interval
          AND o.status IN ${PAID} AND it->>'bundle' IS NOT NULL
        GROUP BY 1 ORDER BY sold DESC`, [String(days)]);
    const picks = await pool.query(
      `SELECT it->>'bundle' AS slug, it->>'bundle_slot' AS slot,
              it->>'product_id' AS product_id,
              max(it->>'name') AS name, max(it->>'variant_name') AS variant_name,
              count(DISTINCT it->>'bundle_line')::int AS picked
         FROM shop_orders o, LATERAL jsonb_array_elements(o.items) it
        WHERE o.created_at > NOW() - ($1 || ' days')::interval
          AND o.status IN ${PAID} AND it->>'bundle' IS NOT NULL
        GROUP BY 1,2,3 ORDER BY picked DESC`, [String(days)]);
    const defs = await pool.query("SELECT slug, name, price, slots FROM cms_bundles");
    const slotType = new Map();
    for (const d of defs.rows) for (const s of d.slots || []) slotType.set(`${d.slug}/${s.key}`, s);
    return c.json({
      ok: true, days,
      bundles: sold.rows.map((r) => {
        const def = defs.rows.find((d) => d.slug === r.slug);
        return { slug: r.slug, name: r.name || (def && def.name) || r.slug, sold: r.sold, orders: r.orders,
          price: def ? Number(def.price) : null,
          revenue: def ? Math.round(Number(def.price) * r.sold * 100) / 100 : null };
      }),
      // مزيج الاختيارات — الخانات من نوع «اختيار» بس (المثبّتة مالهاش معنى)
      choices: picks.rows.filter((r) => {
        const s = slotType.get(`${r.slug}/${r.slot}`);
        return !s || s.type === "choice";
      }).map((r) => ({ bundle: r.slug, slot: r.slot, product_id: r.product_id,
        name: [r.name, r.variant_name].filter(Boolean).join(" · ") || `صنف ${r.product_id}`, picked: r.picked })),
    });
  });

  const _linkSeen = new Map();   // "slug|ip" → آخر ضغطة اتعدّت (ms)
  function linkClickCounts({ slug, ua, ip, qa }, now = Date.now()) {
    if (qa || isBotRequest({ ua, ip })) return false;
    const ipS = String(ip || "").trim();
    if (!ipS) return true;                     // بروكسي قديم مابيبعتش IP: نعدّ زي الأول
    const k = `${slug}|${ipS}`;
    const last = _linkSeen.get(k);
    if (last && now - last < 30 * 60_000) return false;
    if (_linkSeen.size > 20000) _linkSeen.clear();
    _linkSeen.set(k, now);
    return true;
  }

  /* روابط الحملات — freshcuts.sa/l/<slug>. البروكسي بينادي resolve (عام)
     اللي بيعدّ الضغطة ويبني رابط الهبوط، فالقواعد في مكان واحد. */
  const MEDIUM = { influencer: "influencer", whatsapp: "message", sms: "message", qr: "offline" };
  const slugOk = (s) => /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(s);
  function linkBody(b) {
    // «offer» (14 سبتمبر): رابط يفتح عرض واحد على طول — /l/96-kilo و /l/96-box
    const target_type = ["home", "collection", "product", "offer"].includes(b.target_type) ? b.target_type : "home";
    const utm_source = clip(b.utm_source, 30) || "other";
    return {
      label: clip(b.label, 80), target_type,
      target_id: target_type === "home" ? null : clip(b.target_id, 64),
      coupon: clip(String(b.coupon || "").toUpperCase(), 40),
      // الوسيط الصريح بيكسب — من غيره بوستات السوشال العضوية كانت بتتسجّل «paid»
      utm_source, utm_medium: clip(b.utm_medium, 30) || MEDIUM[utm_source] || "paid",
      utm_campaign: clip(b.utm_campaign, 80),
    };
  }

  app.get("/api/cms/links", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query("SELECT * FROM cms_links ORDER BY active DESC, created_at DESC")).rows;
    return c.json({ ok: true, links: rows });
  });
  app.post("/api/cms/links", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const slug = String(b.slug || "").toLowerCase().trim();
    if (!slugOk(slug)) return c.json({ ok: false, error: "bad_slug" }, 400);
    const x = linkBody(b);
    try {
      const r = await pool.query(
        `INSERT INTO cms_links(slug, label, target_type, target_id, coupon, utm_source, utm_medium, utm_campaign, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [slug, x.label, x.target_type, x.target_id, x.coupon, x.utm_source, x.utm_medium, x.utm_campaign, b.active !== false, await who(c)]);
      return c.json({ ok: true, link: r.rows[0] });
    } catch (e) {
      if (String(e.message).includes("duplicate")) return c.json({ ok: false, error: "slug_taken" }, 409);
      throw e;
    }
  });
  app.put("/api/cms/links/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    // تشغيل/إيقاف بس (زرار في القائمة)
    if (Object.keys(b).length === 1 && typeof b.active === "boolean") {
      await pool.query("UPDATE cms_links SET active=$2 WHERE id=$1", [id, b.active]);
      return c.json({ ok: true });
    }
    const slug = String(b.slug || "").toLowerCase().trim();
    if (!slugOk(slug)) return c.json({ ok: false, error: "bad_slug" }, 400);
    const x = linkBody(b);
    try {
      const r = await pool.query(
        `UPDATE cms_links SET slug=$2, label=$3, target_type=$4, target_id=$5, coupon=$6, utm_source=$7,
                utm_medium=$8, utm_campaign=$9, active=$10 WHERE id=$1 RETURNING *`,
        [id, slug, x.label, x.target_type, x.target_id, x.coupon, x.utm_source, x.utm_medium, x.utm_campaign, b.active !== false]);
      if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
      return c.json({ ok: true, link: r.rows[0] });
    } catch (e) {
      if (String(e.message).includes("duplicate")) return c.json({ ok: false, error: "slug_taken" }, 409);
      throw e;
    }
  });
  app.delete("/api/cms/links/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM cms_links WHERE id=$1", [Number(c.req.param("id"))]);
    return c.json({ ok: true });
  });

  // عام: البروكسي بيناديه لما حد يضغط /l/<slug>. رابط موقوف/مش موجود = 404،
  // والبروكسي ساعتها بيودّي على الرئيسية (الإعلان الشغّال عمره ما يقع).
  // العدّاد (١٧ سبتمبر): كان ×١٢ من الحقيقة (زاحف مراجعة ميتا + تكرار نفس
  // الشخص). دلوقتي: البوت وزيارة QA مابيتعدّوش، ونفس الـIP على نفس الرابط
  // بيتعد مرة واحدة كل ٣٠ دقيقة. الرابط نفسه بيرجع عادي في كل الحالات.
  app.post("/api/cms/links/resolve/:slug", async (c) => {
    const slug = String(c.req.param("slug") || "").toLowerCase();
    if (!slugOk(slug)) return c.json({ ok: false }, 404);
    let body = {};
    try { body = await c.req.json(); } catch { body = {}; }
    const count = linkClickCounts({ slug, ua: body.ua, ip: body.ip, qa: body.qa === true });
    const r = count
      ? await pool.query(
        `UPDATE cms_links SET clicks = clicks + 1, last_click_at = NOW()
          WHERE slug=$1 AND active RETURNING *`, [slug])
      : await pool.query(`SELECT * FROM cms_links WHERE slug=$1 AND active`, [slug]);
    const l = r.rows[0];
    if (!l) return c.json({ ok: false }, 404);
    const q = new URLSearchParams();
    q.set("utm_source", l.utm_source || "other");
    q.set("utm_medium", l.utm_medium || "paid");
    if (l.utm_campaign) q.set("utm_campaign", l.utm_campaign);
    q.set("utm_content", l.slug);
    if (l.coupon) q.set("c", l.coupon);
    if (l.target_type === "collection" && l.target_id) q.set("col", l.target_id);
    if (l.target_type === "product" && l.target_id) q.set("p", l.target_id);
    // عرض: ?go=offers&offer=<id> — المتجر بيفتح منتقي العرض على طول (مسار ٠١)
    if (l.target_type === "offer" && l.target_id) { q.set("go", "offers"); q.set("offer", l.target_id); }
    q.set("fc_link", l.slug);
    return c.json({ ok: true, url: "/?" + q.toString() });
  });

  /* ═══ المرحلة ٣: الشرائح + الحملات + الولاء ═══════════════════════════ */
  const STORE_PUBLIC = () => (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
  const notify = () => (typeof deps.notify === "function" ? deps.notify() : null);
  const PHONE_RE = "^5[0-9]{8}$";
  const PAID_ONLINE = "status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')";

  /* عميل واحد = رقم جوال واحد، محسوب من كل الطلبات (نفس IDENT_SQL بتاع
     المؤشرات) + عملاء الموقع اللي طلباتهم لسه مانزلتش نقطة البيع. */
  let segCache = { at: 0, rows: null };
  async function customerRows() {
    if (segCache.rows && Date.now() - segCache.at < 5 * 60_000) return segCache.rows;
    const s = await getSettingsData();
    const apps = (Array.isArray(s?.deliveryAppMethods) && s.deliveryAppMethods.length
      ? s.deliveryAppMethods : (DEFAULT_DELIVERY_APPS || [])).map((x) => String(x).toLowerCase());
    const [pos, online, push, names, tsPhone, shopNames, keeta] = await Promise.all([
      pool.query(`
        WITH x AS (
          SELECT ${IDENT_SQL} AS pn, o.total, o.calendar_day AS day,
                 COALESCE(NULLIF(btrim(s.customer_name), ''), NULLIF(btrim(tc.name), '')) AS name,
                 ${deliverySql("$1::text[]")} AS is_app
            FROM ts_orders o
            LEFT JOIN order_sources s ON s.order_id = o.order_id
            LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
           WHERE ${SALES_ONLY}
        )
        SELECT pn, count(*)::int AS orders, COALESCE(sum(total), 0)::float AS spend,
               max(day) AS last_day, max(name) AS name, count(*) FILTER (WHERE is_app)::int AS app_orders
          FROM x WHERE pn ~ '${PHONE_RE}' GROUP BY pn`, [apps]),
      pool.query(`SELECT phone_norm AS pn, count(*)::int AS n, COALESCE(sum(total), 0)::float AS spend,
                         max(created_at)::date AS last_day
                    FROM shop_orders WHERE ${PAID_ONLINE} AND phone_norm ~ '${PHONE_RE}' GROUP BY 1`),
      pool.query("SELECT DISTINCT phone_norm AS pn FROM push_subs WHERE NOT disabled AND phone_norm IS NOT NULL"),
      pool.query("SELECT phone_norm AS pn, NULLIF(name, '') AS name FROM acct_customers"),
      // ٢٥٪ من العملاء كانوا بيظهروا من غير اسم: الاسم موجود في تاب سينس بس
      // الطلب نفسه مش مربوط بسجل العميل (الكاشير كتب الجوال بس، أو طلب تطبيق).
      // فبنلحق بالجوال.
      pool.query(`SELECT phone_norm AS pn, max(NULLIF(btrim(name), '')) AS name FROM ts_customers
                   WHERE phone_norm ~ '${PHONE_RE}' GROUP BY 1`),
      pool.query(`SELECT phone_norm AS pn, max(NULLIF(btrim(customer->>'name'), '')) AS name FROM shop_orders
                   WHERE phone_norm ~ '${PHONE_RE}' GROUP BY 1`),
      // عملاء كيتا: عدد طلباتهم هناك + أصناف الطلبات دي (للتفضيل مشاوي/بوكس)
      pool.query(`
        WITH k AS (
          SELECT s.phone_norm AS pn, o.order_id FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
           WHERE s.source_note ILIKE 'keeta' AND s.phone_norm ~ '${PHONE_RE}' AND ${SALES_ONLY}),
        n AS (SELECT pn, count(*)::int AS orders FROM k GROUP BY 1)
        SELECT k.pn, n.orders, i.name, COALESCE(sum(i.amount), 0)::float AS amount
          FROM k JOIN n ON n.pn = k.pn LEFT JOIN ts_order_items i ON i.order_id = k.order_id
         GROUP BY k.pn, n.orders, i.name`),
    ]);
    const onl = new Map(online.rows.map((r) => [r.pn, r]));
    const pushSet = new Set(push.rows.map((r) => r.pn));
    const nameOf = new Map(names.rows.map((r) => [r.pn, r.name]));
    // ترتيب مصادر الاسم: اسم على الطلب نفسه ← سجل تاب سينس بالجوال ←
    // حساب الموقع ← اسم كتبه العميل في شيك أوت
    const tsName = new Map(tsPhone.rows.filter((r) => r.name).map((r) => [r.pn, r.name]));
    const shopName = new Map(shopNames.rows.filter((r) => r.name).map((r) => [r.pn, r.name]));
    const pickName = (pn, onOrder) =>
      onOrder || tsName.get(pn) || nameOf.get(pn) || shopName.get(pn) || "";
    const today = new Date(new Date().toISOString().slice(0, 10));
    const daysSince = (d) => (d ? Math.max(0, Math.round((today - new Date(d)) / 86400000)) : 9999);
    const kMap = new Map();
    for (const k of keeta.rows) {
      const e = kMap.get(k.pn) || { orders: 0, grill: 0, box: 0 };
      e.orders = Math.max(e.orders, k.orders);
      const fam = smsRules.itemFamily(k.name);
      if (fam !== "other") e[fam] += k.amount;
      kMap.set(k.pn, e);
    }
    const kOf = (pn) => {
      const e = kMap.get(pn);
      return e ? { keetaOrders: e.orders, keetaLean: smsRules.leanOf(e.grill, e.box) } : { keetaOrders: 0, keetaLean: null };
    };
    const rows = pos.rows.map((r) => {
      const o = onl.get(r.pn);
      const last = o && o.last_day > r.last_day ? o.last_day : r.last_day;
      return { pn: r.pn, name: pickName(r.pn, r.name), orders: r.orders, spend: r.spend,
        appOrders: r.app_orders, online: o ? o.n : 0, onlineDaysSince: o ? daysSince(o.last_day) : 9999,
        push: pushSet.has(r.pn), lastDay: last, daysSince: daysSince(last), ...kOf(r.pn) };
    });
    // عملاء طلبوا من الموقع بس ولسه طلبهم مادخلش سجل نقطة البيع
    const seen = new Set(rows.map((r) => r.pn));
    for (const o of online.rows) {
      if (seen.has(o.pn)) continue;
      rows.push({ pn: o.pn, name: pickName(o.pn, null), orders: o.n, spend: o.spend, appOrders: 0,
        online: o.n, onlineDaysSince: daysSince(o.last_day), push: pushSet.has(o.pn), lastDay: o.last_day,
        daysSince: daysSince(o.last_day), ...kOf(o.pn) });
    }
    // VIP = أعلى ٢٠٪ إنفاق (نفس نسبة المؤشرات)
    const spends = rows.map((r) => r.spend).sort((a, b) => a - b);
    const cut = spends.length ? spends[Math.floor(spends.length * 0.8)] : Infinity;
    for (const r of rows) r.vip = r.spend >= cut && r.spend > 0;
    rows.sort((a, b) => a.daysSince - b.daysSince);
    segCache = { at: Date.now(), rows };
    return rows;
  }

  /* الشرائح عدسات متداخلة عن قصد. أول اتنين هما «الفرص الذهبية»: عملاء
     بيطلبوا فعلاً بس مش من متجرنا — تحويلهم أرخص من أي إعلان. ٢١ يوم = نفس
     حد «متوقف» في المؤشرات. */
  const SEGMENTS = [
    { id: "never_online", icon: "🎯", label: "نشطين ومجربوش الموقع", hint: "طلبوا خلال ٦٠ يوم (صالة/تطبيقات) ولسه ماطلبوش من متجرنا — أرخص تحويل ممكن",
      test: (c) => c.online === 0 && c.daysSince <= 60 },
    { id: "apps_only", icon: "🛵", label: "عملاء التطبيقات بس", hint: "كل طلباتهم من كيتا/هنقر — كل طلب بيدفع عمولة ~٤٠٪. حوّلهم لمتجرك بكوبون",
      test: (c) => c.orders > 0 && c.appOrders === c.orders && c.online === 0 },
    { id: "new", icon: "🌱", label: "جداد", hint: "أول طلب خلال آخر ١٤ يوم", test: (c) => c.orders === 1 && c.daysSince <= 14 },
    { id: "one_timer", icon: "1️⃣", label: "جربوا مرة ومرجعوش", hint: "طلب واحد من ١٥ لـ٦٠ يوم — محتاجين دفعة", test: (c) => c.orders === 1 && c.daysSince >= 15 && c.daysSince <= 60 },
    { id: "loyal", icon: "💎", label: "مخلصين", hint: "٣ طلبات أو أكتر وآخر طلب خلال ٢١ يوم", test: (c) => c.orders >= 3 && c.daysSince <= 21 },
    { id: "vip", icon: "⭐", label: "VIP", hint: "أعلى ٢٠٪ إنفاق ولسه نشطين (٤٥ يوم)", test: (c) => c.vip && c.daysSince <= 45 },
    { id: "at_risk", icon: "⚠️", label: "في خطر", hint: "كانوا بيرجعوا وبقالهم ٢٢–٤٥ يوم", test: (c) => c.orders >= 2 && c.daysSince >= 22 && c.daysSince <= 45 },
    { id: "dormant", icon: "😴", label: "نايمين", hint: "آخر طلب من ٤٦ لـ٩٠ يوم", test: (c) => c.daysSince >= 46 && c.daysSince <= 90 },
    { id: "lost", icon: "👻", label: "ضايعين", hint: "أكتر من ٩٠ يوم من غير طلب", test: (c) => c.daysSince > 90 },
    { id: "online_buyers", icon: "🛒", label: "عملاء الموقع", hint: "طلبوا من متجرنا مرة على الأقل", test: (c) => c.online > 0 },
    ...smsRules.WAVE_SEGMENTS,
    ...smsRules.KEETA_SEGMENTS,
  ];
  const segById = Object.fromEntries(SEGMENTS.map((s) => [s.id, s]));
  const pub = (s) => ({ id: s.id, icon: s.icon, label: s.label, hint: s.hint, ...(s.allowApps ? { allowApps: true } : {}) });

  app.get("/api/cms/segments", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = await customerRows();
    return c.json({
      ok: true, asOf: new Date(segCache.at).toISOString(), customers: rows.length,
      segments: SEGMENTS.map((s) => {
        const m = rows.filter(s.test);
        return { ...pub(s), count: m.length, reachablePush: m.filter((x) => x.push).length };
      }),
    });
  });

  app.get("/api/cms/segments/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = segById[c.req.param("id")];
    if (!s) return c.json({ ok: false, error: "not_found" }, 404);
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const m = (await customerRows()).filter(s.test);
    return c.json({
      ok: true, ...pub(s), total: m.length,
      members: m.slice(offset, offset + limit).map((x) => ({
        phone: x.pn, name: x.name, orders: x.orders, spend: Math.round(x.spend), lastDay: x.lastDay,
        daysSince: x.daysSince, appOrders: x.appOrders, onlineOrders: x.online, vip: x.vip, push: x.push,
        keetaOrders: x.keetaOrders, keetaLean: x.keetaLean })),
    });
  });

  /* ── الحملات ──
     ١٧ سبتمبر (موافقة عمر على تشغيل الـSMS): كل رسالة تسويقية بتعدّي على
     smsrules.js — علاقة مباشرة بس، الموظفين برا، الإيقاف، فاصل ٢١ يوم،
     مفيش طلب أونلاين آخر ٣ أيام، ساعات الهدوء، سقف يومي وسقف ميزانية.
     وكل مستلم بيتسجّل في cms_campaign_sends (رقم رسالة تقنيات + التكلفة) عشان
     النتيجة والنسب والفاصل يتحسبوا من الحقيقة مش من تقدير. */
  const CAMP_DEFAULT = { smsEnabled: false, dailySmsCap: 1000, minGapDays: 21, budgetSar: 0, budgetSince: null, excludePhones: [] };
  async function campaignCfg() {
    const s = await getSettingsData();
    return { ...CAMP_DEFAULT, ...(((s || {}).cms || {}).campaigns || {}) };
  }
  const smsPartsOf = (t) => smsRules.smsParts(t);
  const MAX_PARTS = 2;
  async function smsToday() {
    const r = await pool.query("SELECT n FROM cms_sms_daily WHERE day = CURRENT_DATE");
    return r.rows[0]?.n || 0;
  }
  const bumpSms = (parts) => pool.query(
    `INSERT INTO cms_sms_daily(day, n) VALUES (CURRENT_DATE, $1)
     ON CONFLICT (day) DO UPDATE SET n = cms_sms_daily.n + $1`, [parts]).catch(() => {});
  const renderMsg = (tpl, { name, coupon }) => String(tpl || "")
    .replaceAll("{name}", String(name || "").split(/\s+/)[0] || "")
    .replaceAll("{coupon}", coupon || "")
    .replace(/[ \t]{2,}/g, " ").trim();

  async function optoutCodes(phones) {
    if (!phones.length) return new Map();
    await pool.query(
      `INSERT INTO cms_contacts(phone_norm, optout_code)
       SELECT p, substr(md5(random()::text || p || clock_timestamp()::text), 1, 10) FROM unnest($1::text[]) p
       ON CONFLICT (phone_norm) DO NOTHING`, [phones]);
    const r = await pool.query(
      "SELECT phone_norm, optout_code, opted_out_at FROM cms_contacts WHERE phone_norm = ANY($1)", [phones]);
    return new Map(r.rows.map((x) => [x.phone_norm, x]));
  }

  /* مين اتبعتله رسالة تسويقية (حملة أو أتمتة) خلال آخر N يوم */
  async function recentlyMessaged(phones, days) {
    if (!phones.length || !(days > 0)) return new Set();
    const r = await pool.query(
      `SELECT phone_norm FROM cms_campaign_sends
        WHERE phone_norm = ANY($1) AND status = 'sent' AND created_at > NOW() - ($2 || ' days')::interval
       UNION
       SELECT phone_norm FROM cms_flow_log
        WHERE phone_norm = ANY($1) AND sent_at > NOW() - ($2 || ' days')::interval`, [phones, String(days)]);
    return new Set(r.rows.map((x) => x.phone_norm));
  }

  // الجمهور الفعلي: إشعار = اللي مفعّل إشعارات بس، SMS = بعد كل قواعد smsrules
  async function audienceFor(camp) {
    const s = segById[camp.segment];
    if (!s) return { list: [], holdout: [], segmentSize: 0, optedOut: 0, excluded: {} };
    const m = (await customerRows()).filter(s.test);
    if (camp.channel === "push") return { list: m.filter((x) => x.push), holdout: [], segmentSize: m.length, optedOut: 0, excluded: {} };
    const cfg = await campaignCfg();
    const pns = m.map((x) => x.pn);
    const [codes, gap, recentOnline] = await Promise.all([
      optoutCodes(pns),
      recentlyMessaged(pns, Number(cfg.minGapDays) || 0),
      pool.query(`SELECT DISTINCT phone_norm FROM shop_orders WHERE ${PAID_ONLINE} AND phone_norm = ANY($1)
                   AND created_at > NOW() - INTERVAL '3 days'`, [pns]).then((r) => new Set(r.rows.map((x) => x.phone_norm))),
    ]);
    const optedOut = new Set([...codes.values()].filter((x) => x.opted_out_at).map((x) => x.phone_norm));
    const f = smsRules.filterAudience(m, {
      staff: smsRules.staffPhoneSet(await getSettingsData()), optedOut, recentlyMessaged: gap, recentOnline,
      allowApps: s.allowApps === true });
    const withCode = f.list.map((x) => ({ ...x, code: codes.get(x.pn)?.optout_code }));
    const holdout = withCode.filter((x) => smsRules.inHoldout(camp.id, x.pn, camp.holdout_pct));
    const hold = new Set(holdout.map((x) => x.pn));
    return { list: withCode.filter((x) => !hold.has(x.pn)), holdout, segmentSize: m.length,
      optedOut: f.excluded.opted_out, excluded: f.excluded };
  }

  const smsBody = (camp, person) =>
    `${renderMsg(camp.message, { name: person.name, coupon: camp.coupon })}\nإيقاف: ${STORE_PUBLIC().replace(/^https?:\/\//, "")}/u/${person.code}`;

  async function sendMarketingSms(pn, body) {
    const key = process.env.TAQNYAT_API_KEY, sender = process.env.TAQNYAT_SENDER_AD;
    if (!key || !sender) throw Object.assign(new Error("ad sender not configured"), { code: "sms_failed" });
    if (smsPartsOf(body) > MAX_PARTS) throw Object.assign(new Error("too_long"), { code: "sms_failed" });
    const resp = await fetch("https://api.taqnyat.sa/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipients: [`966${pn}`], body, sender }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || (data.statusCode && data.statusCode >= 400)) {
      throw Object.assign(new Error(`Taqnyat: ${data.message || resp.status}`), { code: "sms_failed" });
    }
    bumpSms(smsPartsOf(body));
    return { messageId: data.messageId != null ? String(data.messageId) : null, cost: Number(data.cost) || 0, parts: Number(data.msgLength) || smsPartsOf(body) };
  }

  async function budgetLeft(cfg) {
    const cap = Number(cfg.budgetSar) || 0;
    if (cap <= 0) return Infinity;
    const r = await pool.query(
      `SELECT COALESCE(sum(cost),0)::float AS spent FROM cms_campaign_sends
        WHERE status='sent' AND created_at >= COALESCE($1::timestamptz, '1970-01-01')`, [cfg.budgetSince || null]);
    return cap - r.rows[0].spent;
  }

  /* فحوصات ما قبل إرسال SMS — نفس الفحص للإرسال الفوري والمجدول */
  async function smsPreflight(camp, aud) {
    const cfg = await campaignCfg();
    if (cfg.smsEnabled !== true) return "sms_disabled";
    if (cfg.brake) return "brake_optout";
    if (smsRules.inQuietHours()) return "quiet_hours";
    const parts = smsPartsOf(smsBody(camp, aud.list[0]));
    if (parts > MAX_PARTS) return "too_long";
    if ((await smsToday()) + aud.list.length * parts > Number(cfg.dailySmsCap || 0)) return "daily_cap";
    if (aud.list.length * parts * 0.075 > (await budgetLeft(cfg))) return "budget_cap";
    return null;
  }

  async function couponOk(code) {
    if (!code) return true;
    const r = await pool.query("SELECT 1 FROM shop_coupons WHERE upper(code)=upper($1) AND active", [code]);
    return r.rowCount > 0;
  }
  const bad = (c, error, status = 400) => c.json({ ok: false, error }, status);
  function campBody(b) {
    return {
      name: clip(b.name, 80), segment: segById[b.segment] ? b.segment : null,
      channel: b.channel === "sms" ? "sms" : "push", message: clip(b.message, 600),
      coupon: clip(String(b.coupon || "").toUpperCase(), 40),
      holdout_pct: Math.min(50, Math.max(0, Math.round(Number(b.holdout_pct) || 0))),
    };
  }

  app.get("/api/cms/campaigns", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const [rows, cfg, today] = await Promise.all([
      pool.query("SELECT * FROM cms_campaigns ORDER BY created_at DESC LIMIT 100"), campaignCfg(), smsToday()]);
    return c.json({ ok: true, campaigns: rows.rows, smsEnabled: cfg.smsEnabled === true,
      dailySmsCap: cfg.dailySmsCap, smsSentToday: today, smsSender: process.env.TAQNYAT_SENDER_AD || null,
      minGapDays: cfg.minGapDays, budgetSar: cfg.budgetSar, budgetLeft: Number.isFinite(await budgetLeft(cfg)) ? await budgetLeft(cfg) : null });
  });

  app.post("/api/cms/campaigns", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const x = campBody(b);
    if (!x.name || !x.segment || !x.message) return bad(c, "name_segment_message_required");
    const r = await pool.query(
      `INSERT INTO cms_campaigns(name, segment, channel, message, coupon, holdout_pct, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [x.name, x.segment, x.channel, x.message, x.coupon, x.holdout_pct, await who(c)]);
    return c.json({ ok: true, campaign: r.rows[0] });
  });

  app.put("/api/cms/campaigns/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const x = campBody(b);
    if (!x.name || !x.segment || !x.message) return bad(c, "name_segment_message_required");
    const r = await pool.query(
      `UPDATE cms_campaigns SET name=$2, segment=$3, channel=$4, message=$5, coupon=$6, holdout_pct=$7
        WHERE id=$1 AND status='draft' RETURNING *`,
      [Number(c.req.param("id")), x.name, x.segment, x.channel, x.message, x.coupon, x.holdout_pct]);
    if (!r.rowCount) return bad(c, "already_sent", 409);
    return c.json({ ok: true, campaign: r.rows[0] });
  });

  app.delete("/api/cms/campaigns/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query("DELETE FROM cms_campaigns WHERE id=$1 AND status='draft'", [Number(c.req.param("id"))]);
    if (!r.rowCount) return bad(c, "already_sent", 409);
    return c.json({ ok: true });
  });

  app.get("/api/cms/campaigns/:id/preview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const camp = (await pool.query("SELECT * FROM cms_campaigns WHERE id=$1", [Number(c.req.param("id"))])).rows[0];
    if (!camp) return bad(c, "not_found", 404);
    const aud = await audienceFor(camp);
    const first = aud.list[0];
    const sample = first
      ? (camp.channel === "sms" ? smsBody(camp, first) : renderMsg(camp.message, { name: first.name, coupon: camp.coupon }))
      : "";
    // الطول بأطول كود إيقاف (١٠ حروف) حتى لو الجمهور فاضي
    const parts = camp.channel === "sms" ? smsPartsOf(sample || smsBody(camp, { name: "", code: "xxxxxxxxxx" })) : 0;
    return c.json({ ok: true, audience: aud.list.length, holdout: aud.holdout.length, segmentSize: aud.segmentSize,
      optedOut: aud.optedOut, excluded: aud.excluded, parts, tooLong: parts > MAX_PARTS,
      quietHours: smsRules.inQuietHours(),
      costEstimate: Math.round(aud.list.length * parts * 0.075 * 100) / 100, sampleBody: sample.replace(/\/u\/[a-f0-9]+/, "/u/••••") });
  });

  app.post("/api/cms/campaigns/:id/test", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const pn = String(b.phone || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
    if (!/^5\d{8}$/.test(pn)) return bad(c, "bad_phone");
    const camp = (await pool.query("SELECT * FROM cms_campaigns WHERE id=$1", [Number(c.req.param("id"))])).rows[0];
    if (!camp) return bad(c, "not_found", 404);
    const person = { pn, name: "", code: (await optoutCodes([pn])).get(pn)?.optout_code };
    let info = null;
    try {
      if (camp.channel === "sms") {
        info = await sendMarketingSms(pn, smsBody(camp, person));
      } else {
        const ok = await notify()?.sendToAudience({ phoneNorm: pn, title: "فريش كاتس 🍔 [تجربة]",
          body: renderMsg(camp.message, { coupon: camp.coupon }), url: camp.coupon ? `${STORE_PUBLIC()}/?c=${camp.coupon}` : STORE_PUBLIC() });
        if (!ok) return bad(c, "no_push_for_phone");
      }
    } catch (e) { return c.json({ ok: false, error: "sms_failed", message: e.message }); }
    return c.json({ ok: true, channel: camp.channel, messageId: info?.messageId || null, cost: info?.cost ?? null, parts: info?.parts ?? null });
  });

  async function runSend(camp, aud, actor) {
    const list = aud.list;
    let sent = 0, failed = 0, lastError = null, cost = 0;
    const url = camp.coupon ? `${STORE_PUBLIC()}/?c=${encodeURIComponent(camp.coupon)}` : STORE_PUBLIC();
    const log = (pn, status, x = {}) => pool.query(
      `INSERT INTO cms_campaign_sends(campaign_id, phone_norm, status, msg_id, parts, cost, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (campaign_id, phone_norm) DO NOTHING`,
      [camp.id, pn, status, x.messageId || null, x.parts || 0, x.cost || 0, x.error || null]).catch(() => {});
    for (const h of aud.holdout || []) await log(h.pn, "holdout");
    const one = async (p) => {
      try {
        if (camp.channel === "sms") {
          // ساعات الهدوء ممكن تبدأ في نص حملة كبيرة — نوقف الباقي
          if (smsRules.inQuietHours()) { failed++; lastError = "quiet_hours"; await log(p.pn, "failed", { error: "quiet_hours" }); return; }
          const info = await sendMarketingSms(p.pn, smsBody(camp, p));
          sent++; cost += info.cost; await log(p.pn, "sent", info);
        } else if (await notify()?.sendToAudience({ phoneNorm: p.pn, title: "فريش كاتس 🍔",
          body: renderMsg(camp.message, { name: p.name, coupon: camp.coupon }), url })) { sent++; await log(p.pn, "sent"); }
        else { failed++; await log(p.pn, "failed", { error: "no_push" }); }
      } catch (e) { failed++; lastError = e.message; await log(p.pn, "failed", { error: String(e.message).slice(0, 200) }); }
    };
    // ٥ في نفس الوقت — تقنيات وخوادم الإشعارات مابتحبش الانفجار
    for (let i = 0; i < list.length; i += 5) {
      await Promise.all(list.slice(i, i + 5).map(one));
      if (camp.channel === "sms") await new Promise((r) => setTimeout(r, 300));
    }
    await pool.query(
      `UPDATE cms_campaigns SET status='sent', sent=$2, failed=$3, audience=$4, sent_at=NOW(), sent_by=$5, last_error=$6,
              cost=$7, excluded=$8 WHERE id=$1`,
      [camp.id, sent, failed, list.length, actor, lastError, Math.round(cost * 100) / 100, jb({ ...(aud.excluded || {}), holdout: (aud.holdout || []).length })]);
    console.log(`[cms] campaign ${camp.id} (${camp.channel}) → sent ${sent}, failed ${failed}, cost ${cost.toFixed(2)}`);
  }

  app.post("/api/cms/campaigns/:id/send", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const id = Number(c.req.param("id"));
    // انتقال ذرّي من مسودة لـ«بتتبعت» — ضغطتين مايبعتوش مرتين
    const r = await pool.query("UPDATE cms_campaigns SET status='sending' WHERE id=$1 AND status='draft' RETURNING *", [id]);
    if (!r.rowCount) return bad(c, "already_sent", 409);
    const camp = r.rows[0];
    const revert = () => pool.query("UPDATE cms_campaigns SET status='draft' WHERE id=$1 AND status='sending'", [id]);
    try {
      const aud = await audienceFor(camp);
      if (!aud.list.length) { await revert(); return bad(c, "empty_audience"); }
      if (Number(b.confirm) !== aud.list.length) { await revert(); return bad(c, "confirm_mismatch"); }
      if (!(await couponOk(camp.coupon))) { await revert(); return bad(c, "coupon_invalid"); }
      if (camp.channel === "sms") {
        const why = await smsPreflight(camp, aud);
        if (why) { await revert(); return bad(c, why, why === "sms_disabled" ? 403 : 400); }
      }
      const actor = await who(c);
      setImmediate(() => runSend(camp, aud, actor).catch(async (e) => {
        console.error(`[cms] campaign ${id} failed:`, e.message);
        await pool.query("UPDATE cms_campaigns SET status='draft', last_error=$2 WHERE id=$1", [id, e.message]).catch(() => {});
      }));
      return c.json({ ok: true, queued: true, audience: aud.list.length, holdout: aud.holdout.length });
    } catch (e) { await revert(); throw e; }
  });

  /* جدولة: التأكيد بالعدد بيتاخد دلوقتي، والإرسال بيحصل في الميعاد لو الجمهور
     ماتغيّرش أكتر من ٢٠٪ (أو ١٠ أشخاص) — غير كده الحملة بتتعلّق «held» ومحدش
     بياخد حاجة لحد ما حد يراجع. */
  app.post("/api/cms/campaigns/:id/schedule", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const id = Number(c.req.param("id"));
    const at = new Date(b.at);
    if (isNaN(at) || at.getTime() < Date.now() - 60_000) return bad(c, "bad_time");
    if (smsRules.inQuietHours(at)) return bad(c, "quiet_hours");
    const camp = (await pool.query("SELECT * FROM cms_campaigns WHERE id=$1 AND status IN ('draft','held')", [id])).rows[0];
    if (!camp) return bad(c, "not_draft", 409);
    const aud = await audienceFor(camp);
    if (Number(b.confirm) !== aud.list.length) return bad(c, "confirm_mismatch");
    await pool.query(
      "UPDATE cms_campaigns SET status='scheduled', scheduled_at=$2, confirm_audience=$3, last_error=NULL WHERE id=$1",
      [id, at.toISOString(), aud.list.length]);
    return c.json({ ok: true, scheduledAt: at.toISOString(), audience: aud.list.length });
  });
  app.post("/api/cms/campaigns/:id/unschedule", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query(
      "UPDATE cms_campaigns SET status='draft', scheduled_at=NULL WHERE id=$1 AND status IN ('scheduled','held') RETURNING id",
      [Number(c.req.param("id"))]);
    return r.rowCount ? c.json({ ok: true }) : bad(c, "not_scheduled", 409);
  });

  async function scheduledTick() {
    const due = (await pool.query(
      `UPDATE cms_campaigns SET status='sending'
        WHERE id = (SELECT id FROM cms_campaigns WHERE status='scheduled' AND scheduled_at <= NOW()
                     ORDER BY scheduled_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`)).rows[0];
    if (!due) return;
    const hold = (why) => pool.query("UPDATE cms_campaigns SET status='held', last_error=$2 WHERE id=$1", [due.id, why]);
    try {
      segCache = { at: 0, rows: null };
      const aud = await audienceFor(due);
      if (!aud.list.length) return void (await hold("empty_audience"));
      if (!smsRules.audienceDriftOk(due.confirm_audience, aud.list.length)) {
        return void (await hold(`audience_changed ${due.confirm_audience}→${aud.list.length}`));
      }
      if (!(await couponOk(due.coupon))) return void (await hold("coupon_invalid"));
      if (due.channel === "sms") {
        const why = await smsPreflight(due, aud);
        if (why) return void (await hold(why));
      }
      console.log(`[cms] scheduled campaign ${due.id} firing → ${aud.list.length} (+${aud.holdout.length} holdout)`);
      await runSend(due, aud, "schedule");
    } catch (e) {
      console.error(`[cms] scheduled campaign ${due.id}:`, e.message);
      await hold(String(e.message).slice(0, 200)).catch(() => {});
    }
  }
  setInterval(() => scheduledTick().catch((e) => console.error("[cms] schedule tick:", e.message)), 60_000);

  /* نتيجة الحملة: مُرسل / فشل / تكلفة / ضغطات الرابط / طلبات أونلاين من
     المستلمين خلال ٧٢ ساعة مقابل مجموعة الـholdout / طلبات جات من الرابط نفسه */
  app.get("/api/cms/campaigns/:id/results", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const camp = (await pool.query("SELECT * FROM cms_campaigns WHERE id=$1", [Number(c.req.param("id"))])).rows[0];
    if (!camp) return bad(c, "not_found", 404);
    const slug = (String(camp.message).match(/\/l\/([a-z0-9-]+)/i) || [])[1] || null;
    const [agg, orders, link, byLink] = await Promise.all([
      pool.query(`SELECT count(*) FILTER (WHERE status='sent')::int AS sent, count(*) FILTER (WHERE status='failed')::int AS failed,
                         count(*) FILTER (WHERE status='holdout')::int AS holdout, COALESCE(sum(cost),0)::float AS cost,
                         COALESCE(sum(parts),0)::int AS parts
                    FROM cms_campaign_sends WHERE campaign_id=$1`, [camp.id]),
      pool.query(`SELECT s.status, count(DISTINCT o.order_no)::int AS orders, COALESCE(sum(o.total),0)::float AS revenue
                    FROM cms_campaign_sends s
                    JOIN shop_orders o ON o.phone_norm = s.phone_norm AND ${PAID_ONLINE.replaceAll("status", "o.status")}
                         AND o.created_at >= s.created_at AND o.created_at < s.created_at + INTERVAL '72 hours'
                   WHERE s.campaign_id=$1 AND s.status IN ('sent','holdout') GROUP BY 1`, [camp.id]),
      slug ? pool.query("SELECT clicks, last_click_at FROM cms_links WHERE slug=$1", [slug]) : Promise.resolve({ rows: [] }),
      slug ? pool.query(`SELECT count(*)::int AS orders, COALESCE(sum(total),0)::float AS revenue FROM shop_orders
                          WHERE attribution->>'fc_link' = $1 AND ${PAID_ONLINE}`, [slug]) : Promise.resolve({ rows: [] }),
    ]);
    const a = agg.rows[0];
    const g = Object.fromEntries(orders.rows.map((r) => [r.status, r]));
    return c.json({ ok: true, id: camp.id, name: camp.name, status: camp.status, sentAt: camp.sent_at, scheduledAt: camp.scheduled_at,
      sent: a.sent, failed: a.failed, holdout: a.holdout, parts: a.parts, cost: Math.round(a.cost * 100) / 100,
      excluded: camp.excluded, slug, clicks: link.rows[0]?.clicks ?? null,
      linkOrders: byLink.rows[0] || null,
      recipientsOrders72h: g.sent || { orders: 0, revenue: 0 }, holdoutOrders72h: g.holdout || { orders: 0, revenue: 0 },
      delivery: "Taqnyat API has no delivery-report endpoint; messageIds stored per recipient" });
  });

  // المالك بس (المسار مش تحت «customers» في خريطة الأقسام عن قصد): SMS بفلوس
  app.put("/api/cms/campaign-settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const prev = await campaignCfg();
    const val = {
      ...prev,
      smsEnabled: b.smsEnabled === true,
      dailySmsCap: Math.min(20000, Math.max(0, Number(b.dailySmsCap) || 0)),
    };
    if (b.minGapDays != null) val.minGapDays = Math.min(90, Math.max(0, Math.round(Number(b.minGapDays) || 0)));
    if (b.budgetSar != null) val.budgetSar = Math.max(0, Number(b.budgetSar) || 0);
    if (b.budgetSince !== undefined) val.budgetSince = b.budgetSince ? new Date(b.budgetSince).toISOString() : null;
    if (b.clearBrake === true) delete val.brake;
    if (Array.isArray(b.excludePhones)) val.excludePhones = b.excludePhones.map(smsRules.normLocal).filter(Boolean).slice(0, 200);
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'cms' THEN data ELSE jsonb_set(data,'{cms}','{}'::jsonb,true) END,
         '{cms,campaigns}', $1::jsonb, true) WHERE id=1`, [jb(val)]);
    return c.json({ ok: true, ...val });
  });

  // عام: صفحة /u/<code> على المتجر بتناديه
  app.post("/api/cms/optout/:code", async (c) => {
    const code = String(c.req.param("code") || "").slice(0, 20);
    if (!/^[a-f0-9]{6,20}$/.test(code)) return c.json({ ok: false }, 404);
    let b = {};
    try { b = await c.req.json(); } catch {}
    const ua = String(b.ua || c.req.header("user-agent") || "").slice(0, 200) || null;
    // ١٧/٩: فتح الرابط (GET على المتجر) بقى «view» بس — الإيقاف بزرار التأكيد (POST)
    if (b.view === true) {
      const v = await pool.query("SELECT phone_norm FROM cms_contacts WHERE optout_code=$1", [code]);
      if (v.rowCount) pool.query("INSERT INTO cms_optout_log(phone_norm, action, source, ua) VALUES ($1,'view','link',$2)", [v.rows[0].phone_norm, ua]).catch(() => {});
      return c.json({ ok: v.rowCount > 0 });
    }
    const r = await pool.query(
      `UPDATE cms_contacts SET optout_source = CASE WHEN opted_out_at IS NULL THEN 'link' ELSE optout_source END,
              opted_out_at = COALESCE(opted_out_at, NOW()) WHERE optout_code=$1 RETURNING phone_norm`, [code]);
    if (r.rowCount) pool.query("INSERT INTO cms_optout_log(phone_norm, action, source, ua) VALUES ($1,'optout','link',$2)", [r.rows[0].phone_norm, ua]).catch(() => {});
    return r.rowCount ? c.json({ ok: true }) : c.json({ ok: false }, 404);
  });

  /* فرملة الإيقاف (قرار ١٧/٩): لو الإيقاف المؤكد (زرار التأكيد) من مستلمي موجة
     عدّى ٥٪ من المُرسل خلال ٣٠ دقيقة من إرسالها → كل الموجات المجدولة بتتعلّق
     «held»، والإرسال بيترفض لحد ما المالك يفك الفرملة، ورسالة للإدارة. */
  const BRAKE_PCT = 5, BRAKE_MIN = 30;
  async function brakeCheck() {
    const cfg = await campaignCfg();
    if (cfg.brake) return;
    const rows = (await pool.query(
      `SELECT s.campaign_id, count(DISTINCT s.phone_norm) FILTER (WHERE s.status='sent')::int AS sent,
              count(DISTINCT l.phone_norm)::int AS optouts
         FROM cms_campaign_sends s
         LEFT JOIN cms_optout_log l ON l.phone_norm = s.phone_norm AND l.action='optout' AND l.source='link'
              AND l.created_at >= s.created_at AND l.created_at < s.created_at + ($1 || ' minutes')::interval
        WHERE s.created_at > NOW() - INTERVAL '2 hours'
        GROUP BY 1`, [String(BRAKE_MIN)])).rows;
    const hit = rows.find((r) => r.sent >= 20 && r.optouts * 100 > r.sent * BRAKE_PCT);
    if (!hit) return;
    const brake = { at: new Date().toISOString(), campaignId: hit.campaign_id, sent: hit.sent, optouts: hit.optouts };
    await pool.query(
      `UPDATE settings SET data = jsonb_set(data, '{cms,campaigns,brake}', $1::jsonb, true) WHERE id=1`, [jb(brake)]);
    const held = await pool.query(
      "UPDATE cms_campaigns SET status='held', last_error='brake_optout' WHERE status='scheduled' RETURNING id");
    console.error(`[cms] OPT-OUT BRAKE: campaign ${hit.campaign_id} ${hit.optouts}/${hit.sent} → held ${held.rowCount}`);
    try {
      const s = await getSettingsData();
      const phones = [...smsRules.staffPhoneSet({ delivery: { alertPhones: s?.delivery?.alertPhones } })];
      const { sendSms } = await import("./accounts.js");
      const msg = `FreshCuts ALERT: SMS campaign ${hit.campaign_id} opt-outs ${hit.optouts}/${hit.sent} in 30 min. ${held.rowCount} scheduled wave(s) paused.`;
      for (const pn of phones) await sendSms({ phoneNorm: pn, body: msg.slice(0, 160) }).catch(() => {});
    } catch (e) { console.error("[cms] brake alert:", e.message); }
  }
  setInterval(() => brakeCheck().catch((e) => console.error("[cms] brake:", e.message)), 60_000);

  /* ── الولاء: كل N طلبات من الموقع = كوبون شخصي ──
     بيعدّ من لحظة التفعيل بس (startedAt) — لو عدّ التاريخ كله، التفعيل كان
     هيطلّع كوبونات لكل العملاء القدام مرة واحدة كتكلفة مفاجئة. */
  const LOYALTY_DEFAULT = { enabled: false, every: 5, reward: "free_delivery", percent: 10, validDays: 14, startedAt: null };
  async function loyaltyCfg() {
    const s = await getSettingsData();
    return { ...LOYALTY_DEFAULT, ...(((s || {}).cms || {}).loyalty || {}) };
  }
  async function loyaltyCounts(cfg) {
    const since = cfg.startedAt || "1970-01-01";
    return (await pool.query(
      `SELECT o.phone_norm AS pn, count(*)::int AS n,
              (SELECT count(*)::int FROM cms_loyalty l WHERE l.phone_norm = o.phone_norm) AS issued
         FROM shop_orders o
        WHERE ${PAID_ONLINE} AND o.phone_norm ~ '${PHONE_RE}' AND o.created_at >= $1::timestamptz
        GROUP BY 1`, [since])).rows;
  }
  async function loyaltyRun() {
    const cfg = await loyaltyCfg();
    if (!cfg.enabled || !cfg.startedAt) return;
    const every = Math.max(2, Number(cfg.every) || 5);
    for (const r of await loyaltyCounts(cfg)) {
      for (let k = r.issued + 1; k <= Math.floor(r.n / every); k++) {
        const code = "FC" + crypto.randomBytes(4).toString("hex").toUpperCase();
        const ins = await pool.query(
          "INSERT INTO cms_loyalty(phone_norm, reward_no, coupon) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1",
          [r.pn, k, code]);
        if (!ins.rowCount) continue;
        const expires = new Date(Date.now() + (Number(cfg.validDays) || 14) * 86400000).toISOString().slice(0, 10);
        const isFree = cfg.reward !== "percent";
        await pool.query(
          `INSERT INTO shop_coupons(code, percent, active, min_total, max_uses, expires_at, note, once_per_customer, free_delivery)
           VALUES ($1,$2,true,0,1,$3,$4,true,$5)`,
          [code, isFree ? 0 : Math.min(50, Number(cfg.percent) || 10), expires, `مكافأة ولاء #${k} — ${r.pn.slice(-4)}`, isFree]);
        const what = isFree ? "توصيل مجاني" : `خصم ${Number(cfg.percent) || 10}٪`;
        notify()?.sendToAudience({ phoneNorm: r.pn, title: "مبروك! 🎁",
          body: `كمّلت ${every * k} طلبات من فريش كاتس — كوبونك ${code}: ${what} لحد ${expires}`,
          url: `${STORE_PUBLIC()}/?c=${code}` }).catch(() => {});
        console.log(`[cms] loyalty reward ${code} → ${r.pn.slice(-4)} (#${k})`);
      }
    }
  }
  setTimeout(() => loyaltyRun().catch((e) => console.error("[cms] loyalty:", e.message)), 60_000);
  setInterval(() => loyaltyRun().catch((e) => console.error("[cms] loyalty:", e.message)), 15 * 60_000);

  app.get("/api/cms/loyalty", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = await loyaltyCfg();
    const every = Math.max(2, Number(cfg.every) || 5);
    const counts = await loyaltyCounts(cfg);
    const [issued, used, recent] = await Promise.all([
      pool.query("SELECT count(*)::int AS n FROM cms_loyalty"),
      pool.query("SELECT count(*)::int AS n FROM cms_loyalty l JOIN shop_coupons s ON s.code = l.coupon WHERE s.used_count > 0"),
      pool.query(`SELECT l.phone_norm AS phone, l.reward_no, l.coupon, l.created_at, COALESCE(s.used_count,0) > 0 AS used
                    FROM cms_loyalty l LEFT JOIN shop_coupons s ON s.code = l.coupon ORDER BY l.created_at DESC LIMIT 10`),
    ]);
    return c.json({ ok: true, config: cfg, stats: {
      members: counts.length,
      eligibleSoon: counts.filter((r) => r.n % every === every - 1).length,
      rewardsIssued: issued.rows[0].n, rewardsUsed: used.rows[0].n, recent: recent.rows,
    } });
  });

  app.put("/api/cms/loyalty", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const prev = await loyaltyCfg();
    const enabled = b.enabled === true;
    const val = {
      enabled,
      every: Math.min(20, Math.max(2, Number(b.every) || 5)),
      reward: b.reward === "percent" ? "percent" : "free_delivery",
      percent: Math.min(50, Math.max(5, Number(b.percent) || 10)),
      validDays: Math.min(90, Math.max(3, Number(b.validDays) || 14)),
      // أول تفعيل بيثبّت نقطة البداية؛ الإيقاف والتشغيل تاني مابيعدّش التاريخ
      startedAt: enabled ? (prev.startedAt || new Date().toISOString()) : prev.startedAt,
    };
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'cms' THEN data ELSE jsonb_set(data,'{cms}','{}'::jsonb,true) END,
         '{cms,loyalty}', $1::jsonb, true) WHERE id=1`, [jb(val)]);
    return c.json({ ok: true, config: val });
  });

  /* ═══ المرحلة ٤: لوحة التشغيل (SLA) + الهدف اليومي + الأتمتة ═══════════ */

  // لوحة التشغيل: كل طلب أونلاين شغّال + حالته مقابل الـSLA (نفس slaCheck
  // ونفس إعدادات settings.delivery.sla اللي الـwatchdog بيصعّد بيها).
  app.get("/api/cms/ops/live", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await getSettingsData();
    const sla = { ...DEFAULT_SLA, ...(((s || {}).delivery || {}).sla || {}) };
    const [rows, today] = await Promise.all([
      pool.query(`
        SELECT o.order_no, o.status, o.option, o.total, o.customer, o.created_at, o.updated_at, o.pos_ready_at,
               sh.provider AS ship_provider, sh.status AS ship_status, sh.driver AS ship_driver,
               sh.arrived_at AS ship_arrived_at, sh.picked_at AS ship_picked_at
          FROM shop_orders o
          LEFT JOIN LATERAL (SELECT provider, status, driver, arrived_at, picked_at FROM dl_shipments
                              WHERE shop_order_no = o.order_no ORDER BY id DESC LIMIT 1) sh ON TRUE
         WHERE o.status NOT IN ('pending_payment','expired','delivered','rejected_refunded')
           AND o.created_at > NOW() - INTERVAL '24 hours'
         ORDER BY o.created_at`),
      pool.query(`
        SELECT count(*) FILTER (WHERE status NOT IN ('pending_payment','expired'))::int AS paid,
               count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
               avg(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) FILTER (WHERE status = 'delivered')::float AS avg_minutes
          FROM shop_orders
         WHERE created_at > (date_trunc('day', NOW() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')`),
    ]);
    const now = Date.now();
    const orders = rows.rows.map((o) => ({
      orderNo: o.order_no, status: o.status, option: o.option, total: Number(o.total) || 0,
      name: (o.customer && o.customer.name) || "", ageMin: Math.floor((now - new Date(o.created_at).getTime()) / 60000),
      ready: Boolean(o.pos_ready_at),
      // محطتا المندوب (وصل المطعم / استلم) — نفس أعمدة البوابة (dl_shipments)
      courier: o.ship_status ? { provider: o.ship_provider, status: o.ship_status, driver: (o.ship_driver && o.ship_driver.name) || null,
        arrivedAt: o.ship_arrived_at || null, pickedAt: o.ship_picked_at || null } : null,
      readyAt: o.pos_ready_at || null,
      sla: slaCheck(o, sla, now),
    }));
    return c.json({ ok: true, sla, orders, breaches: orders.filter((o) => o.sla.level >= 2).length,
      late: orders.filter((o) => o.sla.level === 1).length, today: today.rows[0] });
  });

  // الهدف اليومي لطلبات الموقع (المالك — المسار بيقع على «الإعدادات»)
  app.put("/api/cms/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const t = Math.round(Number(b.dailyTarget));
    if (!(t >= 1 && t <= 100000)) return bad(c, "bad_target");
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'cms' THEN data ELSE jsonb_set(data,'{cms}','{}'::jsonb,true) END,
         '{cms,dailyTarget}', $1::jsonb, true) WHERE id=1`, [jb(t)]);
    return c.json({ ok: true, dailyTarget: t });
  });

  /* الأتمتة: كل ساعة (١٢ الضهر لـ١٠ بالليل بتوقيت الرياض — مفيش رسايل بالليل)
     بنقارن أعضاء الشريحة دلوقتي بآخر مرة. اللي «دخل» جديد بياخد الرسالة، واللي
     خرج بيتشال عشان لو رجع يدخل تاني ياخدها. وقت التشغيل بنسجّل الموجودين
     كنقطة بداية من غير ما نبعتلهم — غير كده تشغيل «النايمين» كان هيبعت لـ١٨٧
     واحد مرة واحدة. ومفيش عميل بياخد رسالة أتمتة أكتر من مرة كل ٢١ يوم. */
  const FLOW_GAP_DAYS = 21;
  const FLOW_RUN_CAP = 200;
  const riyadhHour = () => Number(new Date(Date.now() + 3 * 3600_000).toISOString().slice(11, 13));

  async function flowBaseline(flow) {
    const seg = segById[flow.segment];
    if (!seg) return 0;
    const m = (await customerRows()).filter(seg.test).map((x) => x.pn);
    await pool.query("DELETE FROM cms_flow_members WHERE flow_id=$1", [flow.id]);
    if (m.length) {
      await pool.query(
        `INSERT INTO cms_flow_members(flow_id, phone_norm) SELECT $1, p FROM unnest($2::text[]) p ON CONFLICT DO NOTHING`,
        [flow.id, m]);
    }
    return m.length;
  }

  async function runFlow(flow, cfg) {
    const seg = segById[flow.segment];
    if (!seg) return;
    const rows = (await customerRows()).filter(seg.test);
    const now = new Set(rows.map((x) => x.pn));
    const seen = (await pool.query("SELECT phone_norm FROM cms_flow_members WHERE flow_id=$1", [flow.id])).rows.map((r) => r.phone_norm);
    const seenSet = new Set(seen);
    const left = seen.filter((p) => !now.has(p));
    if (left.length) await pool.query("DELETE FROM cms_flow_members WHERE flow_id=$1 AND phone_norm = ANY($2)", [flow.id, left]);
    const entrants = rows.filter((x) => !seenSet.has(x.pn));
    if (!entrants.length) return;
    // بنسجّلهم دخلوا حتى لو مش هنقدر نوصلهم — عشان مانعيدش كل ساعة
    await pool.query(
      `INSERT INTO cms_flow_members(flow_id, phone_norm) SELECT $1, p FROM unnest($2::text[]) p ON CONFLICT DO NOTHING`,
      [flow.id, entrants.map((x) => x.pn)]);
    const recent = await recentlyMessaged(entrants.map((x) => x.pn), Math.max(FLOW_GAP_DAYS, Number(cfg.minGapDays) || 0));
    let targets = entrants.filter((x) => !recent.has(x.pn));
    if (flow.channel === "push") targets = targets.filter((x) => x.push);
    else {
      if (cfg.smsEnabled !== true) return;
      const codes = await optoutCodes(targets.map((x) => x.pn));
      const optedOut = new Set(targets.filter((x) => codes.get(x.pn)?.opted_out_at).map((x) => x.pn));
      targets = smsRules.filterAudience(targets, { staff: smsRules.staffPhoneSet(await getSettingsData()), optedOut }).list
        .map((x) => ({ ...x, code: codes.get(x.pn)?.optout_code }));
      const room = Math.max(0, Number(cfg.dailySmsCap || 0) - (await smsToday()));
      targets = targets.slice(0, Math.floor(room / 2));
    }
    targets = targets.slice(0, FLOW_RUN_CAP);
    let sent = 0;
    const url = flow.coupon ? `${STORE_PUBLIC()}/?c=${encodeURIComponent(flow.coupon)}` : STORE_PUBLIC();
    for (const p of targets) {
      try {
        let ok = false;
        if (flow.channel === "sms") { await sendMarketingSms(p.pn, smsBody(flow, p)); ok = true; }
        else ok = await notify()?.sendToAudience({ phoneNorm: p.pn, title: "فريش كاتس 🍔",
          body: renderMsg(flow.message, { name: p.name, coupon: flow.coupon }), url });
        if (ok) {
          sent++;
          await pool.query("INSERT INTO cms_flow_log(flow_id, phone_norm) VALUES ($1,$2)", [flow.id, p.pn]);
        }
      } catch (e) { console.error(`[cms] flow ${flow.id} → ${p.pn.slice(-4)}:`, e.message); }
    }
    await pool.query("UPDATE cms_flows SET sent_total = sent_total + $2, last_run_at = NOW() WHERE id=$1", [flow.id, sent]);
    if (sent) console.log(`[cms] flow ${flow.id} (${flow.segment}/${flow.channel}) → ${sent} new entrant(s)`);
  }

  async function flowsTick() {
    const h = riyadhHour();
    if (h < 12 || h >= 22) return;
    const flows = (await pool.query("SELECT * FROM cms_flows WHERE active")).rows;
    if (!flows.length) return;
    segCache = { at: 0, rows: null }; // أعضاء طازة كل دورة
    const cfg = await campaignCfg();
    for (const f of flows) await runFlow(f, cfg).catch((e) => console.error(`[cms] flow ${f.id}:`, e.message));
  }
  setInterval(() => flowsTick().catch((e) => console.error("[cms] flows:", e.message)), 60 * 60_000);

  function flowBody(b) {
    return {
      name: clip(b.name, 80), segment: segById[b.segment] ? b.segment : null,
      channel: b.channel === "sms" ? "sms" : "push", message: clip(b.message, 600),
      coupon: clip(String(b.coupon || "").toUpperCase(), 40),
    };
  }

  app.get("/api/cms/flows", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      `SELECT f.*, (SELECT count(*)::int FROM cms_flow_members m WHERE m.flow_id = f.id) AS tracked
         FROM cms_flows f ORDER BY f.created_at DESC`)).rows;
    return c.json({ ok: true, flows: rows, quietHours: "22:00–12:00", gapDays: FLOW_GAP_DAYS });
  });
  app.post("/api/cms/flows", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const x = flowBody(b);
    if (!x.name || !x.segment || !x.message) return bad(c, "name_segment_message_required");
    const r = await pool.query(
      `INSERT INTO cms_flows(name, segment, channel, message, coupon, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [x.name, x.segment, x.channel, x.message, x.coupon, await who(c)]);
    return c.json({ ok: true, flow: r.rows[0] });
  });
  app.put("/api/cms/flows/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const cur = (await pool.query("SELECT * FROM cms_flows WHERE id=$1", [id])).rows[0];
    if (!cur) return bad(c, "not_found", 404);
    if (Object.keys(b).length === 1 && typeof b.active === "boolean") {
      if (b.active && !cur.active) {
        const n = await flowBaseline(cur); // الموجودين دلوقتي = نقطة البداية، من غير إرسال
        await pool.query("UPDATE cms_flows SET active=TRUE WHERE id=$1", [id]);
        return c.json({ ok: true, active: true, baseline: n });
      }
      await pool.query("UPDATE cms_flows SET active=$2 WHERE id=$1", [id, b.active]);
      return c.json({ ok: true, active: b.active });
    }
    const x = flowBody(b);
    if (!x.name || !x.segment || !x.message) return bad(c, "name_segment_message_required");
    const r = await pool.query(
      `UPDATE cms_flows SET name=$2, segment=$3, channel=$4, message=$5, coupon=$6 WHERE id=$1 RETURNING *`,
      [id, x.name, x.segment, x.channel, x.message, x.coupon]);
    // الشريحة اتغيّرت وهي شغّالة → نقطة بداية جديدة عشان مانبعتش لكل أعضاء الشريحة الجديدة
    if (cur.active && cur.segment !== x.segment) await flowBaseline(r.rows[0]);
    return c.json({ ok: true, flow: r.rows[0] });
  });
  app.delete("/api/cms/flows/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    await pool.query("DELETE FROM cms_flow_members WHERE flow_id=$1", [id]);
    await pool.query("DELETE FROM cms_flows WHERE id=$1", [id]);
    return c.json({ ok: true });
  });

  /* ═══ تقرير المتجر — أرقام الموقع لوحده ════════════════════════════════
     كل التقارير التانية بتقرا من نقطة البيع، وتاب سينس بيسجّل طلبات موقعنا
     بنوع "QR-Menu Orders" — يعني كانت بتتحسب ضمن «داخل المطعم» ومافيش شاشة
     بتقول «الموقع عمل كام». التقرير ده مصدره shop_orders نفسه (مصدرنا
     الأصلي: الجمرك، الرسوم، الكوبون، وقت التوصيل)، وبيقارنه بباقي القنوات. */
  const riyadhDay = (d = Date.now()) => new Date(d + 3 * 3600_000).toISOString().slice(0, 10);
  const RIYADH_DAY = "(o.created_at AT TIME ZONE 'Asia/Riyadh')::date";

  app.get("/api/cms/analytics/store", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("to") || "") ? c.req.query("to") : riyadhDay();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("from") || "")
      ? c.req.query("from") : riyadhDay(Date.now() - 29 * 86400_000);
    const s = await getSettingsData();
    const apps = (Array.isArray(s?.deliveryAppMethods) && s.deliveryAppMethods.length
      ? s.deliveryAppMethods : (DEFAULT_DELIVERY_APPS || [])).map((x) => String(x).toLowerCase());
    // دي بتتحط جوّه وصلات فيها dl_shipments (وعندها عمود status هي كمان)،
    // فلازم العمود يبقى محدّد بالجدول
    const PAID_O = PAID_ONLINE.replace(/\bstatus\b/, "o.status");
    const W = `${PAID_O} AND ${RIYADH_DAY} BETWEEN $1::date AND $2::date`;
    const P = [from, to];

    const [tot, daily, items, coupons, hours, nvr, channels, courier] = await Promise.all([
      pool.query(`
        SELECT count(*)::int AS orders,
               COALESCE(sum(total), 0)::float AS revenue,
               COALESCE(sum(subtotal), 0)::float AS food,
               COALESCE(sum(delivery_fee), 0)::float AS fees,
               COALESCE(sum(tip), 0)::float AS tips,
               COALESCE(sum(discount_amount), 0)::float AS discounts,
               count(*) FILTER (WHERE option = 'delivery')::int AS delivery_orders,
               count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
               count(DISTINCT phone_norm)::int AS customers,
               avg(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60)
                 FILTER (WHERE status = 'delivered')::float AS avg_minutes
          FROM shop_orders o WHERE ${W}`, P),
      pool.query(`
        SELECT ${RIYADH_DAY} AS day, count(*)::int AS orders, COALESCE(sum(total), 0)::float AS revenue
          FROM shop_orders o WHERE ${W} GROUP BY 1 ORDER BY 1`, P),
      pool.query(`
        SELECT it->>'product_id' AS pid,
               sum((it->>'quantity')::numeric)::float AS qty,
               -- وحدة الفلوس بتتخزّن على السطر نفسه (mf) من ١٧ سبتمبر ٢٠٢٦؛
               -- السطور الأقدم من كده كانت كلها نانو-ريال (1e9).
               sum((it->>'quantity')::numeric * COALESCE((it->>'unit_amount')::numeric, 0)
                   / COALESCE(NULLIF((it->>'mf')::numeric, 0), 1e9))::float AS revenue
          FROM shop_orders o, jsonb_array_elements(o.items) it
         WHERE ${W} AND it->>'product_id' IS NOT NULL
         GROUP BY 1 ORDER BY qty DESC LIMIT 12`, P),
      pool.query(`
        SELECT upper(coupon) AS code, count(*)::int AS uses,
               COALESCE(sum(discount_amount), 0)::float AS discount,
               COALESCE(sum(total), 0)::float AS revenue
          FROM shop_orders o WHERE ${W} AND NULLIF(btrim(coupon), '') IS NOT NULL
         GROUP BY 1 ORDER BY uses DESC LIMIT 10`, P),
      pool.query(`
        SELECT EXTRACT(HOUR FROM (o.created_at AT TIME ZONE 'Asia/Riyadh'))::int AS h, count(*)::int AS orders
          FROM shop_orders o WHERE ${W} GROUP BY 1 ORDER BY 1`, P),
      // جديد = أول طلب ليه من الموقع وقع جوّه الفترة
      pool.query(`
        WITH firsts AS (
          SELECT phone_norm, min(created_at) AS f FROM shop_orders o
           WHERE ${PAID_O} AND phone_norm IS NOT NULL GROUP BY 1)
        SELECT count(*) FILTER (WHERE (f.f AT TIME ZONE 'Asia/Riyadh')::date >= $1::date)::int AS new_customers,
               count(*) FILTER (WHERE (f.f AT TIME ZONE 'Asia/Riyadh')::date <  $1::date)::int AS returning_customers
          FROM firsts f
         WHERE EXISTS (SELECT 1 FROM shop_orders o
                        WHERE o.phone_norm = f.phone_norm AND ${W})`, P),
      // نفس فترة التقرير من نقطة البيع: الموقع مقابل التطبيقات مقابل المطعم
      pool.query(`
        SELECT CASE WHEN ${WEBSITE_SQL} THEN 'website'
                    WHEN ${deliverySql("$3::text[]")} THEN 'apps' ELSE 'inhouse' END AS ch,
               count(*)::int AS orders, COALESCE(sum(o.total), 0)::float AS revenue
          FROM ts_orders o
          LEFT JOIN order_sources s ON s.order_id = o.order_id
          LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
         WHERE ${SALES_ONLY} AND o.calendar_day BETWEEN $1::date AND $2::date
         GROUP BY 1`, [...P, apps]),
      pool.query(`
        SELECT count(*)::int AS shipments, COALESCE(sum(sh.cost), 0)::float AS cost
          FROM dl_shipments sh JOIN shop_orders o ON o.order_no = sh.shop_order_no
         WHERE ${W}`, P),
    ]);

    let names = new Map();
    try { names = new Map((await menuItems()).map((i) => [String(i.id), i.name])); } catch { /* المنيو مش متاح — نعرض الرقم */ }
    const t = tot.rows[0];
    const chan = Object.fromEntries(channels.rows.map((r) => [r.ch, { orders: r.orders, revenue: r.revenue }]));
    const n = (v) => Number(v) || 0;

    return c.json({
      ok: true, from, to,
      totals: {
        orders: t.orders, revenue: n(t.revenue), food: n(t.food), fees: n(t.fees), tips: n(t.tips),
        discounts: n(t.discounts), customers: t.customers, delivered: t.delivered,
        deliveryOrders: t.delivery_orders, pickupOrders: t.orders - t.delivery_orders,
        avgOrder: t.orders ? n(t.revenue) / t.orders : 0,
        avgMinutes: t.avg_minutes == null ? null : n(t.avg_minutes),
      },
      // الرسوم اللي حصّلناها من العميل مقابل اللي دفعناه للمندوب
      delivery: { feesCollected: n(t.fees), courierCost: n(courier.rows[0].cost), shipments: courier.rows[0].shipments },
      customers: { new: nvr.rows[0].new_customers, returning: nvr.rows[0].returning_customers },
      daily: daily.rows.map((r) => ({ day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day, orders: r.orders, revenue: n(r.revenue) })),
      hours: hours.rows.map((r) => ({ hour: r.h, orders: r.orders })),
      topItems: items.rows.map((r) => ({ id: r.pid, name: names.get(String(r.pid)) || `صنف ${r.pid}`, qty: n(r.qty), revenue: n(r.revenue) })),
      coupons: coupons.rows.map((r) => ({ code: r.code, uses: r.uses, discount: n(r.discount), revenue: n(r.revenue) })),
      channels: {
        website: chan.website || { orders: 0, revenue: 0 },
        apps: chan.apps || { orders: 0, revenue: 0 },
        inhouse: chan.inhouse || { orders: 0, revenue: 0 },
      },
      note: "أرقام الموقع من نظام المتجر نفسه. المقارنة بين القنوات من نقطة البيع.",
    });
  });

  console.log("[cms] routes ready");
  // `expand` بيتصدّر عشان الـcheckout في shop.js يوسّع الباقة بنفس القواعد
  // بالظبط اللي المتجر عرضها — مفيش نسخة تانية من التسعير في أي مكان.
  return { sectionOf, effectivePerms, sessionUser, whoami, expandBundle: expand, getBundle, offersPagePayload };
}
