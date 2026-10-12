/* مساعد الطلبات — القلب: الأدوات، بنّاء السلة، حاسبة الاقتراح، المراجِع. من غير أي موديل ومن غير أي إرسال. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as A from "./waassist.js";
import { indexMenu } from "./wabot.js";
import { expandBundle, normalizeSlots } from "./bundles.js";

const LIVE = JSON.parse(fs.readFileSync(new URL("./wabot-live.fixture.json", import.meta.url), "utf8"));
const MENU = indexMenu(LIVE.pages);
const item = (id) => MENU.items.find((i) => i.id === String(id));
const dress = (b) => ({ ...b, slots: b.slots.map((s) => (s.type === "fixed"
  ? { ...s, item: { product_id: s.product_id, variant_option_id: s.variant_option_id ?? null, name: item(s.product_id)?.name || "x", variant_name: null, price_incl: item(s.product_id)?.price } }
  : { ...s, choices: s.choices.map((c) => ({ ...c, name: item(c.product_id).name, variant_name: c.variant_option_id ? "وسط" : null, price_incl: item(c.product_id).price })) })) });
/* بوكس بيتزا: خانتين اختيار (واحدة فيها اختيار بفرق سعر) + باستا وبطاطس ومشروبين ثابتين. بوكس وجبة: كله ثابت. */
const BOX_PIZZA = { slug: "box-pizza-night", name: "بوكس سهرة البيتزا", name_en: "Pizza Night Box", price: 85, section: "بوكسات لشخصين", description: "بيتزتين وسط + باستا + بطاطس + مشروبين", slots: normalizeSlots([
  { key: "pizza1", type: "choice", label: "البيتزا الأولى (وسط)", choices: [{ product_id: "43", variant_option_id: 36 }, { product_id: "41", variant_option_id: 34 }, { product_id: "39", variant_option_id: 30, surcharge: 6 }] },
  { key: "pizza2", type: "choice", label: "البيتزا الثانية (وسط)", choices: [{ product_id: "43", variant_option_id: 36 }, { product_id: "41", variant_option_id: 34 }] },
  { key: "pasta", type: "fixed", label: "باستا", product_id: "59" }, { key: "fries", type: "fixed", label: "بطاطس محمرة", product_id: "79" },
  { key: "drinks", type: "fixed", label: "مشروبات غازية", product_id: "82", quantity: 2 }]) };
const BOX_MEAL = { slug: "box-kofta-solo", name: "بوكس الكفتة الفردي", name_en: "Kofta Solo Box", price: 29, section: "بوكسات فردية", description: "وجبة كفتة + بطاطس + مشروب", slots: normalizeSlots([
  { key: "meal", type: "fixed", label: "وجبة كفتة", product_id: "17" }, { key: "fries", type: "fixed", label: "بطاطس محمرة", product_id: "79" }, { key: "drink", type: "fixed", label: "مشروب", product_id: "82" }]) };
const RAW_BOXES = [BOX_PIZZA, BOX_MEAL], BOXES = RAW_BOXES.map(dress);
const resolve = (pid) => { const it = item(pid); return it ? { name: it.name, priceEx: it.price / 1.15, taxId: 1 } : null; };
const MODS = { 43: [{ id: 5, name: "Crust", localName: "حشو الأطراف", min: 0, max: 1, options: [{ id: 16, name: "Kiri", localName: "كيري", shown: 5 }, { id: 15, name: "Mozzarella", localName: "موتزاريلا", shown: 5 }] }],
  41: [{ id: 5, name: "Crust", localName: "حشو الأطراف", min: 0, max: 1, options: [{ id: 16, name: "Kiri", localName: "كيري", shown: 5 }] }] };

function tools(over = {}) {
  const db = { carts: [], orders: over.orders || [], optins: over.optins || {}, loyaltyOrders: over.loyaltyOrders ?? 4, sold: over.sold || [] };
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (over.failDb && over.failDb.test(s)) throw new Error("db down");
    if (/FROM shop_coupons WHERE upper\(code\)='FIRST'/.test(s)) return { rows: [{ code: "FIRST", percent: 0, active: true, expires_at: null, free_delivery: true, min_total: 60 }] };
    if (/shop_coupons/.test(s) && /used|coupon = /.test(s) && !/cms_loyalty/.test(s)) return { rows: over.firstUsed ? [{ x: 1 }] : [], rowCount: over.firstUsed ? 1 : 0 };
    if (/FROM cms_loyalty l JOIN shop_coupons/.test(s)) return { rows: over.rewards || [] };
    if (/count\(\*\)::int AS n FROM shop_orders WHERE phone_norm=\$1 AND created_at >=/.test(s)) return { rows: [{ n: db.loyaltyOrders }] };
    if (/FROM shop_orders WHERE phone_norm=\$1 AND NOT COALESCE\(is_test,false\) AND status NOT IN \('expired','pending_payment'\) AND created_at > NOW\(\) - INTERVAL '72 hours'/.test(s)) return { rows: db.orders.filter((o) => o.phone_norm === p[0]) };
    if (/FROM shop_orders/.test(s)) return { rows: over.priorDelivery ? [{ x: 1 }] : [], rowCount: over.priorDelivery ? 1 : 0 };
    if (/FROM wa_optins/.test(s)) return { rows: db.optins[p[0]] ? [db.optins[p[0]]] : [] };
    if (/FROM ts_order_items/.test(s)) return { rows: [{ name: "بطاطس محمرة", qty: 900 }, { name: "وجبة ميكس جريل", qty: 400 }, { name: "كريب زنجر سوبريم", qty: 300 }, { name: "صنف اتشال", qty: 200 }] };
    return { rows: [], rowCount: 0 };
  } };
  const menu = over.menu === null ? null : { ...MENU, items: MENU.items.map((i) => (db.sold.includes(i.id) ? { ...i, soldOut: true } : i)) };
  const t = A.makeAssistTools({ pool, log: () => {}, now: () => new Date("2026-10-12T15:00:00Z"),
    menuIndex: async () => menu, boxes: async () => (over.boxes === null ? null : BOXES),
    expandBundle: over.expandBundle || (async (slug, choices, qty, option, extra) => { const b = RAW_BOXES.find((x) => x.slug === slug); return b ? expandBundle(b, choices, qty, resolve, extra) : { ok: false, error: "bundle_not_found" }; }),
    modifiers: { catalogItems: async () => MODS, resolve: async (pid, ids) => { const opts = (MODS[pid] || []).flatMap((g) => g.options); const bad = ids.filter((id) => !opts.some((o) => o.id === id)); return bad.length ? { ok: false, error: "unknown_modifier", ids: bad } : { ok: true, shown: ids.reduce((a, id) => a + opts.find((o) => o.id === id).shown, 0) }; } },
    quote: over.quote || (async ({ orderTotal }) => ({ deliverable: true, fee: orderTotal >= 150 ? 0 : orderTotal >= 100 ? 5 : orderTotal >= 80 ? 10 : orderTotal >= 60 ? 15 : 20, toNextTier: orderTotal < 60 ? 60 - orderTotal : orderTotal < 80 ? 80 - orderTotal : orderTotal < 100 ? 100 - orderTotal : orderTotal < 150 ? 150 - orderTotal : 0,
      nextTierFee: orderTotal < 60 ? 15 : orderTotal < 80 ? 10 : orderTotal < 100 ? 5 : 0, toFree: Math.max(0, 150 - orderTotal) })),
    offers: async () => (over.offers === null ? null : [{ title: "باقة تجمّع ٤–٦ أشخاص", price: 225, until: "2026-10-15" }]),
    openState: async () => ({ open: true, closesText: "2 فجراً", opensText: null, deliveryPaused: false }),
    settings: async () => ({ cms: { loyalty: { enabled: true, every: 3, reward: "free_delivery", minTotal: 60, startedAt: "2026-09-01" } } }),
    buildProfile: over.buildProfile || (async () => PROFILE), lastLocation: async () => over.lastLoc || null,
    botCarts: over.botCarts === null ? null : { create: async (x) => { if (over.saveFails) return null; const code = `as${String(db.carts.length + 1).padStart(6, "0")}`; db.carts.push({ code, ...x }); return { code }; } } });
  return { t, db };
}
const ME = "512345678";
const PROFILE = { identity: { name: "أحمد محمد العتيبي", phoneMasked: "05•••5678" }, summary: { orders: 7, aov: 92.456, status: "repeat", daysSinceLast: 6.2 },
  orders: [{ source: "web", at: "2026-10-06T17:10:00Z", channel: "website", option: "delivery", total: 110, items: [{ name: "كريب زنجر سوبريم", qty: 2 }, { name: "وجبة كفتة", qty: 1 }] },
    { source: "web", at: "2026-09-29T18:00:00Z", channel: "website", option: "delivery", total: 80, items: [{ name: "وجبة كفتة", qty: 2 }] }, { source: "pos", at: "2026-09-20T17:30:00Z", channel: "cashier", total: 60, items: [{ name: "برجر لحم كلاسيك", qty: 1 }] },
    { source: "web", at: "2026-09-10T17:30:00Z", option: "pickup", total: 40, items: [], isTest: true }],
  favorites: { items: [{ name: "وجبة كفتة", qty: 5, orders: 4 }, { name: "كريب زنجر سوبريم", qty: 4, orders: 3 }], lean: "grill", leanLabel: "مشاوي" },
  addresses: [{ label: "البيت", area: "الصفا", street: "شارع صاري", building: "12", floor: "3", landmark: "جنب مسجد النور" }, { area: "الصفا" }, { area: "الروضة", street: "x" }],
  reviews: [{ rating: 2, comment: "الأكل وصل بارد والمندوب اسمه خالد تأخر", categories: ["cold_food", "late"], at: "2026-09-21T10:00:00Z" }, { rating: 5, comment: "ممتاز", categories: [], at: "2026-10-07T10:00:00Z" }],
  unpaidAttempts: [{ status: "rejected_refunded" }], voidedOrders: [] };

test("search and facts come from the live menu: results, a dish with its add-ons, availability; a source that is down says so instead of «no results»", async () => {
  const { t } = tools({ sold: ["8"] });
  const r = await t.search_menu(ME, { query: "كريب زنجر" });
  assert.equal(r.ok, true); assert.deepEqual([r.results[0].id, r.results[0].name, r.results[0].price, r.results[0].sold_out, r.results[0].kind], ["8", "كريب زنجر سوبريم", 25, true, "main"]);
  assert.ok(r.results.length <= 8);
  const pep = (await t.search_menu(ME, { query: "بيبسي" })).results[0];
  assert.deepEqual([pep.name, pep.price, pep.kind], ["بيبسي زجاج", 4, "drink"], "a name match ranks above a description match");
  assert.deepEqual((await t.search_menu(ME, { query: "سوشي" })).results, []);
  assert.deepEqual((await t.search_menu(ME, { query: "pizza" })).results.length > 3, true, "English section name matches");
  const it = (await t.get_item(ME, { id: "43" })).item;
  assert.deepEqual([it.name, it.price, it.addons[0].group, it.addons[0].options.map((o) => [o.id, o.name, o.price])], ["بيتزا تشيكن رانش", 28, "حشو الأطراف", [[16, "كيري", 5], [15, "موتزاريلا", 5]]]);
  assert.match(it.note, /not a full ingredient list/);
  assert.equal((await t.get_item(ME, { id: "999999" })).error, "not_found");
  assert.deepEqual((await t.check_availability(ME, { ids: ["8", "59", "999999"] })).items.map((x) => x.status), ["sold_out_today", "available", "not_on_menu"]);
  const down = tools({ menu: null }).t;
  for (const call of [down.search_menu(ME, { query: "كريب" }), down.get_item(ME, { id: "8" }), down.check_availability(ME, { ids: ["8"] }), down.build_cart(ME, { items: [{ id: "8" }] })]) assert.deepEqual(await call, { ok: false, error: "unavailable", what: "menu" });
  assert.equal(A.searchMenu(null, "x"), null);
});

test("boxes: the list, one box with its slots, choices, extra-price choices and crust add-ons; boxes are website-only", async () => {
  const { t } = tools();
  const l = await t.list_boxes();
  assert.deepEqual(l.boxes.map((b) => [b.slug, b.price, b.section]), [["box-pizza-night", 85, "بوكسات لشخصين"], ["box-kofta-solo", 29, "بوكسات فردية"]]); assert.equal(l.online_only, true);
  const b = (await t.get_box(ME, { slug: "box-pizza-night" })).box;
  assert.deepEqual(b.slots.map((s) => [s.key, s.type, s.quantity]), [["pizza1", "choice", 1], ["pizza2", "choice", 1], ["pasta", "fixed", 1], ["fries", "fixed", 1], ["drinks", "fixed", 2]]);
  assert.deepEqual(b.slots[0].choices.map((c) => [c.product_id, c.name, c.extra]), [["43", "بيتزا تشيكن رانش", 0], ["41", "بيتزا سوبر سوبريم", 0], ["39", "بيتزا سي فود رانش", 6]]);
  assert.deepEqual(b.slots[0].choices[0].addons, [{ id: 16, name: "كيري", price: 5, group: "حشو الأطراف" }, { id: 15, name: "موتزاريلا", price: 5, group: "حشو الأطراف" }]);
  assert.equal(b.slots[2].item.name, "بنا تشيكن كازرول"); assert.equal(b.online_only, true);
  assert.equal((await t.get_box(ME, { slug: "nope" })).error, "not_found");
  assert.deepEqual(await tools({ boxes: null }).t.list_boxes(), { ok: false, error: "unavailable", what: "boxes" });
});

test("cart builder: dishes and a box with choices, a premium choice, crust and notes — priced by the checkout functions — and a ready-cart link", async () => {
  const { t, db } = tools();
  const c = await t.build_cart(ME, { option: "delivery", items: [{ id: "8", qty: 2 }, { id: "59", qty: 1, note: "بدون زيتون" }, { id: "8", qty: 1 }],
    boxes: [{ slug: "box-pizza-night", qty: 1, choices: { pizza1: { product_id: "39", variant_option_id: 30 }, pizza2: "43" }, addons: { pizza2: [16] }, notes: { pizza1: "بدون فلفل", drinks: "سفن أب" } }] });
  assert.equal(c.ok, true); assert.deepEqual(c.problems, []);
  assert.deepEqual(c.lines.map((l) => [l.name, l.qty, l.price, l.total]), [["كريب زنجر سوبريم", 3, 25, 75], ["بنا تشيكن كازرول", 1, 28, 28], ["بوكس سهرة البيتزا", 1, 96, 96]]);
  assert.deepEqual([c.lines[2].base_price, c.lines[2].choices_extra, c.lines[2].addons_extra], [85, 6, 5], "box 85 + seafood pizza 6 + kiri crust 5");
  assert.equal(c.subtotal, 199); assert.equal(c.lines[1].note, "بدون زيتون");
  assert.deepEqual(c.lines[2].picks.slice(0, 2).map((p) => [p.name, p.note || null]), [["بيتزا سي فود رانش", "بدون فلفل"], ["بيتزا تشيكن رانش", null]]);
  assert.equal(c.link, "https://freshcuts.sa/c/as000001"); assert.equal(c.saved, true);
  // the stored cart is the storefront's own shape: same key formula as addBundleToCart, choices as the box's choice objects, add-ons and notes per slot
  const saved = db.carts[0];
  assert.deepEqual([saved.phone, saved.source, saved.option], [ME, "assistant", "delivery"]);
  const raw = saved.plan.raw, bk = Object.keys(raw).find((k) => k.startsWith("b:"));
  assert.match(bk, /^b:box-pizza-night:pizza1=39:30\|pizza2=43:36:m16\|n[0-9a-z]+$/);
  assert.deepEqual(raw["8"], { item: { id: 8 }, qty: 3 }); assert.deepEqual(raw["59"], { item: { id: 59 }, qty: 1, note: "بدون زيتون" });
  assert.deepEqual([raw[bk].qty, raw[bk].mods, raw[bk].notes, raw[bk].surIncl, raw[bk].modsIncl, raw[bk].bundle.slug, raw[bk].choices.pizza1.product_id, raw[bk].item.id, raw[bk].item.retail_price],
    [1, { pizza2: [16] }, { pizza1: "بدون فلفل", drinks: "سفن أب" }, 6, 5, "box-pizza-night", "39", "b:box-pizza-night", 91]);
  // preview only: nothing is stored
  const p = await t.build_cart(ME, { items: [{ id: "8" }] }, { save: false });
  assert.deepEqual([p.saved, p.link, db.carts.length], [false, undefined, 1]);
});

test("cart builder never guesses: every line that can not be built comes back with its reason, and the rest is still built", async () => {
  const { t, db } = tools({ sold: ["59"] });
  const c = await t.build_cart(ME, { items: [{ id: "8", qty: 1 }, { id: "59" }, { id: "424242" }, { id: "43", addons: [16] }],
    boxes: [{ slug: "box-pizza-night", choices: { pizza1: "43" } }, { slug: "box-gone" }, { slug: "box-pizza-night", choices: { pizza1: "43", pizza2: "41" }, addons: { pizza2: [15] } }, { slug: "box-pizza-night", choices: { pizza1: "45", pizza2: "41" } }] });
  assert.equal(c.ok, true); assert.deepEqual(c.lines.map((l) => l.name), ["كريب زنجر سوبريم"]);
  assert.deepEqual(c.problems.map((x) => x.error), ["sold_out_today", "not_on_menu", "addons_on_site_only", "choice_required", "box_not_found", "addon_unknown_modifier", "choice_required"]);
  assert.deepEqual(c.problems[3].missing, [{ key: "pizza2", label: "البيتزا الثانية (وسط)" }]); assert.match(c.problems[2].url, /\/l\/wab-menu#item-43$/);
  // by-weight dishes need a weight picked on the site
  const kilo = MENU.items.find((i) => i.byWeight);
  const w = await t.build_cart(ME, { items: [{ id: kilo.id }] });
  assert.deepEqual([w.ok, w.error, w.problems[0].error], [false, "empty_cart", "choose_weight_on_site"]); assert.equal(db.carts.length, 1);
  // a box the checkout function refuses (sold out inside), boxes source down, link can not be saved
  const so = tools({ expandBundle: async () => ({ ok: false, error: "sold_out", items: [{ product_id: 79, name: "بطاطس محمرة" }], message: "خلص اليوم" }) }).t;
  const r = await so.build_cart(ME, { boxes: [{ slug: "box-kofta-solo" }] });
  assert.deepEqual([r.ok, r.problems[0].error, r.problems[0].detail], [false, "box_sold_out", "خلص اليوم"]);
  assert.deepEqual(await tools({ boxes: null }).t.build_cart(ME, { boxes: [{ slug: "box-kofta-solo" }] }), { ok: false, error: "unavailable", what: "boxes" });
  const ns = await tools({ saveFails: true }).t.build_cart(ME, { items: [{ id: "8" }] });
  assert.deepEqual([ns.ok, ns.saved, ns.error_link, ns.link], [true, false, "cannot_save", undefined]);
  assert.equal((await t.build_cart("abc", { items: [{ id: "8" }] })).saved, false);
  // quantities are clamped, notes trimmed
  const q = await t.build_cart(ME, { items: [{ id: "8", qty: 500, note: "  بدون   بصل ".padEnd(300, "ا") }] }, { save: false });
  assert.equal(q.lines[0].qty, 20); assert.ok(q.lines[0].note.length <= 100);
});

test("delivery quote: only from a real location (shared pin or the last one in the chat), with the fee for THIS basket and the gap to the next tier", async () => {
  const { t } = tools();
  assert.deepEqual(await t.quote_delivery(ME, { total: 70 }), { ok: false, error: "need_location", hint: "ask the customer to share their location pin in the chat" });
  const q1 = await t.quote_delivery(ME, { lat: 21.58, lng: 39.15, total: 70 });
  assert.deepEqual([q1.deliverable, q1.fee, q1.to_next_tier, q1.next_tier_fee, q1.to_free, q1.location], [true, 15, 10, 10, 80, "given"]);
  const withLoc = tools({ lastLoc: { lat: 21.58, lng: 39.15 } }).t;
  assert.equal((await withLoc.quote_delivery(ME, { total: 160 })).fee, 0); assert.equal((await withLoc.quote_delivery(ME, { total: 160 })).location, "shared_in_chat");
  const far = tools({ quote: async () => ({ deliverable: false, reason: "out_of_range", farZoneOffer: { surcharge: 9 } }) }).t;
  assert.deepEqual(await far.quote_delivery(ME, { lat: 1, lng: 1 }), { ok: true, deliverable: false, reason: "out_of_range", min_order: null, far_zone_offer_extra: 9, pickup_available: true, location: "given" });
  const dead = tools({ quote: async () => { throw new Error("x"); } }).t;
  assert.deepEqual(await dead.quote_delivery(ME, { lat: 1, lng: 1 }), { ok: false, error: "unavailable", what: "delivery_quote" });
});

test("offers, hours, order status: real terms for THIS phone; order status takes no argument and never leaves the sender", async () => {
  const { t } = tools({ orders: [{ phone_norm: ME, order_no: "W1790011111111", status: "on_the_way", option: "delivery", total: 110.004, created_at: "2026-10-12T14:00:00Z" }, { phone_norm: "598765432", order_no: "W1790022222222", status: "preparing", option: "pickup", total: 40 }], rewards: [{ code: "LOY-AB12", percent: 0, free_delivery: true, min_total: 60, expires: "2026-11-01" }] });
  const o = await t.get_offers(ME);
  assert.deepEqual(o.first_order, { eligible: true, code: "FIRST", free_delivery: true, min_total: 60, reason: null });
  assert.deepEqual([o.loyalty.every, o.loyalty.progress, o.loyalty.left, o.loyalty.reward], [3, 1, 2, "free_delivery"]);
  assert.deepEqual(o.rewards, [{ code: "LOY-AB12", freeDelivery: true, percent: 0, minTotal: 60, expires: "2026-11-01" }]);
  assert.deepEqual(o.timed, [{ title: "باقة تجمّع ٤–٦ أشخاص", price: 225, until: "2026-10-15" }]);
  assert.equal((await tools({ priorDelivery: true }).t.get_offers(ME)).first_order.eligible, false, "a customer who already had a delivery order is not offered FIRST");
  assert.equal((await tools({ offers: null }).t.get_offers(ME)).timed_known, false);
  assert.deepEqual(await t.get_hours(), { ok: true, open_now: true, closes_at: "2 فجراً", opens: null, delivery_paused: false });
  const s = await t.order_status(ME, { phone: "598765432", order_no: "W1790022222222" });
  assert.deepEqual(s.orders, [{ order_no: "W1790011111111", status: "on_the_way", mode: "delivery", total: 110, track_url: "https://freshcuts.sa/track/W1790011111111" }], "arguments from the model are ignored: only the sender's orders");
  assert.equal((await t.order_status("")).error, "no_phone");
});

test("customer profile for the model: the sender's own history, minimal fields — no phone, no street, no review text", async () => {
  const seen = [];
  const { t } = tools({ buildProfile: async (pn) => { seen.push(pn); return PROFILE; }, optins: { [ME]: { updates: true, marketing: false, stopped_at: null } } });
  const p = (await t.customer_profile(ME, { phone: "598765432" })).profile;
  assert.deepEqual(seen, [ME], "the profile is read for the sender only, whatever the model passes");
  assert.deepEqual([p.known, p.name, p.orders, p.status, p.days_since_last, p.usual_basket_sar, p.usual_mode, p.usual_hour, p.taste], [true, "أحمد", 7, "repeat", 6, 92.46, "delivery", 20, "مشاوي"]);
  assert.deepEqual(p.favourites, [{ name: "وجبة كفتة", times: 4 }, { name: "كريب زنجر سوبريم", times: 3 }]);
  assert.deepEqual(p.last_order, { days_ago: 6, channel: "website", mode: "delivery", total: 110, items: [{ name: "كريب زنجر سوبريم", qty: 2 }, { name: "وجبة كفتة", qty: 1 }] });
  assert.deepEqual(p.districts, ["الصفا", "الروضة"]);
  assert.deepEqual([p.loyalty.progress, p.loyalty.every, p.first_order_offer, p.refunds_or_voids], [1, 3, true, 1]);
  assert.deepEqual(p.low_ratings, { count: 1, about: ["cold_food", "late"], last_days_ago: 21 });
  assert.deepEqual(p.consent, { updates: true, marketing: false, stopped: false });
  const sent = JSON.stringify(p);
  assert.doesNotMatch(sent, /512345678|05•|شارع|صاري|مسجد|العتيبي|محمد|خالد|بارد|"12"|floor|building/, "nothing that identifies beyond the first name and the district");
  // what the customer is told when he asks «ايش تعرفوا عني»
  assert.equal(A.profileSummaryAr(p), "عدد طلباتك السابقة: 7.\nأكثر ما طلبته: وجبة كفتة، كريب زنجر سوبريم.\nطريقة الطلب المعتادة: توصيل.\nالأحياء اللي وصّلنا لها: الصفا، الروضة.\nالولاء: 1 من 3 طلبات.\nنستخدمها عشان نخدمك أسرع بس. لإيقاف رسائلنا اكتب: إيقاف");
  assert.equal(A.profileSummaryAr({ known: false }), "ما عندنا طلبات سابقة مسجّلة على رقمك هذا.");
  // new customer, junk name, profile service down
  assert.deepEqual(A.profileForModel({ identity: { name: "05444" }, summary: { orders: 0 }, orders: [] }).name, null);
  assert.equal(A.profileForModel(null).known, false);
  assert.deepEqual(await tools({ buildProfile: async () => { throw new Error("x"); } }).t.customer_profile(ME), { ok: false, error: "unavailable", what: "profile" });
  assert.deepEqual((await t.customer_profile("")).profile, { known: false });
});

test("upsell: at most one suggestion, computed from real numbers, never repeated after a «no», nothing the customer complained about", async () => {
  const L = (id, qty = 1) => { const it = item(id); return { id: it.id, name: it.name, price: it.price, qty, kind: A.itemBrief(it).kind }; };
  const ctx = { menu: MENU, boxes: BOXES, topSellers: ["79", "18", "8"] };
  // the same items exist as a box for less: kofta meal 24 + fries 6 + soft drink 3 = 33 separately, the box is 29
  const same = { lines: [L(17), L(79), L(82)], subtotal: 33, option: "delivery" };
  assert.deepEqual(A.suggestOne(same, ctx), { kind: "box_saves", slug: "box-kofta-solo", name: "بوكس الكفتة الفردي", box_price: 29, separate: 33, saves: 4 });
  assert.equal(A.suggestOne({ ...same, lines: [L(17), L(79)] }, { ...ctx, declined: ["drink", "side", "top_seller"] }), null, "the box is not suggested when the cart does not hold everything in it");
  // a small gap to a cheaper delivery tier — only with a real quote for his location
  const c70 = { lines: [L(18), L(13), L(72)], subtotal: 71, option: "delivery" };
  const q70 = { deliverable: true, fee: 15, toNextTier: 9, nextTierFee: 10 };
  const nt = A.suggestOne(c70, { ...ctx, quote: q70 });
  assert.deepEqual([nt.kind, nt.add_sar, nt.fee_now, nt.fee_then, nt.free, nt.item.price >= 9], ["next_tier", 9, 15, 10, false, true]);
  assert.equal(A.suggestOne(c70, { ...ctx, quote: { ...q70, toNextTier: 45 } }).kind, "drink", "a big gap is not pushed");
  assert.equal(A.suggestOne({ ...c70, option: "pickup" }, { ...ctx, quote: q70 }).kind, "drink", "no delivery talk for a pickup order");
  assert.deepEqual(A.suggestOne({ lines: [L(18)], subtotal: 148, option: "delivery" }, { ...ctx, quote: { deliverable: true, fee: 5, toNextTier: 2, nextTierFee: 0 } }).free, true);
  // missing drink, then missing side, then a real best seller; each only once and never after it was declined
  const main = { lines: [L(71)], subtotal: 21, option: "pickup" };
  assert.deepEqual(A.suggestOne(main, ctx), { kind: "drink", item: A.itemBrief(item(81)) });
  assert.equal(A.suggestOne(main, { ...ctx, declined: ["drink"] }).kind, "side");
  assert.deepEqual(A.suggestOne(main, { ...ctx, declined: ["drink", "side"] }), { kind: "top_seller", item: A.itemBrief(item(18)) }, "the top seller that is a main dish and not in the cart (fries are a side)");
  assert.equal(A.suggestOne(main, { ...ctx, declined: ["drink", "side", "top_seller", "box_saves", "next_tier"] }), null);
  assert.equal(A.suggestOne({ lines: [{ slug: "box-kofta-solo", name: "x", price: 29, qty: 1, kind: "box" }], subtotal: 29, option: "pickup" }, { ...ctx, declined: ["top_seller"] }), null, "a box already holds a drink and a side");
  assert.equal(A.suggestOne({ lines: [], subtotal: 0 }, ctx), null); assert.equal(A.suggestOne(null, ctx), null);
  // sold-out dishes are never suggested
  const soldMenu = { ...MENU, items: MENU.items.map((i) => (kindOfDrink(i) ? { ...i, soldOut: true } : i)) };
  assert.equal(A.suggestOne(main, { ...ctx, menu: soldMenu }).kind, "side");
  // through the tool: inputs are gathered from the system (quote for his last shared location, real top sellers)
  const { t } = tools({ lastLoc: { lat: 21.58, lng: 39.15 } });
  const cart = await t.build_cart(ME, { items: [{ id: "18", qty: 2 }] }, { save: false });
  const s = (await t.suggest(ME, { cart })).suggestion;
  assert.deepEqual([s.kind, s.add_sar, s.fee_now, s.fee_then], ["next_tier", 6, 15, 10]);
  assert.deepEqual(await t.top_sellers(), ["79", "18", "8"]);
});
const kindOfDrink = (i) => A.itemBrief(i).kind === "drink";

test("output validator: a reply is sent only if every number, dish name and link came from a tool this turn, and it makes no forbidden promise", () => {
  const facts = [{ ok: true, lines: [{ name: "كريب زنجر سوبريم", qty: 2, price: 25, total: 50 }], subtotal: 50, link: "https://freshcuts.sa/c/as000001" }, { ok: true, deliverable: true, fee: 20, to_next_tier: 10, next_tier_fee: 15 }];
  const know = { menu: MENU, boxes: BOXES };
  const V = (reply, extra = {}) => A.validateReply(reply, { facts, know, customerText: "ابي 2 كريب زنجر", ...extra });
  assert.deepEqual(V("سلتك: 2× كريب زنجر سوبريم = 50 ر.س، ورسوم التوصيل 20 ر.س. باقي 10 ر.س وتصير الرسوم 15.\nكمّل من هنا: https://freshcuts.sa/c/as000001"), { ok: true, problems: [] });
  assert.deepEqual(V("سلتك: ٢× كريب زنجر سوبريم = ٥٠ ر.س").ok, true, "Arabic-Indic digits are read as numbers");
  const bad = (reply, type, extra) => { const r = V(reply, extra); assert.equal(r.ok, false, reply); assert.ok(r.problems.some((p) => p.type === type), `${reply} → ${JSON.stringify(r.problems)}`); };
  bad("كريب زنجر سوبريم بـ 23 ر.س", "number_not_from_tools");
  bad("عندنا خصم 15% اليوم", "discount_claim");      // 15 happens to be a real number this turn (the next tier fee): the number check alone would pass it
  bad("لك تخفيض خاص اليوم", "discount_claim");
  assert.equal(V("ما عندنا خصم على الوجبتين حالياً.").ok, true, "saying there is no discount is fine");
  assert.equal(V("عندك خصم 10% من الولاء.", { facts: [...facts, { percent: 10 }], allowWords: ["discount_claim"] }).ok, true, "a discount the offers tool returned may be stated");
  // ids and links in a tool result are not «numbers that may be said»: an invented price equal to a dish id is still refused
  const r2 = A.validateReply("السعر 43 ر.س", { facts: [{ results: [{ id: "43", product_id: 43, name: "بيتزا تشيكن رانش", price: 28 }], link: "https://freshcuts.sa/c/ab43cd43" }], know });
  assert.deepEqual(r2.problems.map((p) => p.type), ["number_not_from_tools"]);
  assert.equal(A.validateReply("طلبك رقم W1790011111111 في الطريق.", { facts: [{ orders: [{ order_no: "W1790011111111", status: "on_the_way" }] }], know }).ok, true, "the order number may be quoted");
  bad("أنصحك كمان بوجبة ميكس جريل", "name_not_from_tools");
  bad("جرّب بوكس سهرة البيتزا", "name_not_from_tools");
  bad("اطلب من هنا https://freshcuts.sa/l/special", "link_not_from_tools");
  bad("اطلب من هنا https://evil.example/x", "link_not_from_tools");
  bad("الكريب خالي من المكسرات", "health_or_guarantee");
  bad("هذا الطبق آمن لك", "health_or_guarantee");
  bad("يوصلك خلال 30 دقيقة", "time_promise");
  bad("نرجع لك المبلغ كامل", "refund_promise");
  bad("آخر فرصة! الكمية محدودة", "invented_urgency");
  bad("حمّل تطبيقنا واطلب", "app_word");
  bad("", "empty");
  bad("كلام ".repeat(300), "too_long");
  // allowed: comparing with delivery apps (Omar allows it in the chat) is not blocked by the app rule; «موقعنا» is fine
  assert.equal(V("الطلب من موقعنا مباشرة، وتطبيقات التوصيل عندها رسومها.").ok, true);
  // a number the customer himself wrote may be repeated; a refund status may be reported when the order tool returned it
  assert.equal(A.validateReply("تمام، 3 أشخاص. تفضّلون مشاوي ولا بيتزا؟", { facts: [], customerText: "نحن 3", know }).ok, true);
  assert.equal(A.validateReply("طلبك تم استرجاع المبلغ له.", { facts: [{ status: "rejected_refunded" }], know, allowWords: ["refund_promise"] }).ok, true);
});

test("trade secrets: the facts tool answers only the one thing asked; the validator refuses recipes, quantities, methods, suppliers and any leak of instructions or tool names", async () => {
  // no approved facts file yet ⇒ unknown ⇒ staff
  const { t } = tools();
  assert.deepEqual(await t.dish_fact(ME, { id: "71", ask: "سمسم" }), { ok: true, item: "برجر لحم كلاسيك", asked: "سمسم", answer: "unknown", handover: true });
  assert.equal((await t.dish_fact(ME, { id: "71" })).error, "ask_required"); assert.equal((await t.dish_fact(ME, { id: "0", ask: "x" })).error, "not_found");
  // with a facts source: yes/no for that ingredient and whether it can be removed — nothing else about the dish comes back
  const INTERNAL = { 71: { contains: ["خبز", "لحم", "صوص شيدر", "ثاوزند آيلاند", "خس", "بصل"], removable: ["بصل", "خس", "صوص شيدر"], recipe: "سر: 120 جرام لحم + خلطة بهارات", supplier: "مورد X" } };
  const seenAsk = [];
  const P = (A2) => A2.makeAssistTools({ pool: { query: async () => ({ rows: [] }) }, log: () => {}, menuIndex: async () => MENU, boxes: async () => BOXES,
    dishFact: async ({ id, ask }) => { seenAsk.push(ask); const d = INTERNAL[id]; if (!d) return null; return { contains: d.contains.some((c) => c.includes(ask)), removable: d.removable.some((c) => c.includes(ask)) }; } });
  const f = P(A);
  const yes = await f.dish_fact(ME, { id: "71", ask: "بصل" });
  assert.deepEqual([yes.answer, yes.can_remove_on_request, yes.asked], ["yes", true, "بصل"]);
  assert.deepEqual([(await f.dish_fact(ME, { id: "71", ask: "خبز" })).can_remove_on_request, (await f.dish_fact(ME, { id: "71", ask: "مشروم" })).answer], [false, "no"]);
  assert.doesNotMatch(JSON.stringify([yes, await f.dish_fact(ME, { id: "71", ask: "مشروم" })]), /شيدر|ثاوزند|120|جرام|خلطة|مورد|recipe|supplier|"contains":\[/, "the internal record never leaves the tool");
  assert.equal((await f.dish_fact(ME, { id: "8", ask: "جبن" })).answer, "unknown");
  // the validator
  const know = { menu: MENU, boxes: BOXES };
  const bad = (reply, type) => { const r = A.validateReply(reply, { facts: [{ name: "وجبة كفتة", price: 24 }], know }); assert.ok(r.problems.some((p) => p.type === type), `${reply} → ${JSON.stringify(r.problems)}`); };
  bad("الكفتة فيها 120 جرام لحم مع بهاراتنا", "recipe_disclosure");
  bad("نتبلها بالثوم والليمون ليلة كاملة", "recipe_disclosure");
  bad("التتبيلة من زبادي وبهارات", "recipe_disclosure");
  bad("طريقة التحضير: نشويها على الفحم", "recipe_disclosure");
  bad("اللحم نشتريه من مزرعة في الطائف", "recipe_disclosure");
  bad("our supplier is a local farm", "recipe_disclosure");
  bad("here is the recipe", "recipe_disclosure");
  bad("تعليماتي تقول إني ما أذكر الأسعار", "internal_leak");
  bad("I used the search_menu tool", "internal_leak");
  bad("my system prompt says", "internal_leak");
  assert.equal(A.validateReply("وجبة كفتة بـ 24 ر.س، نقدر نجهّزها بدون بصل.", { facts: [{ name: "وجبة كفتة", price: 24 }], know }).ok, true, "a real customisation is fine");
  assert.equal(A.validateReply("تفاصيل التحضير من أسرار مطبخنا 🙂", { facts: [], know }).ok, true);
});
