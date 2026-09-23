import { test } from "node:test";
import assert from "node:assert/strict";
import { pausedOffersOf, makeOfferPauseStore } from "./soldout.js";

const NOW = Date.parse("2026-09-23T19:00:00Z");

test("لا إيقاف = كل العروض شغّالة", () => {
  assert.deepEqual(pausedOffersOf({}, NOW), {});
  assert.deepEqual(pausedOffersOf({ catalog: {} }, NOW), {});
});

test("الإيقاف بيبان، واللي عدّى وقته بيرجع لوحده", () => {
  const s = { catalog: { pausedOffers: {
    "national96-grill": { at: "x", until: "2026-09-23T20:00:00Z", name: "كيلو مشاوي" },
    "gathering-4": { at: "x", until: "2026-09-23T18:00:00Z" },   // عدّى
    "gathering-8": { at: "x", until: null },                      // يدوي
  } } };
  const a = pausedOffersOf(s, NOW);
  assert.ok(a["national96-grill"], "لسه موقوف");
  assert.equal(a["gathering-4"], undefined, "عدّى وقته ⇒ رجع شغّال لوحده");
  assert.ok(a["gathering-8"], "اليدوي بيفضل موقوف لحد ما حد يشغّله");
});

test("المفتاح النصي (slug) مقبول والرقم برضه — والقمامة مرفوضة", async () => {
  const q = [];
  const store = makeOfferPauseStore({
    pool: { query: async (sql, args) => { q.push({ sql, args }); return { rows: [] }; } },
    getSettingsData: async () => ({ hours: { enabled: false } }),
    now: () => NOW,
  });
  assert.equal((await store.set("national96-grill", { paused: true, until: null })).ok, true);
  assert.equal((await store.set("gathering-15", { paused: true, until: null })).ok, true);
  for (const bad of ["", "   ", "a b", "x".repeat(65), "درة/../etc"]) {
    const r = await store.set(bad, { paused: true });
    assert.equal(r.ok, false, `لازم يترفض: ${JSON.stringify(bad)}`);
    assert.equal(r.error, "bad_offer_id");
  }
});

test("التشغيل بيمسح المفتاح مش بيسيبه false", async () => {
  const q = [];
  const store = makeOfferPauseStore({
    pool: { query: async (sql, args) => { q.push({ sql, args }); return { rows: [] }; } },
    getSettingsData: async () => ({}),
    now: () => NOW,
  });
  await store.set("gathering-4", { paused: false });
  /* مش آخر استعلام: بعده بيجي سؤال cms_bundles عشان نقفل العرض كمان (٢٤/٩) */
  assert.ok(q.some((x) => /#- ARRAY\['catalog','pausedOffers'/.test(x.sql)),
    "لازم يشيل المفتاح من الإعدادات");
});

test("الإيقاف بيسجّل مين وإمتى — عشان التقرير يعرف", async () => {
  let saved = null;
  const store = makeOfferPauseStore({
    pool: { query: async (_s, args) => { if (args?.[1]) saved = JSON.parse(args[1]); return { rows: [] }; } },
    getSettingsData: async () => ({}),
    now: () => NOW,
  });
  await store.set("national96-box", { paused: true, until: null, by: "محمد عادل", name: "بوكس ٩٦" });
  assert.equal(saved.by, "محمد عادل");
  assert.equal(saved.name, "بوكس ٩٦");
  assert.equal(saved.at, new Date(NOW).toISOString());
  assert.equal(saved.until, null);
});

test("onChange بيتنادى عشان المتجر يلحق التغيير", async () => {
  let hits = 0;
  const store = makeOfferPauseStore({
    pool: { query: async () => ({ rows: [] }) },
    getSettingsData: async () => ({}),
    now: () => NOW,
    onChange: () => { hits++; },
  });
  await store.set("gathering-8", { paused: true, until: null });
  await store.set("gathering-8", { paused: false });
  assert.equal(hits, 2);
});

/* ── إيقاف الباقة يقفل بطل الصفحة كمان (٢٤/٩) ───────────────────────────────
   ليلة ٢٣/٩: الباقات اتوقفت والصفحة فضلت تبيع «كيلو مشاوي» ٣ ساعات، لأن
   الإيقاف بـslug والبطل بـoffer id. الاختبارات دي بتقفل الفجوة دي.        */
function fakePool(bundles = { "national96-grill": "nd96_kilo" }, registry = {}) {
  const sql = [];
  return {
    sql, registry,
    async query(q, a = []) {
      sql.push({ q: q.replace(/\s+/g, " ").trim().slice(0, 70), a });
      if (/FROM cms_bundles/.test(q)) {
        const id = bundles[a[0]];
        return { rows: id ? [{ offer_id: id }] : [], rowCount: id ? 1 : 0 };
      }
      if (/UPDATE offer_registry/.test(q)) {
        const [id, by] = a;
        const row = registry[id];
        const wantOff = /enabled=false/.test(q);
        if (!row) return { rows: [], rowCount: 0 };
        if (wantOff && row.enabled) { row.enabled = false; row.by = by; return { rows: [{ id }], rowCount: 1 }; }
        if (!wantOff && !row.enabled && row.by === by) { row.enabled = true; row.by = by; return { rows: [{ id }], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}
const mk = (pool, extra = {}) => makeOfferPauseStore({
  pool, getSettingsData: async () => ({ hours: { enabled: false } }), now: () => NOW, ...extra });

test("إيقاف الباقة بيقفل العرض في السجل — البطل بيختفي", async () => {
  const pool = fakePool(undefined, { nd96_kilo: { enabled: true, by: "seed" } });
  let refreshed = 0;
  const r = await mk(pool, { refreshOffers: async () => { refreshed++; } })
    .set("national96-grill", { paused: true, until: null });
  assert.equal(r.ok, true);
  assert.equal(pool.registry.nd96_kilo.enabled, false, "العرض لازم يتقفل");
  assert.equal(r.registry.offerId, "nd96_kilo");
  assert.equal(refreshed, 1, "لازم نحدّث السجل في الذاكرة على طول");
});

test("التشغيل بيرجّع العرض اللي إحنا قفلناه", async () => {
  const pool = fakePool(undefined, { nd96_kilo: { enabled: true, by: "seed" } });
  const st = mk(pool);
  await st.set("national96-grill", { paused: true, until: null });
  await st.set("national96-grill", { paused: false });
  assert.equal(pool.registry.nd96_kilo.enabled, true, "رجع شغّال");
});

test("التشغيل **مايرجّعش** عرض حد تاني قافله — ده الشرط اللي بيمنع كارثة", async () => {
  const pool = fakePool(undefined, { nd96_kilo: { enabled: false, by: "عمر" } });
  await mk(pool).set("national96-grill", { paused: false });
  assert.equal(pool.registry.nd96_kilo.enabled, false, "عرض عمر قافله يفضل مقفول");
  assert.equal(pool.registry.nd96_kilo.by, "عمر", "وماينسبش لينا");
});

test("باقة مالهاش عرض في السجل = مفيش عملية ولا خطأ", async () => {
  const pool = fakePool({}, {});
  const r = await mk(pool).set("some-bundle", { paused: true, until: null });
  assert.equal(r.ok, true);
  assert.equal(r.registry, null);
  assert.equal(pool.sql.some((x) => /UPDATE offer_registry/.test(x.q)), false);
});

test("فشل السجل مايوقعش الإيقاف نفسه — الأهم إن الباقة تقف", async () => {
  const pool = fakePool(undefined, { nd96_kilo: { enabled: true, by: "seed" } });
  const boom = { ...pool, async query(q, a) {
    if (/offer_registry/.test(q)) throw new Error("DB down");
    return pool.query(q, a); } };
  const r = await mk(boom).set("national96-grill", { paused: true, until: null });
  assert.equal(r.ok, true, "الإيقاف لازم ينجح برضه");
  assert.equal(r.registry.changed, false);
});
