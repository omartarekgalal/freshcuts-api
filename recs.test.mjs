/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات محرّك «تحب تضيف؟» (recs.js) — أوفلاين بداتابيز مزيّفة

     node --test recs.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

const realSI = globalThis.setInterval, realST = globalThis.setTimeout;
globalThis.setInterval = (...a) => { const t = realSI(...a); t?.unref?.(); return t; };
globalThis.setTimeout = (...a) => { const t = realST(...a); t?.unref?.(); return t; };

const { Hono } = await import("hono");
const recs = await import("./recs.js");
const { sectionOf } = await import("./cms.js");

const NOW = new Date("2026-09-16T12:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

/* منيو المتجر (نفس شكل catalog.menuRows) */
const MENU = [
  { id: "10", title: "بطاطس محمرة", price: 9, image: "fries.jpg", category: "اضافات" },
  { id: "11", title: "كلوسلو", price: 6, image: "cole.jpg", category: "اضافات" },
  { id: "12", title: "مياه", price: 2, image: "water.jpg", category: "اضافات" },
  { id: "13", title: "بيبسي زجاج", price: 5, image: "pepsi.jpg", category: "اضافات" },
  { id: "14", title: "مشروبات غازية - كان", price: 4, image: "can.jpg", category: "اضافات" },
  { id: "20", title: "كريب زنجر سوبريم", price: 28, image: "", category: "كريبات" },
  { id: "21", title: "كريب ستربس", price: 14, image: "strips.jpg", category: "كريبات" },
  { id: "30", title: "طبق كبدة اسكندراني", price: 22, image: "", category: "وجبات" },
  { id: "31", title: "حواوشي", price: 13, image: "haw.jpg", category: "حواوشي" },
  { id: "40", title: "صينية اللمة — داخل الصالة فقط", price: 100, image: "", category: "العروض", dineIn: true },
  { id: "41", title: "صوص جبنة", price: 3, image: "", category: "اضافات", dineIn: true },
  { id: "50", title: "ثومية", price: 2, image: "garlic.jpg", category: "Offers" },
  { id: "60", title: "كبدة مشوية كيلو", price: 12, image: "", category: "وجبات" },
  { id: "61", title: "كبدة مشوية نص", price: 7, image: "", category: "وجبات" },
];

function fakeOrdersData() {
  const ts = [];
  let n = 0;
  const order = (type, day, names) => { n++; names.forEach((name) => ts.push({ order_id: "T" + n, name, order_type: type, at: daysAgo(day) })); };
  // بطاطس + كلوسلو: اقتران قوي في الصالة
  for (let i = 0; i < 8; i++) order("Created", 5 + i, ["بطاطس محمره", "كلوسلو"]);
  // كريب زنجر + ستربس: من التطبيقات
  for (let i = 0; i < 5; i++) order("External", 10 + i, ["كريب زنجر سوبريم", "كريب ستربس - كبير"]);
  // كبدة + حواوشي + مياه
  for (let i = 0; i < 4; i++) order("Table", 20, ["طبق كبدة اسكندراني", "حواوشي", "Water"]);
  // مياه لوحدها كتير (شعبية)
  for (let i = 0; i < 6; i++) order("Created", 3, ["مياة"]);
  // مستبعدة
  for (let i = 0; i < 20; i++) order("Refund", 2, ["بطاطس محمرة", "مياه"]);
  for (let i = 0; i < 20; i++) order("Void QR-Menu Orders", 2, ["كريب ستربس", "مياه"]);
  // اسم مش في المنيو
  order("Created", 2, ["ستيك ريب اي", "بطاطس محمرة"]);
  const shop = [
    { order_no: "W1", created_at: daysAgo(1), items: [{ product_id: 10, quantity: 1 }, { product_id: 11, quantity: 2 }] },
    { order_no: "W2", created_at: daysAgo(1), items: JSON.stringify([{ product_id: 10 }, { product_id: 11 }, { product_id: 99, bundle: "box96" }]) },
  ];
  return { ts, shop };
}

/* داتابيز مزيّفة بتفهم استعلامات recs.js */
function fakePool({ data = fakeOrdersData(), settings = {}, sessions = {}, customerShop = {}, customerTs = {}, failAll = false } = {}) {
  const db = { rec_pairs: [], rec_items: [], rec_meta: null, settings, sql: [], writes: [] };
  const zip = (cols, arrays) => arrays[0].map((_, i) => Object.fromEntries(cols.map((c, k) => [c, arrays[k][i]])));
  db.query = async (sql, p = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    db.sql.push(s);
    if (failAll) throw new Error("db down");
    if (/^CREATE TABLE/i.test(s)) return { rows: [] };
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s)) return { rows: [] };
    if (/^DELETE FROM rec_pairs/i.test(s)) { db.rec_pairs = []; return { rows: [] }; }
    if (/^DELETE FROM rec_items/i.test(s)) { db.rec_items = []; return { rows: [] }; }
    if (/^INSERT INTO rec_pairs/i.test(s)) {
      db.rec_pairs.push(...zip(["a_id", "b_id", "together", "together_w", "in_store", "apps", "online", "confidence", "lift", "last_seen"], p.slice(0, 10)));
      return { rows: [] };
    }
    if (/^INSERT INTO rec_items/i.test(s)) {
      db.rec_items.push(...zip(["product_id", "name", "price", "image", "category", "dine_in", "orders", "orders_w", "in_store", "apps", "online", "last_seen"], p.slice(0, 12)));
      return { rows: [] };
    }
    if (/^INSERT INTO rec_meta/i.test(s)) { db.rec_meta = { built_at: p[0], stats: JSON.parse(p[1]) }; return { rows: [] }; }
    if (/FROM rec_pairs/i.test(s)) return { rows: db.rec_pairs.map((r) => ({ ...r })) };
    if (/FROM rec_items/i.test(s)) return { rows: db.rec_items.map((r) => ({ ...r })) };
    if (/FROM rec_meta/i.test(s)) return { rows: db.rec_meta ? [db.rec_meta] : [] };
    if (/FROM ts_order_items i JOIN ts_orders o/i.test(s)) {
      // الفلتر الحقيقي في SQL — المزيّفة بتطبّقه بنفس المعنى
      return { rows: data.ts.filter((r) => !/void|refund|parked/i.test(r.order_type)) };
    }
    if (/^SELECT order_no, items, created_at FROM shop_orders/i.test(s)) return { rows: data.shop };
    if (/FROM acct_sessions/i.test(s)) return { rows: sessions[p[0]] ? [{ phone_norm: sessions[p[0]] }] : [] };
    if (/^SELECT order_no, items FROM shop_orders WHERE phone_norm/i.test(s)) return { rows: customerShop[p[0]] || [] };
    if (/FROM ts_orders o JOIN ts_order_items i/i.test(s)) return { rows: customerTs[p[0]] || [] };
    if (/^UPDATE settings/i.test(s)) {
      db.writes.push({ sql: s, value: JSON.parse(p[0]) });
      db.settings = { ...db.settings, shop: { ...(db.settings.shop || {}), recommendations: JSON.parse(p[0]) } };
      return { rows: [], rowCount: 1 };
    }
    throw new Error("unexpected SQL: " + s.slice(0, 80));
  };
  return db;
}

function makeApp(pool, { admin = true, menuRows = async () => MENU, hiddenOfferIds = () => new Set() } = {}) {
  const app = new Hono();
  const ctx = {
    pool,
    requireAdmin: async (c) => (admin ? null : c.json({ error: "unauthorized" }, 401)),
    getSettingsData: async () => pool.settings,
    jb: (v) => JSON.stringify(v),
  };
  const api = recs.register(app, ctx, { menuRows, rawMenu: null, hiddenOfferIds, now: () => NOW, schedule: false });
  return { app, api };
}

/* ═══ صافية ═════════════════════════════════════════════════════════════ */

test("normName/baseName: unify alef, taa marbuta, harakat, dine-in note, sizes", () => {
  assert.equal(recs.normName("بطاطس مُحمّرة"), recs.normName("بطاطس محمره"));
  assert.equal(recs.normName("مياة"), recs.normName("مياه"));
  assert.equal(recs.normName("صينية اللمة — داخل الصالة فقط"), recs.normName("صينيه اللمه"));
  assert.equal(recs.baseName("كبدة مشوية كيلو"), recs.baseName("كبدة مشوية نص"));
});

test("makeResolver: exact, size suffix, prefix, containment; unmatched stays out", () => {
  const r = recs.makeResolver(MENU, [["Water", "12"]]);
  assert.equal(r("بطاطس محمره"), "10");
  assert.equal(r("كريب ستربس - كبير"), "21");
  assert.equal(r("كريب زنجر سوبريم حار"), "20");
  assert.equal(r("Water"), "12");
  assert.equal(r("مياة"), "12");
  assert.equal(r("ستيك ريب اي"), null);
  assert.equal(r(""), null);
});

test("sourceOfType: in_store / apps / online / excluded", () => {
  assert.equal(recs.sourceOfType("Created"), "in_store");
  assert.equal(recs.sourceOfType("Table"), "in_store");
  assert.equal(recs.sourceOfType(null), "in_store");
  assert.equal(recs.sourceOfType("External"), "apps");
  assert.equal(recs.sourceOfType("QR-Menu Orders"), "online");
  for (const t of ["Refund", "Void", "Parked", "Void QR-Menu Orders"]) assert.equal(recs.sourceOfType(t), null, t);
});

test("recencyWeight: 1 inside the window, halves per window after, floor 0.2", () => {
  assert.equal(recs.recencyWeight(10, 90), 1);
  assert.equal(recs.recencyWeight(90, 90), 1);
  assert.equal(recs.recencyWeight(180, 90), 0.5);
  assert.equal(recs.recencyWeight(2000, 90), 0.2);
});

test("normalizeSettings: defaults, clamps, id lists", () => {
  assert.deepEqual(recs.normalizeSettings(undefined), { ...recs.DEFAULT_SETTINGS, pinned: [], excluded: [] });
  const s = recs.normalizeSettings({ enabled: false, maxPrice: "20", limit: 99, pinned: ["12", "12", "bad id", 13], excluded: "10, 11", weightRecentDays: 1, personalBoost: false });
  assert.equal(s.enabled, false);
  assert.equal(s.maxPrice, 20);
  assert.equal(s.limit, 12);
  assert.deepEqual(s.pinned, ["12", "13"]);
  assert.deepEqual(s.excluded, ["10", "11"]);
  assert.equal(s.weightRecentDays, 7);
  assert.equal(s.personalBoost, false);
});

test("shopItemIds skips bundle lines and parses JSON strings", () => {
  assert.deepEqual([...recs.shopItemIds('[{"product_id":1},{"product_id":2,"bundle":"b"},{"productId":"3"}]')], ["1", "3"]);
  assert.deepEqual([...recs.shopItemIds(null)], []);
});

test("buildPairs: together, source split, confidence, lift, last_seen, minTogether", () => {
  const orders = [
    { source: "in_store", at: daysAgo(1), ids: new Set(["a", "b"]) },
    { source: "apps", at: daysAgo(2), ids: new Set(["a", "b"]) },
    { source: "online", at: daysAgo(3), ids: new Set(["a", "c"]) },
    { source: "in_store", at: daysAgo(4), ids: new Set(["c"]) },
  ];
  const B = recs.buildPairs(orders, { now: NOW, weightRecentDays: 90 });
  const ab = B.pairs.find((p) => p.a_id === "a" && p.b_id === "b");
  assert.equal(ab.together, 2);
  assert.deepEqual([ab.in_store, ab.apps, ab.online], [1, 1, 0]);
  assert.equal(ab.confidence, 0.6667); // 2 of a's 3 orders
  assert.equal(ab.lift, 1.3333);       // (2*4)/(3*2)
  assert.equal(ab.last_seen, daysAgo(1));
  const ba = B.pairs.find((p) => p.a_id === "b" && p.b_id === "a");
  assert.equal(ba.confidence, 1);
  assert.equal(B.pairs.some((p) => p.a_id === "a" && p.b_id === "c"), false, "together=1 is below minTogether");
  assert.equal(B.orders, 4);
});

test("buildPairs: old orders weigh less", () => {
  const B = recs.buildPairs([
    { source: "in_store", at: daysAgo(270), ids: new Set(["a", "b"]) },
    { source: "in_store", at: daysAgo(270), ids: new Set(["a", "b"]) },
  ], { now: NOW, weightRecentDays: 90 });
  assert.equal(B.pairs[0].together, 2);
  assert.equal(B.pairs[0].together_w, 0.5); // 2 × 0.25
});

/* موديل صغير مباشر لاختبار التقييم */
function modelOf(pairs, items = []) {
  const byA = new Map();
  for (const p of pairs) { if (!byA.has(p.a_id)) byA.set(p.a_id, []); byA.get(p.a_id).push(p); }
  return { byA, items: new Map(items.map((i) => [i.product_id, i])) };
}
const P = (a, b, together, confidence, lift) => ({ a_id: a, b_id: b, together, confidence, lift, in_store: together, apps: 0, online: 0 });

test("scoreCart: filters cart, dine-in, offers page, hidden, excluded, maxPrice, same dish", () => {
  const menu = recs.menuMapOf(MENU);
  const model = modelOf([
    P("30", "10", 20, 0.5, 2), P("30", "30", 20, 0.9, 3), P("30", "41", 20, 0.9, 3), P("30", "40", 20, 0.9, 3),
    P("30", "50", 20, 0.9, 3), P("30", "11", 20, 0.9, 3), P("30", "21", 20, 0.9, 3), P("30", "31", 20, 0.9, 3),
    P("30", "61", 20, 0.9, 3), P("60", "61", 20, 0.9, 3),
  ]);
  const out = recs.scoreCart({
    cartIds: ["30", "60"], model, menu, hidden: new Set(["31"]),
    settings: { maxPrice: 15, excluded: ["11"] },
  });
  const ids = out.map((x) => x.product_id);
  for (const bad of ["30", "41", "40", "50", "11", "31", "61"]) assert.equal(ids.includes(bad), false, bad);
  assert.ok(ids.includes("10"));
  assert.ok(ids.includes("21"));
  for (const x of out) {
    assert.ok(x.price <= 15);
    assert.deepEqual(Object.keys(x).sort(), ["image", "name", "price", "product_id", "reason"]);
  }
});

test("scoreCart: lift>1 beats a coincidental pair; multi-item carts add a bonus", () => {
  const menu = recs.menuMapOf(MENU);
  const model = modelOf([
    P("20", "12", 40, 0.6, 0.9),  // مياه مع كل حاجة — صدفة
    P("20", "21", 30, 0.4, 4.2),  // ستربس — اقتران حقيقي
    P("10", "13", 10, 0.2, 1.5), P("20", "13", 10, 0.2, 1.5),
  ]);
  const out = recs.scoreCart({ cartIds: ["20", "10"], model, menu, settings: {} });
  assert.equal(out[0].product_id, "21");
  assert.equal(out[0].reason, "pair");
  assert.ok(out.findIndex((x) => x.product_id === "13") < out.findIndex((x) => x.product_id === "12"));
});

test("scoreCart: pinned first, popular fallback, limit, personal reason", () => {
  const menu = recs.menuMapOf(MENU);
  const model = modelOf([P("20", "21", 30, 0.4, 4.2)], [
    { product_id: "12", orders_w: 50 }, { product_id: "13", orders_w: 20 }, { product_id: "10", orders_w: 5 },
  ]);
  const out = recs.scoreCart({
    cartIds: ["20"], model, menu, settings: { pinned: ["14", "40"], limit: 6 },
    personal: new Map([["11", 5]]),
  });
  assert.deepEqual(out.map((x) => [x.product_id, x.reason]), [
    ["14", "pinned"], ["21", "pair"], ["11", "personal"], ["12", "popular"], ["10", "popular"], ["13", "popular"],
  ]);
  assert.equal(recs.scoreCart({ cartIds: ["20"], model, menu, settings: {}, limit: 2 }).length, 2);
  // personalBoost off → no personal item
  const off = recs.scoreCart({ cartIds: ["20"], model, menu, settings: { personalBoost: false }, personal: new Map([["11", 5]]) });
  assert.equal(off.some((x) => x.reason === "personal"), false);
});

test("scoreCart: at most two drinks unless nothing else is left", () => {
  const menu = recs.menuMapOf(MENU);
  const model = modelOf([P("30", "12", 30, 0.9, 3), P("30", "13", 30, 0.8, 3), P("30", "14", 30, 0.7, 3), P("30", "10", 5, 0.1, 1.2)]);
  const out = recs.scoreCart({ cartIds: ["30"], model, menu, settings: { limit: 3 } });
  assert.deepEqual(out.map((x) => x.product_id), ["12", "13", "10"]);
  const four = recs.scoreCart({ cartIds: ["30"], model, menu, settings: { limit: 4 } });
  assert.deepEqual(four.map((x) => x.product_id), ["12", "13", "10", "14"]);
});

/* ═══ البناء + المسارات بداتابيز مزيّفة ═════════════════════════════════ */

test("build: POS names mapped to product ids, excluded types dropped, online merged, table written", async () => {
  const pool = fakePool();
  const { app, api } = makeApp(pool);
  const r = await api.build({ reason: "test" });
  const fc = pool.rec_pairs.find((p) => p.a_id === "10" && p.b_id === "11");
  assert.ok(fc, "fries → coleslaw pair exists");
  assert.equal(fc.together, 10);             // 8 in-store + 2 online
  assert.equal(fc.in_store, 8);
  assert.equal(fc.online, 2);
  assert.ok(fc.lift > 1);
  const zs = pool.rec_pairs.find((p) => p.a_id === "20" && p.b_id === "21");
  assert.equal(zs.apps, 5);
  // refunds/voids must not create a fries↔water or strips↔water pair
  assert.equal(pool.rec_pairs.some((p) => p.a_id === "10" && p.b_id === "12"), false);
  assert.equal(pool.rec_pairs.some((p) => p.a_id === "21" && p.b_id === "12"), false);
  // bundle line 99 never enters
  assert.equal(pool.rec_items.some((i) => i.product_id === "99"), false);
  assert.ok(r.unmatched.some((u) => u.name === "ستيك ريب اي"));
  assert.equal(pool.rec_meta.stats.pairs, pool.rec_pairs.length);
  // Water (English) has no alias with rawMenu disabled → unmatched, not guessed
  assert.ok(r.unmatched.some((u) => u.name === "Water"));

  const res = await app.request("/api/shop/recommendations?items=10&option=delivery&limit=6");
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.items[0].product_id, "11");
  assert.equal(j.items[0].reason, "pair");
  assert.equal(j.items.some((x) => x.product_id === "10"), false);
});

test("public endpoint: never 5xx, ok:false + [] when the DB is down", async () => {
  const pool = fakePool({ failAll: true });
  const app = new Hono();
  recs.register(app, {
    pool, requireAdmin: async () => null, jb: JSON.stringify,
    getSettingsData: async () => { throw new Error("db down"); },
  }, { menuRows: async () => MENU, rawMenu: null, now: () => NOW, schedule: false });
  const res = await app.request("/api/shop/recommendations?items=10");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, items: [] });
});

test("public endpoint: disabled → empty; hidden ids and stopped offers filtered; maxPrice from settings", async () => {
  const pool = fakePool({ settings: { shop: { recommendations: { enabled: false } } } });
  const { app, api } = makeApp(pool);
  await api.build();
  let j = await (await app.request("/api/shop/recommendations?items=10")).json();
  assert.deepEqual(j, { ok: true, items: [] });

  const pool2 = fakePool({ settings: { catalog: { hiddenIds: ["11"] }, shop: { recommendations: { maxPrice: 5 } } } });
  const m2 = makeApp(pool2, { hiddenOfferIds: () => new Set(["21"]) });
  await m2.api.build();
  j = await (await m2.app.request("/api/shop/recommendations?items=20,10")).json();
  const ids = j.items.map((x) => x.product_id);
  assert.equal(ids.includes("11"), false);
  assert.equal(ids.includes("21"), false);
  assert.ok(j.items.every((x) => x.price <= 5));
});

test("public endpoint: logged-in customer gets their own add-ons as personal", async () => {
  const tok = "ab".repeat(24);
  const pool = fakePool({
    sessions: { [tok]: "512345678" },
    customerShop: { "512345678": [{ order_no: "W9", items: [{ product_id: 13 }] }, { order_no: "W8", items: [{ product_id: 13 }] }] },
    customerTs: { "512345678": [{ order_id: "T900", name: "بيبسي زجاج" }] },
  });
  const { app, api } = makeApp(pool);
  await api.build();
  const res = await app.request("/api/shop/recommendations?items=20", { headers: { Authorization: `Bearer cust:${tok}` } });
  const j = await res.json();
  const pepsi = j.items.find((x) => x.product_id === "13");
  assert.ok(pepsi, "customer's own drink is suggested");
  assert.equal(pepsi.reason, "personal");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  // no writes from a public read (acct_sessions is only SELECTed)
  assert.equal(pool.sql.some((s) => /^UPDATE acct_sessions/i.test(s)), false);
});

test("public endpoint answers under 150ms from the precomputed table (3000 pairs)", async () => {
  const pool = fakePool();
  const { app, api } = makeApp(pool);
  await api.build();
  for (let i = 0; i < 3000; i++) {
    pool.rec_pairs.push({ a_id: String(1000 + (i % 60)), b_id: String(["10", "11", "12", "13", "14"][i % 5]), together: 5, together_w: 5, in_store: 5, apps: 0, online: 0, confidence: 0.2, lift: 1.5, last_seen: null });
  }
  await api.loadModel(true);
  await app.request("/api/shop/recommendations?items=10"); // warm settings cache
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) {
    const r = await app.request(`/api/shop/recommendations?items=10,20,1001,1002,1003&limit=6`);
    assert.equal(r.status, 200);
  }
  const avg = (performance.now() - t0) / 20;
  assert.ok(avg < 150, `avg ${avg.toFixed(1)}ms`);
});

test("admin: settings GET/PUT require admin, normalise, persist under settings.shop.recommendations", async () => {
  const pool = fakePool();
  const locked = makeApp(pool, { admin: false });
  assert.equal((await locked.app.request("/api/cms/recommendations/settings")).status, 401);
  assert.equal((await locked.app.request("/api/cms/recommendations/preview?product_id=10")).status, 401);
  assert.equal((await locked.app.request("/api/cms/recommendations/rebuild", { method: "POST" })).status, 401);

  const { app } = makeApp(pool);
  let j = await (await app.request("/api/cms/recommendations/settings")).json();
  assert.equal(j.ok, true);
  assert.equal(j.settings.maxPrice, 15);
  const put = await app.request("/api/cms/recommendations/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxPrice: 20, pinned: ["12", "12"], limit: 50, junk: 1 }),
  });
  j = await put.json();
  assert.equal(j.ok, true);
  assert.equal(j.settings.maxPrice, 20);
  assert.equal(j.settings.limit, 12);
  assert.deepEqual(j.settings.pinned, ["12"]);
  assert.equal("junk" in j.settings, false);
  assert.match(pool.writes[0].sql, /'\{shop,recommendations\}'/);
  j = await (await app.request("/api/cms/recommendations/settings")).json();
  assert.equal(j.settings.maxPrice, 20);
  const bad = await app.request("/api/cms/recommendations/settings", { method: "PUT", body: "nope" });
  assert.equal(bad.status, 400);
});

test("admin preview: score, together, lift, source split, eligibility", async () => {
  const pool = fakePool();
  const { app, api } = makeApp(pool);
  await api.build();
  const j = await (await app.request("/api/cms/recommendations/preview?product_id=10")).json();
  assert.equal(j.ok, true);
  assert.equal(j.product.name, "بطاطس محمرة");
  const cole = j.pairs.find((p) => p.product_id === "11");
  assert.equal(cole.together, 10);
  assert.deepEqual(cole.sources, { in_store: 8, apps: 0, online: 2 });
  assert.ok(cole.lift > 1 && cole.score > 0);
  assert.equal(cole.eligible, true);
  assert.equal(j.wouldShow[0].product_id, "11");
  const z = await (await app.request("/api/cms/recommendations/preview?product_id=20")).json();
  const strips = z.pairs.find((p) => p.product_id === "21");
  assert.equal(strips.eligible, true);
  assert.deepEqual(strips.sources, { in_store: 0, apps: 5, online: 0 });
  assert.equal((await app.request("/api/cms/recommendations/preview")).status, 400);
});

test("cms: recommendations admin routes belong to the products section", () => {
  assert.equal(sectionOf("/api/cms/recommendations/settings"), "products");
  assert.equal(sectionOf("/api/cms/recommendations/preview"), "products");
  assert.equal(sectionOf("/api/cms/recommendations/rebuild"), "products");
});

test("public endpoint: empty limit falls back to settings; Vary: Authorization; stopped offer productIds hidden", async () => {
  const pool = fakePool();
  const app = new Hono();
  const api = recs.register(app, {
    pool, requireAdmin: async () => null, getSettingsData: async () => pool.settings, jb: JSON.stringify,
  }, {
    menuRows: async () => MENU, rawMenu: null, hiddenOfferIds: () => new Set(), now: () => NOW, schedule: false,
    // عرض موقوف مربوط بصنف الكلوسلو (11) ⇒ نفس قاعدة المتجر: مايتعرضش
    offers: [{ id: "x", productId: "11", enabled: false }, { id: "y", productId: "13", enabled: true, from: "2027-01-01" }],
  });
  await api.build();
  const res = await app.request("/api/shop/recommendations?items=10&limit=");
  assert.equal(res.headers.get("vary"), "Authorization");
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  const j = await res.json();
  assert.equal(j.ok, true);
  const ids = j.items.map((x) => x.product_id);
  assert.equal(ids.includes("11"), false, "stopped offer item is hidden");
  assert.ok(j.items.length > 1, "empty limit is not treated as 1");
  // «قادم» مش موقوف — المتجر مابيخفيهوش، فإحنا كمان لأ
  const p = await (await app.request("/api/cms/recommendations/preview?product_id=10")).json();
  assert.notEqual(p.pairs.find((x) => x.product_id === "13")?.blockedBy, "hidden");
});
