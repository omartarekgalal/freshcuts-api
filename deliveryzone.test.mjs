/* منطقة التوصيل على الخريطة (deliveryzone.js) — دالة مسافة متزيّفة، من غير جوجل ولا قاعدة بيانات.
     node --test deliveryzone.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDriveZone, circlePolygon, destPoint, fallbackRadiusKm, rayCapKm, makeZoneService, zoneKey,
} from "./deliveryzone.js";
import { makeDriveDistance, googleDriveMatrix } from "./drivedist.js";
import { haversineKm } from "./delivery.js";

const STORE = { lat: 21.5881404, lng: 39.1521236 };
const quiet = () => {};
const kmFrom = (p) => haversineKm(STORE.lat, STORE.lng, p.lat, p.lng);

/* مسافة المشوار = هوائي × معامل (ممكن يختلف حسب الاتجاه) */
const fakeMany = (factorFor, log = []) => async (pts) => {
  log.push(pts.length);
  return { results: pts.map((p) => ({ km: kmFrom(p) * factorFor(p) })), billed: pts.length };
};

/* هل المضلّع بسيط (مفيش ضلعين بيتقاطعوا)؟ */
function selfIntersects(ring) {
  const seg = (a, b, c, d) => {
    const o = (p, q, r) => Math.sign((q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
  };
  const n = ring.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (seg(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
  }
  return false;
}

test("destPoint: 5 كم شمال/شرق بيرجع 5 كم هوائي", () => {
  assert.ok(Math.abs(kmFrom(destPoint(STORE.lat, STORE.lng, 0, 5)) - 5) < 0.01);
  assert.ok(Math.abs(kmFrom(destPoint(STORE.lat, STORE.lng, 90, 5)) - 5) < 0.01);
});

test("بحث الأشعة: معامل 1.3 → نصف القطر ≈ 10/1.3 على كل شعاع، مضلّع بسيط", async () => {
  const z = await buildDriveZone({ center: STORE, maxKm: 10, distMany: fakeMany(() => 1.3) });
  assert.equal(z.polygon.length, 36);
  assert.equal(z.iterations, 6);
  for (const r of z.radiiKm) {
    assert.ok(r <= 10 / 1.3 + 1e-9, `radius ${r} must never overshoot`);
    assert.ok(r >= 10 / 1.3 - 10 / 64 - 0.01, `radius ${r} within one step`);
  }
  assert.ok(!selfIntersects(z.polygon));
});

test("بحث الأشعة: رتيب — الاتجاه اللي شوارعه ألف أطول بيطلع أقصر", async () => {
  // الغرب (bearing 270) بحر/لفّة طويلة: معامل 2.5، الباقي 1.2
  const f = (p) => (p.lng < STORE.lng - 0.01 && Math.abs(p.lat - STORE.lat) < 0.02 ? 2.5 : 1.2);
  const z = await buildDriveZone({ center: STORE, maxKm: 10, distMany: fakeMany(f) });
  assert.ok(z.radiiKm[27] < z.radiiKm[9], "west shorter than east");
  assert.ok(z.radiiKm[9] > 7.9 && z.radiiKm[9] <= 10 / 1.2);
});

test("مفيش طريق (noRoute) = برّه", async () => {
  const z = await buildDriveZone({
    center: STORE, maxKm: 10,
    distMany: async (pts) => ({ results: pts.map(() => ({ noRoute: true })), billed: pts.length }),
  });
  assert.ok(z.radiiKm.every((r) => r === 0.3));
});

test("الميزانية: عمرها ما تتعدّى، ولو ماتكفيش ٣ لفّات → zone_budget", async () => {
  const log = [];
  const z = await buildDriveZone({ center: STORE, maxKm: 10, maxElements: 150, distMany: fakeMany(() => 1.3, log) });
  assert.equal(z.iterations, 4); // 4×36 = 144 ≤ 150
  assert.ok(z.elements <= 150);
  await assert.rejects(
    buildDriveZone({ center: STORE, maxKm: 10, maxElements: 100, distMany: fakeMany(() => 1.3) }),
    /zone_budget/);
});

test("الافتراضي: البناء كله ≤ ٢١٦ عنصر", async () => {
  const log = [];
  const z = await buildDriveZone({ center: STORE, maxKm: 10, distMany: fakeMany(() => 1.3, log) });
  assert.equal(log.reduce((a, b) => a + b, 0), 216);
  assert.equal(z.elements, 216);
});

test("جوجل واقع (أغلب النتايج null) → zone_google_failed", async () => {
  await assert.rejects(
    buildDriveZone({ center: STORE, maxKm: 10, distMany: async (pts) => ({ results: pts.map(() => null), billed: 0 }) }),
    /zone_google_failed/);
});

test("سقف هوائي maxStraightKm أصغر بيقصّ الشعاع + دايرة الاحتياطي", () => {
  assert.equal(rayCapKm({ maxKm: 10, maxStraightKm: 7 }), 7);
  assert.equal(rayCapKm({ maxKm: 10, maxStraightKm: null }), 10);
  assert.ok(Math.abs(fallbackRadiusKm({ maxKm: 10, routeFactor: 1.3 }) - 7.6923) < 1e-3);
  assert.equal(fallbackRadiusKm({ maxKm: 10, routeFactor: 1.3, maxStraightKm: 5 }), 5);
  const c = circlePolygon(STORE, 5, 72);
  assert.equal(c.length, 72);
  assert.ok(c.every((p) => Math.abs(kmFrom({ lat: p[0], lng: p[1] }) - 5) < 0.01));
});

/* ── الخدمة: جدول متزيّف في الذاكرة ── */
function fakePool() {
  const db = { row: null };
  return {
    db,
    query: async (sql, params) => {
      if (/^\s*CREATE/.test(sql)) return { rows: [] };
      if (/SELECT zone_key/.test(sql)) return { rows: db.row ? [db.row] : [] };
      if (/INSERT INTO dl_delivery_zone/.test(sql)) {
        db.row = { zone_key: params[0], max_km: params[1], polygon: JSON.parse(params[2]), meta: JSON.parse(params[3]), computed_at: new Date() };
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}
const CFG = { maxKm: 10, maxStraightKm: null, routeFactor: 1.3 };

test("الخدمة: قبل الحساب → دايرة هوائية؛ بعده → مضلّع المشوار؛ وتاني مرة مابتسألش جوجل", async () => {
  const pool = fakePool();
  let calls = 0;
  const drive = { configured: () => true, getMany: async (from, pts) => { calls += pts.length; return fakeMany(() => 1.25)(pts); } };
  const svc = makeZoneService({ pool, drive, getCfg: async () => CFG, store: () => STORE, log: quiet });
  const before = await svc.current();
  assert.equal(before.source, "straight");
  assert.equal(before.polygon.length, 72);
  assert.equal(calls, 0, "current() never calls Google");
  const r = await svc.refresh();
  assert.equal(r.built, true);
  const after = await svc.current();
  assert.equal(after.source, "drive");
  assert.equal(after.maxKm, 10);
  assert.equal(after.polygon.length, 36);
  assert.ok(after.computedAt);
  assert.deepEqual(after.store, STORE);
  const again = await svc.refresh();
  assert.equal(again.skipped, "fresh");
  assert.equal(calls, 216);
});

test("الخدمة: تغيير maxKm → دايرة لحد ما يتحسب من جديد", async () => {
  const pool = fakePool();
  let cfg = { ...CFG };
  const drive = { configured: () => true, getMany: (from, pts) => fakeMany(() => 1.3)(pts) };
  const svc = makeZoneService({ pool, drive, getCfg: async () => cfg, store: () => STORE, log: quiet });
  await svc.refresh();
  cfg = { ...CFG, maxKm: 12 };
  assert.equal((await svc.current()).source, "straight");
  assert.equal(zoneKey(cfg, STORE) === pool.db.row.zone_key, false);
  assert.equal((await svc.refresh()).built, true);
  assert.equal((await svc.current()).source, "drive");
});

test("الخدمة: فشل جوجل → دايرة، ومفيش محاولة تانية قبل ٦ ساعات", async () => {
  const pool = fakePool();
  let n = 0, t = 1_000_000;
  const drive = { configured: () => true, getMany: async (from, pts) => { n++; return { results: pts.map(() => null), billed: 0 }; } };
  const svc = makeZoneService({ pool, drive, getCfg: async () => CFG, store: () => STORE, log: quiet, now: () => t });
  assert.match((await svc.refresh()).failed, /zone_google_failed/);
  assert.equal((await svc.current()).source, "straight");
  assert.equal((await svc.refresh()).skipped, "retry_later");
  assert.equal(n, 1);
  t += 6 * 3600_000 + 1;
  await svc.refresh();
  assert.equal(n, 2);
});

test("الخدمة: مفتاح جوجل ناقص → مابتحاولش", async () => {
  const svc = makeZoneService({
    pool: fakePool(), drive: { configured: () => false, getMany: async () => { throw new Error("no"); } },
    getCfg: async () => CFG, store: () => STORE, log: quiet,
  });
  assert.equal((await svc.refresh()).skipped, "google_not_configured");
});

/* ── drivedist.getMany: مصفوفة + كاش ── */
function matrixFetch(kmFor, calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const els = body.destinations.map((d, i) => {
      const ll = d.waypoint.location.latLng;
      const km = kmFor({ lat: ll.latitude, lng: ll.longitude });
      const el = { originIndex: 0, destinationIndex: i, status: {} };
      if (i === 0) delete el.destinationIndex; // proto3 بيشيل الصفر
      if (km == null) el.condition = "ROUTE_NOT_FOUND";
      else { el.condition = "ROUTE_EXISTS"; el.distanceMeters = Math.round(km * 1000); el.duration = "600s"; }
      return el;
    });
    return { ok: true, status: 200, json: async () => els };
  };
}

test("getMany: طلب مصفوفة واحد، Essentials mask، الكاش بيوفّر اللفّة التانية", async () => {
  const calls = [];
  const drive = makeDriveDistance({ fetchImpl: matrixFetch((p) => kmFrom(p) * 1.3, calls), keyFn: () => "k", log: quiet });
  const pts = [0, 90, 180].map((b) => destPoint(STORE.lat, STORE.lng, b, 4));
  const a = await drive.getMany(STORE, pts);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("computeRouteMatrix"));
  assert.equal(calls[0].init.headers["X-Goog-FieldMask"], "originIndex,destinationIndex,distanceMeters,duration,status,condition");
  assert.equal(calls[0].body.routingPreference, "TRAFFIC_UNAWARE");
  assert.equal(a.billed, 3);
  assert.ok(Math.abs(a.results[0].km - 5.2) < 0.01);
  const b = await drive.getMany(STORE, pts);
  assert.equal(calls.length, 1);
  assert.equal(b.billed, 0);
  assert.equal(b.results[2].source, "cache");
});

test("getMany: ROUTE_NOT_FOUND → noRoute (مش بيتخزّن)، وفشل HTTP → null من غير رمي", async () => {
  const calls = [];
  const drive = makeDriveDistance({ fetchImpl: matrixFetch(() => null, calls), keyFn: () => "k", log: quiet });
  const r = await drive.getMany(STORE, [{ lat: 21.6, lng: 39.0 }]);
  assert.deepEqual(r.results[0], { noRoute: true });
  const bad = makeDriveDistance({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }), keyFn: () => "k", log: quiet });
  const x = await bad.getMany(STORE, [{ lat: 21.6, lng: 39.2 }]);
  assert.equal(x.results[0], null);
  await assert.rejects(googleDriveMatrix({ from: STORE, tos: [STORE], key: "k",
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }), /matrix_http_500/);
});
