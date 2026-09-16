/* ═══════════════════════════════════════════════════════════════════════════
   W1-03 — صفحة العروض لمحركات البحث (مسار ٠١، الجزء بتاع الـAPI)

   بيحرس:
     • GET /api/shop/offers-page: live بس، delivery/pickup بس، مفيش price_incl/
       compareAt/note، البوكس (أونلاين بس) بيتشال لو باقته مش قابلة للطلب،
       ودايماً HTTP 200 (ok:false عند الخطأ)
     • حد الوقت: ٤ الفجر بالرياض بعد آخر يوم
     • PUT /api/cms/offer-pages/:id: رفض التوفير والعلم والـslug الغلط،
       و409 slug_locked بعد النشر، والصلاحيات (products) + سجل التعديل
     • offer_id في /api/shop/bundles، ورابط حملة target_type=offer

   أوفلاين بالكامل: pool وهمي + tsstore وهمي (مفيش شبكة ولا داتابيز).
     node --test offerpages.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// register() في cms بيشغّل مؤقتات — مانخلّيهاش تمسك عملية الاختبار
const realSI = globalThis.setInterval, realST = globalThis.setTimeout;
globalThis.setInterval = (...a) => { const t = realSI(...a); t?.unref?.(); return t; };
globalThis.setTimeout = (...a) => { const t = realST(...a); t?.unref?.(); return t; };

const { Hono } = await import("hono");
const offers = await import("./offers.js");
const cms = await import("./cms.js");

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/* ── سجل العروض: combo70/lamma موقوفين، والعرضين ٩٦ شغّالين. البوكس أونلاين بس ── */
function applyRegistry({ from, until, kilo = {}, box = {} }) {
  const base = (id, extra) => ({
    id, enabled: true, from_day: from, until_day: until, until_provisional: true,
    title: offers.OFFER_SEED.find((s) => s.id === id).title,
    description: offers.OFFER_SEED.find((s) => s.id === id).desc,
    updated_at: new Date("2026-09-12T10:00:00Z"), ...extra,
  });
  offers.applyOfferRows([
    base("combo70", { enabled: false, from_day: null, until_day: "2026-09-14", channels: null }),
    base("lamma", { enabled: false, from_day: null, until_day: "2026-09-14", channels: null }),
    base("nd96_kilo", { channels: { dineIn: true, takeaway: true, delivery: true, deliveryApps: false }, ...kilo }),
    base("nd96_box", { channels: { dineIn: false, takeaway: true, delivery: true, deliveryApps: false }, ...box }),
  ]);
}

/* ── تاب سينس وهمي ── */
const PRODUCTS = {
  91: { name: "كفتة مشوية بالوزن", price: 100, retail_price: 115, variant: { options: [{ id: 46, name: "كيلو", price: 104, retail_price: 120 }] } },
  94: { name: "شيش طاووق بالوزن", price: 100, retail_price: 115, variant: { options: [{ id: 47, name: "كيلو", price: 96, retail_price: 110 }] } },
  123: { name: "طبق أرز بسمتي", price: 5.22, retail_price: 6 },
  41: { name: "بيتزا سوبر سوبريم", price: 30, retail_price: 34.5 },
  21: { name: "حواوشي سادة", price: 10, retail_price: 11.5 },
};
function fakeTs({ missing = [] } = {}) {
  return {
    STORE: () => "freshcuts",
    fetchMenu: async () => ({ pages: [{ items: [{ id: 91, image: "https://img/91.jpg" }, { id: 41, image: "https://img/41.jpg" }] }] }),
    callStore: async (path) => {
      const id = String(path).split("/").pop();
      if (missing.includes(id) || !PRODUCTS[id]) return { data: null };
      return { data: { id: Number(id), tax_id: 1, ...PRODUCTS[id] } };
    },
  };
}

function bundles({ kiloActive = true, boxActive = true } = {}) {
  return [
    { id: 1, slug: "national96-grill", name: "كيلو مشاوي ٩٦", name_en: "", description: "", image: "", badge: "", price: 96,
      active: kiloActive, offer_id: "nd96_kilo", order_kinds: ["delivery", "pickup", "dine_in"], sort: 0,
      updated_at: new Date("2026-09-13T08:12:00Z"),
      slots: [
        { key: "grill", type: "choice", label: "المشوي", quantity: 1,
          choices: [{ product_id: "91", variant_option_id: 46 }, { product_id: "94", variant_option_id: 47 }] },
        { key: "rice", type: "fixed", label: "أرز", quantity: 1, product_id: "123" },
      ] },
    { id: 2, slug: "national96-box", name: "بوكس ٩٦", name_en: "", description: "", image: "", badge: "", price: 96,
      active: boxActive, offer_id: "nd96_box", order_kinds: ["delivery", "pickup", "dine_in"], sort: 1,
      updated_at: new Date("2026-09-12T09:00:00Z"),
      slots: [
        { key: "pizza", type: "choice", label: "بيتزا", quantity: 1, choices: [{ product_id: "41" }] },
        { key: "hawawshi", type: "fixed", label: "حواوشي", quantity: 1, product_id: "21" },
      ] },
    { id: 3, slug: "family", name: "عائلية", name_en: "", description: "", image: "", badge: "", price: 150,
      active: true, offer_id: null, order_kinds: ["delivery"], sort: 2, updated_at: new Date("2026-09-01T00:00:00Z"),
      slots: [{ key: "hawawshi", type: "fixed", label: "حواوشي", quantity: 1, product_id: "21" }] },
  ];
}

/* ── داتابيز وهمية ── */
const USERS = {
  [sha("cms:7:mk")]: { id: 7, username: "mk", name: "مسوّق", role: "marketing" },
  [sha("cms:1:own")]: { id: 1, username: "omar", name: "عمر", role: "owner" },
};
function fakePool({ bundleRows = bundles(), pages = null, failPages = false } = {}) {
  const pageTable = new Map((pages || [
    { offer_id: "nd96_kilo", slug: "kilo-grills-96", sort: 0 },
    { offer_id: "nd96_box", slug: "national-day-box-96", sort: 1 },
  ]).map((p) => [p.offer_id, { faq: [], indexable: true, published_at: null, updated_at: new Date("2026-09-12T08:00:00Z"), updated_by: "seed", ...p }]));
  const pool = {
    pages: pageTable, audit: [], sql: [],
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      this.sql.push(s);
      if (/offer_pages/i.test(s) && failPages && !/^CREATE|^WITH/i.test(s)) throw new Error("relation \"offer_pages\" does not exist");
      if (/^SELECT \* FROM offer_pages WHERE offer_id=\$1/i.test(s)) {
        const r = pageTable.get(p[0]); return { rows: r ? [{ ...r }] : [], rowCount: r ? 1 : 0 };
      }
      if (/^SELECT \* FROM offer_pages$/i.test(s)) return { rows: [...pageTable.values()].map((r) => ({ ...r })) };
      if (/^UPDATE offer_pages SET published_at/i.test(s)) {
        const r = pageTable.get(p[0]);
        if (r && !r.published_at) { r.published_at = new Date(); return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      if (/^INSERT INTO offer_pages \(offer_id, slug/i.test(s)) {
        const [offer_id, slug, h1, h1_en, seo_title, seo_title_en, meta, meta_en, title_en, desc_en,
          image_web, image_wide, image_og, faq, sort, indexable, updated_by] = p;
        for (const r of pageTable.values()) {
          if (r.offer_id !== offer_id && r.slug === slug) {
            throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
          }
        }
        const cur = pageTable.get(offer_id);
        if (cur && cur.published_at && cur.slug !== slug) return { rows: [], rowCount: 0 }; // حارس الـWHERE
        const row = { ...(cur || { published_at: null }), offer_id, slug, h1, h1_en, seo_title, seo_title_en, meta, meta_en,
          title_en, desc_en, image_web, image_wide, image_og, faq: JSON.parse(faq), sort, indexable,
          updated_at: new Date(), updated_by };
        pageTable.set(offer_id, row);
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (/^SELECT id, updated_at FROM offer_registry/i.test(s)) {
        return { rows: offers.OFFERS.map((o) => ({ id: o.id, updated_at: new Date("2026-09-12T10:00:00Z") })) };
      }
      if (/^SELECT \* FROM cms_bundles WHERE active/i.test(s)) return { rows: bundleRows.filter((b) => b.active) };
      if (/^SELECT \* FROM cms_bundles WHERE offer_id IS NOT NULL/i.test(s)) return { rows: bundleRows.filter((b) => b.offer_id) };
      if (/FROM cms_sessions s JOIN cms_users u ON u.id = s.user_id WHERE s.token_hash = \$1/i.test(s)) {
        const u = USERS[p[0]];
        return { rows: u ? [{ ...u, active: true, expires_at: new Date(Date.now() + 86400000) }] : [] };
      }
      if (/^INSERT INTO cms_audit/i.test(s)) {
        this.audit.push({ method: p[3], path: p[4], section: p[5], note: null });
        return { rows: [{ id: this.audit.length }] };
      }
      if (/^UPDATE cms_audit SET note/i.test(s)) { this.audit[p[0] - 1].note = p[1]; return { rows: [], rowCount: 1 }; }
      if (/^UPDATE cms_links SET clicks/i.test(s)) {
        return { rows: p[0] === "96-kilo" ? [{ slug: "96-kilo", target_type: "offer", target_id: "nd96_kilo",
          utm_source: "tiktok", utm_medium: "paid", utm_campaign: "nd96", coupon: null }] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

function makeApp(poolOpts = {}, { ts = fakeTs(), perms = { marketing: { products: "view" } } } = {}) {
  const pool = fakePool(poolOpts);
  const app = new Hono();
  let hooks = null;
  const ctx = {
    pool, jb: (x) => JSON.stringify(x), DEFAULT_DELIVERY_APPS: [], todayISO: () => offers.riyadhDay(),
    getSettingsData: async () => ({ cms: { perms } }),
    setCmsHooks: (h) => { hooks = h; },
    // نفس requireAdmin بتاع index.js: مفتاح الأدمن بيعدّي، وتوكن الفريق بيتفحص بالقسم
    requireAdmin: async (c) => {
      const h = c.req.header("Authorization") || "";
      if (h === "Bearer ADMIN") { hooks?.audit(c, { kind: "admin" }); return null; }
      if (hooks) { const r = await hooks.resolve(c); if (r === true) return null; if (r) return r; }
      return c.json({ error: "Unauthorized" }, 401);
    },
  };
  const api = cms.register(app, ctx, { notify: () => null, tsstore: ts });
  const call = async (method, path, body, token = "ADMIN") => {
    const res = await app.request(path, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { app, pool, api, call };
}

const liveNow = () => {
  const today = offers.riyadhDay();
  applyRegistry({ from: addDays(today, -3), until: addDays(today, 10) });
  return today;
};

/* ١ */
test("offers-page: العروض الـlive بس — مفيش combo70/lamma (موقوفين) ولا upcoming/ended", async () => {
  liveNow();
  const { call } = makeApp();
  const r = await call("GET", "/api/shop/offers-page");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.headers.get("cache-control"), "public, max-age=60");
  assert.deepEqual(r.body.offers.map((o) => o.id), ["nd96_kilo", "nd96_box"]);
  assert.equal(r.body.today, offers.riyadhDay());
  const kilo = r.body.offers[0];
  assert.equal(kilo.slug, "kilo-grills-96");
  assert.equal(kilo.status, "live");
  assert.equal(kilo.price, 96);
  assert.equal(kilo.currency, "SAR");
  assert.equal(kilo.priceRole, "price");
  assert.equal(kilo.onlineOnly, false);
  assert.equal(kilo.orderableOnline, true);
  assert.deepEqual(kilo.excludes, ["بيبسي"]);
  assert.deepEqual(kilo.channels, { dineIn: true, takeaway: true, delivery: true, deliveryApps: false });
  assert.equal(kilo.untilProvisional, true);
  assert.ok(kilo.untilText.startsWith("حتى "));
  assert.equal(kilo.bundle.slug, "national96-grill");
  assert.equal(kilo.bundle.slots[0].choices[0].name, "كفتة مشوية بالوزن");
  assert.equal(kilo.bundle.slots[0].choices[0].variant_name, "كيلو");
  assert.equal(kilo.bundle.slots[0].choices[0].image, "https://img/91.jpg");
  assert.equal(kilo.bundle.slots[1].item.name, "طبق أرز بسمتي");
  const box = r.body.offers[1];
  assert.equal(box.onlineOnly, true, "البوكس أونلاين بس (dineIn=false)");
  assert.equal(box.channels.dineIn, false);
  // lastmod = أكبر updated_at (باقة الكيلو 2026-09-13T08:12)
  assert.equal(r.body.lastmod, "2026-09-13T08:12:00.000Z");
  assert.equal(kilo.updated_at, "2026-09-13T08:12:00.000Z");

  // عرض لسه مابدأش ⇒ مش موجود، والتاني فاضل
  const today = offers.riyadhDay();
  applyRegistry({ from: addDays(today, -3), until: addDays(today, 10), kilo: { from_day: addDays(today, 1) } });
  assert.deepEqual((await call("GET", "/api/shop/offers-page")).body.offers.map((o) => o.id), ["nd96_box"]);
  // عرض موقوف ⇒ مش موجود
  applyRegistry({ from: addDays(today, -3), until: addDays(today, 10), box: { enabled: false } });
  assert.deepEqual((await call("GET", "/api/shop/offers-page")).body.offers.map((o) => o.id), ["nd96_kilo"]);
  // الاتنين خلصوا امبارح ⇒ فاضية بس ok
  applyRegistry({ from: addDays(today, -10), until: addDays(today, -1) });
  const empty = (await call("GET", "/api/shop/offers-page")).body;
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.offers, []);
  assert.equal(empty.lastmod, null);
});

/* ٢ */
test("حد الوقت: until=2026-09-30 → موجود ٣:٥٩ الفجر بالرياض ومش موجود ٤:٠٠", async () => {
  applyRegistry({ from: "2026-09-12", until: "2026-09-30" });
  const { api } = makeApp();
  const before = await api.offersPagePayload(new Date("2026-10-01T00:59:00Z"));
  assert.deepEqual(before.offers.map((o) => o.id), ["nd96_kilo", "nd96_box"]);
  assert.equal(before.today, "2026-09-30");
  const after = await api.offersPagePayload(new Date("2026-10-01T01:00:00Z"));
  assert.deepEqual(after.offers, []);
  assert.equal(after.today, "2026-10-01");
});

/* ٣ */
test("الرد مفيهوش price_incl ولا compareAt ولا note ولا dine_in", async () => {
  liveNow();
  const { call } = makeApp();
  const r = await call("GET", "/api/shop/offers-page");
  const txt = JSON.stringify(r.body);
  for (const bad of ["price_incl", "compareAt", "compareAtPrice", "\"note\"", "dine_in", "savingsClaim", "داخل الصالة فقط"]) {
    assert.equal(txt.includes(bad), false, `الرد فيه ${bad}`);
  }
  for (const o of r.body.offers) {
    assert.ok(o.bundle.order_kinds.length > 0);
    assert.ok(o.bundle.order_kinds.every((k) => ["delivery", "pickup"].includes(k)), JSON.stringify(o.bundle.order_kinds));
  }
});

/* ٤ */
test("البوكس (أونلاين بس) باقته مسودة ⇒ بيتشال؛ الكيلو باقته مش قابلة للطلب ⇒ orderableOnline:false", async () => {
  liveNow();
  let { call } = makeApp({ bundleRows: bundles({ kiloActive: false, boxActive: false }) });
  let r = await call("GET", "/api/shop/offers-page");
  assert.deepEqual(r.body.offers.map((o) => o.id), ["nd96_kilo"]);
  assert.equal(r.body.offers[0].orderableOnline, false);
  assert.equal(r.body.offers[0].bundle, null);
  assert.ok(r.body.offers[0].components.length > 0, "المكوّنات موجودة كبديل للباقة");

  // صنف في البوكس اتشال من تاب سينس ⇒ الباقة مكسورة ⇒ البوكس بيتشال برضه
  ({ call } = makeApp({}, { ts: fakeTs({ missing: ["41"] }) }));
  r = await call("GET", "/api/shop/offers-page");
  assert.deepEqual(r.body.offers.map((o) => o.id), ["nd96_kilo"]);
  assert.equal(r.body.offers[0].orderableOnline, true);

  // تاب سينس المنيو واقع ⇒ الصفحة شغّالة من غير صور
  const ts = fakeTs();
  ts.fetchMenu = async () => { throw new Error("down"); };
  ({ call } = makeApp({}, { ts }));
  r = await call("GET", "/api/shop/offers-page");
  assert.equal(r.body.ok, true);
  assert.equal(r.body.offers[0].bundle.slots[0].choices[0].image, "");
});

/* ٥ */
test("PUT offer-pages: رفض التوفير والعلم والـslug الغلط", async () => {
  liveNow();
  const { call } = makeApp();
  const cases = [
    [{ seo_title: "وفّر مع بوكس ٩٦" }, 400, "savings_claim_forbidden"],
    [{ meta_en: "Save 20%" }, 400, "savings_claim_forbidden"],
    [{ meta: "بوكس ٩٦ بخصم" }, 400, "savings_claim_forbidden"],
    [{ desc_en: "Big discount on the box" }, 400, "savings_claim_forbidden"],
    [{ faq: [{ q: "فيه عرض؟", a: "أيوه ٢٠٪" }] }, 400, "savings_claim_forbidden"],
    [{ h1: "🇸🇦 بوكس" }, 400, "flag_forbidden"],
    [{ slug: "Box 96" }, 400, "bad_slug"],
    [{ slug: "-box" }, 400, "bad_slug"],
    [{ image_og: "http://x/og.jpg" }, 400, "bad_image"],
    [{ seo_title: "x".repeat(71) }, 400, "too_long"],
    [{ faq: Array.from({ length: 9 }, (_, i) => ({ q: `س${i}`, a: `ج${i}` })) }, 400, "faq_too_many"],
  ];
  for (const [body, status, error] of cases) {
    const r = await call("PUT", "/api/cms/offer-pages/nd96_box", body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.body.error, error, JSON.stringify(body));
    assert.ok(/[؀-ۿ]/.test(r.body.message), "الرسالة عربي");
  }
  assert.equal((await call("PUT", "/api/cms/offer-pages/nope", { h1: "x" })).status, 404);

  // المسموح: الرقم ٩٦ + «متوفر» (مش وعد بتوفير) + صور https و/static
  const ok = await call("PUT", "/api/cms/offer-pages/nd96_box", {
    seo_title: "بوكس اليوم الوطني 96 ر.س – توصيل واستلام | فريش كاتس جدة",
    meta: "بيتزا + باستا + كريب — متوفر توصيل واستلام من حي السلامة، جدة",
    h1_en: "National Day Box 96", title_en: "National Day Box", image_og: "/static/offers/nd96_box-og.jpg",
    image_web: "https://freshcuts.sa/static/offers/nd96_box-web.jpg",
    faq: [{ q: "هل البوكس ينفع في الصالة؟", a: "يتطلب من الموقع استلام وتاكله في الصالة." }, { q: "", a: "" }],
    sort: 1, indexable: false,
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.warnings, []);
  assert.equal(ok.body.page.page.faq.length, 1, "السؤال الفاضي اتشال");
  assert.equal(ok.body.page.page.indexable, false);
  assert.ok(ok.body.changed.includes("seo_title"));
  assert.ok(!ok.body.changed.includes("slug"));

  // رقم غير السعر ⇒ تحذير مش رفض
  const warn = await call("PUT", "/api/cms/offer-pages/nd96_box", { meta: "بوكس ٧٠ و96" });
  assert.equal(warn.status, 200);
  assert.equal(warn.body.warnings.length, 1);
  assert.match(warn.body.warnings[0], /70/);
});

/* ٦ */
test("slug مقفول بعد النشر → 409 slug_locked، وقبل النشر يتغيّر عادي", async () => {
  const today = liveNow();
  const { call, pool } = makeApp({ pages: [
    { offer_id: "nd96_kilo", slug: "kilo-grills-96", sort: 0 },
    { offer_id: "nd96_box", slug: "national-day-box-96", sort: 1 },
  ] });
  // العرض لسه مش live ومش منشور ⇒ الـslug يتغيّر
  applyRegistry({ from: addDays(today, 2), until: addDays(today, 10) });
  let r = await call("PUT", "/api/cms/offer-pages/nd96_kilo", { slug: "kilo-96" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.page.slugLocked, false);
  assert.equal(pool.pages.get("nd96_kilo").slug, "kilo-96");
  // slug مستخدم لعرض تاني ⇒ 409 slug_taken
  r = await call("PUT", "/api/cms/offer-pages/nd96_kilo", { slug: "national-day-box-96" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "slug_taken");

  // العرض بقى live ⇒ أول قراءة عامة بتختم published_at ⇒ الـslug مقفول
  applyRegistry({ from: addDays(today, -1), until: addDays(today, 10) });
  await call("GET", "/api/shop/offers-page");
  await new Promise((res) => setImmediate(res));
  assert.ok(pool.pages.get("nd96_kilo").published_at, "published_at اتختم");
  r = await call("PUT", "/api/cms/offer-pages/nd96_kilo", { slug: "kilo-grills-96" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "slug_locked");
  // نفس الـslug + تعديل تاني ⇒ مسموح
  r = await call("PUT", "/api/cms/offer-pages/nd96_kilo", { slug: "kilo-96", h1: "كيلو مشاوي 96" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.page.slugLocked, true);

  // حتى لو العرض وقف بعدها: published_at بيفضل قافل الرابط
  applyRegistry({ from: addDays(today, -10), until: addDays(today, -1) });
  r = await call("PUT", "/api/cms/offer-pages/nd96_kilo", { slug: "kilo-new" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "slug_locked");

  // عرض مالوش صف (combo70) ⇒ لازم slug عشان يتعمل
  r = await call("PUT", "/api/cms/offer-pages/combo70", { h1: "x" });
  assert.equal(r.body.error, "slug_required");
  r = await call("PUT", "/api/cms/offer-pages/combo70", { slug: "combo-70" });
  assert.equal(r.status, 200);

  // حارس الداتابيز (سباق): الصف اتنشر بعد القراءة ⇒ برضه 409
  pool.pages.get("combo70").published_at = new Date();
  const v = cms.validateOfferPagePatch({ slug: "combo-70" }, { slug: "combo-x" }, { slugLocked: false });
  assert.equal(v.ok, true, "التحقق الصافي عدّى لأن القراءة كانت قبل النشر");
  const origQuery = pool.query.bind(pool);
  pool.query = async (sql, p) => (/^SELECT \* FROM offer_pages WHERE offer_id/i.test(String(sql).trim())
    ? { rows: [{ offer_id: "combo70", slug: "combo-70", published_at: null, faq: [], sort: 0, indexable: true }] }
    : origQuery(sql, p));
  r = await call("PUT", "/api/cms/offer-pages/combo70", { slug: "combo-x" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "slug_locked");
});

/* ٧ */
test("الصلاحيات: مسوّق عنده products/view بس → GET مسموح وPUT 403؛ المالك مسموح + سجل", async () => {
  liveNow();
  const { call, pool } = makeApp();
  let r = await call("GET", "/api/cms/offer-pages", undefined, "cms:7:mk");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.pages.map((p) => p.offer_id), ["combo70", "lamma", "nd96_kilo", "nd96_box"]);
  const kilo = r.body.pages.find((p) => p.offer_id === "nd96_kilo");
  assert.equal(kilo.page.slug, "kilo-grills-96");
  assert.equal(kilo.status, "live");
  assert.equal(kilo.slugLocked, true, "العرض live ⇒ الرابط مقفول");
  assert.equal(kilo.url, "https://freshcuts.sa/offers/kilo-grills-96");
  assert.equal(r.body.pages.find((p) => p.offer_id === "combo70").page, null);
  assert.equal(r.body.pages.find((p) => p.offer_id === "nd96_box").onlineOnly, true);

  r = await call("PUT", "/api/cms/offer-pages/nd96_kilo", { h1: "كيلو 96" }, "cms:7:mk");
  assert.equal(r.status, 403);
  assert.equal(r.body.section, "products");

  r = await call("PUT", "/api/cms/offer-pages/nd96_kilo", { h1: "كيلو مشاوي 96" }, "cms:1:own");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(pool.pages.get("nd96_kilo").updated_by, "عمر");
  await new Promise((res) => setImmediate(res));
  const row = pool.audit.find((a) => a.path === "/api/cms/offer-pages/nd96_kilo");
  assert.equal(row.section, "products");
  assert.match(row.note, /صفحة بحث nd96_kilo: h1/);

  // من غير توكن ⇒ 401
  assert.equal((await call("GET", "/api/cms/offer-pages", undefined, "nope")).status, 401);
});

/* ٨ */
test("/api/shop/bundles فيه offer_id لكل باقة مربوطة (والشكل القديم زي ما هو)", async () => {
  liveNow();
  const { call } = makeApp();
  const r = await call("GET", "/api/shop/bundles");
  assert.equal(r.body.ok, true);
  const by = Object.fromEntries(r.body.bundles.map((b) => [b.slug, b]));
  assert.equal(by["national96-grill"].offer_id, "nd96_kilo");
  assert.equal(by["national96-box"].offer_id, "nd96_box");
  assert.equal(by.family.offer_id, null);
  // المتجر لسه بياخد price_incl وvariant_option_id وdine_in من هنا — مفيش تغيير
  assert.equal(by["national96-grill"].slots[0].choices[0].price_incl, 120);
  assert.equal(by["national96-grill"].slots[0].choices[0].variant_option_id, 46);
  assert.deepEqual(by["national96-grill"].order_kinds, ["dine_in", "pickup", "delivery"]);
  assert.deepEqual(by["national96-box"].order_kinds, ["pickup", "delivery"]);
  assert.deepEqual(Object.keys(by.family).sort(),
    ["badge", "description", "image", "name", "name_en", "offer_id", "order_kinds", "price", "slots", "slug"]);
  // فلتر option لسه شغّال
  const pick = await call("GET", "/api/shop/bundles?option=dine_in");
  assert.deepEqual(pick.body.bundles.map((b) => b.slug), ["national96-grill"]);
});

/* ٩ */
test("resolve لرابط target_type=offer بيرجع /?…go=offers&offer=nd96_kilo…", async () => {
  const { call } = makeApp();
  const r = await call("POST", "/api/cms/links/resolve/96-kilo");
  assert.equal(r.status, 200);
  const u = new URL(r.body.url, "https://freshcuts.sa");
  assert.equal(u.pathname, "/");
  assert.equal(u.searchParams.get("go"), "offers");
  assert.equal(u.searchParams.get("offer"), "nd96_kilo");
  assert.equal(u.searchParams.get("utm_source"), "tiktok");
  assert.equal(u.searchParams.get("fc_link"), "96-kilo");
  assert.equal(u.searchParams.get("p"), null);
});

/* ١٠ */
test("خطأ داتابيز في offers-page → HTTP 200 + ok:false + offers:[]", async () => {
  liveNow();
  const { call } = makeApp({ failPages: true });
  const r = await call("GET", "/api/shop/offers-page");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: false, error: "offers_page_unavailable", offers: [] });
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("الجدول والبذرة: offer_pages + nd96_kilo/nd96_box مرة واحدة (cms_migrations offer-pages-v1)", async () => {
  const { pool } = makeApp();
  await new Promise((res) => realST(res, 20));
  const ddl = pool.sql.find((s) => /CREATE TABLE IF NOT EXISTS offer_pages/.test(s));
  assert.ok(ddl, "CREATE TABLE offer_pages");
  assert.match(ddl, /slug TEXT UNIQUE NOT NULL CHECK/);
  assert.match(ddl, /published_at TIMESTAMPTZ/);
  const seed = pool.sql.find((s) => /INSERT INTO offer_pages\(offer_id, slug, sort, updated_by\)/.test(s));
  assert.ok(seed, "بذرة");
  assert.match(seed, /'offer-pages-v1'/);
  assert.match(seed, /'nd96_kilo', 'kilo-grills-96'/);
  assert.match(seed, /'nd96_box', 'national-day-box-96'/);
  assert.match(seed, /ON CONFLICT DO NOTHING/);
  // الـregex في الداتابيز = نفس الـregex في الكود
  for (const [slug, ok] of [["kilo-grills-96", true], ["national-day-box-96", true], ["a", true], ["Box 96", false],
    ["box-", false], ["-box", false], ["x".repeat(60), true], ["x".repeat(61), false]]) {
    assert.equal(cms.OFFER_PAGE_SLUG_RE.test(slug), ok, slug);
  }
});

test("validateOfferPagePatch صافية: قواعد رسالة ٩٦", () => {
  const cur = { slug: "kilo-grills-96", faq: [], sort: 0, indexable: true };
  const v = (body, opts = { price: 96 }) => cms.validateOfferPagePatch(cur, body, opts);
  assert.equal(v({ h1: "عروض اليوم الوطني ٩٦ – فريش كاتس" }).ok, true);
  assert.deepEqual(v({ h1: "عروض اليوم الوطني ٩٦" }).warnings, [], "٩٦ بالأرقام العربي = السعر");
  assert.equal(v({ meta: "كيلو مشاوي بدلاً من ١٢٠" }).error, "savings_claim_forbidden");
  assert.equal(v({ meta_en: "Kilo grills 96 SAR — 10% off" }).error, "savings_claim_forbidden");
  assert.equal(v({ title_en: "Savings box" }).error, "savings_claim_forbidden");
  // التشكيل والتطويل مايعدّوش الفلتر
  for (const t of ["وفِّر مع البوكس", "وَفّر", "خَصم كبير", "بوكس بخـصم"]) {
    assert.equal(v({ h1: t }).error, "savings_claim_forbidden", t);
  }
  assert.equal(v({ meta_en: "20 percent less" }).error, "savings_claim_forbidden");
  assert.equal(v({ h1: "متوفر توصيل واستلام" }).ok, true, "«متوفر» مش وعد بتوفير");
  assert.equal(v({ desc_en: "Grilled kofta, delivered in Jeddah" }).ok, true);
  assert.equal(v({ faq: [{ q_en: "Is it 🇸🇦?", q: "س", a: "ج" }] }).error, "flag_forbidden");
  assert.equal(v({ faq: [{ q: "س" }] }).error, "faq_incomplete");
  assert.equal(v({ indexable: "yes" }).error, "bad_indexable");
  assert.equal(v({ sort: 1.5 }).error, "bad_sort");
  assert.equal(v({ image_wide: "/static/offers/nd96_kilo-wide.jpg" }).ok, true);
  assert.equal(v({ image_wide: "javascript:alert(1)" }).error, "bad_image");
  assert.equal(v({ h1: 5 }).error, "bad_field");
  assert.deepEqual(v({ image_wide: null }).changed, []);
  assert.deepEqual(v({ h1: "" }).row.h1, null);
  assert.equal(cms.validateOfferPagePatch(null, {}).error, "slug_required");
  assert.equal(cms.validateOfferPagePatch(null, []).error, "bad_body");
});
