/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات سجل العروض الحي (offer_registry) — العروض بقت داتا مش كود

   بيحرس الوعود اللي اتقالت لعمر لما العروض اتنقلت للوحة:
     ١) أول تشغيل بيزرع **نفس** القيم الحالية بالظبط (مفيش تاريخ اتغيّر بالنقل)
     ٢) تغيير تاريخ النهاية من اللوحة → كل مستهلك بيشوفه (الكتالوج، الشريط،
        مركز التسويق، الباقة المربوطة) من غير نشر
     ٣) إيقاف العرض → الباقة المربوطة مش قابلة للطلب (المتجر والشيك أوت)
     ٤) القواعد المقفولة مابتتكسرش: مفيش «توفير»، مفيش تطبيقات توصيل، السعر ثابت
     ٥) مفيش عرض من غير تاريخ نهاية

     node --test offers-db.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

// register() في cms/offers بيشغّل مؤقتات — مانخلّيهاش تمسك عملية الاختبار
const realSI = globalThis.setInterval, realST = globalThis.setTimeout;
globalThis.setInterval = (...a) => { const t = realSI(...a); t?.unref?.(); return t; };
globalThis.setTimeout = (...a) => { const t = realST(...a); t?.unref?.(); return t; };

const { Hono } = await import("hono");
const offers = await import("./offers.js");
const { bundleAvailability, kindsFromOffer } = await import("./bundles.js");
const { catalogFeedRows } = await import("./catalog.js");
const { validityText } = await import("./hub.js");
const cms = await import("./cms.js");

const at = (day) => new Date(`${day}T12:00:00Z`);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const ids = (list) => list.map((o) => o.id).sort();
const byId = (id) => offers.offerById(id);

/* داتابيز مزيّفة: بتفهم استعلامات offer_registry و cms_bundles اللي الكود بيبعتها،
   وأي استعلام تاني (زرع جداول الـCMS) بيرجع فاضي. */
function fakePool({ bundles = [] } = {}) {
  const table = new Map();
  const parseCh = (v) => (v == null ? null : typeof v === "string" ? JSON.parse(v) : v);
  return {
    table, bundles, sql: [],
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      this.sql.push(s);
      if (/^INSERT INTO offer_registry/i.test(s)) {
        if (table.has(p[0])) return { rows: [], rowCount: 0 };
        table.set(p[0], { id: p[0], enabled: p[1], from_day: p[2], until_day: p[3], until_provisional: p[4],
          title: p[5], description: p[6], channels: parseCh(p[7]), updated_by: "seed" });
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE offer_registry/i.test(s)) {
        if (!table.has(p[0])) return { rows: [], rowCount: 0 };
        const row = { ...table.get(p[0]), enabled: p[1], from_day: p[2], until_day: p[3], until_provisional: p[4],
          title: p[5], description: p[6], channels: parseCh(p[7]), updated_by: p[8] };
        table.set(p[0], row);
        return { rows: [row], rowCount: 1 };
      }
      if (/FROM offer_registry/i.test(s)) return { rows: [...table.values()].map((r) => ({ ...r })), rowCount: table.size };
      if (/^SELECT \* FROM cms_bundles WHERE slug=\$1/i.test(s)) return { rows: bundles.filter((b) => b.slug === p[0]) };
      if (/^SELECT \* FROM cms_bundles WHERE id=\$1/i.test(s)) return { rows: bundles.filter((b) => b.id === p[0]) };
      if (/^SELECT \* FROM cms_bundles WHERE active/i.test(s)) return { rows: bundles.filter((b) => b.active) };
      if (/^SELECT \* FROM cms_bundles WHERE offer_id IS NOT NULL/i.test(s)) return { rows: bundles.filter((b) => b.offer_id) };
      return { rows: [], rowCount: 0 };
    },
  };
}

async function freshRegistry() {
  offers.resetOffersToSeed();
  const pool = fakePool();
  await offers.ensureOffersSchema(pool);
  await offers.loadOffers(pool);
  return pool;
}

/* القيم الحيّة زي ما اتقرت من GET /api/offers/all يوم ٢٠٢٦-٠٩-١٢ قبل النقل. */
const APPS_NOTE = "صالة · تيك أواي · توصيل من المتجر — غير متاح على تطبيقات التوصيل";
const ALL_CH = { dineIn: true, takeaway: true, delivery: true, deliveryApps: false };
const LIVE_BEFORE_MIGRATION = {
  combo70: { from: null, until: "2026-09-14", untilProvisional: false, active: true, started: true, channels: null, dineInOnly: true, note: "داخل الصالة فقط", price: 70, untilText: "حتى 14 سبتمبر", daysLeft: 2 },
  lamma: { from: null, until: "2026-09-14", untilProvisional: false, active: true, started: true, channels: null, dineInOnly: true, note: "داخل الصالة فقط", price: 100, untilText: "حتى 14 سبتمبر", daysLeft: 2 },
  nd96_kilo: { from: "2026-09-15", until: "2026-09-30", untilProvisional: true, active: false, started: false, upcoming: true, startsIn: 3, channels: ALL_CH, dineInOnly: false, note: APPS_NOTE, price: 96, untilText: "حتى 30 سبتمبر", daysLeft: 18 },
  nd96_box: { from: "2026-09-15", until: "2026-09-30", untilProvisional: true, active: false, started: false, upcoming: true, startsIn: 3, channels: ALL_CH, dineInOnly: false, note: APPS_NOTE, price: 96, untilText: "حتى 30 سبتمبر", daysLeft: 18 },
};

test("أول تشغيل: الجدول بيتزرع بنفس القيم الحيّة بالظبط — النقل ماغيّرش ولا تاريخ", async () => {
  offers.resetOffersToSeed();
  const now = at("2026-09-12");
  const seedView = offers.OFFERS.map((o) => offers.publicOffer(o, now));
  const pool = fakePool();
  const { seeded } = await offers.ensureOffersSchema(pool);
  assert.equal(seeded, 4);
  await offers.loadOffers(pool);
  assert.equal(offers.offersSource().source, "db");
  const dbView = offers.OFFERS.map((o) => offers.publicOffer(o, now));
  assert.deepEqual(dbView, seedView, "قراءة من الجدول لازم تطابق البذرة حرف بحرف");
  for (const p of dbView) {
    const want = LIVE_BEFORE_MIGRATION[p.id];
    for (const [k, v] of Object.entries(want)) assert.deepEqual(p[k], v, `${p.id}.${k}`);
    assert.equal(p.savingsClaim, false);
    assert.equal(p.compareAtPrice, null);
    assert.equal(p.status, p.active ? "live" : "upcoming");
  }
  assert.deepEqual(ids(offers.activeOffers(now)), ["combo70", "lamma"]);
  // الجدول نفسه: التاريخ إجباري على مستوى الداتابيز
  assert.ok(pool.sql.some((s) => /until_day TEXT NOT NULL/.test(s)));
});

test("إعادة التشغيل مابترجّعش البذرة فوق تعديل المالك", async () => {
  const pool = await freshRegistry();
  const r = await offers.saveOffer(pool, "nd96_box", { until: "2026-10-10", untilProvisional: false }, "عمر");
  assert.equal(r.ok, true, r.message);
  await offers.ensureOffersSchema(pool); // إقلاع تاني
  await offers.loadOffers(pool);
  assert.equal(byId("nd96_box").until, "2026-10-10");
  assert.equal(byId("nd96_box").untilProvisional, false);
});

test("تغيير تاريخ النهاية من اللوحة → كل مستهلك بيشوفه من غير نشر", async () => {
  const pool = await freshRegistry();
  const liveArray = offers.OFFERS; // المرجع اللي catalog/content/hub مستوردينه
  const r = await offers.saveOffer(pool, "nd96_kilo", { until: "2026-10-05", untilProvisional: false }, "عمر");
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.changed.sort(), ["until", "untilProvisional"]);

  // نفس المصفوفة (مش نسخة) — أي موديول مستوردها شايف القيمة الجديدة
  assert.equal(offers.OFFERS, liveArray);
  assert.equal(liveArray.find((o) => o.id === "nd96_kilo").until, "2026-10-05");

  const oct2 = at("2026-10-02");
  // شريط العروض /api/offers + /api/catalog/dine-in
  assert.deepEqual(ids(offers.activeOffers(oct2)), ["nd96_kilo"]);
  // صفوف الكتالوج اللي بتروح للمنصات
  assert.deepEqual(ids(offers.catalogOffers(oct2)), ["nd96_kilo"]);
  const p = offers.publicOffer(byId("nd96_kilo"), oct2);
  assert.equal(p.untilText, "حتى 5 أكتوبر");
  assert.equal(p.untilProvisional, false);
  assert.equal(p.daysLeft, 3);

  // feed.csv نفسه
  const menu = [
    { id: "121", title: "صينية اللمة 100 ريال", price: 100, category: "Offers", image: "https://x/1.jpg" },
    { id: "91", title: "كفتة مشوية بالوزن", price: 120, category: "Grill", image: "https://x/2.jpg" },
  ];
  const feed = catalogFeedRows(menu, oct2);
  const feedIds = feed.map((x) => x.id);
  assert.ok(feedIds.includes("offer-nd96-kilo"), "العرض الممدود في الـfeed");
  assert.ok(!feedIds.includes("offer-nd96-box"), "العرض اللي انتهى ٣٠ سبتمبر مش في الـfeed");
  assert.ok(!feedIds.includes("121"), "صينية اللمة انتهت ١٤ سبتمبر — شيلت من الإعلانات");
  // عرض اليوم الوطني متاح تيك أواي وتوصيل — مايتكتبش عليه «داخل الصالة فقط»
  assert.equal(/داخل الصالة فقط/.test(feed.find((x) => x.id === "offer-nd96-kilo").title), false);

  // مركز التسويق (hub.js) بيكتب جملة الصلاحية من نفس السجل
  assert.match(validityText("nd96_kilo"), /5 أكتوبر/);

  // الباقة المربوطة: شغّالة ٢ أكتوبر، ومقفولة بعد ٥ أكتوبر
  const kiloBundle = { id: 1, slug: "national96-grill", active: true, offer_id: "nd96_kilo", order_kinds: ["delivery", "pickup", "dine_in"] };
  assert.equal(bundleAvailability(kiloBundle, p).orderable, true);
  const after = bundleAvailability(kiloBundle, offers.publicOffer(byId("nd96_kilo"), at("2026-10-06")));
  assert.equal(after.orderable, false);
  assert.equal(after.reasons[0].code, "offer_ended");
  const boxBundle = { ...kiloBundle, id: 2, slug: "national96-box", offer_id: "nd96_box" };
  assert.equal(bundleAvailability(boxBundle, offers.publicOffer(byId("nd96_box"), oct2)).orderable, false);
});

test("إيقاف العرض → بيختفي من كل مكان والباقة المربوطة مش قابلة للطلب", async () => {
  const pool = await freshRegistry();
  const d = at("2026-09-13");
  assert.equal(offers.hiddenOfferItemIds(d).has("121"), false);
  const r = await offers.saveOffer(pool, "lamma", { enabled: false }, "عمر");
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(ids(offers.activeOffers(d)), ["combo70"]);
  assert.equal(offers.hiddenOfferItemIds(d).has("121"), true);
  assert.equal(offers.publicOffer(byId("lamma"), d).status, "disabled");
  assert.equal(offers.publicOffer(byId("lamma"), d).statusLabel, "موقوف");
  assert.ok(!catalogFeedRows([{ id: "121", title: "صينية اللمة 100 ريال", price: 100, category: "Offers", image: "https://x" }], d)
    .some((x) => x.id === "121"));
  assert.match(validityText("lamma"), /موقوف/);

  // عرض اليوم الوطني موقوف وسط مدته ⇒ الباقة مرفوضة حتى لو «مفعّلة»
  await offers.saveOffer(pool, "nd96_box", { enabled: false }, "عمر");
  const av = bundleAvailability(
    { active: true, offer_id: "nd96_box", order_kinds: ["delivery"] },
    offers.publicOffer(byId("nd96_box"), at("2026-09-20")));
  assert.equal(av.orderable, false);
  assert.equal(av.reasons[0].code, "offer_disabled");
  // ورجوعه بيرجّع الباقة
  await offers.saveOffer(pool, "nd96_box", { enabled: true }, "عمر");
  assert.equal(bundleAvailability(
    { active: true, offer_id: "nd96_box", order_kinds: ["delivery"] },
    offers.publicOffer(byId("nd96_box"), at("2026-09-20"))).orderable, true);
  // والباقة المسودة بتفضل مقفولة مهما كان العرض
  assert.deepEqual(bundleAvailability(
    { active: false, offer_id: "nd96_box" }, offers.publicOffer(byId("nd96_box"), at("2026-09-20"))).reasons.map((x) => x.code),
  ["bundle_draft"]);
});

test("القواعد المقفولة: مفيش «توفير»، مفيش تطبيقات توصيل، السعر واسم الكتالوج ثابتين", async () => {
  const pool = await freshRegistry();
  const reject = async (body, code) => {
    const r = await offers.saveOffer(pool, "nd96_kilo", body, "x");
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.error, code, JSON.stringify(body));
    assert.ok(r.message && /[؀-ۿ]/.test(r.message), "الرسالة لازم تبقى عربي");
  };
  await reject({ savingsClaim: true }, "locked_field");
  await reject({ compareAt: 120 }, "locked_field");
  await reject({ compareAtPrice: 120 }, "locked_field");
  await reject({ price: 90 }, "locked_field");
  await reject({ catalogTitle: "اسم تاني" }, "locked_field");
  await reject({ channels: { deliveryApps: true } }, "delivery_apps_locked");
  await reject({ desc: "وفّر ٢٠٪ على الكيلو" }, "savings_claim_forbidden");
  await reject({ title: "كيلو مشاوي بخصم" }, "savings_claim_forbidden");
  await reject({ desc: "بـ٩٦ بدلاً من ١١٠" }, "savings_claim_forbidden");
  // «متوفر» مش وعد بتوفير
  const ok = await offers.saveOffer(pool, "nd96_kilo", { desc: "كيلو مشاوي من اختيارك — متوفر صالة وتيك أواي" }, "x");
  assert.equal(ok.ok, true, ok.message);

  // حتى لو حد كتب في الجدول بإيده: الدمج مابيقراش الحقول المقفولة
  const hacked = offers.mergeOffer(offers.OFFER_SEED.find((s) => s.id === "nd96_kilo"), {
    id: "nd96_kilo", enabled: true, from_day: "2026-09-15", until_day: "2026-09-30", title: "x", description: "y",
    channels: { dineIn: true, takeaway: true, delivery: true, deliveryApps: true },
    savingsClaim: true, compareAt: 150, price: 50, catalogTitle: "zzz",
  });
  assert.equal(offers.canClaimSavings(hacked), false);
  assert.equal(offers.publicOffer(hacked).compareAtPrice, null);
  assert.equal(offers.publicOffer(hacked).savingsClaim, false);
  assert.equal(hacked.price, 96);
  assert.equal(hacked.catalogTitle, "كيلو مشاوي + أرز — اليوم الوطني ٩٦ ريال");
  assert.equal(hacked.channels.deliveryApps, false);
  for (const o of offers.OFFERS) {
    assert.equal(offers.canClaimSavings(o), false, o.id);
    if (o.channels) assert.equal(o.channels.deliveryApps, false, o.id);
  }
});

test("مفيش عرض من غير تاريخ نهاية — الحفظ مستحيل", async () => {
  const o = byId("nd96_kilo");
  for (const [body, code] of [
    [{ until: "" }, "until_required"],
    [{ until: null }, "until_required"],
    [{ until: "2026-02-30" }, "bad_until"],
    [{ until: "30/09/2026" }, "bad_until"],
    [{ from: "2026-10-01", until: "2026-09-30" }, "from_after_until"],
    [{ from: "15-09-2026" }, "bad_from"],
    [{ title: "  " }, "title_required"],
    [{ channels: { dineIn: false, takeaway: false, delivery: false } }, "no_channel"],
  ]) {
    const v = offers.validateOfferPatch(o, body);
    assert.equal(v.ok, false, JSON.stringify(body));
    assert.equal(v.error, code, JSON.stringify(body));
  }
  assert.equal(offers.validateOfferPatch(o, { from: "", until: "2026-10-01" }).row.from_day, null);
});

test("القنوات من العرض: الملاحظة وأنواع طلب الباقة بتتبني منها", async () => {
  const pool = await freshRegistry();
  const r = await offers.saveOffer(pool, "nd96_box", { channels: { delivery: false } }, "عمر");
  assert.equal(r.ok, true, r.message);
  const p = offers.publicOffer(byId("nd96_box"), at("2026-09-20"));
  assert.equal(p.note, "صالة · تيك أواي — غير متاح على تطبيقات التوصيل");
  assert.deepEqual(p.channels, { dineIn: true, takeaway: true, delivery: false, deliveryApps: false });
  assert.deepEqual(kindsFromOffer(p), ["dine_in", "pickup"]);
  // الباقة كان مكتوب عليها توصيل — القنوات بتيجي من العرض مش منها
  const av = bundleAvailability({ active: true, offer_id: "nd96_box", order_kinds: ["delivery"] }, p);
  assert.deepEqual(av.kinds, ["dine_in", "pickup"]);
  // صالة بس = «داخل الصالة فقط»
  await offers.saveOffer(pool, "nd96_box", { channels: { dineIn: true, takeaway: false, delivery: false } }, "عمر");
  assert.equal(byId("nd96_box").dineInOnly, true);
  assert.equal(offers.publicOffer(byId("nd96_box")).note, "داخل الصالة فقط");
});

test("HTTP: /api/offers و /api/cms/offers وتشخيص النشر — بالساعة الحقيقية", async () => {
  offers.resetOffersToSeed();
  const today = offers.riyadhDay();
  const pool = fakePool({
    bundles: [
      { id: 1, slug: "national96-grill", name: "كيلو", price: 96, active: true, offer_id: "nd96_kilo",
        order_kinds: ["delivery", "pickup", "dine_in"], sort: 0,
        slots: [{ key: "grill", type: "choice", label: "المشوي", quantity: 1, choices: [{ product_id: "91", variant_option_id: 46 }] }] },
      { id: 2, slug: "national96-box", name: "بوكس", price: 96, active: false, offer_id: "nd96_box",
        order_kinds: ["delivery", "pickup", "dine_in"], sort: 1,
        slots: [{ key: "hawawshi", type: "fixed", label: "حواوشي", quantity: 1, product_id: "21" }] },
    ],
  });
  const app = new Hono();
  const ctx = {
    pool, requireAdmin: async () => null, todayISO: () => today, DEFAULT_DELIVERY_APPS: [],
    getSettingsData: async () => ({}), jb: (x) => JSON.stringify(x), setCmsHooks: () => {},
  };
  const reg = offers.register(app, ctx, { menuRows: async () => [], deliveryApps: async () => [] });
  await reg.ready;
  const cmsApi = cms.register(app, ctx, { notify: () => null });
  const get = async (p) => (await app.request(p)).json();
  const put = async (p, body) => {
    const res = await app.request(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  const diag = await get("/api/cms/offers/diag");
  assert.equal(diag.ok, true);
  assert.equal(diag.build, "offers-registry-v1");
  assert.equal(diag.source, "db");

  // صينية اللمة تنتهي امبارح ⇒ تختفي من الشريط العام فوراً
  let r = await put("/api/cms/offers/lamma", { until: addDays(today, -1) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!(await get("/api/offers")).offers.some((o) => o.id === "lamma"));
  assert.equal((await get("/api/offers/all")).offers.find((o) => o.id === "lamma").status, "ended");
  // وتتمد ⇒ ترجع
  r = await put("/api/cms/offers/lamma", { until: addDays(today, 10) });
  assert.equal(r.status, 200);
  assert.ok((await get("/api/offers")).offers.some((o) => o.id === "lamma"));

  // من غير تاريخ نهاية ⇒ مرفوض برسالة عربي
  r = await put("/api/cms/offers/nd96_kilo", { until: "" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "until_required");

  // الشاشة بتشوف الباقة المربوطة وحالتها
  const list = await get("/api/cms/offers");
  const kilo = list.offers.find((o) => o.id === "nd96_kilo");
  assert.equal(kilo.locked.price, 96);
  assert.equal(kilo.locked.deliveryApps, false);
  assert.deepEqual(kilo.bundles.map((b) => b.slug), ["national96-grill"]);

  // الشيك أوت: عرض الكيلو موقوف ⇒ الباقة مرفوضة رغم إنها «مفعّلة»
  r = await put("/api/cms/offers/nd96_kilo", { enabled: false, from: addDays(today, -1), until: addDays(today, 5) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let ex = await cmsApi.expandBundle("national96-grill", { grill: "91" }, 1, "delivery");
  assert.equal(ex.ok, false);
  assert.equal(ex.error, "offer_not_active");
  assert.equal(ex.reasons[0].code, "offer_disabled");
  // المتجر: مابتظهرش أصلاً (ومن غير ما نكلّم تاب سينس)
  assert.deepEqual((await get("/api/shop/bundles")).bundles, []);
  // عرض لسه مابدأش ⇒ برضه مرفوضة
  await put("/api/cms/offers/nd96_kilo", { enabled: true, from: addDays(today, 1), until: addDays(today, 5) });
  ex = await cmsApi.expandBundle("national96-grill", { grill: "91" }, 1, "delivery");
  assert.equal(ex.reasons[0].code, "offer_upcoming");
  // الباقة المسودة ⇒ bundle_inactive زي الأول
  ex = await cmsApi.expandBundle("national96-box", {}, 1, "delivery");
  assert.equal(ex.ok, false);
  assert.ok(["bundle_inactive", "offer_not_active"].includes(ex.error));
  assert.ok(ex.reasons.some((x) => x.code === "bundle_draft"));
});
