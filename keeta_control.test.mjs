import test from "node:test";
import assert from "node:assert/strict";


test("KT2: promoBody takes audience (new=2) and a per-SKU daily limit; defaults unchanged", async () => {
  const { promoBody, PROMO_AUDIENCE } = await import("./keeta_control.js");
  const menuById = new Map([[114048891, { name: "كريب زنجر سوبريم", skuList: [{ id: 1, price: 35 }] }]]);
  const base = promoBody({ items: [{ spuId: 114048891, percent: 20 }], menuById, startSec: 1, endSec: 2 });
  assert.equal(base.baseActInfo.userType, 1); assert.equal(base.spuActSaveParam[0].skuActInfoList[0].dailyLimit, 0); assert.equal(base.spuActSaveParam[0].orderLimit, -1);
  const b = promoBody({ items: [{ spuId: 114048891, percent: 20 }], menuById, startSec: 1, endSec: 2, orderLimit: 1, userType: PROMO_AUDIENCE.new, dailyLimit: 10 });
  assert.equal(b.baseActInfo.userType, 2); assert.equal(b.spuActSaveParam[0].skuActInfoList[0].dailyLimit, 10); assert.equal(b.spuActSaveParam[0].orderLimit, 1);
  assert.equal(b.spuActSaveParam[0].skuActInfoList[0].actPrice, "28");
  assert.equal(promoBody({ items: [{ spuId: 114048891, percent: 20 }], menuById, startSec: 1, endSec: 2, userType: 9, dailyLimit: -3 }).baseActInfo.userType, 1);
});
