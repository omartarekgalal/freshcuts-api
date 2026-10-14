/* الوقت المتوقع الذكي (ETA1، ١٤/١٠) — node --test smarteta.test.mjs
   الموديل صافي (smarteta-core.js) + ربطه بصفحة التتبع (tracketa.computeTrackEta مع smart) + سطر الواتساب + إعدادات اللوحة. مفيش شبكة ولا جوجل. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  stickDeadline, displayWindow,
  COLD_START, SMART_ETA_DEFAULTS, smartEtaCfg, classifyItems, hourBand, predictPrep, predictDrive, timeline, promise,
  promiseFromPosition, fitModel, backtest, activeModel, hmArabic, stateAt, sampleFacts,
} from "./smarteta-core.js";
import { computeTrackEta } from "./tracketa.js";
import { rowsToSamples, register as registerSmart, etaWaLine, smartTrackContext, recordShownEta } from "./smarteta.js";
import { validatePatch, effectiveOf, FIELD_BY_PATH, GROUPS } from "./deliverycontrol.js";
import { cacheKey } from "./drivedist.js";

const M = 60_000;
const ceil5 = (t) => Math.ceil(t / (5 * M)) * 5 * M;
// ٨:٣٠ م الرياض (ذروة) — و٢:٣٠ م (نهار)
const PEAK = Date.parse("2026-10-14T17:30:00Z");
const QUIET = Date.parse("2026-10-14T11:30:00Z");
const HEAVY = [{ name: "كفتة مشوية بالوزن", variant_name: "كيلو", quantity: 1 }, { name: "طرب مشوي بالوزن", variant_name: "كيلو", quantity: 1 },
  { name: "طبق أرز بسمتي", quantity: 2 }, { name: "بطاطس محمرة", quantity: 2 }, { name: "كلوسلو", quantity: 1 }];
const CREPE = [{ name: "كريب سوبر كرانشي", quantity: 1 }];
const cfg = { ...SMART_ETA_DEFAULTS, dispatchDelayMin: 15 };

test("classify: grill by the kilo / boxes = heavy, a single crepe = light, pizza/pasta on their own", () => {
  const h = classifyItems(HEAVY);
  assert.equal(h.mix, "grill_heavy"); assert.equal(h.kg, 2); assert.equal(h.qty, 7);
  assert.equal(classifyItems(CREPE).mix, "light");
  assert.equal(classifyItems([{ name: "كفتة مشوية بالوزن", variant_name: "ثلث كيلو" }]).mix, "grill");
  assert.equal(classifyItems([{ name: "وجبة نصف دجاجة على الفحم" }]).mix, "grill");
  assert.equal(classifyItems([{ name: "بيتزا تشيكن رانش", variant_name: "وسط" }, { name: "مياه" }]).mix, "pizza");
  assert.equal(classifyItems([{ name: "بوكس العيلة" }]).mix, "grill_heavy");
  assert.equal(classifyItems(JSON.stringify(CREPE)).mix, "light", "items as a JSON string (jsonb from pg can arrive either way)");
  assert.equal(classifyItems(null).mix, "side");
});

test("hour bands follow the Riyadh clock: 11–17 day, 18–20 peak, 23–00 second peak, the rest night", () => {
  assert.deepEqual([11, 17, 18, 20, 21, 23, 0, 1, 3].map(hourBand), ["day", "day", "peak1", "peak1", "night", "peak2", "peak2", "night", "night"]);
});

test("prep: a heavy grill order is slower than a single crepe; the dashboard override wins for its category", () => {
  const h = predictPrep(COLD_START, { ...classifyItems(HEAVY), band: "peak1", dow: 2, load: 2 });
  const c = predictPrep(COLD_START, { ...classifyItems(CREPE), band: "peak1", dow: 2, load: 2 });
  assert.ok(h.med > c.med + 4, `${h.med} vs ${c.med}`);
  const o = predictPrep(COLD_START, { ...classifyItems(CREPE), band: "peak1", dow: 2 }, { ...cfg, prepOverride: { ...cfg.prepOverride, light: 40 } });
  assert.equal(o.override, true); assert.ok(o.med > 35);
});

test("drive: far (Google 18 min) is later than near (Google 3 min); peak hours add the measured traffic", () => {
  const far = predictDrive(COLD_START, { gMin: 18, band: "night" }), near = predictDrive(COLD_START, { gMin: 3, band: "night" });
  assert.ok(far - near > 15, `${far} vs ${near}`);
  assert.ok(predictDrive(COLD_START, { gMin: 10, band: "peak1" }) > predictDrive(COLD_START, { gMin: 10, band: "day" }));
  assert.ok(predictDrive(COLD_START, { routeKm: 8 }) > predictDrive(COLD_START, { routeKm: 2 }), "no Google duration ⇒ route km calibration");
});

test("promise: padded (P80 residual + buffer), rounded UP to 5, never before paid+minTotal, never within 5 min of now", () => {
  const x = { ...classifyItems(HEAVY), gMin: 10, load: 2 };
  const st = { paidAt: PEAK, acceptedAt: PEAK, now: PEAK };
  const p = promise(COLD_START, cfg, st, x);
  const tl = timeline(COLD_START, cfg, st, x);
  assert.equal(p.stage, "s0");
  assert.equal(p.highAt % (5 * M), 0, "rounded to 5 min");
  assert.ok(p.highAt >= tl.deliveredAt + (COLD_START.resid.s0[80] + 5) * M, "median + P80 residual + 5 buffer");
  assert.ok(p.highAt - p.lowAt <= cfg.maxRangeMin * M && p.highAt > p.lowAt, "range ≤ maxRangeMin, high is the promise");
  // more conservative percentile ⇒ later
  assert.ok(promise(COLD_START, { ...cfg, percentile: 95 }, st, x).highAt > p.highAt);
  // tiny order very close: the floor holds
  const tiny = promise(COLD_START, { ...cfg, minTotalMin: 60 }, st, { ...classifyItems(CREPE), gMin: 1 });
  assert.ok(tiny.highAt >= PEAK + 60 * M);
  // an order stuck for 2 hours: no number (a promise there is a lie)
  const stuck = promise(COLD_START, cfg, { paidAt: PEAK - 130 * M, acceptedAt: PEAK - 130 * M, now: PEAK }, x);
  assert.equal(stuck.hidden, true);
});

test("fixtures: heavy grill at peak > single crepe in a quiet hour; far > near; known milestones shrink the promise", () => {
  const heavyPeakFar = promise(COLD_START, cfg, { paidAt: PEAK, acceptedAt: PEAK, now: PEAK }, { ...classifyItems(HEAVY), gMin: 18, load: 6 });
  const crepeQuietNear = promise(COLD_START, cfg, { paidAt: QUIET, acceptedAt: QUIET, now: QUIET }, { ...classifyItems(CREPE), gMin: 3, load: 0 });
  const heavyMin = (heavyPeakFar.highAt - PEAK) / M, crepeMin = (crepeQuietNear.highAt - QUIET) / M;
  assert.ok(heavyMin - crepeMin >= 20, `heavy/peak/far ${heavyMin} vs crepe/quiet/near ${crepeMin}`);
  // same heavy order, kitchen pressed «جاهز» and the courier is at the store ⇒ s1, earlier
  const x = { ...classifyItems(HEAVY), gMin: 10, load: 2 };
  const s0 = promise(COLD_START, cfg, { paidAt: PEAK, acceptedAt: PEAK, now: PEAK + 10 * M }, x);
  const s1 = promise(COLD_START, cfg, { paidAt: PEAK, acceptedAt: PEAK, readyAt: PEAK + 12 * M, requestedAt: PEAK + 12 * M, assignedAt: PEAK + 13 * M, arrivedAt: PEAK + 20 * M, now: PEAK + 20 * M }, x);
  assert.equal(s1.stage, "s1");
  const s2 = promise(COLD_START, cfg, { paidAt: PEAK, acceptedAt: PEAK, readyAt: PEAK + 12 * M, arrivedAt: PEAK + 20 * M, pickedAt: PEAK + 22 * M, now: PEAK + 22 * M }, x);
  assert.equal(s2.stage, "s2");
  assert.ok(s2.highAt <= s1.highAt && s1.highAt <= s0.highAt + 5 * M, `${s0.highAt} ${s1.highAt} ${s2.highAt}`);
});

test("after pickup from the live position: closer ⇒ earlier, the pad shrinks with the remaining trip, never in the past", () => {
  const a = promiseFromPosition(COLD_START, cfg, { now: PEAK, remKm: 6, tripKm: 8, band: "peak1", doorMin: 2 });
  const b = promiseFromPosition(COLD_START, cfg, { now: PEAK, remKm: 1, tripKm: 8, band: "peak1", doorMin: 2 });
  assert.ok(b.highAt < a.highAt); assert.ok(b.padMin < a.padMin);
  assert.ok(b.highAt >= PEAK + 3 * M && b.highAt % (5 * M) === 0);
});

test("learning: peak orders that really take longer get a longer prep; near/far drive calibration is learned from our own deliveries", () => {
  const rows = [];
  for (let d = 0; d < 20; d++) {
    for (const [hour, prep] of [[14, 18], [19, 32], [20, 30]]) {
      for (const g of [3, 12]) {
        const paid = Date.parse(`2026-09-${String(10 + d).padStart(2, "0")}T${String(hour - 3).padStart(2, "0")}:00:00Z`) + g * 1000;
        const ready = paid + prep * M, arrived = paid + 25 * M, picked = Math.max(ready, arrived) + 3 * M;
        rows.push({ orderNo: `W${d}${hour}${g}`, option: "delivery", paidAt: paid, acceptedAt: paid, readyAt: ready, requestedAt: paid + 15 * M,
          assignedAt: paid + 16 * M, arrivedAt: arrived, pickedAt: picked, deliveredAt: picked + (4 + 1.5 * g) * M, provider: "leajlak",
          items: CREPE, load: hour === 14 ? 1 : 5, gMin: g, routeKm: g * 0.6 });
      }
    }
  }
  const m = fitModel(rows, { now: Date.parse("2026-10-01T00:00:00Z") });
  assert.equal(m.source, "learned"); assert.ok(m.n.delivery >= 100);
  assert.ok(m.prep.hourAdj.peak1 - m.prep.hourAdj.day > 8, JSON.stringify(m.prep.hourAdj));
  assert.ok(Math.abs(m.drive.b - 1.5) < 0.2 && Math.abs(m.drive.a - 4) < 1.5, JSON.stringify(m.drive));
  const peak = promise(m, cfg, { paidAt: PEAK, acceptedAt: PEAK, now: PEAK }, { ...classifyItems(CREPE), gMin: 3, load: 5 });
  const day = promise(m, cfg, { paidAt: QUIET, acceptedAt: QUIET, now: QUIET }, { ...classifyItems(CREPE), gMin: 3, load: 1 });
  assert.ok((peak.highAt - PEAK) > (day.highAt - QUIET), "peak promise is longer");
  // backtest walk-forward: on its own history the padded promise is kept almost always
  const bt = backtest(rows, { days: 5, cfg, minTrain: 20 });
  assert.ok(bt.summary.s0.n > 0 && bt.summary.s0.hitRate >= 0.9, JSON.stringify(bt.summary.s0));
  // activeModel: too few samples ⇒ cold start; learn switched off ⇒ cold start
  assert.equal(activeModel(m, cfg).source, "learned");
  assert.equal(activeModel(m, { ...cfg, minSamples: 1000 }).source, "cold");
  assert.equal(activeModel(m, { ...cfg, learn: false }).source, "cold");
  assert.equal(activeModel(null, cfg).source, "cold");
});

test("stateAt only uses what was known at that moment (no peeking at later milestones)", () => {
  const s = sampleFacts({ paidAt: PEAK, acceptedAt: PEAK + 10_000, readyAt: PEAK + 20 * M, requestedAt: PEAK + 15 * M, assignedAt: PEAK + 16 * M, arrivedAt: PEAK + 26 * M, pickedAt: PEAK + 28 * M, deliveredAt: PEAK + 45 * M, items: CREPE });
  const s1 = stateAt(s, "s1");
  assert.equal(s1.now, PEAK + 20 * M); assert.equal(s1.arrivedAt, null, "the courier arrived after «ready»"); assert.equal(s1.assignedAt, PEAK + 16 * M);
  assert.equal(stateAt(s, "s0").readyAt, undefined);
});

test("settings: dashboard knobs are validated and out-of-range values fall back to defaults", () => {
  assert.deepEqual(smartEtaCfg({}).percentile, 80);
  const c = smartEtaCfg({ delivery: { smartEta: { percentile: "90", bufferMin: 99, roundMin: "10", enabled: "false", prepOverride: { pizza: 30, light: -4 } } } });
  assert.equal(c.percentile, 90); assert.equal(c.bufferMin, 5, "99 is out of range ⇒ default"); assert.equal(c.roundMin, 10); assert.equal(c.enabled, false);
  assert.equal(c.prepOverride.pizza, 30); assert.equal(c.prepOverride.light, 0);
  // dashboard (deliverycontrol): own group, Arabic labels, enum for the percentile
  assert.ok(GROUPS.some((g) => g.id === "eta"));
  for (const p of ["delivery.smartEta.enabled", "delivery.smartEta.percentile", "delivery.smartEta.bufferMin", "delivery.smartEta.roundMin", "delivery.smartEta.minTotalMin", "delivery.smartEta.maxTotalMin", "delivery.smartEta.prepOverride.grill_heavy", "delivery.smartEta.whatsappLine"]) {
    assert.ok(FIELD_BY_PATH[p], p); assert.equal(FIELD_BY_PATH[p].group, "eta"); assert.match(FIELD_BY_PATH[p].label, /[؀-ۿ]/);
  }
  assert.equal(validatePatch({ "delivery.smartEta.percentile": "85", "delivery.smartEta.bufferMin": 7 }).ok, true);
  assert.equal(validatePatch({ "delivery.smartEta.percentile": "75" }).ok, false);
  assert.equal(validatePatch({ "delivery.smartEta.maxTotalMin": 20 }).ok, false);
  assert.equal(effectiveOf("delivery.smartEta.percentile", {}), "80");
  assert.equal(effectiveOf("delivery.smartEta.prepOverride.pizza", { delivery: { smartEta: { prepOverride: { pizza: 28 } } } }), 28);
});

test("hmArabic: Riyadh 12-hour clock with Latin digits", () => {
  assert.equal(hmArabic(Date.parse("2026-10-14T18:45:00Z")), "9:45 م");
  assert.equal(hmArabic(Date.parse("2026-10-14T21:05:00Z")), "12:05 ص");
  assert.equal(hmArabic(Date.parse("2026-10-14T08:00:00Z")), "11:00 ص");
});

/* ── صفحة التتبع: computeTrackEta مع smart ── */
const CUST = { lat: 21.6241, lng: 39.1521 };
const row = (x = {}) => ({ order_no: "W1790012345678", option: "delivery", status: "accepted", created_at: new Date(PEAK - 10 * M).toISOString(),
  accepted_at: new Date(PEAK - 9 * M).toISOString(), pos_ready_at: null, address: { latitude: CUST.lat, longitude: CUST.lng },
  delivery_quote: { routeKm: 5.2, driveMin: 11 }, items: HEAVY, history: [{ status: "paid", at: new Date(PEAK - 10 * M).toISOString() }], ...x });
const smart = { model: COLD_START, cfg, gMin: 11, load: 3 };

test("track: before pickup the old keys stay (basis prep, range, no precise time) and range.to IS the padded promise", () => {
  const e = computeTrackEta({ row: row(), settings: {}, now: PEAK, smart });
  for (const k of ["at", "minutes", "basis", "soon", "range"]) assert.ok(k in e, k);
  assert.equal(e.basis, "prep"); assert.equal(e.at, null); assert.equal(e.minutes, null);
  assert.equal(e.range.to, e.promise); assert.equal(e.high, e.promise);
  assert.ok(Date.parse(e.range.from) < Date.parse(e.range.to));
  assert.equal(new Date(e.promise).getUTCMinutes() % 5, 0);
  assert.ok(["low", "medium", "high"].includes(e.confidence)); assert.equal(e.stage, "s0");
  for (const k of ["prep", "wait", "drive", "door", "pad"]) assert.ok(k in e.parts, k);
  // smart is MORE conservative than the old flat-settings range (which history kept only ~37%)
  const old = computeTrackEta({ row: row(), settings: {}, now: PEAK });
  assert.ok(Date.parse(e.range.to) >= Date.parse(old.range.to), `${e.range.to} vs ${old.range.to}`);
  // switched off in the dashboard ⇒ the TR1 computation, untouched
  const off = computeTrackEta({ row: row(), settings: {}, now: PEAK, smart: { ...smart, cfg: { ...cfg, enabled: false } } });
  assert.deepEqual(off, old);
});

test("track: after pickup — position basis pads the courier's time; stale position ⇒ route basis from pickup; near ⇒ soon", () => {
  const picked = new Date(PEAK - 2 * M).toISOString();
  const sh = { status: "picked", picked_at: picked, updated_at: new Date(PEAK - 30_000).toISOString(), driver: { location: { latitude: "21.6000", longitude: "39.1521" } } };
  const e = computeTrackEta({ row: row({ status: "on_the_way", pos_ready_at: picked }), sh, settings: {}, now: PEAK, smart });
  assert.equal(e.basis, "position"); assert.equal(e.at, e.promise); assert.ok(e.minutes >= 3); assert.equal(e.stage, "s2");
  const old = computeTrackEta({ row: row({ status: "on_the_way", pos_ready_at: picked }), sh, settings: {}, now: PEAK });
  assert.ok(Date.parse(e.at) >= Date.parse(old.at), "padded vs the raw courier estimate");
  const stale = computeTrackEta({ row: row({ status: "on_the_way" }), sh: { ...sh, updated_at: new Date(PEAK - 20 * M).toISOString() }, settings: {}, now: PEAK, smart });
  assert.equal(stale.basis, "route"); assert.ok(stale.at && stale.minutes > 0);
  const near = computeTrackEta({ row: row({ status: "on_the_way" }), sh: { ...sh, driver: { location: { latitude: String(CUST.lat), longitude: String(CUST.lng + 0.001) } } }, settings: {}, now: PEAK, smart });
  assert.equal(near.soon, true); assert.equal(near.at, null);
  assert.equal(computeTrackEta({ row: row({ status: "delivered" }), settings: {}, now: PEAK, smart }), null);
});

/* ── الطبقة اللي فوق الـDB: عيّنات + سطر الواتساب + تسجيل الوعد ── */
function fakePool(order, ship) {
  const calls = [];
  return {
    calls,
    async query(sql, args) {
      calls.push({ sql, args });
      if (/FROM shop_orders WHERE order_no/.test(sql)) return { rows: order ? [order] : [] };
      if (/FROM dl_shipments WHERE shop_order_no/.test(sql)) return { rows: ship ? [ship] : [] };
      if (/FROM ts_orders/.test(sql)) return { rows: [{ n: 3 }] };
      if (/FROM geo_drive_cache/.test(sql)) return { rows: [{ duration_sec: 660 }] };
      if (/FROM eta_models/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}
test("rowsToSamples: Google duration from the quote first, then the drive cache; incidents (>4 h) dropped", () => {
  const base = { order_no: "W1", option: "delivery", paid: "2026-10-01T15:00:00Z", pos_ready_at: "2026-10-01T15:20:00Z", picked_at: "2026-10-01T15:30:00Z",
    delivered_at: "2026-10-01T15:50:00Z", lat1: "21.6241", lng1: "39.1521", items: CREPE, load: 2 };
  const dur = new Map([[cacheKey(21.6241, 39.1521), 600]]);
  const [a] = rowsToSamples([base], dur); assert.equal(a.gMin, 10);
  const [b] = rowsToSamples([{ ...base, drive_min: "12.5" }], dur); assert.equal(b.gMin, 12.5);
  assert.equal(rowsToSamples([{ ...base, delivered_at: "2026-10-01T21:00:00Z" }], dur).length, 0);
  assert.equal(rowsToSamples([{ ...base, option: "pickup", picked_at: null, delivered_at: null }], dur).length, 1, "pickup orders feed the prep table");
});

test("WhatsApp line «يوصلك خلال 20~30 دقيقة · قبل 4:00 م» comes from the same padded promise, records it, and is off with the switch", async () => {
  const picked = new Date(Date.now() - 2 * 60_000).toISOString();
  const order = { ...row({ status: "on_the_way", pos_ready_at: picked }), history: [{ status: "paid", at: new Date(Date.now() - 30 * 60_000).toISOString() }] };
  const pool = fakePool(order, { status: "picked", picked_at: picked, updated_at: new Date(Date.now() - 20 * 60_000).toISOString() });
  let st = {};
  registerSmart({ get() {} }, { pool, requireAdmin: async () => null, getSettingsData: async () => st, startJobs: false, log: { log() {}, error() {} } });
  const line = await etaWaLine(order.order_no);
  assert.match(line, /^يوصلك خلال \d+~\d+ دقيقة · قبل \d{1,2}:\d{2} [صم]$/);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(pool.calls.some((c) => /INSERT INTO eta_shown\(order_no, wa_high/.test(c.sql)), "the promise said on WhatsApp is recorded for the hit rate");
  st = { delivery: { smartEta: { whatsappLine: false } } };
  assert.equal(await etaWaLine(order.order_no), null);
  st = { delivery: { smartEta: { enabled: false } } };
  assert.equal(await smartTrackContext(order), null);
  // the track recorder throttles: the same promise twice in a minute = one write
  st = {};
  const n0 = pool.calls.filter((c) => /INSERT INTO eta_shown\(order_no, first_at/.test(c.sql)).length;
  const eta = { promise: new Date(Date.now() + 30 * M).toISOString(), stage: "s0", basis: "prep", model: "x" };
  recordShownEta("W9", eta); recordShownEta("W9", eta);
  assert.equal(pool.calls.filter((c) => /INSERT INTO eta_shown\(order_no, first_at/.test(c.sql)).length, n0 + 1);
});

test("cold start is internally consistent (every residual table has every percentile, every mix has a base)", () => {
  for (const s of ["s0", "s1", "s2"]) for (const p of [50, 70, 80, 85, 90, 95]) assert.ok(Number.isFinite(COLD_START.resid[s][p]), `${s} P${p}`);
  for (const k of ["grill_heavy", "grill", "pizza", "pasta", "light", "side"]) assert.ok(COLD_START.prep.base[k] > 10, k);
  assert.ok(ceil5(1) > 0);
});

/* ── قواعد المالك (عمر ١٤/١٠) + «قبل الساعة» الثابت + شكل العرض ── */
test("owner rules: grill/meal ≥30, many items (>6) ≥40, big order (≥200 SAR) +10 — floors on top, never lower; switchable", () => {
  const x = (items, extra = {}) => ({ ...classifyItems(items), band: "night", dow: 2, load: 0, ...extra });
  const grill = predictPrep(COLD_START, x([{ name: "كفتة مشوية بالوزن", variant_name: "ثلث كيلو" }]), cfg);
  assert.equal(grill.med, 30); assert.deepEqual(grill.rules, ["grill_floor"]);
  const meal = predictPrep(COLD_START, x([{ name: "وجبة نصف دجاجة على الفحم" }]), cfg);
  assert.equal(meal.med, 30);
  const crepe = predictPrep(COLD_START, x(CREPE), cfg);
  assert.ok(crepe.med < 30 && crepe.rules.length === 0, "a crepe keeps its learned time");
  const many = predictPrep(COLD_START, x(HEAVY), cfg);   // 7 items, 2 kg grill
  assert.equal(many.med, 40); assert.ok(many.rules.includes("many_items_floor"));
  const big = predictPrep(COLD_START, x(HEAVY, { subtotal: 260 }), cfg);
  assert.equal(big.med, 50); assert.ok(big.rules.includes("big_order"));
  // busy-only: quiet night ⇒ no 40 floor, peak or a loaded kitchen ⇒ floor
  const busyOnly = { ...cfg, manyItemsBusyOnly: true };
  assert.equal(predictPrep(COLD_START, x(HEAVY), busyOnly).med, 30);
  assert.equal(predictPrep(COLD_START, x(HEAVY, { load: 5 }), busyOnly).med, 40);
  assert.equal(predictPrep(COLD_START, x(HEAVY, { band: "peak1" }), busyOnly).med, 40);
  // switched off ⇒ the learned number
  const off = predictPrep(COLD_START, x(HEAVY, { subtotal: 260 }), { ...cfg, ownerRules: false });
  assert.equal(off.med, off.learned); assert.deepEqual(off.rules, []);
  // a learned value already above a floor stays (floors never lower)
  { const hi = predictPrep(COLD_START, x(CREPE), { ...cfg, prepOverride: { ...cfg.prepOverride, light: 45 } }); assert.equal(hi.med, hi.learned); assert.ok(hi.med > 40 && hi.rules.length === 0); }
  // settings + dashboard fields
  const c = smartEtaCfg({ delivery: { smartEta: { grillFloorMin: 25, manyItemsQty: 8, manyItemsBusyOnly: "true", bigOrderSar: 0 } } });
  assert.equal(c.grillFloorMin, 25); assert.equal(c.manyItemsQty, 8); assert.equal(c.manyItemsBusyOnly, true); assert.equal(c.bigOrderSar, 0);
  for (const p of ["ownerRules", "grillFloorMin", "bigOrderSar", "bigOrderExtraMin", "manyItemsQty", "manyItemsFloorMin", "manyItemsBusyOnly", "busyLoad", "stickyStepMin"]) {
    const f = FIELD_BY_PATH["delivery.smartEta." + p]; assert.ok(f, p); assert.equal(f.group, "eta"); assert.match(f.label, /[؀-ۿ]/);
  }
  assert.equal(effectiveOf("delivery.smartEta.grillFloorMin", {}), 30);
  assert.equal(effectiveOf("delivery.smartEta.manyItemsFloorMin", {}), 40);
  assert.equal(validatePatch({ "delivery.smartEta.manyItemsQty": 1 }).ok, false);
});

test("«قبل الساعة» is sticky: later when the estimate passes it, earlier only after pickup by ≥5 min, otherwise unchanged", () => {
  const now = PEAK, D = PEAK + 30 * M;
  assert.deepEqual(stickDeadline({ prevAt: null, nextAt: D, stage: "s0", now }), { at: D, moved: "first" });
  // jitter: new estimate 4 min earlier / 3 min earlier before pickup ⇒ kept
  assert.equal(stickDeadline({ prevAt: D, nextAt: D - 5 * M, rawAt: D - 4 * M, stage: "s0", now }).at, D);
  assert.equal(stickDeadline({ prevAt: D, nextAt: D - 10 * M, rawAt: D - 12 * M, stage: "s1", now }).at, D, "never earlier before pickup");
  // raw estimate passes the deadline ⇒ later (silently)
  const later = stickDeadline({ prevAt: D, nextAt: D + 5 * M, rawAt: D + 1 * M, stage: "s0", now });
  assert.equal(later.at, D + 5 * M); assert.equal(later.moved, "later");
  // after pickup, clearly earlier ⇒ earlier; only slightly earlier ⇒ kept
  assert.equal(stickDeadline({ prevAt: D, nextAt: D - 10 * M, rawAt: D - 11 * M, stage: "s2", now }).at, D - 10 * M);
  assert.equal(stickDeadline({ prevAt: D, nextAt: D - 5 * M, rawAt: D - 6 * M, stage: "s2", now }).at, D, "needs 2 more minutes of margin");
  // the old deadline has (almost) passed ⇒ the new one
  assert.equal(stickDeadline({ prevAt: now + M, nextAt: now + 15 * M, stage: "s1", now }).at, now + 15 * M);
});

test("display: «18~28 دقيقة · قبل 4:00 م» — the high end is the minutes to the deadline, the low end = high − width", () => {
  const w = displayWindow(Date.parse("2026-10-14T13:00:00Z"), Date.parse("2026-10-14T12:31:30Z"), cfg);
  assert.equal(w.toMin, 28); assert.equal(w.fromMin, 18); assert.equal(w.text, "18~28 دقيقة · قبل 4:00 م"); assert.equal(w.before, "2026-10-14T13:00:00.000Z");
  const close = displayWindow(PEAK + 4 * M, PEAK, cfg);
  assert.equal(close.fromMin, 1); assert.equal(close.toMin, 4);
});

test("track: eta.window carries the two values and follows the sticky deadline across refreshes", () => {
  const e1 = computeTrackEta({ row: row(), settings: {}, now: PEAK, smart });
  assert.ok(e1.window && e1.window.before === e1.promise && e1.window.toMin === Math.floor((Date.parse(e1.promise) - PEAK) / M));
  assert.match(e1.window.text, /^\d+~\d+ دقيقة · قبل \d{1,2}:\d{2} [صم]$/);
  assert.ok(e1.rules.includes("grill_floor") || e1.rules.includes("many_items_floor"), JSON.stringify(e1.rules));
  // a minute later the kitchen load jumped by one: the shown deadline must not move earlier, and a small later wobble inside the deadline keeps it
  const e2 = computeTrackEta({ row: row(), settings: {}, now: PEAK + M, smart: { ...smart, load: 0, prevAt: Date.parse(e1.promise) + 5 * M } });
  assert.equal(e2.promise, new Date(Date.parse(e1.promise) + 5 * M).toISOString(), "before pickup the deadline is never pulled earlier");
  assert.equal(e2.range.to, e2.promise);
});
