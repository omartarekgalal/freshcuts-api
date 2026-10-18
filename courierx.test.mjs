/* CX1 (عمر ١٨/١٠: «التتبع بتاع المندوب الخارجي مش شغال كويس — لينك أو واتس»).
   node --test courierx.test.mjs — قاعدة وهمية، أرقام وهمية، مفيش شبكة. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as CL from "./courierlive.js";
import * as CW from "./courierwa.js";
import { computeTrackEta, positionAtMs } from "./tracketa.js";

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const HASH = sha("raw-token-one-aaaaaaaaaa"), HASH2 = sha("raw-token-two-bbbbbbbbbb");

/* ── ١) الرابط الثابت للرحلة ──────────────────────────────────────────── */
test("link token: stable per run, dies with «رابط جديد», other runs and forgeries rejected, fits the storefront /d/ filter", () => {
  const run = { id: 41, token_hash: HASH };
  const t = CL.extLinkToken(run);
  assert.match(t, /^r41x[A-Za-z0-9]{22}$/);
  assert.equal(CL.extLinkToken(run), t, "same run ⇒ same link every time (the 2nd «ابعتله على واتساب» works)");
  const p = CL.parseLinkToken(t);
  assert.equal(CL.verifyLinkToken(p, run), true);
  assert.equal(CL.verifyLinkToken(p, { ...run, token_hash: HASH2 }), false, "new token ⇒ old link dead");
  assert.equal(CL.verifyLinkToken(p, { ...run, id: 42 }), false);
  assert.equal(CL.verifyLinkToken({ ...p, sig: "A".repeat(22) }, run), false);
  assert.equal(CL.parseLinkToken("r41x" + "A".repeat(21)), null);
  assert.equal(CL.parseLinkToken("abcdefghijklmnopqrstuvwx"), null, "random base64url tokens keep their own path");
  /* storefront server.py: alnum/-/_ only, 16..64 — and the API's /^[A-Za-z0-9_-]{16,64}$/ */
  assert.ok(/^[A-Za-z0-9_-]{16,64}$/.test(t));
  assert.equal(CL.extLinkUrl(run, "https://freshcuts.sa/"), `https://freshcuts.sa/d/${t}`);
  assert.equal(CL.extLinkBase({ delivery: { extLink: { base: "https://x.test/" } } }), "https://x.test");
  assert.equal(CL.extLinkToken({ id: 41 }), null, "no hash ⇒ no link");
});

/* ── قاعدة وهمية لـcourierlive.register ─────────────────────────────── */
const ORDER = { order_no: "W1790000000041", total: 88.5, option: "delivery", status: "courier_assigned", phone_norm: "500000799",
  customer: { name: "عميل تجربة", phone: "0500000799" },
  address: { area: "السلامة", street: "شارع تجربة", building: "3", latitude: 21.6147, longitude: 39.1450, delivery_notes: "البوابة الخلفية" } };

function world({ nowMs = Date.parse("2026-10-18T15:00:00Z") } = {}) {
  const db = { runs: [], ship: { id: 9, shop_order_no: ORDER.order_no, provider: "external", status: "assigned", driver: { name: "سالم", phone: "0500000731" }, updated_at: new Date(nowMs).toISOString() },
    pings: [], runUpdates: [], driverUpdates: [], statuses: [] };
  let clock = nowMs;
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE|^ALTER TABLE/i.test(s)) return { rows: [] };
    if (/^SELECT \* FROM dl_ext_runs WHERE shipment_id=\$1/.test(s)) return { rows: db.runs.filter((r) => r.shipment_id === p[0]) };
    if (/^INSERT INTO dl_ext_runs/.test(s)) {
      const cur = db.runs.find((r) => r.shipment_id === p[0]);
      const row = { ...(cur || { id: 41, pings: 0 }), shipment_id: p[0], order_no: p[1], token_hash: p[2], courier_name: p[3] ?? cur?.courier_name ?? null,
        courier_phone: p[4] ?? cur?.courier_phone ?? null, created_by: p[5], created_at: new Date(clock).toISOString(), expires_at: p[6],
        revoked_at: null, opened_at: null, started_at: null, arrived_at: null, delivered_at: null, last_at: null };
      db.runs = [row];
      return { rows: [{ ...row }] };
    }
    if (/^UPDATE dl_ext_runs SET courier_name=COALESCE/.test(s)) return { rows: [{ ...db.runs[0] }] };
    if (/FROM dl_ext_runs r JOIN dl_shipments sh ON sh.id = r.shipment_id WHERE r.id=\$1/.test(s)) {
      const r = db.runs.find((x) => Number(x.id) === Number(p[0]));
      return { rows: r ? [{ ...r, ship_status: db.ship.status, provider: "external", shop_order_no: db.ship.shop_order_no }] : [] };
    }
    if (/FROM dl_ext_runs r JOIN dl_shipments sh ON sh.id = r.shipment_id WHERE r.token_hash=\$1/.test(s)) {
      const r = db.runs.find((x) => x.token_hash === p[0]);
      return { rows: r ? [{ ...r, ship_status: db.ship.status }] : [] };
    }
    if (/^UPDATE dl_ext_runs SET opened_at/.test(s)) return { rows: [] };
    if (/^UPDATE dl_ext_runs SET seen_at = NOW\(\), last_acc/.test(s)) { db.runUpdates.push({ coarse: true, acc: p[1] }); db.runs[0].seen_at = new Date(clock).toISOString(); return { rows: [] }; }
    if (/^UPDATE dl_ext_runs SET pings = pings \+ \$2, last_at = NOW\(\)/.test(s)) {
      db.runUpdates.push({ saved: p[1] }); db.runs[0].pings += p[1]; db.runs[0].last_at = new Date(clock).toISOString(); return { rows: [] };
    }
    if (/^UPDATE dl_ext_runs SET last_at = NOW\(\)/.test(s)) { db.runs[0].last_at = new Date(clock).toISOString(); return { rows: [] }; }
    if (/^UPDATE dl_ext_runs SET started_at/.test(s)) { db.runs[0].started_at = db.runs[0].started_at || new Date(clock).toISOString(); return { rows: [] }; }
    if (/^UPDATE dl_shipments SET driver = COALESCE\(driver,'\{\}'::jsonb\) \|\| \$2::jsonb WHERE id=\$1/.test(s)) {
      const d = JSON.parse(p[1]); db.driverUpdates.push(d); db.ship.driver = { ...(db.ship.driver || {}), ...d }; return { rows: [] };
    }
    if (/^UPDATE dl_shipments SET status = CASE/.test(s)) { db.ship.status = "picked"; return { rows: [] }; }
    if (/^SELECT at, lat, lng FROM dl_courier_pings/.test(s)) { const l = db.pings.at(-1); return { rows: l ? [l] : [] }; }
    if (/^INSERT INTO dl_courier_pings/.test(s)) { db.pings.push({ at: p[2], lat: p[3], lng: p[4] }); return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  } };
  const routes = {};
  const app = { get(path, fn) { routes[`GET ${path}`] = fn; }, post(path, fn) { routes[`POST ${path}`] = fn; } };
  const shop = { getOrderRow: async (no) => (no === ORDER.order_no ? { ...ORDER } : null),
    setStatus: async (no, st) => { db.statuses.push(st); } };
  const delivery = { shipmentOf: async (no) => (no === ORDER.order_no ? { ...db.ship } : null) };
  const api = CL.register(app, { pool, getSettingsData: async () => ({}), jb: JSON.stringify, log: { error() {}, warn() {} } },
    { shop, delivery, portal: { scheduleRefresh() {} }, emitOrder: () => {}, timers: false, now: () => clock });
  const call = async (method, path, params = {}, body = undefined) => {
    const key = Object.keys(routes).find((k) => k === `${method} ${path}`);
    assert.ok(key, `route ${method} ${path}`);
    let out = null;
    const c = { req: { param: (k) => params[k], json: async () => body ?? {}, header: () => null, query: () => undefined, path },
      json: (j, status = 200) => { out = { status, body: j }; return out; } };
    await routes[key](c);
    return out;
  };
  return { db, api, call, tick: (msAdd) => { clock += msAdd; }, now: () => clock };
}
const tokOf = (link) => String(link).split("/d/")[1];

test("handoff: the 2nd «💬 ابعتله على واتساب» carries the SAME working link (was literally «…/d/…»), «🔁 رابط جديد» kills it", async () => {
  const w = world();
  const a = await w.api.makeHandoff(ORDER.order_no, { by: "مدير", mode: "direct" });
  assert.equal(a.ok, true); assert.equal(a.fresh, true);
  assert.match(a.link, /^https:\/\/freshcuts\.sa\/d\/r41x[A-Za-z0-9]{22}$/);
  assert.ok(a.text.includes(a.link));
  const b = await w.api.makeHandoff(ORDER.order_no, { by: "مدير", mode: "direct" });
  assert.equal(b.fresh, false);
  assert.equal(b.link, a.link, "same link while it lives");
  assert.equal(b.hasLink, true);
  assert.ok(b.text.includes(a.link)); assert.ok(!b.text.includes("/d/…"), "never a dead «…» link in the WhatsApp text");
  assert.ok(decodeURIComponent(b.waUrl).includes(a.link));
  /* the link opens the page */
  const g = await w.call("GET", "/api/d/:token", { token: tokOf(a.link) });
  assert.equal(g.status, 200); assert.equal(g.body.ok, true); assert.equal(g.body.orderNo, ORDER.order_no);
  assert.equal(g.body.pingEverySec, CL.PING_EVERY_SEC); assert.equal(g.body.maxAccM, CL.PING_MAX_ACC_M);
  /* «رابط جديد» ⇒ new hash ⇒ the old link is dead */
  const c = await w.api.makeHandoff(ORDER.order_no, { by: "مدير", mode: "direct", fresh: true });
  assert.notEqual(c.link, a.link);
  assert.equal((await w.call("GET", "/api/d/:token", { token: tokOf(a.link) })).status, 404);
  assert.equal((await w.call("GET", "/api/d/:token", { token: tokOf(c.link) })).status, 200);
});

test("group handoff text carries a real link too", async () => {
  const w = world();
  const a = await w.api.makeHandoff(ORDER.order_no, { by: "مدير", mode: "group" });
  assert.equal(a.mode, "group");
  assert.ok(a.text.includes(a.link)); assert.ok(!a.text.includes("/d/…"));
});

test("expired link: the page still loads (no customer data) so «تم التسليم» can close the order; revoked stays shut", async () => {
  const w = world();
  const a = await w.api.makeHandoff(ORDER.order_no, { by: "مدير", mode: "direct" });
  w.db.runs[0].started_at = new Date(w.now() - 3600_000).toISOString();
  w.db.runs[0].expires_at = new Date(w.now() - 1000).toISOString();
  const g = await w.call("GET", "/api/d/:token", { token: tokOf(a.link) });
  assert.equal(g.status, 200); assert.equal(g.body.expired, true); assert.equal(g.body.stage, "started");
  assert.equal(g.body.customer, undefined, "no customer phone/address after expiry");
  assert.equal(g.body.address, undefined);
  w.db.runs[0].revoked_at = new Date().toISOString();
  assert.equal((await w.call("GET", "/api/d/:token", { token: tokOf(a.link) })).status, 410);
});

test("ping: every accepted ping refreshes «آخر تحديث» + driver.location WITH its own time; coarse fixes are reported, not drawn", async () => {
  const w = world();
  const a = await w.api.makeHandoff(ORDER.order_no, { by: "مدير", mode: "direct" });
  const tok = tokOf(a.link);
  await w.call("POST", "/api/d/:token/start", { token: tok }, { lat: 21.5885, lng: 39.1525 });
  assert.equal(w.db.ship.driver.location.latitude, 21.5885, "the start point shows at once");
  assert.ok(w.db.ship.driver.at);
  w.tick(9_000);
  const p1 = await w.call("POST", "/api/d/:token/ping", { token: tok }, { lat: 21.5900, lng: 39.1525, acc: 12 });
  assert.equal(p1.body.ok, true); assert.equal(p1.body.saved, true); assert.equal(p1.body.nextSec, CL.PING_EVERY_SEC);
  assert.equal(w.db.ship.driver.at, new Date(w.now()).toISOString());
  assert.equal(w.db.ship.driver.acc, 12);
  /* standing still 9 s later: not a new trail point, but «آخر تحديث» and driver.at still move */
  w.tick(9_000);
  const p2 = await w.call("POST", "/api/d/:token/ping", { token: tok }, { lat: 21.59001, lng: 39.1525, acc: 10 });
  assert.equal(p2.body.saved, false);
  assert.equal(w.db.runs[0].last_at, new Date(w.now()).toISOString());
  assert.equal(w.db.ship.driver.at, new Date(w.now()).toISOString());
  /* within 8 s ⇒ throttled, nothing written */
  const before = w.db.driverUpdates.length;
  w.tick(2_000);
  const p3 = await w.call("POST", "/api/d/:token/ping", { token: tok }, { lat: 21.60, lng: 39.16, acc: 10 });
  assert.equal(p3.body.skipped, "throttled"); assert.equal(w.db.driverUpdates.length, before);
  /* iPhone «Precise Location» off ⇒ ±3 km: reported back with the number, the map keeps the last real point */
  w.tick(9_000);
  const p4 = await w.call("POST", "/api/d/:token/ping", { token: tok }, { lat: 21.70, lng: 39.30, acc: 3000 });
  assert.equal(p4.body.skipped, "accuracy"); assert.equal(p4.body.acc, 3000); assert.equal(p4.body.maxAcc, 500);
  assert.equal(w.db.ship.driver.location.latitude, 21.59001);
  assert.ok(w.db.runUpdates.some((u) => u.coarse && u.acc === 3000));
  /* junk */
  w.tick(9_000);
  assert.equal((await w.call("POST", "/api/d/:token/ping", { token: tok }, { lat: 0, lng: 0 })).status, 400);
  assert.equal((await w.call("POST", "/api/d/:token/ping", { token: tok }, { lat: "x" })).status, 400);
});

/* ── ٢) صفحة تتبّع العميل: حداثة الموقع من driver.at ─────────────────── */
test("customer ETA: a live external position (driver.at fresh) counts as fresh even when updated_at is 20 min old", () => {
  const NOW = Date.parse("2026-10-18T15:00:00Z");
  const at = (m) => new Date(NOW + m * 60_000).toISOString();
  const row = { order_no: "W1", option: "delivery", status: "on_the_way", created_at: at(-40), accepted_at: at(-38),
    address: { latitude: 21.6241, longitude: 39.1521 }, delivery_quote: { routeKm: 5.2 }, history: [] };
  const drv = { location: { latitude: 21.6061, longitude: 39.1521 }, source: "external" };
  const live = computeTrackEta({ row, sh: { status: "picked", picked_at: at(-20), updated_at: at(-20), driver: { ...drv, at: at(-0.5) } }, settings: {}, now: NOW });
  assert.equal(live.basis, "position", "before CX1 this was «route» + «قد لا يكون موقع المندوب محدّثاً»");
  const old = computeTrackEta({ row, sh: { status: "picked", picked_at: at(-20), updated_at: at(-20), driver: drv }, settings: {}, now: NOW });
  assert.equal(old.basis, "route", "no driver.at ⇒ updated_at as before");
  /* a fresh event on the shipment must not make an old position look live */
  const stale = computeTrackEta({ row, sh: { status: "picked", picked_at: at(-20), updated_at: at(0), driver: { ...drv, at: at(-15) } }, settings: {}, now: NOW });
  assert.equal(stale.basis, "route");
  assert.equal(positionAtMs({ updated_at: at(-5), driver: { at: at(+3) } }, undefined, NOW), NOW, "a future clock is clamped");
  assert.equal(positionAtMs({ updated_at: at(-5) }, undefined, NOW), NOW - 5 * 60_000);
});

/* ── ٣) الواتساب: زر «📍 شارك موقعي» ─────────────────────────────────── */
const COURIER = "500000731";
const runOf = (x = {}) => ({ id: 41, shipment_id: 9, order_no: ORDER.order_no, token_hash: HASH, courier_name: "سالم", courier_phone: `0${COURIER}`,
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(),
  started_at: null, arrived_at: null, delivered_at: null, revoked_at: null, wa_phone: null, wa_sent_at: null, last_at: null, ...x });

function rig({ run = runOf(), window = true, cfg = {}, settings = {}, sweepRows = null } = {}) {
  const state = { run: { ...run }, sends: [], templates: [], stages: [], locMarks: [] };
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^ALTER TABLE/i.test(s)) return { rows: [] };
    if (/WHERE r\.order_no=\$1 AND sh\.provider='external'/.test(s)) return { rows: [{ ...state.run }] };
    if (/make_interval/.test(s)) return { rows: sweepRows ? sweepRows.map((r) => ({ ...r })) : [] };
    if (/^UPDATE dl_ext_runs SET loc_sent_at/.test(s)) { state.locMarks.push({ id: p[0], nudge: /loc_nudges/.test(s) }); return { rows: [] }; }
    if (/^UPDATE dl_ext_runs SET wa_phone/.test(s)) { state.run.wa_phone = p[1]; if (p[4]) state.run.wa_sent_at = new Date().toISOString(); return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  } };
  const wa = { hooks: [], on(ev, fn) { if (ev === "claim") this.hooks.push(fn); },
    async sendFreeform(x) { state.sends.push(x); return window ? { ok: true, wamid: `w${state.sends.length}` } : { ok: false, skipped: "window_closed" }; },
    async sendTemplate(x) { state.templates.push(x); return { ok: true, wamid: "t1" }; } };
  const courierLive = { ensureSchema: async () => true,
    runById: async (id) => (Number(id) === Number(state.run.id) ? { ...state.run } : null),
    extStart: async () => { state.stages.push("start"); state.run.started_at = state.run.started_at || new Date().toISOString(); return { ok: true }; },
    extArrived: async () => ({ ok: true }), extDelivered: async () => ({ ok: true }) };
  const events = [];
  const api = CW.register({ post() {} }, { pool, getSettingsData: async () => ({ ...settings, waBot: { ...(settings.waBot || {}), courierJob: cfg } }), jb: JSON.stringify, log: { error() {}, warn() {} } },
    { wa, courierLive, shop: { getOrderRow: async (no) => (no === ORDER.order_no ? { ...ORDER } : null) }, portal: { scheduleRefresh() {} },
      emitOrder: (n, e) => events.push(e), boot: false });
  state.events = events;
  const tap = (act, from = COURIER) => wa.hooks[0]({ phoneNorm: from, interactiveId: CW.cwPayload(state.run, act), text: CW.BTN[act], type: "button" });
  return { api, state, tap };
}
const ctaUrl = (s) => s.payload.interactive && s.payload.interactive.type === "cta_url" ? s.payload.interactive.action.parameters.url : null;

test("config: «📍 شارك موقعي» on by default + nudge after 5 min (0..30); both carry an Arabic label + help for the dashboard", () => {
  const c = CW.courierJobConfig({});
  assert.equal(c.locationButton, true); assert.equal(c.locationNudgeMin, 5);
  assert.equal(CW.courierJobConfig({ locationNudgeMin: 99 }).locationNudgeMin, 30);
  assert.equal(CW.courierJobFromBody({ locationButton: false, locationNudgeMin: 0 }, c).ok, true);
  assert.equal(CW.courierJobFromBody({ locationNudgeMin: 31 }, c).ok, false);
  for (const k of ["courierJob.locationButton", "courierJob.locationNudgeMin"]) assert.ok(CW.COURIER_JOB_SCHEMA[k].ar && CW.COURIER_JOB_SCHEMA[k].help, k);
  assert.ok([...CW.LOC_BTN].length <= 20, "Meta: cta display_text ≤ 20");
  assert.equal(CW.locationCta("x", "http://insecure"), null);
});

test("template flow: the courier taps «استلمت الطلب» on the template ⇒ window open ⇒ «📍 شارك موقعي» (working /d/ link) THEN the next buttons", async () => {
  const { state, tap } = rig();
  await tap("p");
  assert.deepEqual(state.stages, ["start"]);
  assert.equal(state.sends.length, 2);
  const url = ctaUrl(state.sends[0]);
  assert.match(url, /^https:\/\/freshcuts\.sa\/d\/r41x[A-Za-z0-9]{22}$/);
  assert.equal(CL.verifyLinkToken(CL.parseLinkToken(url.split("/d/")[1]), state.run), true);
  assert.equal(state.sends[0].source, "courier");
  assert.deepEqual(state.sends[1].payload.interactive.action.buttons.map((b) => b.reply.title), ["وصلت عند العميل", "تم التسليم", "عندي مشكلة"]);
  assert.equal(state.locMarks.length, 1);
});

test("location button is not repeated while the position is flowing; off in the dashboard ⇒ the link goes in the card text instead", async () => {
  const a = rig({ run: runOf({ last_at: new Date(Date.now() - 30_000).toISOString() }) });
  await a.tap("p");
  assert.equal(a.state.sends.length, 1, "already sharing ⇒ only the stage buttons");
  const b = rig({ cfg: { locationButton: false } });
  await b.api.sendJob(ORDER.order_no, {});
  assert.equal(b.state.sends.length, 1);
  assert.match(b.state.sends[0].preview, /freshcuts\.sa\/d\/r41x/, "link in the card body when the button is off");
  const c = rig();
  await c.api.sendJob(ORDER.order_no, {});
  assert.equal(c.state.sends.length, 2);
  assert.ok(!/\/d\//.test(c.state.sends[1].preview), "with the button on, the card has no long link line");
  /* window closed + template ⇒ template only (no free CTA possible) */
  const d = rig({ window: false, cfg: { useTemplate: true } });
  const r = await d.api.sendJob(ORDER.order_no, {});
  assert.equal(r.via, "template"); assert.equal(d.state.templates.length, 1);
});

test("nudge sweep: position stopped ⇒ «📍 شارك موقعي» again (counted); window closed ⇒ counted, nothing logged; team/customer phones skipped", async () => {
  const started = runOf({ started_at: new Date(Date.now() - 10 * 60_000).toISOString(), wa_phone: COURIER });
  const a = rig({ sweepRows: [started] });
  assert.equal(await a.api.nudgeSweep(), 1);
  assert.equal(a.state.sends.length, 1);
  assert.match(a.state.sends[0].payload.interactive.body.text, /ما وصلنا/);
  assert.ok(ctaUrl(a.state.sends[0]));
  assert.deepEqual(a.state.locMarks, [{ id: 41, nudge: true }]);
  assert.ok(a.state.events.some((e) => /وقف/.test(e.summary)));
  const closed = rig({ sweepRows: [started], window: false });
  assert.equal(await closed.api.nudgeSweep(), 0);
  assert.deepEqual(closed.state.locMarks, [{ id: 41, nudge: true }], "an attempt is counted so we don't retry every minute");
  const team = rig({ sweepRows: [started], settings: { waTeam: { members: [{ phone: `0${COURIER}`, name: "مدير", role: "manager" }] } } });
  assert.equal(await team.api.nudgeSweep(), 0); assert.equal(team.state.sends.length, 0);
  const cust = rig({ sweepRows: [{ ...started, wa_phone: ORDER.phone_norm, courier_phone: `0${ORDER.phone_norm}` }] });
  assert.equal(await cust.api.nudgeSweep(), 0); assert.equal(cust.state.sends.length, 0);
  const off = rig({ sweepRows: [started], cfg: { locationNudgeMin: 0 } });
  assert.equal(await off.api.nudgeSweep(), 0); assert.equal(off.state.sends.length, 0);
});
