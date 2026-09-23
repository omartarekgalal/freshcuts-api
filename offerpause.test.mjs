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
  assert.match(q.at(-1).sql, /#- ARRAY\['catalog','pausedOffers'/, "لازم يشيل المفتاح من الإعدادات");
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
