/* السلة الجاهزة: سطر الصنف بالوزن بيتسعّر من جديد وقت فتح الرابط (M3، ١٣/١٠) — node --test wabotcart-reprice.test.mjs
   نقطة البيع بترفض أي سعر مش مطابق لسعرها وقت الحساب، فسعر قديم في السلة = رقم غلط قدام العميل وحساب فاشل. */
import test from "node:test";
import assert from "node:assert/strict";
import { makeBotCarts, repriceVariants } from "./wabotcart.js";

const W = { 103: [{ variant_option_id: 56, price: 53, price_ex: 46.09, label_ar: "ثلث كيلو", label_en: "1/3 Kilo" }, { variant_option_id: 57, price: 78, price_ex: 67.83, label_ar: "نصف كيلو", label_en: "1/2 Kilo" }, { variant_option_id: 58, price: 155, price_ex: 134.78, label_ar: "كيلو", label_en: "Kilo" }] };
const line = (id, vid, price, ex, qty = 1) => ({ item: { id }, qty, variant: { id: vid, name: "كيلو", retail_price: price, price: ex } });

test("repriceVariants: the weight's price of NOW replaces the stored one; a weight no longer offered drops its line; everything else is untouched", () => {
  const raw = { "103:v58": line(103, 58, 96, 83.48, 2), "103:v57": line(103, 57, 78, 67.83), "8": { item: { id: 8 }, qty: 1, note: "بدون بصل" }, "box:x": { bundle: { slug: "box-x" }, qty: 1 }, "97:v52": line(97, 52, 140, 121.74), "103:v99": line(103, 99, 10, 8.7) };
  const r = repriceVariants(raw, W);
  assert.deepEqual([r.repriced, r.dropped], [1, 1]);
  assert.deepEqual(r.raw["103:v58"], { item: { id: 103 }, qty: 2, variant: { id: 58, name: "كيلو", local_name: "Kilo", retail_price: 155, price: 134.78 } }, "the 96 offer price stored a week ago is now the till's price");
  assert.equal(r.raw["103:v57"].variant.retail_price, 78);
  assert.deepEqual(r.raw["8"], raw["8"]); assert.deepEqual(r.raw["box:x"], raw["box:x"]);
  assert.deepEqual(r.raw["97:v52"], raw["97:v52"], "weights of that dish are not known right now: left as stored, never guessed");
  assert.equal("103:v99" in r.raw, false, "the option no longer exists: the line cannot be ordered");
  assert.deepEqual(Object.keys(raw).length, 6, "the stored cart itself is not modified");
  assert.deepEqual(repriceVariants(null, W), { raw: null, repriced: 0, dropped: 0 }); assert.deepEqual(repriceVariants(raw, null).raw, raw);
});

test("restore: the cart answer carries today's weight price; with the weights unavailable it is returned as stored; an emptied cart has no raw", async () => {
  const rows = { ab12cd34: { items: [{ id: "103", q: 2, p: 96 }], cart_raw: { "103:v58": line(103, 58, 96, 83.48, 2) }, option: "pickup" }, zz99zz99: { items: [], cart_raw: { "103:v99": line(103, 99, 10, 8.7) }, option: "pickup" } };
  const pool = { async query(sql, p = []) { const s = String(sql).replace(/\s+/g, " ").trim(); if (/^CREATE/i.test(s)) return { rows: [] }; if (/FROM wa_bot_carts c LEFT JOIN wa_bot_chats ch/.test(s)) { const c = rows[p[0]]; return { rows: c ? [{ ...c, last_loc: null }] : [] }; } return { rows: [] }; } };
  let by = W;
  const carts = makeBotCarts({ pool, weightsNow: async () => by, log: () => {} });
  const r = await carts.restore("ab12cd34");
  assert.equal(r.raw["103:v58"].variant.retail_price, 155); assert.equal(r.raw["103:v58"].qty, 2);
  by = null; assert.equal((await carts.restore("ab12cd34")).raw["103:v58"].variant.retail_price, 96, "weights unknown right now: as stored");
  by = W; assert.equal((await carts.restore("zz99zz99")).raw, null);
  const boom = makeBotCarts({ pool, weightsNow: async () => { throw new Error("menu down"); }, log: () => {} });
  assert.equal((await boom.restore("ab12cd34")).raw["103:v58"].variant.retail_price, 96, "a failure never breaks the restore");
  assert.equal((await makeBotCarts({ pool, log: () => {} }).restore("ab12cd34")).raw["103:v58"].variant.retail_price, 96, "no weights source wired: unchanged behaviour");
});
