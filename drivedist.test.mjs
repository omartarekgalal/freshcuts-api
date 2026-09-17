/* اختبارات مسافة المشوار بالعربية (drivedist.js) — fetch متزيّف، من غير جوجل ولا قاعدة بيانات.
     node --test drivedist.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { makeDriveDistance, resolveRouteKm, googleDriveKm, cacheKey } from "./drivedist.js";
import { computeDeliveryFee, haversineKm } from "./delivery.js";

const STORE = { lat: 21.5881404, lng: 39.1521236 };
const POLICY = { baseKm: 10, baseFee: 20, perKm: 3, maxKm: 10, maxStraightKm: null, routeFactor: 1.3 };
const quiet = () => {};

function fakeFetch(meters, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ routes: [{ distanceMeters: meters, duration: "900s" }] }) };
  };
}

async function quoteAt(to, drive, orderTotal = 100) {
  const straight = haversineKm(STORE.lat, STORE.lng, to.lat, to.lng);
  const rk = await resolveRouteKm({ cfg: POLICY, straightKm: straight, from: STORE, to, drive });
  return { rk, res: computeDeliveryFee(POLICY, { distanceKm: rk.routeKm, straightKm: straight, orderTotal }) };
}

// ~8.2 كم هوائي شمالاً: التقدير القديم 8.2×1.3 = 10.7 → كان مرفوض
const NORTH = { lat: 21.662, lng: 39.1521236 };

test("9.9 كم بالعربية: مقبول، حتى لو التقدير الهوائي القديم كان بيرفضه", async () => {
  const old = computeDeliveryFee(POLICY, {
    distanceKm: haversineKm(STORE.lat, STORE.lng, NORTH.lat, NORTH.lng) * 1.3, orderTotal: 100 });
  assert.equal(old.deliverable, false);
  const drive = makeDriveDistance({ fetchImpl: fakeFetch(9900), keyFn: () => "k", log: quiet });
  const { rk, res } = await quoteAt(NORTH, drive);
  assert.equal(rk.distanceSource, "google");
  assert.equal(rk.driveKm, 9.9);
  assert.equal(res.deliverable, true);
  assert.equal(res.distanceKm, 9.9);
  assert.equal(res.fee, 20); // الرسوم ما اتغيّرتش: 9.9 < baseKm فمفيش كم إضافي
});

test("10.1 كم بالعربية: خارج النطاق out_of_range", async () => {
  const drive = makeDriveDistance({ fetchImpl: fakeFetch(10100), keyFn: () => "k", log: quiet });
  const { rk, res } = await quoteAt(NORTH, drive);
  assert.equal(rk.distanceSource, "google");
  assert.equal(res.deliverable, false);
  assert.equal(res.reason, "out_of_range");
  assert.equal(res.distanceKm, 10.1);
});

test("كاش: نفس النقطة (لحد ~11 م) مابتتحاسبش مرتين", async () => {
  const calls = [];
  const drive = makeDriveDistance({ fetchImpl: fakeFetch(8000, calls), keyFn: () => "k", log: quiet });
  const a = await drive.get(STORE, { lat: 21.62001, lng: 39.16001 });
  const b = await drive.get(STORE, { lat: 21.620012, lng: 39.160008 });
  assert.equal(calls.length, 1);
  assert.equal(a.source, "google");
  assert.equal(b.source, "cache");
  assert.equal(b.km, 8);
  assert.equal(cacheKey(21.62001, 39.16001), "21.6200,39.1600");
});

test("كاش Postgres: بيتقري من الجدول قبل ما يسأل جوجل", async () => {
  const calls = [];
  const pool = { query: async (sql) => (/SELECT km/.test(sql)
    ? { rows: [{ km: "7.25", duration_sec: 600, created_at: new Date() }] } : { rows: [] }) };
  const drive = makeDriveDistance({ pool, fetchImpl: fakeFetch(1, calls), keyFn: () => "k", log: quiet });
  const r = await drive.get(STORE, { lat: 21.6, lng: 39.2 });
  assert.equal(calls.length, 0);
  assert.equal(r.km, 7.25);
});

test("طلب جوجل: Essentials (DRIVE + TRAFFIC_UNAWARE + mask المسافة بس)", async () => {
  const calls = [];
  await googleDriveKm({ from: STORE, to: { lat: 21.6, lng: 39.2 }, key: "k", fetchImpl: fakeFetch(5000, calls) });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.travelMode, "DRIVE");
  assert.equal(body.routingPreference, "TRAFFIC_UNAWARE");
  assert.equal(calls[0].init.headers["X-Goog-FieldMask"], "routes.distanceMeters,routes.duration");
});

test("احتياطي: جوجل فشل (500) → الحساب الهوائي القديم بالظبط، ومفيش سؤال تاني لمدة دقيقة", async () => {
  let n = 0;
  const failing = async () => { n++; return { ok: false, status: 500, json: async () => ({}) }; };
  const drive = makeDriveDistance({ fetchImpl: failing, keyFn: () => "k", log: quiet });
  const { rk, res } = await quoteAt(NORTH, drive);
  const straight = haversineKm(STORE.lat, STORE.lng, NORTH.lat, NORTH.lng);
  assert.equal(rk.distanceSource, "straight");
  assert.equal(rk.driveKm, null);
  assert.equal(rk.routeKm, straight * 1.3);
  assert.equal(res.deliverable, false);
  await quoteAt({ lat: 21.61, lng: 39.16 }, drive);
  assert.equal(n, 1);
});

test("احتياطي: مهلة 3 ثواني (هنا 30ms) → هوائي", async () => {
  const hang = (url, init) => new Promise((_, rej) =>
    init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const drive = makeDriveDistance({ fetchImpl: hang, keyFn: () => "k", timeoutMs: 30, log: quiet });
  const { rk } = await quoteAt({ lat: 21.61, lng: 39.16 }, drive);
  assert.equal(rk.distanceSource, "straight");
});

test("احتياطي: مفيش مفتاح → هوائي من غير أي طلب", async () => {
  const calls = [];
  const drive = makeDriveDistance({ fetchImpl: fakeFetch(1000, calls), keyFn: () => "", log: quiet });
  const { rk } = await quoteAt({ lat: 21.61, lng: 39.16 }, drive);
  assert.equal(rk.distanceSource, "straight");
  assert.equal(calls.length, 0);
});

test("الهوائي أكبر من السقف: مرفوض من غير ما ندفع لجوجل", async () => {
  const calls = [];
  const drive = makeDriveDistance({ fetchImpl: fakeFetch(1000, calls), keyFn: () => "k", log: quiet });
  const { res } = await quoteAt({ lat: 21.70, lng: 39.1521236 }, drive); // ~12.4 كم هوائي
  assert.equal(calls.length, 0);
  assert.equal(res.deliverable, false);
});

test("useDrivingDistance=false في السياسة يقفل جوجل", async () => {
  const calls = [];
  const drive = makeDriveDistance({ fetchImpl: fakeFetch(1000, calls), keyFn: () => "k", log: quiet });
  const rk = await resolveRouteKm({ cfg: { ...POLICY, useDrivingDistance: false }, straightKm: 3, from: STORE, to: NORTH, drive });
  assert.equal(rk.distanceSource, "straight");
  assert.equal(calls.length, 0);
});
