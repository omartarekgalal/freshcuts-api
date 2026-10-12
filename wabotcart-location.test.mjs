/* السلة الجاهزة من واتساب: موقع المحادثة في إجابة الاسترجاع (GET /api/carts/restore/<code>) — ١٢/١٠/٢٠٢٦
   المتجر بيحط الدبوس عليه «غير مؤكد». القاعدة: موقع نفس الرقم صاحب السلة بس، بوقته، وعمره أقل من الإعداد (٢٤ ساعة)، ومن غيره المفتاح مايتبعتش.
     node --test wabotcart-location.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { makeBotCarts, chatLocation } from "./wabotcart.js";
import * as R from "./wabotrun.js";
import * as AR from "./waassistrun.js";

const NOW = new Date("2026-10-12T18:00:00Z");
const ago = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();

test("chatLocation: a valid point with its time, younger than the limit — anything else is no location", () => {
  assert.deepEqual(chatLocation({ lat: 21.5810, lng: 39.1502, at: ago(2), via: "location" }, NOW), { lat: 21.581, lng: 39.1502, at: ago(2) }, "only lat, lng and the time: «via» and anything else stay behind");
  assert.deepEqual(chatLocation({ lat: "21.58", lng: "39.15", at: ago(23.9) }, NOW), { lat: 21.58, lng: 39.15, at: ago(23.9) });
  for (const [bad, why] of [[{ lat: 21.58, lng: 39.15, at: ago(24) }, "exactly 24 h"], [{ lat: 21.58, lng: 39.15, at: ago(30) }, "old"], [{ lat: 21.58, lng: 39.15 }, "no time"], [{ lat: 21.58, lng: 39.15, at: "x" }, "bad time"],
    [{ lat: 21.58, lng: 39.15, at: new Date(NOW.getTime() + 60_000).toISOString() }, "in the future"], [{ lat: "abc", lng: 39.15, at: ago(1) }, "bad lat"], [{ lat: 21.58, at: ago(1) }, "no lng"], [{ lat: 121, lng: 39, at: ago(1) }, "lat out of range"],
    [{ lat: 21, lng: 239, at: ago(1) }, "lng out of range"], [null, "null"], ["21.58,39.15", "a string"], [[21.58, 39.15], "an array"]]) assert.equal(chatLocation(bad, NOW), null, why);
  // the limit is a setting
  assert.equal(chatLocation({ lat: 21.58, lng: 39.15, at: ago(3) }, NOW, 2), null); assert.ok(chatLocation({ lat: 21.58, lng: 39.15, at: ago(1.5) }, NOW, 2));
});

function store({ carts, chats, hours = undefined, fail = false }) {
  const seen = [];
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim(); seen.push([s, p]);
    if (fail) throw new Error("db down");
    if (/FROM wa_bot_carts c LEFT JOIN wa_bot_chats ch ON ch\.phone_norm = c\.phone_norm WHERE c\.code=\$1 AND c\.expires_at > NOW\(\)/.test(s)) {
      const c = carts.find((x) => x.code === p[0] && !x.expired);
      return { rows: c ? [{ items: c.items, cart_raw: c.cart_raw, option: c.option, last_loc: (chats[c.phone_norm] || {}).last_loc ?? null }] : [] };
    }
    return { rows: [] };
  } };
  return { seen, bc: makeBotCarts({ pool, log: () => {}, now: () => NOW, ...(hours === undefined ? {} : { locationHours: hours }) }) };
}
const RAW = { 8: { item: { id: 8 }, qty: 1 } }, ITEMS = [{ id: "8", n: "كريب زنجر سوبريم", q: 1, p: 25 }];
const CARTS = [{ code: "ab12cd34", phone_norm: "512345678", source: "assistant", items: ITEMS, cart_raw: RAW, option: "delivery" }, { code: "zz99yy88", phone_norm: "598765432", source: "reorder", items: ITEMS, cart_raw: RAW, option: "pickup" },
  { code: "old00000", phone_norm: "512345678", source: "assistant", items: ITEMS, cart_raw: RAW, option: "delivery", expired: true }];

test("restore: the cart of a customer who shared a pin in the chat carries location {lat, lng, at}; the other customer's cart does not", async () => {
  const { bc, seen } = store({ carts: CARTS, chats: { 512345678: { last_loc: { lat: 21.581, lng: 39.1502, at: ago(1), via: "maps_link" } } } });
  const mine = await bc.restore("ab12cd34");
  assert.deepEqual(mine, { ok: true, items: ITEMS, raw: RAW, option: "delivery", subtotal: 0, ordered: false, location: { lat: 21.581, lng: 39.1502, at: ago(1) } });
  assert.ok(!JSON.stringify(mine).includes("512345678"), "the phone is used for the join only");
  // the location belongs to the phone that owns the code: another customer's cart never gets it
  const other = await bc.restore("zz99yy88");
  assert.deepEqual(other, { ok: true, items: ITEMS, raw: RAW, option: "pickup", subtotal: 0, ordered: false }); assert.ok(!("location" in other), "no key at all, not null");
  // the join is on the cart's own phone, the code is the only input
  const q = seen.find(([s]) => /wa_bot_carts c LEFT JOIN/.test(s));
  assert.deepEqual(q[1], ["ab12cd34"]);
  // expired or unknown code, a bad code: nothing (and no query for a code that cannot exist)
  assert.equal(await bc.restore("old00000"), null); assert.equal(await bc.restore("nope1234"), null);
  const n = seen.length; assert.equal(await bc.restore("../etc/passwd"), null); assert.equal(await bc.restore("AB12CD34"), null); assert.equal(seen.length, n);
});

test("restore: an old pin, a pin with no time, no pin, a broken setting or a database error never add a location and never break the cart", async () => {
  for (const [loc, why] of [[{ lat: 21.58, lng: 39.15, at: ago(25) }, "25 h old"], [{ lat: 21.58, lng: 39.15 }, "no time"], [null, "never shared"], [{ lat: "x", lng: 39.15, at: ago(1) }, "bad point"]]) {
    const r = await store({ carts: CARTS, chats: { 512345678: { last_loc: loc } } }).bc.restore("ab12cd34");
    assert.equal(r.ok, true, why); assert.ok(!("location" in r), why); assert.deepEqual(r.raw, RAW, why);
  }
  const fresh = { 512345678: { last_loc: { lat: 21.58, lng: 39.15, at: ago(3) } } };
  // the dashboard setting (assist.locationHours) is read at restore time
  assert.ok(!("location" in (await store({ carts: CARTS, chats: fresh, hours: async () => 2 }).bc.restore("ab12cd34"))));
  assert.ok((await store({ carts: CARTS, chats: fresh, hours: async () => 4 }).bc.restore("ab12cd34")).location);
  for (const broken of [async () => { throw new Error("settings down"); }, async () => "abc", async () => 0, async () => null])
    assert.deepEqual((await store({ carts: CARTS, chats: fresh, hours: broken }).bc.restore("ab12cd34")).location, { lat: 21.58, lng: 39.15, at: ago(3) }, "an unreadable setting falls back to 24 h");
  assert.equal(await store({ carts: CARTS, chats: fresh, fail: true }).bc.restore("ab12cd34"), null, "database down: the same answer as an unknown code");
});

test("the limit is a dashboard setting: assist.locationHours, 24 by default, 1 to 24 (the storefront itself ignores anything older than 24 h)", () => {
  assert.equal(R.botConfig({}).assist.locationHours, 24);
  const row = R.SCHEMA["assist.locationHours"];
  assert.deepEqual([row.type, row.min, row.max, row.unit, row.group, Boolean(row.ar && row.help)], ["number", 1, 24, "ساعة", "assist", true]);
  assert.equal(R.configFromBody({ assist: { locationHours: 6 } }).value.assist.locationHours, 6);
  for (const bad of [0, 25, "", "x", null]) assert.equal(R.configFromBody({ assist: { locationHours: bad } }).ok, false, String(bad));
  assert.equal(AR.assistConfig({ locationHours: 99 }).locationHours, 24); assert.equal(Object.keys(AR.ASSIST_SCHEMA).length, Object.keys(AR.ASSIST_CFG_DEFAULTS).length);
});
