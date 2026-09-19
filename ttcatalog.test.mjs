import test from "node:test";
import assert from "node:assert/strict";
import { toTtProduct, ttCsv, removedIds } from "./ttcatalog.js";

const row = { id: "18", title: "مشكل مشاوي", description: "", price: 45, image: "https://x/y.jpg", category: "Grills" };

test("toTtProduct: ECOM shape with the feed id as sku_id (= pixel content_id)", () => {
  const p = toTtProduct(row);
  assert.equal(p.sku_id, "18");
  assert.equal(p.description, "مشكل مشاوي");
  assert.deepEqual(p.price_info, { price: 45 });
  assert.deepEqual(p.product_detail, { condition: "NEW" });
  assert.match(p.landing_page.landing_page_url, /#item-18$/);
});

test("ttCsv: TikTok headers + SAR price", () => {
  const [h, l] = ttCsv([row]).split("\n");
  assert.ok(h.startsWith("sku_id,title,description,availability,condition,price,link,image_link,brand"));
  assert.ok(l.startsWith('"18",'));
  assert.ok(l.includes('"45.00 SAR"'));
});

test("removedIds", () => {
  assert.deepEqual(removedIds(["1", "2", "3"], ["2", "3", "4"]), ["1"]);
  assert.deepEqual(removedIds(undefined, ["1"]), []);
});
