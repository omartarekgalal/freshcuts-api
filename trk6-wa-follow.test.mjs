// TRK6a (16/10): the «تابع طلبك على واتساب» banner after paying —
//   1) the ready-made text is white dialect «مرحبا، أبي أتابع طلبي رقم W…» and the bot still answers it with the order status (old text too)
//   2) /api/shop/track gives wa.windowOpen (the customer wrote to us < 20 h ago ⇒ the storefront skips the banner)
//   3) the storefront's wa_follow_* events are accepted by the journey batch
//   4) the daily report counts shown / tapped / chats opened / new windows / free updates after it
// Fake phones only. Run: node --test trk6-wa-follow.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { followLinkOf, followText, FOLLOW_RE, WINDOW_OPEN_SQL, FOLLOW_WINDOW_HOURS, FOLLOW_SQL, followLinkReport, waPolicyCfg, WA_POLICY_DEFAULTS } from "./wapolicy.js";

const NO = "W1790012345678";

test("ready-made text: white dialect, carries the order number, the bot's FOLLOW_RE reads it — and still reads the old «تابع طلبي W…»", () => {
  assert.equal(followText(NO), "مرحبا، أبي أتابع طلبي رقم " + NO);
  assert.equal(followText(NO, "en"), "Hi, I'd like to track my order " + NO);
  const f = followLinkOf({ settings: { waBot: { mode: "live" } }, orderNo: NO, status: "paid" });
  assert.equal(f.url, "https://wa.me/966546715683?text=" + encodeURIComponent("مرحبا، أبي أتابع طلبي رقم " + NO));
  for (const t of [followText(NO), followText(NO, "en"), "تابع طلبي " + NO, "Track my order " + NO, "📲 تابع طلبي رقم " + NO, "track my order #" + NO.toLowerCase(),
    "مرحبا ابي اتابع طلبي " + NO, "مرحباً، أبغى أتابع طلبي رقم " + NO + ".", "السلام عليكم أبي أتابع طلبي " + NO, "hi, i’d like to track my order " + NO, "Hello I want to track my order no. " + NO]) {
    const m = FOLLOW_RE.exec(t);
    assert.ok(m, t);
    assert.equal(m[1].toUpperCase(), NO, t);
  }
  for (const t of ["ابي اتابع طلبي " + NO + " وين وصل وليش تأخر", "مرحبا", "أبي أتابع طلبي", "مرحبا، أبي ألغي طلبي رقم " + NO, "أبي أتابع طلب صاحبي " + NO, "track my order W12"]) {
    assert.equal(FOLLOW_RE.test(t), false, t);
  }
});

test("dashboard settings: banner on by default, skip-hours 20 (0–23, 0 = always show), bad values fall back", () => {
  assert.equal(WA_POLICY_DEFAULTS.followBanner, true); assert.equal(WA_POLICY_DEFAULTS.followBannerSkipHours, 20);
  assert.deepEqual([waPolicyCfg({}).followBanner, waPolicyCfg({}).followBannerSkipHours], [true, 20]);
  assert.equal(waPolicyCfg({ waBot: { followBanner: false } }).followBanner, false);
  assert.equal(waPolicyCfg({ waBot: { followBannerSkipHours: 0 } }).followBannerSkipHours, 0);
  assert.equal(waPolicyCfg({ waBot: { followBannerSkipHours: 6 } }).followBannerSkipHours, 6);
  for (const bad of [24, -1, 2.5, "", null, "x"]) assert.equal(waPolicyCfg({ waBot: { followBannerSkipHours: bad } }).followBannerSkipHours, 20, String(bad));
});

test("the two knobs are in the bot settings schema (dashboard «رسايل الطلب» renders them) and saved/validated like the others", async () => {
  const B = await import("./wabotrun.js");
  const S = B.SCHEMA;
  assert.equal(S.followBanner.type, "boolean"); assert.equal(S.followBanner.group, "orderMsgs");
  assert.equal(S.followBannerSkipHours.type, "number"); assert.deepEqual([S.followBannerSkipHours.min, S.followBannerSkipHours.max, S.followBannerSkipHours.unit], [0, 23, "ساعة"]);
  assert.match(S.followBanner.ar, /بانر «تابع طلبك على واتساب»/); assert.ok(S.followBanner.help.length > 40 && S.followBannerSkipHours.help.length > 40, "Arabic explanation under each knob");
  const ok = B.configFromBody({ followBanner: false, followBannerSkipHours: 6 }, {});
  assert.deepEqual([ok.value?.followBanner ?? ok.followBanner, ok.value?.followBannerSkipHours ?? ok.followBannerSkipHours], [false, 6], JSON.stringify(ok).slice(0, 200));
  const bad = B.configFromBody({ followBannerSkipHours: 30 }, {});
  assert.ok(JSON.stringify(bad.errors || []).includes("followBannerSkipHours"), JSON.stringify(bad).slice(0, 200));
  const cfg = B.botConfig({ waBot: { followBanner: false, followBannerSkipHours: 4 } });
  assert.deepEqual([cfg.followBanner, cfg.followBannerSkipHours], [false, 4]);
  assert.deepEqual([B.botConfig({}).followBanner, B.botConfig({}).followBannerSkipHours], [true, 20]);
});

test("window-open query: by phone, inbound only, last N hours, one row max (index phone_norm, created_at)", () => {
  assert.equal(FOLLOW_WINDOW_HOURS, 20);
  assert.match(WINDOW_OPEN_SQL, /FROM wa_messages WHERE phone_norm=\$1 AND direction='in' AND created_at > NOW\(\) - make_interval\(hours => \$2::int\) LIMIT 1/);
});

/* ═══ /api/shop/track ═══ */
const { register: registerShop } = await import("./shop.js");
function build({ order, settings = {}, inbound = false, fail = false } = {}) {
  const routes = {}, calls = [];
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
  const pool = { query: async (sql, params) => {
    const s = String(sql);
    if (/^SELECT \* FROM shop_orders WHERE order_no=\$1/.test(s)) return { rows: order ? [order] : [] };
    if (s === WINDOW_OPEN_SQL) { calls.push(params); if (fail) throw new Error("db down"); return { rows: inbound ? [{ "?column?": 1 }] : [] }; }
    return { rows: [], rowCount: 0 };
  } };
  process.env.SHOP_SWEEP_SECONDS = "0";
  registerShop(app, { pool, requireAdmin: async () => null, requireCashierOrAdmin: async () => null, getSettingsData: async () => settings, jb: JSON.stringify, normPhone: (p) => String(p || "").replace(/\D/g, "").slice(-9) }, {
    pay: { configured: () => false }, delivery: { quote: async () => ({}), shipmentOf: async () => null, cancelShipment: async () => null, dispatchGate: async () => ({ mode: "manual" }), canAutoDispatch: async () => false },
    emitOrder: () => {}, journey: () => ({ emit: () => {} }) });
  const get = (no) => routes["GET /api/shop/track/:orderNo"]({ req: { param: () => no, header: () => undefined, query: () => undefined }, json: (body, status = 200) => ({ body, status }) });
  return { get, calls };
}
const ORDER = (o = {}) => ({ order_no: NO, status: "paid", option: "delivery", phone_norm: "500000001", total: "79", subtotal: "76", delivery_fee: "3", created_at: new Date(Date.now() - 120000).toISOString(), ...o });
const LIVE = { waBot: { mode: "live" } };

test("track: wa.windowOpen false when the customer has not written to us; true when they did (< 20 h); cached a minute per phone", async () => {
  const a = build({ order: ORDER(), settings: LIVE });
  const r = (await a.get(NO)).body;
  assert.equal(r.wa.windowOpen, false); assert.equal(r.wa.banner, true);
  assert.match(r.wa.follow.url, /^https:\/\/wa\.me\/966546715683\?text=/);
  assert.deepEqual(a.calls[0], ["500000001", 20]);
  const b = build({ order: ORDER({ phone_norm: "500000002" }), settings: LIVE, inbound: true });
  assert.equal((await b.get(NO)).body.wa.windowOpen, true);
  await b.get(NO); await b.get(NO);
  assert.equal(b.calls.length, 1, "the page polls every 12 s — one query a minute per phone");
});

test("track: a DB failure on the window check never breaks tracking (windowOpen false); no follow ⇒ no window query at all", async () => {
  const a = build({ order: ORDER({ phone_norm: "500000003" }), settings: LIVE, fail: true });
  const r = (await a.get(NO)).body;
  assert.equal(r.ok, true); assert.equal(r.wa.windowOpen, false);
  const off = build({ order: ORDER({ phone_norm: "500000004" }), settings: { waBot: { mode: "test" } }, inbound: true });
  assert.equal((await off.get(NO)).body.wa, null);
  assert.equal(off.calls.length, 0);
  const done = build({ order: ORDER({ phone_norm: "500000005", status: "delivered" }), settings: LIVE, inbound: true });
  assert.equal((await done.get(NO)).body.wa, null);
  assert.equal(done.calls.length, 0);
  // dashboard: banner off ⇒ banner:false, no window query (the page button stays); skip-hours from the dashboard; 0 ⇒ no query, always shown
  const off2 = build({ order: ORDER({ phone_norm: "500000006" }), settings: { waBot: { mode: "live", followBanner: false } }, inbound: true });
  const r2 = (await off2.get(NO)).body;
  assert.deepEqual([r2.wa.banner, r2.wa.windowOpen, off2.calls.length], [false, false, 0]);
  assert.ok(r2.wa.follow.url, "the page button keeps its link");
  const h6 = build({ order: ORDER({ phone_norm: "500000007" }), settings: { waBot: { mode: "live", followBannerSkipHours: 6 } }, inbound: true });
  assert.equal((await h6.get(NO)).body.wa.windowOpen, true); assert.deepEqual(h6.calls[0], ["500000007", 6]);
  const h0 = build({ order: ORDER({ phone_norm: "500000008" }), settings: { waBot: { mode: "live", followBannerSkipHours: 0 } }, inbound: true });
  assert.equal((await h0.get(NO)).body.wa.windowOpen, false); assert.equal(h0.calls.length, 0);
});

/* ═══ journey ═══ */
test("journey: the storefront's wa_follow_* events are accepted (banner / pill / track_btn)", async () => {
  const J = await import("./journey.js");
  for (const n of ["wa_follow_shown", "wa_follow_tap", "wa_follow_close"]) assert.ok(J.WEB_EVENTS.includes(n), n);
  const p = J.parseBatch(JSON.stringify({ v: 1, sessionId: "s1abc2def3", anonId: "d1abc2def3", events: [{ n: "wa_follow_shown", t: Date.now(), seq: 1, path: "/track/" + NO, p: { where: "banner" } }, { n: "wa_follow_tap", t: Date.now(), seq: 2, path: "/", p: { where: "pill" } }] }));
  assert.equal(p.error, undefined, JSON.stringify(p));
  assert.equal(p.events.length, 2);
  assert.equal(p.events[0].props.where, "banner");
});

/* ═══ daily report ═══ */
test("report: shown / taps by place, chats that are the ready-made text, windows they opened, orders, free updates after it", () => {
  const T0 = "2026-10-16T15:00:00Z";
  const chats = [
    { phone_norm: "500000001", body: followText(NO), created_at: T0, opened: true },
    { phone_norm: "500000002", body: "تابع طلبي W1790012345679", created_at: T0, opened: false },
    { phone_norm: "500000003", body: "ابي اتابع طلبي W1790012345670 وين وصل", created_at: T0, opened: true },   // a question, not the button
    { phone_norm: "500000001", body: followText(NO), created_at: T0, opened: false },                          // pressed twice
  ];
  const events = [
    { name: "wa_follow_shown", where_: "banner", n: 10 }, { name: "wa_follow_tap", where_: "banner", n: 3 }, { name: "wa_follow_close", where_: "banner", n: 2 },
    { name: "wa_follow_shown", where_: "pill", n: 5 }, { name: "wa_follow_tap", where_: "pill", n: 1 }, { name: "wa_follow_tap", where_: "track_btn", n: 2 },
  ];
  const freeAfter = [{ order_no: NO, n: 3 }, { order_no: "W1790012345679", n: 2 }, { order_no: "W1790012345670", n: 9 }];
  const r = followLinkReport({ chats, events, freeAfter, rate: 0.04 });
  assert.equal(r.shown, 15); assert.equal(r.taps, 6); assert.equal(r.closed, 2);
  assert.deepEqual(r.by_where.banner, { shown: 10, tap: 3, close: 2 });
  assert.deepEqual(r.by_where.track_btn, { shown: 0, tap: 2, close: 0 });
  assert.equal(r.tap_rate, 0.4);
  assert.equal(r.chats, 3); assert.equal(r.customers, 2); assert.equal(r.opened_window, 1); assert.equal(r.orders, 2);
  assert.equal(r.free_updates, 5, "W…670 was a question, not the button — its updates are not counted");
  assert.equal(r.saved_sar, 0.2);
  const empty = followLinkReport({});
  assert.deepEqual([empty.shown, empty.taps, empty.chats, empty.tap_rate], [0, 0, 0, null]);
  assert.match(FOLLOW_SQL.events, /NOT s\.is_qa AND NOT s\.is_bot AND NOT s\.is_staff/);
  assert.match(FOLLOW_SQL.chats, /direction = 'in'/);
});
