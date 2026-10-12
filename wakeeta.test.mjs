/* KS1: شرايح حملة واتساب لعملاء كيتا + إيقاف SMS المؤقت — node --test wakeeta.test.mjs (دوال صِرفة، من غير قاعدة ولا شبكة) */
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "./smsrules.js";

const C = (x = {}) => ({ pn: "5" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"), keetaOrders: 1, appNames: "Keeta", appTopFood: "crepe", online: 0, orders: 1, appOrders: 1, daysSince: 10, onlineDaysSince: 9999, ...x });
const segOf = (c) => R.KEETA_WA_SEGMENTS.filter((s) => s.test(c)).map((s) => s.id);
const byId = Object.fromEntries(R.KEETA_WA_SEGMENTS.map((s) => [s.id, s]));

test("12 segments: 4 dishes × 3 waves; every Keeta customer who never ordered online and does not buy in the shop is in exactly one", () => {
  assert.equal(R.KEETA_WA_SEGMENTS.length, 12);
  assert.deepEqual(R.KEETA_WA_IDS.slice(0, 4), ["kw_w1_crepe", "kw_w1_grill", "kw_w1_pasta", "kw_w1_other"]);
  for (const s of R.KEETA_WA_SEGMENTS) { assert.equal(s.allowApps, true, s.id); assert.ok(s.label && s.hint); }
  assert.deepEqual(segOf(C({ keetaOrders: 3 })), ["kw_w1_crepe"]);
  assert.deepEqual(segOf(C({ keetaOrders: 2, appTopFood: "grill" })), ["kw_w1_grill"]);
  assert.deepEqual(segOf(C({ keetaOrders: 1, daysSince: 30, appTopFood: "pasta" })), ["kw_w2_pasta"]);
  assert.deepEqual(segOf(C({ keetaOrders: 1, daysSince: 31, appTopFood: "pizza" })), ["kw_w3_other"]);
  for (const f of ["hawawshi", "burger", null, undefined]) assert.deepEqual(segOf(C({ appTopFood: f })), ["kw_w2_other"]);
});

test("who is left out: ordered on the website, buys in the shop directly, no Keeta order, or the app is not Keeta", () => {
  assert.deepEqual(segOf(C({ online: 1 })), [], "already a website customer");
  assert.deepEqual(segOf(C({ orders: 3, appOrders: 1 })), [], "also buys in the shop: has other segments");
  assert.deepEqual(segOf(C({ keetaOrders: 0 })), []);
  assert.deepEqual(segOf(C({ appNames: "HungerStation" })), [], "another app");
  assert.deepEqual(segOf(C({ appNames: "W1790012345678" })), [], "a website order number is not an app (the AP1 bug must not come back here)");
  assert.deepEqual(segOf(C({ appNames: "keeta,HungerStation" })), ["kw_w2_crepe"]);
  /* العدّ بطلبات كيتا، مش بكل طلبات نقطة البيع */
  assert.deepEqual(segOf(C({ keetaOrders: 1, orders: 1, appOrders: 1, daysSince: 5 })), ["kw_w2_crepe"]);
});

test("the plan's measured table is reproduced from the same rule (counts by dish × wave)", () => {
  const mk = (n, x) => Array.from({ length: n }, () => C(x));
  const rows = [...mk(7, { keetaOrders: 3 }), ...mk(23, { keetaOrders: 2 }), ...mk(33, { keetaOrders: 1, daysSince: 12 }), ...mk(49, { keetaOrders: 1, daysSince: 60 }),
    ...mk(36, { keetaOrders: 2, orders: 4, appOrders: 2 }), ...mk(20, { keetaOrders: 1, online: 2 })];
  const n = (id) => rows.filter(byId[id].test).length;
  assert.deepEqual([n("kw_w1_crepe"), n("kw_w2_crepe"), n("kw_w3_crepe")], [30, 33, 49]);
  assert.equal(R.KEETA_WA_SEGMENTS.reduce((a, s) => a + rows.filter(s.test).length, 0), 112, "the 36 shop buyers and the 20 website customers are in none");
});

test("SMS pause: nothing by default; a pause covers the members of its segments until the end of its last day (Riyadh), then lifts by itself", () => {
  const rows = [C({ pn: "511111111", keetaOrders: 3 }), C({ pn: "522222222", keetaOrders: 1, daysSince: 5 }), C({ pn: "533333333", online: 1 })];
  assert.deepEqual(R.activeSmsPauses({}), []); assert.equal(R.smsPausedSet({}, rows, byId).size, 0);
  const s = { cms: { smsPause: [{ segments: ["kw_w1_crepe", "kw_w2_crepe"], until: "2026-11-03", note: "حملة واتساب كيتا" }] } };
  const at = (iso) => new Date(iso);
  assert.deepEqual([...R.smsPausedSet(s, rows, byId, at("2026-10-14T10:00:00Z"))].sort(), ["511111111", "522222222"]);
  assert.equal(R.smsPausedSet(s, rows, byId, at("2026-11-03T20:59:00Z")).size, 2, "23:59 Riyadh on the last day: still paused");
  assert.equal(R.smsPausedSet(s, rows, byId, at("2026-11-03T21:01:00Z")).size, 0, "00:01 Riyadh the next day: lifted");
  for (const bad of [{ cms: { smsPause: [{ segments: [], until: "2026-11-03" }] } }, { cms: { smsPause: [{ segments: ["kw_w1_crepe"], until: "soon" }] } }, { cms: { smsPause: "x" } }, { cms: { smsPause: [{ segments: ["no_such"], until: "2026-11-03" }] } }])
    assert.equal(R.smsPausedSet(bad, rows, byId, at("2026-10-14T10:00:00Z")).size, 0);
});

test("filterAudience: a paused phone is excluded with its own reason; nobody else is touched; the reasons list has the Arabic label", () => {
  const m = [C({ pn: "511111111" }), C({ pn: "522222222" })];
  const f = R.filterAudience(m, { allowApps: true, paused: new Set(["511111111"]) });
  assert.deepEqual(f.list.map((x) => x.pn), ["522222222"]); assert.equal(f.excluded.sms_paused, 1);
  const g = R.filterAudience(m, { allowApps: true });
  assert.equal(g.list.length, 2); assert.ok(!("sms_paused" in g.excluded), "no new key when nothing is paused");
  assert.match(R.EXCLUDE_LABELS.sms_paused, /موقوف مؤقتاً/);
});

test("cleanSmsPauses: unknown segment, no segment, bad or far date are refused with the reason; a good list is normalised", () => {
  const now = new Date("2026-10-14T10:00:00Z"), ids = R.KEETA_WA_IDS;
  const ok = R.cleanSmsPauses([{ segments: ["kw_w1_crepe", "kw_w1_crepe", "kw_w1_grill"], until: "2026-11-04", note: "  حملة   كيتا " }], ids, now);
  assert.deepEqual(ok, { ok: true, list: [{ segments: ["kw_w1_crepe", "kw_w1_grill"], until: "2026-11-04", note: "حملة كيتا" }], errors: [] });
  assert.deepEqual(R.cleanSmsPauses([], ids, now), { ok: true, list: [], errors: [] }, "an empty list clears every pause");
  assert.match(R.cleanSmsPauses([{ segments: ["nope"], until: "2026-11-04" }], ids, now).errors[0], /مش معروفة/);
  assert.match(R.cleanSmsPauses([{ segments: [], until: "2026-11-04" }], ids, now).errors[0], /شريحة واحدة/);
  assert.match(R.cleanSmsPauses([{ segments: ["kw_w1_crepe"], until: "x" }], ids, now).errors[0], /تاريخ/);
  assert.match(R.cleanSmsPauses([{ segments: ["kw_w1_crepe"], until: "2027-06-01" }], ids, now).errors[0], /٣ شهور/);
});
