/* صفحة تتبّع العميل (١٤/١٠): المراحل بأوقاتها + «يوصلك تقريباً» — node --test tracketa.test.mjs
   الحساب صافي (tracketa.js) + المسار العام ‎GET /api/shop/track/:orderNo‎ بقاعدة وهمية (مفيش شبكة، ومفيش جوجل). */
import test from "node:test";
import assert from "node:assert/strict";
import { computeTrackEta, trackStages, trackEtaCfg, TRACK_ETA_DEFAULTS, haversineKm } from "./tracketa.js";
import { validatePatch, effectiveOf, FIELD_BY_PATH } from "./deliverycontrol.js";
import { register as registerShop } from "./shop.js";

const STORE = { lat: 21.5881404, lng: 39.1521236 };
const NOW = Date.parse("2026-10-14T17:30:00Z");      // ٨:٣٠ م الرياض
const min = (n) => n * 60_000;
const at = (offMin) => new Date(NOW + min(offMin)).toISOString();
// عميل على بعد ~٤ كم شمال المطعم (خط مستقيم)، ومسافة الطريق المحفوظة وقت التسعير ٥٫٢ كم
const CUST = { lat: 21.6241, lng: 39.1521 };
const row = (x = {}) => ({ order_no: "W1790012345678", option: "delivery", status: "accepted", created_at: at(-10), accepted_at: at(-8), pos_ready_at: null,
  address: { latitude: CUST.lat, longitude: CUST.lng }, delivery_quote: { routeKm: 5.2 }, history: [], ...x });

test("defaults: the dashboard knobs (speed 25 km/h, road factor 1.35, door 2 min, range 15, stale 8) and their limits", () => {
  assert.deepEqual(trackEtaCfg({}), { ...TRACK_ETA_DEFAULTS });
  const c = trackEtaCfg({ delivery: { trackEta: { speedKmh: 30, roadFactor: 9, enabled: false, doorMin: "" } } });
  assert.equal(c.speedKmh, 30); assert.equal(c.roadFactor, 1.35, "out of range ⇒ default, never a wild number"); assert.equal(c.enabled, false); assert.equal(c.doorMin, 2);
});

test("before pickup: a RANGE only (no precise time) from the prep settings + the order's own trip; never earlier than now", () => {
  const e = computeTrackEta({ row: row(), settings: {}, now: NOW });
  assert.equal(e.basis, "prep"); assert.equal(e.at, null); assert.equal(e.minutes, null);
  const from = Date.parse(e.range.from), to = Date.parse(e.range.to);
  assert.ok(from >= NOW + min(5), "the range starts in the future");
  assert.ok(to - from >= min(10), "a real range, at least 10 minutes wide");
  assert.equal(new Date(from).getUTCMinutes() % 5, 0, "rounded to 5 minutes"); assert.equal(new Date(to).getUTCMinutes() % 5, 0);
  // prep 19 from acceptance (11 left) + courier at the store ~12 from now + 2 handover + 5.2 km at 25 km/h (12.5) + 2 at the door ≈ 8:58 ⇒ 8:55–9:10 (start floored to 5 min, + the 15-minute range)
  assert.equal(e.range.from, "2026-10-14T17:55:00.000Z"); assert.equal(e.range.to, "2026-10-14T18:10:00.000Z");
  // the kitchen pressed «جاهز» and the courier is already at the store ⇒ earlier range
  const r2 = computeTrackEta({ row: row({ pos_ready_at: at(-1) }), sh: { status: "assigned", assigned_at: at(-6), arrived_at: at(-1) }, settings: {}, now: NOW });
  assert.ok(Date.parse(r2.range.from) < from, JSON.stringify(r2));
  // a slower city speed from the dashboard pushes it out
  const slow = computeTrackEta({ row: row(), settings: { delivery: { trackEta: { speedKmh: 10 } } }, now: NOW });
  assert.ok(Date.parse(slow.range.from) > from);
});

test("after pickup: ONE time from the courier's position (road ≈ straight × the order's route ratio), refreshed by every position; dashboard factor when there is no route", () => {
  const picked = { status: "picked", picked_at: at(-3), updated_at: at(-0.5), driver: { name: "أحمد", location: { latitude: "21.6061", longitude: "39.1521" } } };
  const e = computeTrackEta({ row: row({ status: "on_the_way" }), sh: picked, settings: {}, now: NOW });
  assert.equal(e.basis, "position"); assert.equal(e.ratio, "route"); assert.equal(e.soon, false);
  const straight = haversineKm({ lat: 21.6061, lng: 39.1521 }, CUST), ratio = 5.2 / haversineKm(STORE, CUST);
  assert.equal(e.minutes, Math.ceil((straight * ratio) / 25 * 60 + 2));
  assert.ok(Date.parse(e.at) >= NOW + min(e.minutes) && Date.parse(e.at) < NOW + min(e.minutes + 1), "at = now + minutes (rounded up to the minute)");
  // the courier moves closer ⇒ fewer minutes
  const closer = computeTrackEta({ row: row({ status: "on_the_way" }), sh: { ...picked, driver: { location: { latitude: "21.6181", longitude: "39.1521" } } }, settings: {}, now: NOW });
  assert.ok(closer.minutes < e.minutes);
  // no stored route distance ⇒ the dashboard road factor
  const nf = computeTrackEta({ row: row({ status: "on_the_way", delivery_quote: null }), sh: picked, settings: { delivery: { trackEta: { roadFactor: 2 } } }, now: NOW });
  assert.equal(nf.ratio, "setting"); assert.equal(nf.minutes, Math.ceil((straight * 2) / 25 * 60 + 2));
});

test("after pickup: stale or missing position ⇒ from the pickup time + the whole trip; once that passes ⇒ «قريب جداً» (soon), never negative", () => {
  const stale = { status: "picked", picked_at: at(-5), updated_at: at(-20), driver: { location: { latitude: "21.6061", longitude: "39.1521" } } };
  const e = computeTrackEta({ row: row({ status: "on_the_way" }), sh: stale, settings: {}, now: NOW });
  assert.equal(e.basis, "route"); assert.equal(e.minutes, Math.ceil(5.2 / 25 * 60 + 2 - 5));
  const late = computeTrackEta({ row: row({ status: "on_the_way" }), sh: { ...stale, picked_at: at(-40) }, settings: {}, now: NOW });
  assert.deepEqual([late.soon, late.at, late.minutes], [true, null, 0]);
  const near = computeTrackEta({ row: row({ status: "on_the_way" }), sh: { status: "picked", picked_at: at(-10), updated_at: at(0), driver: { location: { latitude: String(CUST.lat - 0.002), longitude: String(CUST.lng) } } }, settings: {}, now: NOW });
  assert.equal(near.soon, true, "courier within ~400 m ⇒ soon");
  // the cashier handed it over (handed_at) but the provider has not said «picked» yet ⇒ still counts as picked up
  const handed = computeTrackEta({ row: row({ status: "courier_assigned", handed_at: at(-2) }), sh: { status: "assigned", updated_at: at(-30) }, settings: {}, now: NOW });
  assert.equal(handed.basis, "route");
});

test("no ETA when it would be made up: delivered, cancelled shipment, pickup, table, no coordinates and no route, switched off", () => {
  assert.equal(computeTrackEta({ row: row({ status: "delivered" }), now: NOW }), null);
  assert.equal(computeTrackEta({ row: row({ status: "on_the_way" }), sh: { status: "cancelled" }, now: NOW }), null);
  assert.equal(computeTrackEta({ row: row({ option: "pickup" }), now: NOW }), null);
  assert.equal(computeTrackEta({ row: row({ table_no: 4 }), now: NOW }), null);
  assert.equal(computeTrackEta({ row: row({ address: {}, delivery_quote: null }), now: NOW }), null);
  assert.equal(computeTrackEta({ row: row(), settings: { delivery: { trackEta: { enabled: false } } }, now: NOW }), null);
  assert.equal(computeTrackEta({ row: row({ status: "rejected_refunded" }), now: NOW }), null);
});

test("stages: five steps with their own times; nothing invented for a step not reached", () => {
  const s0 = trackStages({ row: row({ status: "pos_created", accepted_at: null }) });
  assert.deepEqual(s0.steps.map((x) => x.state), ["active", "pending", "pending", "pending", "pending"]);
  assert.deepEqual(s0.steps.map((x) => x.key), ["received", "preparing", "courier_to_store", "picked", "delivered"]);
  const s2 = trackStages({ row: row({ status: "courier_assigned" }), sh: { status: "assigned", assigned_at: at(-2), arrived_at: null } });
  assert.equal(s2.current, 2); assert.equal(s2.steps[2].at, at(-2)); assert.equal(s2.steps[3].at, null);
  const s3 = trackStages({ row: row({ status: "on_the_way" }), sh: { status: "picked", assigned_at: at(-12), arrived_at: at(-6), picked_at: at(-3) } });
  assert.equal(s3.current, 3); assert.equal(s3.steps[3].at, at(-3)); assert.equal(s3.steps[2].arrivedAt, at(-6));
  const s4 = trackStages({ row: row({ status: "delivered" }), sh: { status: "delivered", picked_at: at(-20), delivered_at: at(-1) } });
  assert.ok(s4.steps.every((x) => x.state === "done")); assert.equal(s4.steps[4].at, at(-1));
  assert.equal(trackStages({ row: row({ option: "pickup" }) }), null);
});

test("dashboard: the trackEta knobs live in «التوصيل والمندوبين» (group zone), are validated, and show the effective value", () => {
  for (const k of ["enabled", "speedKmh", "roadFactor", "useRouteRatio", "doorMin", "rangeMin", "staleMin"]) assert.equal(FIELD_BY_PATH[`delivery.trackEta.${k}`].group, "zone", k);
  assert.equal(validatePatch({ "delivery.trackEta.speedKmh": 200 }).ok, false);
  assert.equal(validatePatch({ "delivery.trackEta.speedKmh": 22, "delivery.trackEta.roadFactor": 1.4 }).ok, true);
  assert.equal(effectiveOf("delivery.trackEta.speedKmh", {}), 25);
  assert.equal(effectiveOf("delivery.trackEta.roadFactor", { delivery: { trackEta: { roadFactor: 1.5 } } }), 1.5);
});

/* ═══ المسار العام ═══ */
function build({ order, ship = null, settings = {} } = {}) {
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
  const pool = { query: async (sql) => (/^SELECT \* FROM shop_orders WHERE order_no=\$1/.test(String(sql)) ? { rows: order ? [order] : [] } : { rows: [], rowCount: 0 }) };
  process.env.SHOP_SWEEP_SECONDS = "0";
  registerShop(app, { pool, requireAdmin: async () => null, requireCashierOrAdmin: async () => null, getSettingsData: async () => settings, jb: JSON.stringify, normPhone: (p) => String(p || "").replace(/\D/g, "").slice(-9) }, {
    pay: { configured: () => false }, delivery: { quote: async () => ({}), shipmentOf: async () => ship, cancelShipment: async () => null, dispatchGate: async () => ({ mode: "manual" }), canAutoDispatch: async () => false },
    emitOrder: () => {}, journey: () => ({ emit: () => {} }) });
  const get = (no) => routes["GET /api/shop/track/:orderNo"]({ req: { param: () => no, header: () => undefined, query: () => undefined }, json: (body, status = 200) => ({ body, status }) });
  return { get };
}

test("track route: stages + eta + courier card (first name, masked phone, our /m/ chat link) + the WhatsApp follow button only while the bot is live", async () => {
  const order = row({ status: "on_the_way", created_at: new Date(Date.now() - min(30)).toISOString(), accepted_at: new Date(Date.now() - min(28)).toISOString(), phone_norm: "512345678", total: "120", subtotal: "100", delivery_fee: "20" });
  const ship = { status: "picked", picked_at: new Date(Date.now() - min(2)).toISOString(), updated_at: new Date().toISOString(), assigned_at: new Date(Date.now() - min(15)).toISOString(),
    driver: { name: "أحمد علي", phone: "0551234567", location: { latitude: "21.6061", longitude: "39.1521" } } };
  const s = build({ order, ship, settings: { waBot: { mode: "live" } } });
  const r = (await s.get("W1790012345678")).body;
  assert.equal(r.ok, true);
  assert.equal(r.stages.current, 3);
  assert.equal(r.eta.basis, "position"); assert.ok(r.eta.minutes > 0); assert.ok(Date.parse(r.eta.at) > Date.now());
  assert.equal(r.courier.firstName, "أحمد"); assert.equal(r.courier.phoneMasked, "055•••4567");
  assert.match(r.courier.chatUrl, /^https:\/\/freshcuts\.sa\/m\/W1790012345678\.[A-Za-z0-9]{12}$/); assert.doesNotMatch(r.courier.chatUrl, /0551234567|966551234567/);
  assert.equal(r.wa.follow.url, `https://wa.me/966546715683?text=${encodeURIComponent("مرحبا، أبي أتابع طلبي رقم W1790012345678")}`);   // TRK6: لهجة بيضاء
  assert.equal(r.wa.follow.urlEn, `https://wa.me/966546715683?text=${encodeURIComponent("Hi, I'd like to track my order W1790012345678")}`);
  assert.equal(JSON.stringify(r).includes(String(CUST.lat)), false, "the customer's coordinates never leave the server");
  const off = build({ order, ship, settings: { waBot: { mode: "test" } } });
  assert.equal((await off.get("W1790012345678")).body.wa, null, "bot not live for customers ⇒ no button (nobody would answer)");
  const done = build({ order: { ...order, status: "delivered" }, ship: { ...ship, status: "delivered" }, settings: { waBot: { mode: "live" } } });
  const d = (await done.get("W1790012345678")).body;
  assert.equal(d.wa, null); assert.equal(d.eta, null); assert.equal(d.stages.current, 4);
  const hidden = build({ order, ship, settings: { waBot: { mode: "live", followLink: false } } });
  assert.equal((await hidden.get("W1790012345678")).body.wa, null, "dashboard switch off ⇒ no button");
});
