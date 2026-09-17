/* Places (New) — التحليل والتكلفة والروابط. مفيش شبكة: fetch محقون. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePlace, parseSearch, validPlaceId, writeReviewUrl, placeMapsUrl,
  monthlyCost, staleAfter, fetchPlaceDetails, searchPlaces, PLACES_SKU, placesKey,
} from "./places.js";

const REAL = {
  id: "ChIJf3COWQDbwxURIbSA8CqW8cw",
  displayName: { text: "فريش كاتس", languageCode: "ar" },
  rating: 4.8, userRatingCount: 181,
  googleMapsUri: "https://maps.google.com/?cid=14767749764292326433&g_mp=Cidnb29nbGU",
};

test("parsePlace بياخد الأرقام الحقيقية وبينضّف رابط الخريطة", () => {
  const p = parsePlace(REAL);
  assert.equal(p.rating, 4.8);
  assert.equal(p.count, 181);
  assert.equal(p.placeId, REAL.id);
  assert.equal(p.name, "فريش كاتس");
  assert.equal(p.mapsUrl, "https://maps.google.com/?cid=14767749764292326433");
});

test("مفيش تقييم = null، مش صفر ولا رقم مخترع", () => {
  assert.equal(parsePlace({ id: "x", rating: 0, userRatingCount: 0 }), null);
  assert.equal(parsePlace({ id: "x", userRatingCount: 12 }), null);      // مفيش rating
  assert.equal(parsePlace({ id: "x", rating: 4.5 }), null);              // مفيش count
  assert.equal(parsePlace({ id: "x", rating: 9, userRatingCount: 3 }), null); // بره المدى
  assert.equal(parsePlace(null), null);
});

test("التقريب لخانة عشرية واحدة", () => {
  assert.equal(parsePlace({ ...REAL, rating: 4.8499 }).rating, 4.8);
  assert.equal(parsePlace({ ...REAL, rating: 4.86 }).rating, 4.9);
});

test("parseSearch بيرجّع مرشحين بمعرّفات صالحة بس", () => {
  const out = parseSearch({ places: [REAL, { id: "", displayName: { text: "لا" } }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].placeId, REAL.id);
});

test("validPlaceId بيرفض الفاضي والرموز الغريبة", () => {
  assert.ok(validPlaceId(REAL.id));
  assert.ok(!validPlaceId(""));
  assert.ok(!validPlaceId("abc"));
  assert.ok(!validPlaceId("ChIJ/../../etc"));
});

test("روابط جوجل بتتبني من المعرّف", () => {
  assert.equal(writeReviewUrl(REAL.id), `https://search.google.com/local/writereview?placeid=${REAL.id}`);
  assert.ok(placeMapsUrl(REAL.id).includes("place_id:" + REAL.id));
  assert.equal(writeReviewUrl(""), "");
});

test("التكلفة: نداء كل ١٢ ساعة جوّه الحد المجاني (صفر دولار)", () => {
  const c = monthlyCost(12);
  assert.equal(c.calls, 60);
  assert.equal(c.billable, 0);
  assert.equal(c.usd, 0);
  assert.equal(PLACES_SKU.details.usd1000, 20);
  // حتى كل ٦ ساعات لسه ببلاش
  assert.equal(monthlyCost(6).usd, 0);
  // كل ساعة = ٧٢٠ نداء، لسه تحت الألف
  assert.equal(monthlyCost(1).billable, 0);
});

test("staleAfter: مفيش تاريخ = قديم، ودلوقتي = مش قديم", () => {
  assert.ok(staleAfter(null, 12));
  assert.ok(staleAfter("مش تاريخ", 12));
  assert.ok(!staleAfter(new Date().toISOString(), 12));
  assert.ok(staleAfter(new Date(Date.now() - 13 * 3600_000).toISOString(), 12));
});

test("fetchPlaceDetails بيبعت المفتاح والقناع والـReferer", async () => {
  let seen = null;
  const p = await fetchPlaceDetails(REAL.id, {
    key: "K", fetchFn: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => REAL }; },
  });
  assert.equal(p.rating, 4.8);
  assert.ok(seen.url.includes(`/places/${REAL.id}`));
  assert.equal(seen.init.headers["X-Goog-Api-Key"], "K");
  assert.ok(seen.init.headers["X-Goog-FieldMask"].includes("userRatingCount"));
  assert.ok(seen.init.headers.Referer.startsWith("http"));
});

test("خطأ جوجل بيطلع برسالته (مش بيرجّع رقم وهمي)", async () => {
  await assert.rejects(() => fetchPlaceDetails(REAL.id, {
    key: "K", fetchFn: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { message: "blocked" } }) }),
  }), /places 403: blocked/);
});

test("من غير مفتاح أو بمعرّف غلط مابنكلّمش جوجل أصلاً", async () => {
  await assert.rejects(() => fetchPlaceDetails(REAL.id, { key: "" }), /no_places_key/);
  await assert.rejects(() => fetchPlaceDetails("!!", { key: "K" }), /bad_place_id/);
});

test("searchPlaces POST بجسم فيه النص", async () => {
  let body = null;
  const out = await searchPlaces("فريش كاتس", {
    key: "K", fetchFn: async (u, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ places: [REAL] }) }; },
  });
  assert.equal(out[0].placeId, REAL.id);
  assert.equal(body.textQuery, "فريش كاتس");
  assert.equal(body.regionCode, "SA");
});

test("placesKey بيفضّل مفتاح السيرفر", () => {
  assert.equal(placesKey({ GOOGLE_PLACES_KEY: "a", GOOGLE_MAPS_BROWSER_KEY: "b" }), "a");
  assert.equal(placesKey({ GOOGLE_MAPS_BROWSER_KEY: "b", GOOGLE_ROUTES_KEY: "c" }), "b");
  assert.equal(placesKey({}), "");
});
