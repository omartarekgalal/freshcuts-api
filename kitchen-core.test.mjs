/* شاشة المطبخ — المنطق الصافي (node --test kitchen-core.test.mjs) */
import test from "node:test";
import assert from "node:assert/strict";
import {
  channelOfTs, cleanNote, noteLevel, stageFromTs, stageFromShop, courierOf, itemsFromPurchases,
  itemsFromShop, buildBoard, normConfig, DEFAULT_CONFIG, tsTime, validBump, stationOf, shortRef, tsIsDead,
} from "./kitchen-core.js";

const NOW = Date.parse("2026-09-19T18:00:00Z");
const utc = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString().replace("T", " ").slice(0, 19); // شكل تاب سينس
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const CAT = { c_grill: "وجبات", c_crepe: "كريبات", c_pizza: "بيتزا", c_fee: "رسوم التوصيل", c_app: "مقبلات" };
const OPT = { o_dine: "Dine in", o_take: "Take away", o_del: "توصيل Delivery" };

function tsOrder(id, extra = {}) {
  return {
    id, order_type_name: "created", order_option_id: "o_take", created_at: utc(3),
    receipt: { number: 4027, prefix: 101, formatted_no: 101000004027 },
    purchases: [{ name: "وجبة كفتة", quantity: 1, category_id: "c_grill", modifiers: [], meta: { notes: null }, variant_option: null }],
    meta: { notes: null }, tables: [], ...extra,
  };
}

test("القناة: صالة/طاولة/تيك أواي/توصيل المطعم/كيتا/هنقرستيشن/متجر", () => {
  assert.equal(channelOfTs(tsOrder("a", { order_option_id: "o_dine" }), OPT.o_dine), "dine_in");
  assert.equal(channelOfTs(tsOrder("a", { order_type_name: "table" }), ""), "dine_in");
  assert.equal(channelOfTs(tsOrder("a"), OPT.o_take), "takeaway");
  assert.equal(channelOfTs(tsOrder("a"), OPT.o_del), "own_delivery");
  const ext = (sc, source = "Feedus") => tsOrder("a", { order_type_name: "external", orders_external: { source, source_channel: sc } });
  assert.equal(channelOfTs(ext("Keeta"), OPT.o_take), "keeta");
  assert.equal(channelOfTs(ext("Hungerstation")), "hungerstation");
  assert.equal(channelOfTs(ext("ninja")), "ninja");
  assert.equal(channelOfTs(ext("Jahez")), "jahez");
  assert.equal(channelOfTs(ext("feedus")), "app");
  assert.equal(channelOfTs(ext("freshcuts_online", "FreshCuts"), "", "pickup"), "store_pickup");
  assert.equal(channelOfTs(ext("freshcuts_online", "FreshCuts"), "", "delivery"), "store_delivery");
});

test("الملاحظات: ذيل «الاسم · +966…» بيتشال وأي رقم طويل بيتمسح", () => {
  const raw = "استلام - طُلب 21:10 - استلام 21:50 - مدفوع أونلاين✅ - الكريب الاتنين سبايسي بدون مايونيز — noha soliman · +966512345678";
  const n = cleanNote(raw);
  assert.ok(n.includes("سبايسي بدون مايونيز"));
  assert.ok(!/noha|966|\d{7}/.test(n), n);
  assert.equal(cleanNote("كلمني على 0551234567 لو تأخر"), "كلمني على لو تأخر");
  assert.equal(cleanNote("   "), null);
  assert.equal(noteLevel("عنده حساسية مكسرات"), 2);
  assert.equal(noteLevel("بدون بصل"), 1);
  assert.equal(noteLevel(""), 0);
});

test("وقت تاب سينس من غير منطقة = UTC", () => {
  assert.equal(tsTime({ created_at: "2026-09-18 22:52:18" }), "2026-09-18T22:52:18.000Z");
  assert.equal(tsTime({ timestamp: 1789000000 }), new Date(1789000000 * 1000).toISOString());
  assert.equal(tsTime({}), null);
});

test("مرحلة تاب سينس: الخارجي بالـapproval، والطاولة اللي وصلت وقت الحساب = اتسلّم", () => {
  const ext = (a) => [tsOrder("x", { order_type_name: "external", orders_external: { approval_status: a } }), { approval_status: a }];
  assert.equal(stageFromTs(...ext("new")), "new");
  assert.equal(stageFromTs(...ext("accepted")), "prep");
  assert.equal(stageFromTs(...ext("pickup_ready")), "ready");
  assert.equal(stageFromTs(...ext("delivered")), "done");
  // كاونتر: اتدفع بعد ٢٠ ث ← جديد
  assert.equal(stageFromTs(tsOrder("c", { created_at: utc(3) }), {}, { firstSeenAt: iso(2.5) }), "new");
  // طاولة: اتفتحت من ٥٥ د واتحاسبت دلوقتي ← الأكل خرج خلاص
  assert.equal(stageFromTs(tsOrder("t", { order_type_name: "table", created_at: utc(55) }), {}, { firstSeenAt: iso(1) }), "done");
  assert.ok(tsIsDead(tsOrder("v", { order_status_name: "void" })));
  assert.ok(tsIsDead(tsOrder("r"), { approval_status: "rejected" }));
  assert.ok(!tsIsDead(tsOrder("ok"), { approval_status: "accepted", order_status: "processing" }));
});

test("مرحلة طلب المتجر + المندوب (وصل/استلم)", () => {
  assert.equal(stageFromShop({ status: "paid" }), "new");
  assert.equal(stageFromShop({ status: "pos_created" }), "new");
  assert.equal(stageFromShop({ status: "accepted" }), "prep");
  assert.equal(stageFromShop({ status: "courier_assigned", pos_ready_at: iso(1) }), "ready");
  assert.equal(stageFromShop({ status: "courier_assigned", pos_ready_at: iso(1), ship_status: "picked" }), "done");
  assert.equal(stageFromShop({ status: "on_the_way" }), "done");
  assert.equal(stageFromShop({ status: "rejected_refunded" }), null);
  assert.equal(courierOf({ ship_status: "assigned", ship_arrived_at: iso(2) }).status, "arrived");
  assert.equal(courierOf({ ship_status: "assigned", ship_picked_at: iso(1) }).status, "picked");
  assert.equal(courierOf({ ship_status: "pending" }).label, "بندوّر على مندوب");
  assert.equal(courierOf({}), null);
});

test("الأصناف: الوزن + الإضافات + ملاحظة الصنف + المحطة، ورسوم التوصيل بتتشال", () => {
  const items = itemsFromPurchases([
    { name: "مشكل مخصوص بالوزن", quantity: 1, category_id: "c_grill", variant_option: { name: "ثلث كيلو" }, modifiers: [], meta: { notes: "مكان الرز بطاطس" } },
    { name: "بيتزا تشيكن رانش", quantity: 2, category_id: "c_pizza", variant_option: { name: "وسط" }, modifiers: [{ name: "حشو اطراف كيري", quantity: 1 }], meta: { notes: null } },
    { name: "رسوم التوصيل", quantity: 1, category_id: "c_fee", modifiers: [] },
    { name: "بطاطس محمرة", quantity: 1, category_id: "c_app", modifiers: [] },
  ], CAT);
  assert.equal(items.length, 3);
  assert.deepEqual([items[0].variant, items[0].station, items[0].noteLevel], ["ثلث كيلو", "grill", 1]);
  assert.deepEqual([items[1].qty, items[1].station, items[1].mods[0].name], [2, "pizza", "حشو اطراف كيري"]);
  assert.equal(items[2].station, "sides");
  // قسم بالـid (قسم «Crepes» في تاب سينس = إضافات)، وصنف بعينه يغلب القسم، والمجهول = null («غير محدد»)
  assert.equal(stationOf({ name: "شوربه", categoryId: "eQr8vxoyBE", category: "Crepes" }, DEFAULT_CONFIG), "sides");
  const cfg = normConfig({ stations: [{ id: "grill", name: "مشاوي", categories: ["وجبات"], products: ["حواوشي موتزريلا"] }] });
  assert.equal(stationOf({ name: "حواوشي موتزريلا", category: "سندوتشات" }, cfg), "grill");
  assert.equal(stationOf({ name: "كريب", category: "كريبات" }, cfg), null);
  assert.equal(stationOf({ name: "صينية اللمة", category: "العروض" }, DEFAULT_CONFIG), null);
});

test("أصناف المتجر: الباقة عنوان + مكوّنات، والمحطات من المكوّنات", () => {
  const items = itemsFromShop([
    { name: "كريب ميكس دجاج", qty: 1, note: "سبايسي" },
    { name: "وجبة كفتة", qty: 2, bundle: "بوكس ٩٦", bundle_name: "بوكس ٩٦", bundle_line: "L1", bundle_qty: 2 },
    { name: "بيتزا مارجريتا", qty: 2, bundle: "بوكس ٩٦", bundle_name: "بوكس ٩٦", bundle_line: "L1", bundle_qty: 2 },
  ], DEFAULT_CONFIG, { catMap: { cc: "كريبات", cg: "وجبات", cp: "بيتزا" }, prodCat: { "كريب ميكس دجاج": "cc", "وجبه كفته": "cg" } });
  assert.equal(items.length, 2);
  assert.equal(items[0].station, "crepe");
  assert.equal(items[1].bundle, true);
  assert.equal(items[1].name, "بوكس ٩٦");
  assert.equal(items[1].qty, 2);
  assert.deepEqual(items[1].mods.map((m) => [m.name, m.qty, m.station]), [["وجبة كفتة", 1, "grill"], ["بيتزا مارجريتا", 1, null]]);
});

test("اللوحة: دمج المتجر مع نسخته في تاب سينس + التقديم + الإخفاء + مفيش جوال", () => {
  const shopRow = {
    order_no: "W1789000001234", status: "pos_created", option: "delivery", pos_order_id: "P9",
    items: [{ name: "وجبة طرب", qty: 1 }], notes: "بدون بصل — كلمني 0551234567",
    address: { area: "السلامة", leave_at_door: true, street: "شارع" }, created_at: iso(6), updated_at: iso(1),
    far_zone: { km: 9.2, extraKm: 2, surcharge: 5 }, ship_status: "assigned", ship_arrived_at: iso(1), is_test: false,
  };
  const tsOrders = [
    // نفس طلب المتجر على نقطة البيع — الكاشير سجّل جاهز (أسرع من كنسة المتجر)
    { order: tsOrder("P9", { order_type_name: "external", orders_external: { source: "FreshCuts", source_channel: "freshcuts_online", approval_status: "pickup_ready" }, meta: { notes: "توصيل — ahmad · +966500000000" } }),
      slugs: { approval_status: "pickup_ready" }, firstSeenAt: iso(5), lastAt: iso(0.5) },
    { order: tsOrder("K1", { order_type_name: "external", orders_external: { source: "Feedus", source_channel: "Keeta", approval_status: "accepted", external_order_number: "88812345" }, created_at: utc(12) }),
      slugs: { approval_status: "accepted" }, firstSeenAt: iso(12), lastAt: iso(11) },
    { order: tsOrder("C1", { created_at: utc(2) }), slugs: {}, firstSeenAt: iso(1.8), lastAt: iso(1.8) },
    { order: tsOrder("OLD", { created_at: utc(200) }), slugs: {}, firstSeenAt: iso(199), lastAt: iso(199) },
    { order: tsOrder("V1", { order_status_name: "void" }), slugs: {}, firstSeenAt: iso(2), lastAt: iso(2) },
    { order: tsOrder("D1", { order_type_name: "external", orders_external: { source_channel: "Keeta", approval_status: "delivered" } }),
      slugs: { approval_status: "delivered" }, firstSeenAt: iso(40), lastAt: iso(30) },
  ];
  const bumps = new Map([["ts:C1", { stage: "prep", at: iso(1), by: "شيف" }]]);
  const board = buildBoard({ tsOrders, shopRows: [shopRow], bumps, catMap: CAT, optionNames: OPT, now: NOW });
  const keys = board.map((o) => o.key);
  assert.deepEqual(keys.sort(), ["shop:W1789000001234", "ts:C1", "ts:K1"].sort());
  const s = board.find((o) => o.key === "shop:W1789000001234");
  assert.equal(s.stage, "ready");           // من الـwebhook
  assert.equal(s.channel.key, "store_delivery");
  assert.equal(s.flags.leaveAtDoor, true);
  assert.deepEqual(s.flags.farZone, { km: 9.2 });
  assert.equal(s.courier.status, "arrived");
  assert.equal(s.posRef, "4027");
  assert.equal(s.notes[0].text.includes("بدون بصل"), true);
  const k = board.find((o) => o.key === "ts:K1");
  assert.deepEqual([k.stage, k.channel.label, k.ref], ["prep", "كيتا", "812345"]);
  const c = board.find((o) => o.key === "ts:C1");
  assert.deepEqual([c.sourceStage, c.stage, c.bump.by], ["new", "prep", "شيف"]);
  assert.deepEqual(c.stations, ["grill"]);
  const out = JSON.stringify(board);
  assert.ok(!/0551234567|966500000000|ahmad|شارع/.test(out), "مفيش جوال ولا اسم ولا عنوان");
});

test("اللوحة: «اتسلّم» يفضل ١٠ دقايق بس، والتقديم مايرجعش ورا المصدر", () => {
  const t = (lastMin) => [{ order: tsOrder("E", { order_type_name: "external", orders_external: { approval_status: "delivered" } }), slugs: { approval_status: "delivered" }, firstSeenAt: iso(30), lastAt: iso(lastMin) }];
  assert.equal(buildBoard({ tsOrders: t(4), now: NOW }).length, 1);
  assert.equal(buildBoard({ tsOrders: t(12), now: NOW }).length, 0);
  // bump لورا مابيأثرش
  const b = buildBoard({ tsOrders: t(4), bumps: new Map([["ts:E", { stage: "prep", at: iso(1) }]]), now: NOW });
  assert.equal(b[0].stage, "done");
  assert.equal(validBump("ready", "prep"), false);
  assert.equal(validBump("new", "ready"), true);
  assert.equal(validBump("new", "bogus"), false);
});

test("الإعدادات: حدود + المحطات + الأحمر بعد الأصفر", () => {
  const c = normConfig({ slaAmberMin: 15, slaRedMin: 10, allowBump: false, stations: [{ id: "Grill!", name: "مشاوي", categories: ["وجبات"] }, { id: "all", name: "x" }] });
  assert.equal(c.slaAmberMin, 15);
  assert.equal(c.slaRedMin, 16);
  assert.equal(c.allowBump, false);
  assert.deepEqual(c.stations.map((s) => s.id), ["grill"]);
  assert.equal(normConfig(null).slaRedMin, 20);
  assert.equal(normConfig({ slaAmberMin: "abc" }).slaAmberMin, 10);
});

test("رقم قصير: رقم التطبيق للتوصيل، رقم الفاتورة للكاونتر", () => {
  assert.equal(shortRef(tsOrder("a")), "4027");
  assert.equal(shortRef({ id: "abc", orders_external: { external_order_number: "123456789", source_channel: "Keeta" } }), "456789");
});

test("عمر ١٩/٩: البرجر والطاسات على محطة الباستا", () => {
  assert.equal(stationOf({ name: "برجر لحم كلاسيك", category: "برجر" }, DEFAULT_CONFIG), "pasta");
  assert.equal(stationOf({ name: "طاسة الاكيلة", category: "طاسات" }, DEFAULT_CONFIG), "pasta");
  assert.equal(stationOf({ name: "وجبة كفتة", category: "وجبات" }, DEFAULT_CONFIG), "grill");
});

test("العروض: مكوّنات العرض بتتوزّع كل واحد على محطته، والعرض من غير تعريف ظاهر", () => {
  const catMap = { cg: "وجبات", cs: "مقبلات", co: "العروض" };
  const prodCat = { "مشكل مخصوص بالوزن": "cg", "طبق ارز بسمتي": "cs" };
  const cfg = normConfig({ offers: { "صينية اللمة 100 ريال": [{ name: "مشكل مخصوص بالوزن — نصف كيلو", qty: 1 }, { name: "طبق أرز بسمتي", qty: 2 }] } });
  const [it] = itemsFromPurchases([{ name: "صينية اللمة 100 ريال", quantity: 1, category_id: "co", modifiers: [] }], catMap, cfg, { prodCat });
  assert.equal(it.bundle, true);
  assert.deepEqual(it.mods.map((m) => [m.name, m.qty, m.station]), [["مشكل مخصوص بالوزن — نصف كيلو", 1, "grill"], ["طبق أرز بسمتي", 2, "sides"]]);
  const [u] = itemsFromPurchases([{ name: "عرض جديد", quantity: 1, category_id: "co", modifiers: [] }], catMap, cfg, { prodCat });
  assert.deepEqual([u.bundle, u.offerUndefined, u.mods.length], [true, true, 0]);
  const b = buildBoard({ tsOrders: [{ order: { id: "O1", order_type_name: "created", created_at: new Date(NOW - 60000).toISOString(), purchases: [{ name: "صينية اللمة 100 ريال", quantity: 1, category_id: "co", modifiers: [] }], meta: {} }, slugs: {}, firstSeenAt: iso(1), lastAt: iso(1) }],
    catMap, prodCat, cfg, now: NOW });
  assert.deepEqual(b[0].stations.sort(), ["grill", "sides"]);
});

test("الوضع: display + مسح تلقائي في الإعدادات", () => {
  const c = normConfig({ defaultMode: "display", autoClearMin: 3 });
  assert.equal(c.defaultMode, "display");
  assert.equal(c.autoClearMin, 30);
  assert.equal(normConfig({ defaultMode: "x" }).defaultMode, "touch");
  assert.equal(normConfig({ autoClearMin: 45 }).autoClearMin, 45);
});
