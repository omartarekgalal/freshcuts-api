/* «خلص النهارده» — node --test soldout.test.mjs
   المنطق الصافي + المسارات (بورتال/لوحة) + رفض الشيك أوت والباقة. كله وهمي. */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  nextOpening, activeSoldOut, soldOutLines, groupMenu, makeSoldOutStore, register,
} from "./soldout.js";
import { register as registerShop } from "./shop.js";

const HOURS = { enabled: true, days: Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
  .map((d) => [d, { open: "12:00", close: "02:00" }])) };
// ٢٠٢٦-٠٩-١٨ الساعة ١٥:٠٠ الرياض = ١٢:٠٠ UTC
const T = Date.parse("2026-09-18T12:00:00Z");

test("nextOpening: وسط الشغل ← بكرة ١٢ الرياض، قبل الفتح ← النهارده ١٢، بعد نص الليل ← النهارده ١٢", () => {
  assert.equal(nextOpening(HOURS, T), "2026-09-19T09:00:00.000Z");
  assert.equal(nextOpening(HOURS, Date.parse("2026-09-18T06:00:00Z")), "2026-09-18T09:00:00.000Z"); // ٩ الصبح
  assert.equal(nextOpening(HOURS, Date.parse("2026-09-18T22:30:00Z")), "2026-09-19T09:00:00.000Z"); // ١:٣٠ فجراً
  assert.equal(nextOpening(null, T), "2026-09-19T09:00:00.000Z"); // مفيش مواعيد = ١٢
  const fri = { ...HOURS, days: { ...HOURS.days, sat: { closed: true } } };
  assert.equal(nextOpening(fri, T), "2026-09-20T09:00:00.000Z"); // السبت مقفول ⇒ الحد
});

test("activeSoldOut: اللي وقته عدّى بيرجع لوحده، وnull = لحد ما حد يفتحه", () => {
  const m = {
    108: { at: "x", by: "أحمد", until: "2026-09-18T11:00:00Z" },
    91: { at: "x", by: "أحمد", until: "2026-09-19T09:00:00Z" },
    94: { at: "x", by: "أحمد", until: null },
  };
  assert.deepEqual(Object.keys(activeSoldOut(m, T)).sort(), ["91", "94"]);
  assert.deepEqual(activeSoldOut(null, T), {});
});

test("soldOutLines: بيطلع الصنف الخلصان مرة واحدة باسمه", () => {
  const bad = soldOutLines([{ product_id: 91, name: "كفتة" }, { product_id: 91 }, { product_id: 5 }], { 91: {} });
  assert.deepEqual(bad, [{ product_id: 91, name: "كفتة" }]);
});

/* قاعدة وهمية بتنفّذ jsonb_set / #- على settings.catalog.soldOut */
function fakeDb(settings = {}) {
  const db = { settings: JSON.parse(JSON.stringify(settings)), audit: [] };
  const pool = {
    query: async (sql, vals = []) => {
      if (/ARRAY\['catalog','soldOut',\$1::text\], \$2::jsonb/.test(sql)) {
        db.settings.catalog = db.settings.catalog || {};
        db.settings.catalog.soldOut = { ...(db.settings.catalog.soldOut || {}), [vals[0]]: JSON.parse(vals[1]) };
      } else if (/#- ARRAY\['catalog','soldOut',\$1::text\]/.test(sql)) {
        if (db.settings.catalog?.soldOut) delete db.settings.catalog.soldOut[vals[0]];
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return { db, pool, getSettingsData: async () => db.settings };
}

test("store.set: قفل افتراضي لحد الفتح الجاي، يدوي null، وفتح بيشيل المفتاح", async () => {
  const f = fakeDb({ hours: HOURS });
  const st = makeSoldOutStore({ pool: f.pool, getSettingsData: f.getSettingsData, now: () => T });
  const r = await st.set(108, { soldOut: true, by: "أحمد" });
  assert.equal(r.ok, true);
  assert.equal(f.db.settings.catalog.soldOut["108"].until, "2026-09-19T09:00:00.000Z");
  assert.equal(f.db.settings.catalog.soldOut["108"].by, "أحمد");
  await st.set(94, { soldOut: true, until: null });
  assert.equal(f.db.settings.catalog.soldOut["94"].until, null);
  assert.deepEqual(Object.keys(await st.active()).sort(), ["108", "94"]);
  await st.set("108", { soldOut: false });
  assert.deepEqual(Object.keys(await st.active()), ["94"]);
  assert.equal((await st.set("abc", { soldOut: true })).ok, false);
});

const MENU = { data: { pages: [
  { title: "Best Sellers", local_title: "الأكثر طلباً", items: [{ id: 108, name: "كبدة مشوية بالوزن", retail_price: 45 }] },
  { title: "Grilled KG", local_title: "مشاوي بالوزن", items: [{ id: 108, name: "كبدة مشوية بالوزن", retail_price: 45 }, { id: 91, name: "كفتة مشوية بالوزن", retail_price: 47 }] },
] } };

test("groupMenu: كل صنف مرة في قسمه الحقيقي + حالة خلص", () => {
  const g = groupMenu(MENU, { 108: { at: "a", by: "أحمد", until: null } });
  assert.equal(g.length, 1);
  assert.equal(g[0].category, "مشاوي بالوزن");
  assert.equal(g[0].items.find((i) => i.id === "108").soldOut, true);
  assert.equal(g[0].items.find((i) => i.id === "91").soldOut, false);
});

function routes({ role = "manager", settings = {} } = {}) {
  const f = fakeDb({ hours: HOURS, ...settings });
  const app = new Hono();
  const audit = [];
  const requirePortal = async (c, need) => {
    const r = c.req.header("x-role") || role;
    if (need === "manager" && r !== "manager") return { res: c.json({ ok: false, error: "forbidden" }, 403) };
    return { user: { id: "s1", name: r === "manager" ? "المدير أحمد" : "كاشير", role: r } };
  };
  register(app, {
    pool: f.pool, getSettingsData: f.getSettingsData, requireAdmin: async (c) => (c.req.header("x-admin") ? null : c.json({ ok: false }, 401)),
    requirePortal, audit: (...a) => audit.push(a), fetchMenu: async () => MENU, now: () => T, log: { log() {} },
  });
  return { app, f, audit };
}
const post = (app, path, body, headers = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("بورتال: المدير يقفل ويفتح + سجل باسمه، الكاشير 403 إلا لو الإعداد سامح", async () => {
  const { app, f, audit } = routes();
  let r = await post(app, "/api/portal/menu-availability", { productId: 108, soldOut: true, name: "كبدة" });
  assert.equal(r.status, 200);
  assert.equal(f.db.settings.catalog.soldOut["108"].by, "المدير أحمد");
  assert.equal(audit[0][1], "item_sold_out");
  let j = await (await app.request("/api/portal/menu-availability")).json();
  assert.equal(j.count, 1);
  assert.equal(j.closed[0].name, "كبدة مشوية بالوزن");
  assert.equal(j.canEdit, true);
  r = await post(app, "/api/portal/menu-availability", { productId: 108, soldOut: false });
  assert.equal(audit[1][1], "item_reopened");
  j = await (await app.request("/api/portal/menu-availability")).json();
  assert.equal(j.count, 0);

  r = await post(app, "/api/portal/menu-availability", { productId: 91, soldOut: true }, { "x-role": "cashier" });
  assert.equal(r.status, 403);
  const k = routes({ role: "cashier", settings: { portal: { cashierCanSoldOut: true } } });
  r = await post(k.app, "/api/portal/menu-availability", { productId: 91, soldOut: true, until: "manual" });
  assert.equal(r.status, 200);
  assert.equal(k.f.db.settings.catalog.soldOut["91"].until, null);
});

test("لوحة: requireAdmin", async () => {
  const { app, f } = routes();
  assert.equal((await post(app, "/api/cms/menu-availability", { productId: 91, soldOut: true })).status, 401);
  assert.equal((await post(app, "/api/cms/menu-availability", { productId: 91, soldOut: true }, { "x-admin": "1" })).status, 200);
  assert.ok(f.db.settings.catalog.soldOut["91"]);
});

/* ── الشيك أوت: رفض قبل الـOTP وقبل الدفع ── */
function fakeApp() {
  const r = {};
  const add = (m) => (p, h) => { r[`${m} ${p}`] = h; };
  return { routes: r, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
}
function ctx(body) {
  const h = { "cf-connecting-ip": `10.9.${Math.floor(Math.random() * 250)}.1` };
  return { req: { header: (n) => h[String(n).toLowerCase()], json: async () => body, param: () => undefined, query: () => undefined },
    json: (obj, status = 200) => ({ body: obj, status }) };
}
function shop(settings, bundles = () => null) {
  process.env.SHOP_SWEEP_SECONDS = "0";
  const app = fakeApp();
  let paid = 0;
  registerShop(app, {
    pool: { query: async () => ({ rows: [], rowCount: 0 }) }, requireAdmin: async () => null, requireCashierOrAdmin: async () => null,
    getSettingsData: async () => settings, jb: JSON.stringify, normPhone: (p) => String(p || "").replace(/\D/g, "").slice(-9),
  }, {
    pay: { configured: () => true, initiateSession: async () => { paid++; return { SessionId: "S" }; } },
    delivery: { quote: async () => ({ deliverable: true, fee: 0 }), shipmentOf: async () => null, cancelShipment: async () => null,
      dispatchGate: async () => ({ mode: "manual" }), canAutoDispatch: async () => false },
    emitOrder: () => {}, journey: () => ({ emit: () => {} }), bundles,
  });
  return { app, paid: () => paid };
}
const future = new Date(Date.now() + 3600_000).toISOString();

test("checkout: صنف خلصان ← 409 item_sold_out بالاسم، من غير OTP ولا دفع", async () => {
  const s = shop({ catalog: { soldOut: { 108: { at: "a", by: "أحمد", until: future } } } });
  const res = await s.app.routes["POST /api/shop/checkout"](ctx({
    option: "pickup", items: [{ product_id: 108, quantity: 1, unit_amount: 45000000, name: "كبدة مشوية بالوزن" }],
    customer: { phone: "0512345678" } }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "item_sold_out");
  assert.equal(res.body.items[0].product_id, 108);
  assert.match(res.body.message, /كبدة مشوية بالوزن/);
  assert.equal(s.paid(), 0);
});

test("checkout: القفل اللي وقته عدّى مابيمنعش (بيكمل لحد الـOTP)", async () => {
  const s = shop({ catalog: { soldOut: { 108: { at: "a", until: "2020-01-01T00:00:00Z" } } } });
  const res = await s.app.routes["POST /api/shop/checkout"](ctx({
    option: "pickup", items: [{ product_id: 108, quantity: 1, unit_amount: 45000000 }], customer: { phone: "0512345678" } }));
  assert.equal(res.body.error, "otp_required");
});

test("checkout: باقة باختيار خلصان ← item_sold_out برسالة عربي", async () => {
  const bundles = () => ({ expandBundle: async () => ({ ok: false, error: "sold_out", items: [{ product_id: 91, name: "كفتة مشوية بالوزن" }], message: "للأسف كفتة مشوية بالوزن خلص النهارده" }) });
  const s = shop({}, bundles);
  const res = await s.app.routes["POST /api/shop/checkout"](ctx({
    option: "pickup", items: [{ bundle: "national96-grill", quantity: 1, choices: { grill: { product_id: 91 } } }], customer: { phone: "0512345678" } }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "item_sold_out");
  assert.equal(res.body.bundle, "national96-grill");
});

test("cms expand: الباقة بترفض الاختيار الخلصان (soldOutLines على سطور التوسيع)", async () => {
  const { expandBundle } = await import("./bundles.js");
  const bundle = { slug: "g", price: 96, slots: [{ key: "grill", type: "choice", quantity: 1, choices: [{ product_id: "91", variant_option_id: null }, { product_id: "94", variant_option_id: null }] }] };
  const resolve = () => ({ name: "كفتة مشوية بالوزن", priceEx: 40 * 1e6, taxId: 1 });
  const r = expandBundle(bundle, { grill: { product_id: 91 } }, 1, resolve);
  assert.equal(r.ok, true);
  assert.equal(soldOutLines(r.lines, { 91: {} }).length, 1);
  assert.equal(soldOutLines(r.lines, { 94: {} }).length, 0);
});
