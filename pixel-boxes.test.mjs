// Pixel review (10/10): the boxes are in the Meta catalogue feed and every event of a box
// (browser map, server copy, server Purchase) carries the id of its catalogue row.
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

process.env.META_WEB_PIXEL_ID = "PIXEL_TEST";
process.env.META_CAPI_TOKEN = "fake-token-for-tests";

const F = await import("./funnel.js");
const C = await import("./catalog.js");

const BOX = { slug: "box-crepe-duo", name: "بوكس الكريب لشخصين", description: "كريبين من اختيارك", price: "65", image: "https://x/y.jpg", active: true, offer_id: null, order_kinds: ["delivery", "pickup", "dine_in"] };

test("boxCatalogId: the slug is the catalogue id; a slug without the prefix gets it; junk is refused", () => {
  assert.equal(C.boxCatalogId("box-crepe-duo"), "box-crepe-duo");
  assert.equal(C.boxCatalogId("Box-Crepe-Duo "), "box-crepe-duo");
  assert.equal(C.boxCatalogId("family-night"), "box-family-night");
  for (const bad of ["", null, "b:box", "a b", "x", "-box", "بوكس", "a".repeat(80)]) assert.equal(C.boxCatalogId(bad), null, String(bad));
});

test("boxRowsOf: one row per active, orderable box with a picture; offer bundles and table-only boxes stay out", () => {
  const rows = C.boxRowsOf([
    BOX,
    { ...BOX, slug: "box-solo-crepe", price: 29 },
    { ...BOX, slug: "box-crepe-duo" },                                   // duplicate slug
    { ...BOX, slug: "box-off", active: false },
    { ...BOX, slug: "gathering-4", offer_id: "gathering_4" },            // has its own offer row
    { ...BOX, slug: "box-noimg", image: null },
    { ...BOX, slug: "box-free", price: 0 },
    { ...BOX, slug: "box-table", order_kinds: ["dine_in"] },
    { ...BOX, slug: "box-noname", name: " " },
    null,
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["box-crepe-duo", "box-solo-crepe"]);
  assert.deepEqual(rows[0], { id: "box-crepe-duo", boxSlug: "box-crepe-duo", title: BOX.name, description: BOX.description, price: 65, image: BOX.image, category: "Boxes", isBox: true });
  assert.deepEqual(C.boxRowsOf(null), []);
});

test("catalogLink: a box opens its own picker on the storefront", () => {
  assert.match(C.catalogLink(C.boxRowsOf([BOX])[0]), /\/\?box=box-crepe-duo$/);
  assert.match(C.catalogLink({ id: "59" }), /\/#item-59$/);
  assert.match(C.catalogLink({ id: "offer-x", offerId: "x" }), /\/\?offer=x$/);
});

test("withBoxRows: boxes are appended and never repeat an id already in the feed", () => {
  const out = C.withBoxRows([{ id: "59" }, { id: "box-solo-crepe" }], C.boxRowsOf([BOX, { ...BOX, slug: "box-solo-crepe" }]));
  assert.deepEqual(out.map((r) => r.id), ["59", "box-solo-crepe", "box-crepe-duo"]);
  assert.deepEqual(C.withBoxRows(null, null), []);
});

test("bundleCatalogId: offer bundle → the offer's row; plain box → its own row", () => {
  const offerOf = (id) => (id === "gathering_4" ? { productId: "offer-gathering_4" } : null);
  assert.equal(F.bundleCatalogId({ slug: "gathering-4", offer_id: "gathering_4" }, offerOf), "offer-gathering_4");
  assert.equal(F.bundleCatalogId({ slug: "old", offer_id: "gone" }, offerOf), null);          // an offer that no longer exists maps to nothing
  assert.equal(F.bundleCatalogId({ slug: "box-crepe-duo", offer_id: null }, offerOf), "box-crepe-duo");
  assert.equal(F.bundleCatalogId(null, offerOf), null);
});

test("canonicalContentId: «b:<slug>» becomes the catalogue id; anything else passes through", () => {
  const map = { "box-crepe-duo": "box-crepe-duo" };
  assert.equal(F.canonicalContentId("b:box-crepe-duo", map), "box-crepe-duo");
  assert.equal(F.canonicalContentId("b:unknown", map), "b:unknown");
  assert.equal(F.canonicalContentId("59", map), "59");
});

test("purchaseContentsOf: a box in a paid order is ONE row with the box id and the price paid for it", async () => {
  const line = (o) => ({ mf: 1000000, bundle: "box-grill-half-half", bundle_qty: 1, bundle_line: "box-grill-half-half-a-0", bundle_name: "بوكس المشاوي نص ونص", quantity: 1, ...o });
  const items = [
    line({ product_id: 91, unit_amount: 45289855 }), line({ product_id: 91, unit_amount: 45289855 }),
    line({ product_id: 123, unit_amount: 4528986, quantity: 2 }), line({ product_id: 79, unit_amount: 4528985 }), line({ product_id: 72, unit_amount: 4528985 }),
    { mf: 1000000, product_id: 59, name: "بنا تشيكن كازرول", quantity: 1, unit_amount: 24347826 },
  ];
  const out = await F.purchaseContentsOf(items, 0, null, { "box-grill-half-half": "box-grill-half-half" });
  assert.deepEqual(out.map((r) => r.id), ["box-grill-half-half", "59"]);
  assert.equal(out[0].quantity, 1);
  assert.equal(out[0].itemPrice, 125);                 // 2×45.29 + 2×4.53 + 4.53 + 4.53 net, ×1.15
  assert.equal(out[1].itemPrice, 28);
  // without the map (the behaviour before): the box falls apart into its components
  const before = await F.purchaseContentsOf(items, 0, null, {});
  assert.deepEqual(before.map((r) => r.id).sort(), ["123", "59", "72", "79", "91"]);
});

function setup(bundles) {
  const calls = [];
  const pool = { async query(sql) {
    if (/SELECT slug, offer_id FROM cms_bundles/.test(sql)) return { rows: bundles, rowCount: bundles.length };
    if (/INSERT INTO/.test(sql)) return { rows: [{ id: "x" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const app = new Hono();
  F.register(app, { pool, requireAdmin: async () => null, jb: (v) => JSON.stringify(v), normPhone: (s) => String(s || "").replace(/\D/g, "") }, {
    httpJson: async (url, opt) => { calls.push({ url, body: opt.body }); return { ok: true, status: 200, json: { events_received: 1 } }; },
  });
  return { calls, app };
}

test("route /api/funnel/config: the browser map has every box, so the pixel sends the catalogue id", async () => {
  const { app } = setup([{ slug: "box-crepe-duo", offer_id: null }, { slug: "family-night", offer_id: null }]);
  const j = await (await app.request("/api/funnel/config")).json();
  assert.equal(j.contentIds["b:box-crepe-duo"], "box-crepe-duo");
  assert.equal(j.contentIds["b:family-night"], "box-family-night");
});

test("route /api/funnel/event: the server copy of a box event carries the catalogue id in content_ids and contents", async () => {
  const { calls, app } = setup([{ slug: "box-crepe-duo", offer_id: null }]);
  const r = await app.request("/api/funnel/event", { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9", "user-agent": "Mozilla/5.0 (iPhone)" },
    body: JSON.stringify({ eventName: "ViewContent", eventId: "e1", value: 65, anonId: "dmg3k2x1abcdefgh", contents: [{ id: "b:box-crepe-duo", name: "x", quantity: 1, item_price: 65 }] }) });
  assert.equal(r.status, 200);
  const cd = calls.find((c) => /facebook/.test(c.url)).body.data[0].custom_data;
  assert.deepEqual(cd.content_ids, ["box-crepe-duo"]);
  assert.deepEqual(cd.contents, [{ id: "box-crepe-duo", quantity: 1, item_price: 65 }]);
  assert.equal(cd.content_type, "product");
});
