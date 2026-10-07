/* تحكم كيتا (keeta_control.js) — أشكال الطلبات اللي اتجرّبت على المحل الحقيقي ٧/١٠.
   لو حد غيّر شكل من دول التست يقع، لأن الشكل الغلط بيرجع «success» من غير ما يعمل حاجة. */
import test from "node:test";
import assert from "node:assert/strict";

import {
  availabilityBody, untilToMs, promoBody, actPriceOf, parseRule, normaliseAct,
  controlSettings, pictureOf, DEFAULT_CONTROL,
} from "./keeta_control.js";
import { sectionOf } from "./cms.js";

const NOW = Date.parse("2026-10-07T12:00:00Z"); // ٣ العصر الرياض

test("off body = the shape that actually changed the status (not spuIdList)", () => {
  const b = availabilityBody([114071196], false, NOW + 600_000, 1430391221);
  assert.deepEqual(b, {
    idList: [114071196], status: 0,
    spuChoiceGroupList: [{ spuId: 114071196, choiceGroupIdList: [] }],
    onShelfTime: NOW + 600_000, businessTime: false, shopId: 1430391221,
  });
  assert.equal("spuIdList" in b, false);
});

test("on body", () => {
  assert.deepEqual(availabilityBody(["5", 6], true, null, 1), { idList: [5, 6], status: 1, spuChoiceGroupList: [], shopId: 1 });
});

test("until: manual = 0 (Keeta's «until reopened»), relative, next opening, ISO guards", () => {
  assert.equal(untilToMs("manual", { nowMs: NOW }), 0);
  assert.equal(untilToMs("1h", { nowMs: NOW }), NOW + 3600_000);
  assert.equal(untilToMs("30m", { nowMs: NOW }), NOW + 1800_000);
  // بعد ١٢ الضهر الرياض → أول فتح بكرة ١٢:٠٠ الرياض = ٠٩:٠٠ UTC
  assert.equal(untilToMs("open", { nowMs: NOW }), Date.parse("2026-10-08T09:00:00Z"));
  assert.equal(untilToMs("2026-10-07T18:00:00Z", { nowMs: NOW }), Date.parse("2026-10-07T18:00:00Z"));
  assert.throws(() => untilToMs("2026-10-07T11:00:00Z", { nowMs: NOW }));
  assert.throws(() => untilToMs("2027-10-07T11:00:00Z", { nowMs: NOW }));
  assert.throws(() => untilToMs("bukra", { nowMs: NOW }));
});

const MENU = new Map([
  [114063343, { id: 114063343, name: "بيبسي زجاج", skuList: [{ id: 112130227, price: "5", pickPrice: "5" }] }],
  [114054759, { id: 114054759, name: "بيتزا سوبر سوبريم", skuList: [{ id: 112129224, price: "44" }] }],
]);

test("promo body = what act-batch-check accepted on 7/10", () => {
  const b = promoBody({ items: [{ spuId: 114063343, percent: 5 }], menuById: MENU, startSec: 100, endSec: 3700, shopId: 1430391221 });
  assert.equal(b.baseActInfo.actTypeId, 18);
  assert.equal(b.baseActInfo.benefitType, 5);
  assert.equal(b.baseActInfo.isAutoDelay, false);
  assert.equal(b.baseActInfo.startTime, 100);
  const p = b.spuActSaveParam[0];
  assert.equal(p.orderLimit, -1);
  assert.equal(p.autoDelayType, 0);
  assert.deepEqual(p.skuActInfoList, [{ spuId: 114063343, skuId: 112130227, originalPrice: "5", actPrice: "4.75", discountValue: "5", dailyLimit: 0 }]);
});

test("discountValue is the percent OFF — matches act-detail (44 → 35.2 at 20)", () => {
  assert.equal(actPriceOf(44, 20), 35.2);
  const b = promoBody({ items: [{ spuId: 114054759, percent: 20 }], menuById: MENU, startSec: 1, endSec: 2, autoRenew: true, orderLimit: 1 });
  assert.equal(b.spuActSaveParam[0].skuActInfoList[0].actPrice, "35.2");
  assert.equal(b.spuActSaveParam[0].skuActInfoList[0].discountValue, "20");
  assert.equal(b.spuActSaveParam[0].autoDelayType, 1);
  assert.equal(b.spuActSaveParam[0].orderLimit, 1);
  assert.equal(b.baseActInfo.isAutoDelay, true);
});

test("promo body refuses an item not on Keeta's menu", () => {
  assert.throws(() => promoBody({ items: [{ spuId: 1, percent: 5 }], menuById: MENU, startSec: 1, endSec: 2 }));
});

test("rule descriptions → name + percent", () => {
  assert.deepEqual(parseRule("بيتزا تشيكن ديناميت:\t-20%"), { name: "بيتزا تشيكن ديناميت", percent: 20 });
  assert.deepEqual(parseRule("‏بيبسي: -5%"), { name: "بيبسي", percent: 5 });
  assert.equal(parseRule("حاجة غريبة").percent, null);
});

test("act row normaliser (real act-list row)", () => {
  const a = normaliseAct({
    actBaseInfo: { actId: 13089208, actAggregateType: 3, actTypeDoc: "الأصناف الترويجية", actStandardStatus: 1, actStandardStatusDoc: "قيد التقدم", userGetMode: "delivery", userTypeDoc: "جميع العملاء" },
    actTime: { startTime: 1783458000, endTime: 1793393999, autoDelayType: 1, dateRangeDesc: "08/07/2026–30/10/2026" },
    benefitRuleDescs: ["بيتزا سوبر سوبريم:\t-20%"],
    activityOperations: [{ type: 11, isAllowed: 1 }, { type: 2, isAllowed: 1 }],
  });
  assert.equal(a.id, 13089208);
  assert.equal(a.percent, 20);
  assert.deepEqual(a.names, ["بيتزا سوبر سوبريم"]);
  assert.equal(a.autoRenew, true);
  assert.equal(a.canEnd, true);
});

test("control settings: defaults + clamping", () => {
  assert.deepEqual(controlSettings({}), DEFAULT_CONTROL);
  assert.equal(controlSettings({ keeta: { control: { enabled: false } } }).enabled, false);
  assert.equal(controlSettings({ keeta: { control: { maxDiscountPercent: 500 } } }).maxDiscountPercent, 90);
  assert.equal(controlSettings({ keeta: { control: { maxItemsPerAction: "x" } } }).maxItemsPerAction, 40);
});

test("picture: master first, https", () => {
  assert.equal(pictureOf([{ picUrl: "http://a/1.jpg" }, { picUrl: "http://a/2.jpg", isMaster: true }]), "https://a/2.jpg");
  assert.equal(pictureOf([]), null);
});

test("permissions: control = products, its settings = settings, reports stay analytics", () => {
  assert.equal(sectionOf("/api/keeta/control/state"), "products");
  assert.equal(sectionOf("/api/keeta/control/availability"), "products");
  assert.equal(sectionOf("/api/keeta/control/promos/end"), "products");
  assert.equal(sectionOf("/api/keeta/control/settings"), "settings");
  assert.equal(sectionOf("/api/keeta/menu"), "analytics");
  assert.equal(sectionOf("/api/keeta-reports/overview"), "analytics");
});

test("order-level tiered discount is not read as item names", () => {
  const a = normaliseAct({
    actBaseInfo: { actId: 12978425, actAggregateType: 1, actTypeDoc: "خصم", actStandardStatus: 1 },
    actTime: {},
    benefitRuleDescs: ["سلم1:	مقابل سعر 80.00 ر.س. سيتم تخفيضه بمقدار20%, إعانة المتجر"],
  });
  assert.deepEqual(a.names, []);
  assert.equal(a.percent, null);
  assert.equal(a.isItem, false);
  assert.match(a.desc, /80\.00/);
});
