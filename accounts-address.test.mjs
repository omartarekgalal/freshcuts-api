/* دفتر العناوين للشيك أوت الجديد — node --test accounts-address.test.mjs

   قاعدة بيانات وهمية بالكامل: صف acct_customers واحد في الذاكرة، وجلسة
   عميل ثابتة. مفيش شبكة ولا SMS. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  register, cleanAddress, normalizeAddresses, sortAddresses,
  addAddress, updateAddress, removeAddress, recordUsedAddress, ADDR_MAX,
} from "./accounts.js";

const TOKEN = "a".repeat(48);
const PHONE = "512345678";

function fakeApp() {
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
}

function fakePool(row) {
  const writes = [];
  return {
    writes,
    row,
    query: async (sql, params = []) => {
      const s = String(sql);
      if (/UPDATE acct_sessions SET last_seen_at/.test(s)) {
        return params[0] === TOKEN ? { rowCount: 1, rows: [{ phone_norm: PHONE }] } : { rowCount: 0, rows: [] };
      }
      if (/SELECT \* FROM acct_customers/.test(s)) {
        return { rowCount: row ? 1 : 0, rows: row ? [JSON.parse(JSON.stringify(row))] : [] };
      }
      if (/SELECT addresses FROM acct_customers/.test(s)) {
        return { rowCount: row ? 1 : 0, rows: row ? [{ addresses: JSON.parse(JSON.stringify(row.addresses)) }] : [] };
      }
      if (/UPDATE acct_customers SET addresses=\$2/.test(s)) {
        writes.push(params);
        if (row && params[0] === row.phone_norm) row.addresses = JSON.parse(params[1]);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] }; // schema + anything else
    },
  };
}

function setup(addresses = []) {
  const app = fakeApp();
  const pool = fakePool({ phone_norm: PHONE, name: "عمر", addresses, ts_customer_id: null });
  const api = register(app, {
    pool, requireAdmin: async () => null, getSettingsData: async () => ({}),
    jb: (v) => JSON.stringify(v), normPhone: (p) => String(p || "").replace(/\D/g, "").slice(-9),
    deliveryAppOf: () => null,
  });
  const call = async (method, path, { body, id, auth = true, bodyThrows = false } = {}) => {
    const h = auth ? { authorization: `Bearer cust:${TOKEN}` } : {};
    const c = {
      req: {
        header: (n) => h[String(n).toLowerCase()],
        json: async () => { if (bodyThrows) throw new SyntaxError("bad"); return body; },
        param: (k) => (k === "id" ? id : undefined),
        query: () => undefined,
      },
      json: (obj, status = 200) => ({ body: obj, status }),
    };
    return app.routes[`${method} ${path}`](c);
  };
  return { app, pool, api, call };
}

const JED = { latitude: 21.5433, longitude: 39.1728 };
const JED2 = { latitude: 21.6000, longitude: 39.1100 };
const JED3 = { latitude: 21.4800, longitude: 39.2000 };

/* ── pure helpers ── */

test("cleanAddress: new fields, label capped at 30, defaults", () => {
  const a = cleanAddress({
    label: "المنزل".padEnd(50, "x"), area: "الروضة", street: "شارع الأمير سلطان",
    building: "12", floor: "3", landmark: "جنب الصيدلية", notes: "الباب الأخضر",
    ...JED,
  }, null, "2026-09-16T10:00:00.000Z");
  assert.equal(a.label.length, 30);
  assert.equal(a.building, "12");
  assert.equal(a.floor, "3");
  assert.equal(a.landmark, "جنب الصيدلية");
  assert.equal(a.notes, "الباب الأخضر");
  assert.equal(a.latitude, JED.latitude);
  assert.equal(a.is_default, false);
  assert.equal(a.created_at, "2026-09-16T10:00:00.000Z");
  assert.ok(a.id);
  assert.equal(cleanAddress({ ...JED }).label, "عنواني");
});

test("cleanAddress: partial update keeps untouched fields; legacy long label survives", () => {
  const prev = { id: "x1", label: "📍 بيت — حي الروضة شارع طويل جداً", building: "7", floor: "2", ...JED };
  const a = cleanAddress({ notes: "جديد" }, prev);
  assert.equal(a.id, "x1");
  assert.equal(a.label, prev.label);   // 34 chars: not cut when not edited
  assert.equal(a.building, "7");
  assert.equal(a.floor, "2");
  assert.equal(a.notes, "جديد");
  assert.equal(cleanAddress({ label: prev.label }, prev).label.length, 30);
});

test("normalizeAddresses: legacy list gets ids and first stored becomes default", () => {
  const list = normalizeAddresses([
    { label: "قديم ١", ...JED }, { label: "قديم ٢", ...JED2 }, null, "junk",
  ]);
  assert.equal(list.length, 2);
  assert.ok(list.every((a) => a.id));
  assert.deepEqual(list.map((a) => a.is_default), [true, false]);
  // two defaults stored (corruption): only the first stays
  const two = normalizeAddresses([{ id: "a", is_default: true }, { id: "b", is_default: true }]);
  assert.deepEqual(two.map((a) => a.is_default), [true, false]);
  assert.deepEqual(normalizeAddresses(undefined), []);
});

test("sortAddresses: default first, then most recently used; undated legacy keep stored order", () => {
  const s = sortAddresses([
    { id: "old", used_at: "2026-09-01T00:00:00Z" },
    { id: "legacyA" }, { id: "legacyB" },
    { id: "def", is_default: true, used_at: "2026-01-01T00:00:00Z" },
    { id: "new", used_at: "2026-09-10T00:00:00Z" },
  ]);
  assert.deepEqual(s.map((a) => a.id), ["def", "new", "old", "legacyA", "legacyB"]);
});

test("sortAddresses is idempotent: legacy list order does not flip between reads", () => {
  let s = [{ label: "A", ...JED }, { label: "B", ...JED2 }, { label: "C", ...JED3 }];
  const seen = [];
  for (let k = 0; k < 4; k++) { s = sortAddresses(normalizeAddresses(s)); seen.push(s.map((a) => a.label).join()); }
  assert.deepEqual(seen, ["A,B,C", "A,B,C", "A,B,C", "A,B,C"]);
});

test("cap evicts the oldest undated legacy address, not the newest", () => {
  const legacy = Array.from({ length: ADDR_MAX }, (_, i) => ({ label: `L${i}`, latitude: 21.3 + i * 0.01, longitude: 39.2 }));
  const r = addAddress(legacy, { label: "new", ...JED }, { now: "2026-09-16T00:00:00Z" });
  assert.equal(r.list.length, ADDR_MAX);
  const labels = r.list.map((a) => a.label);
  assert.ok(labels.includes("L0"));        // default kept
  assert.ok(!labels.includes("L1"));       // oldest non-default evicted
  assert.ok(labels.includes(`L${ADDR_MAX - 1}`) && labels.includes("new"));
});

test("old-UI POST (no building/floor) on a pin saved by the new UI updates instead of duplicating", () => {
  let r = addAddress([], { label: "المنزل", building: "5", floor: "2", ...JED });
  r = addAddress(r.list, { label: "📍 — الروضة", area: "الروضة", street: "س", ...JED });
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].building, "5");
  assert.equal(r.list[0].floor, "2");
});

test("address text strips angle brackets (current storefront renders it unescaped)", () => {
  const a = cleanAddress({ label: "<img src=x onerror=alert(1)>", street: "<b>x</b>", ...JED });
  assert.ok(!/[<>]/.test(a.label + a.street));
});

test("addAddress: first is default; is_default moves the flag; one default only", () => {
  let r = addAddress([], { label: "المنزل", ...JED }, { now: "2026-09-16T10:00:00Z" });
  assert.equal(r.list.length, 1);
  assert.equal(r.address.is_default, true);
  r = addAddress(r.list, { label: "العمل", ...JED2 }, { now: "2026-09-16T11:00:00Z" });
  assert.equal(r.address.is_default, false);
  assert.equal(r.list[0].label, "المنزل");
  r = addAddress(r.list, { label: "بيت الأهل", ...JED3, is_default: true }, { now: "2026-09-16T12:00:00Z" });
  assert.equal(r.list.filter((a) => a.is_default).length, 1);
  assert.equal(r.list[0].label, "بيت الأهل");
  assert.deepEqual(r.list.map((a) => a.label), ["بيت الأهل", "العمل", "المنزل"]);
});

test("addAddress: same pin + same building/floor updates; different floor is a new address", () => {
  let r = addAddress([], { label: "المنزل", building: "5", floor: "1", ...JED });
  const id = r.address.id;
  r = addAddress(r.list, { label: "البيت", building: "5", floor: "1", latitude: JED.latitude + 0.0001, longitude: JED.longitude });
  assert.equal(r.list.length, 1);
  assert.equal(r.address.id, id);
  assert.equal(r.address.label, "البيت");
  assert.equal(r.address.is_default, true);
  r = addAddress(r.list, { label: "بيت الأهل", building: "5", floor: "4", ...JED });
  assert.equal(r.list.length, 2);
  // legacy calls (no building/floor) against a legacy record still dedupe like before
  let l = addAddress([{ id: "L", label: "قديم", ...JED }], { label: "📍 — الروضة", ...JED });
  assert.equal(l.list.length, 1);
  assert.equal(l.list[0].id, "L");
});

test("addAddress: capped at ADDR_MAX, never drops the default", () => {
  let list = [];
  for (let i = 0; i < ADDR_MAX + 3; i++) {
    list = addAddress(list, { label: `ع${i}`, latitude: 21.4 + i * 0.01, longitude: 39.1 },
      { now: new Date(Date.UTC(2026, 8, 1, i)).toISOString() }).list;
  }
  assert.equal(list.length, ADDR_MAX);
  assert.equal(list[0].label, "ع0");          // first-ever = default, kept
  assert.ok(list[0].is_default);
  assert.ok(!list.some((a) => ["ع1", "ع2", "ع3"].includes(a.label)));
  assert.ok(list.some((a) => a.label === `ع${ADDR_MAX + 2}`));
});

test("updateAddress: set default clears others; unset default promotes most recent other", () => {
  let list = addAddress([], { label: "A", ...JED }, { now: "2026-09-01T00:00:00Z" }).list;
  list = addAddress(list, { label: "B", ...JED2 }, { now: "2026-09-02T00:00:00Z" }).list;
  list = addAddress(list, { label: "C", ...JED3 }, { now: "2026-09-03T00:00:00Z" }).list;
  const id = (l) => list.find((a) => a.label === l).id;
  let r = updateAddress(list, id("B"), { is_default: true, floor: "2" });
  assert.deepEqual(r.list.map((a) => [a.label, a.is_default]), [["B", true], ["C", false], ["A", false]]);
  assert.equal(r.address.floor, "2");
  r = updateAddress(r.list, id("B"), { is_default: false });
  assert.equal(r.list.filter((a) => a.is_default).length, 1);
  assert.equal(r.list[0].label, "C");
  assert.equal(updateAddress(list, "nope", {}), null);
  assert.deepEqual(updateAddress(list, id("A"), { latitude: "abc" }), { error: "location_required" });
  // sole address can't lose default
  const solo = addAddress([], { label: "S", ...JED }).list;
  assert.equal(updateAddress(solo, solo[0].id, { is_default: false }).list[0].is_default, true);
});

test("removeAddress: deleting the default promotes the most recently used; index delete still works", () => {
  let list = addAddress([], { label: "A", ...JED }, { now: "2026-09-01T00:00:00Z" }).list;
  list = addAddress(list, { label: "B", ...JED2 }, { now: "2026-09-05T00:00:00Z" }).list;
  list = addAddress(list, { label: "C", ...JED3 }, { now: "2026-09-03T00:00:00Z" }).list;
  const next = removeAddress(list, list.find((a) => a.label === "A").id);
  assert.deepEqual(next.map((a) => [a.label, a.is_default]), [["B", true], ["C", false]]);
  const byIdx = removeAddress([{ label: "x", ...JED }, { label: "y", ...JED2 }], "0");
  assert.deepEqual(byIdx.map((a) => [a.label, a.is_default]), [["y", true]]);
  assert.deepEqual(removeAddress(next, "missing").length, 2);
});

test("recordUsedAddress: known pin only bumps used_at; new pin is added; bad coords ignored", () => {
  let list = addAddress([], { label: "A", street: "شارع نظيف", ...JED }, { now: "2026-09-01T00:00:00Z" }).list;
  list = addAddress(list, { label: "B", ...JED2 }, { now: "2026-09-02T00:00:00Z" }).list;
  const bumped = recordUsedAddress(list, { street: "شارع نظيف، مبنى 5", ...JED2 }, { now: "2026-09-10T00:00:00Z" });
  assert.equal(bumped.length, 2);
  const b = bumped.find((a) => a.label === "B");
  assert.equal(b.used_at, "2026-09-10T00:00:00Z");
  assert.equal(bumped.find((a) => a.label === "A").street, "شارع نظيف");
  const added = recordUsedAddress(list, { area: "الصفا", ...JED3 });
  assert.equal(added.length, 3);
  assert.equal(recordUsedAddress(list, { latitude: 0, longitude: 0 }), null);
});

/* ── routes ── */

test("routes: unauthorized without a customer token", async () => {
  const { call } = setup();
  for (const [m, p] of [["GET", "/api/account/addresses"], ["POST", "/api/account/addresses"],
    ["PUT", "/api/account/addresses/:id"], ["DELETE", "/api/account/addresses/:id"]]) {
    const r = await call(m, p, { auth: false, body: {}, id: "x" });
    assert.equal(r.status, 401);
  }
});

test("POST /api/account/addresses: validates location, saves full shape, returns sorted list", async () => {
  const { call, pool } = setup();
  let r = await call("POST", "/api/account/addresses", { body: { label: "المنزل" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "location_required");
  r = await call("POST", "/api/account/addresses", { bodyThrows: true });
  assert.equal(r.status, 400);

  r = await call("POST", "/api/account/addresses", { body: {
    label: "المنزل", area: "الروضة", street: "الأمير سلطان", building: "12", floor: "3",
    landmark: "جنب الصيدلية", ...JED,
  } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.address.is_default, true);
  assert.equal(r.body.addresses.length, 1);
  r = await call("POST", "/api/account/addresses", { body: { label: "العمل", ...JED2, is_default: "true" } });
  assert.deepEqual(r.body.addresses.map((a) => [a.label, a.is_default]), [["العمل", true], ["المنزل", false]]);
  assert.deepEqual(pool.row.addresses.map((a) => a.label), ["العمل", "المنزل"]); // stored == returned order
});

test("PUT /api/account/addresses/:id: edit fields + default, 404 on unknown", async () => {
  const { call } = setup();
  const a = (await call("POST", "/api/account/addresses", { body: { label: "المنزل", ...JED } })).body.address;
  const b = (await call("POST", "/api/account/addresses", { body: { label: "العمل", ...JED2 } })).body.address;
  let r = await call("PUT", "/api/account/addresses/:id", { id: b.id, body: { building: "9", is_default: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.address.building, "9");
  assert.deepEqual(r.body.addresses.map((x) => [x.id, x.is_default]), [[b.id, true], [a.id, false]]);
  r = await call("PUT", "/api/account/addresses/:id", { id: "nope", body: { label: "x" } });
  assert.equal(r.status, 404);
  r = await call("PUT", "/api/account/addresses/:id", { id: a.id, body: { latitude: null } });
  assert.equal(r.status, 400);
});

test("DELETE /api/account/addresses/:id: default deletion promotes another", async () => {
  const { call } = setup();
  const a = (await call("POST", "/api/account/addresses", { body: { label: "المنزل", ...JED } })).body.address;
  await call("POST", "/api/account/addresses", { body: { label: "العمل", ...JED2 } });
  const r = await call("DELETE", "/api/account/addresses/:id", { id: a.id });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.addresses.length, 1);
  assert.equal(r.body.addresses[0].label, "العمل");
  assert.equal(r.body.addresses[0].is_default, true);
  const empty = await call("DELETE", "/api/account/addresses/:id", { id: r.body.addresses[0].id });
  assert.deepEqual(empty.body.addresses, []);
});

test("legacy stored addresses: /me and GET normalize once and persist stable ids", async () => {
  const { call, pool } = setup([
    { label: "📍 — الروضة", area: "الروضة", street: "", latitude: JED.latitude, longitude: JED.longitude, notes: "" },
    { id: "keep-me", label: "عنواني", area: "الصفا", latitude: JED2.latitude, longitude: JED2.longitude, notes: "دور 2" },
  ]);
  const me = await call("GET", "/api/account/me");
  assert.equal(me.body.ok, true);
  assert.equal(me.body.addresses.length, 2);
  assert.equal(me.body.addresses[0].label, "📍 — الروضة");  // first stored = default, like index 0 before
  assert.equal(me.body.addresses[0].is_default, true);
  assert.equal(pool.writes.length, 1);
  const firstId = me.body.addresses[0].id;
  assert.equal(pool.row.addresses[0].id, firstId);          // persisted: ids stable across calls
  const again = await call("GET", "/api/account/addresses");
  assert.equal(again.body.addresses[0].id, firstId);
  assert.equal(pool.writes.length, 1);                      // already normalized → no extra write
  // old storefront delete by id still works
  const del = await call("DELETE", "/api/account/addresses/:id", { id: "keep-me" });
  assert.deepEqual(del.body.addresses.map((a) => a.id), [firstId]);
});

test("old storefront POST shape (label/area/street/notes/lat/lng) keeps working", async () => {
  const { call } = setup();
  const r = await call("POST", "/api/account/addresses", { body: {
    label: "🏠 — حي الروضة، شارع الأمير", area: "الروضة", street: "الأمير",
    latitude: JED.latitude, longitude: JED.longitude, notes: "مبنى 4، جنب البقالة",
  } });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.addresses[0].notes, "مبنى 4، جنب البقالة");
  assert.equal(r.body.addresses[0].building, "");
  // same spot again → update, not duplicate (old behaviour)
  const r2 = await call("POST", "/api/account/addresses", { body: { label: "عنواني", ...JED } });
  assert.equal(r2.body.addresses.length, 1);
});

test("saveAddressFor (paid delivery order): adds new, bumps known, ignores guests/bad input", async () => {
  const { api, call, pool } = setup();
  await call("POST", "/api/account/addresses", { body: { label: "المنزل", street: "نظيف", ...JED } });
  await call("POST", "/api/account/addresses", { body: { label: "العمل", ...JED2 } });
  let list = await api.saveAddressFor(PHONE, { area: "الروضة", street: "شارع نظيف، مبنى 3", ...JED2 });
  assert.equal(list.length, 2);
  assert.equal(list[0].label, "المنزل");                    // default stays first
  assert.equal(list[1].label, "العمل");
  assert.equal(pool.row.addresses.find((a) => a.label === "المنزل").street, "نظيف");
  list = await api.saveAddressFor(PHONE, { area: "الصفا", street: "شارع ١", ...JED3 });
  assert.equal(list.length, 3);
  assert.equal(list.filter((a) => a.is_default).length, 1);
  assert.equal(await api.saveAddressFor("123", { ...JED }), null);
  assert.equal(await api.saveAddressFor(PHONE, { latitude: 0, longitude: 0 }), null);
});
