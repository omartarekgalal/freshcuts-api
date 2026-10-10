// P5 (owner review 10/10): a table link opened days ago must not tag a later pickup order as "table".
// Run: node --test table-attribution.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isTableAttribution, stripTableAttribution, classifySource } from "./checkout-meta.js";

const omar = { // W1791580926313 as stored: pickup, no table session, landing 5/10, order 9/10
  fc_link: "table-1", landing_at: "2026-10-05T17:34:24.037Z", captured: "checkout", ip: "x", ua: "y",
  utm: { utm_source: "qr", utm_medium: "table", utm_content: "table-1", utm_campaign: "table-qr", utm_term: "كبدة اسكندراني" },
  click: { fbclid: "abc", gclid: "def" },
};

test("table attribution is recognised by link slug, medium, content or campaign", () => {
  assert.equal(isTableAttribution(omar), true);
  assert.equal(isTableAttribution({ fc_link: "table-12" }), true);
  assert.equal(isTableAttribution({ utm: { utm_medium: "Table" } }), true);
  assert.equal(isTableAttribution({ utm: { utm_content: "table-3" } }), true);
  assert.equal(isTableAttribution({ utm: { utm_campaign: "table-qr" } }), true);
  assert.equal(isTableAttribution({ fc_link: "m-box-s1", utm: { utm_source: "meta", utm_medium: "paid" } }), false);
  assert.equal(isTableAttribution({ fc_link: "tablet-promo" }), false);
  assert.equal(isTableAttribution(null), false);
});

test("a pickup order without a table session loses the table link and utm — click ids, ip and ua stay, the original is kept for audit", () => {
  const r = stripTableAttribution(omar, false);
  assert.equal(r.stripped, true);
  assert.equal(r.attribution.fc_link, null);
  assert.deepEqual(r.attribution.utm, {});
  assert.equal(r.attribution.landing_at, null);
  assert.deepEqual(r.attribution.click, omar.click);
  assert.equal(r.attribution.ip, "x");
  assert.equal(r.attribution.stale_table.fc_link, "table-1");
  assert.equal(r.attribution.stale_table.utm.utm_medium, "table");
  assert.equal(isTableAttribution(r.attribution), false, "idempotent: nothing table-like is left");
  assert.equal(stripTableAttribution(r.attribution, false).stripped, false);
  assert.equal(omar.fc_link, "table-1", "input is not mutated");
  // the source column no longer says offline/qr for it
  assert.equal(classifySource(omar), "offline");
  assert.equal(classifySource(r.attribution), "meta");
  assert.equal(classifySource(stripTableAttribution({ fc_link: "table-2", utm: { utm_source: "qr", utm_medium: "table" } }, false).attribution), "direct");
});

test("a real table order (placed with a table session) keeps its attribution untouched", () => {
  const r = stripTableAttribution(omar, true);
  assert.equal(r.stripped, false);
  assert.equal(r.attribution, omar);
});

test("anything that is not table attribution passes through as the same object", () => {
  const a = { fc_link: "m-box-d1", utm: { utm_source: "meta", utm_medium: "paid" }, click: { fbclid: "z" } };
  assert.equal(stripTableAttribution(a, false).attribution, a);
});

test("wiring: checkout applies the rule with the session-derived table number, also after the journey merge", () => {
  const shop = readFileSync(new URL("./shop.js", import.meta.url), "utf8");
  assert.ok(shop.includes("meta.attribution = stripTableAttribution(meta.attribution, !!tableNo).attribution;"));
  assert.ok(shop.includes("attr = stripTableAttribution(attr, !!tableNo).attribution;"));
  assert.ok(shop.indexOf("tableNo = tg.table;") < shop.indexOf("meta.attribution = stripTableAttribution("), "table gate runs before the attribution is stored");
});
