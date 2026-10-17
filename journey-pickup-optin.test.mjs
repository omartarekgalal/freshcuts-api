/* ═══════════════════════════════════════════════════════════════════════════
   JE1 — أحداث تفعيل التنبيهات لطلبات الاستلام (كارت RT4 «نبّهك لما يجهز؟») في رحلة العميل — أوفلاين بداتابيز مزيّفة

     node --test journey-pickup-optin.test.mjs

   بيثبت: الخمس أسماء مقبولة والمجهول لسه مرفوض · الأحداث دي ماتختمش الجلسة برقم الطلب (درس TRK6) بس رقمها بيتكتب في عمود الحدث ·
   رقم الطلب W17925… مابيتبلعش من منضّف الجوال · شكل GET /api/journey/pickup-optin · النسب من غير قسمة على صفر.
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

const realSI = globalThis.setInterval, realST = globalThis.setTimeout;
globalThis.setInterval = (...a) => { const t = realSI(...a); t?.unref?.(); return t; };
globalThis.setTimeout = (...a) => { const t = realST(...a); t?.unref?.(); return t; };

const { Hono } = await import("hono");
const J = await import("./journey.js");

const FIVE = ["pickup_optin_shown", "pickup_optin_push_ok", "pickup_optin_push_denied", "pickup_optin_push_unsupported", "pickup_optin_wa_click"];
// رقم طلب بشكل ٢٠/١٠: «٥ وبعدها ٨ أرقام» — منضّف الجوال كان بيبدّله [redacted]
const NO = "W1792512345678";
const SID = "sje1abcdef123", ANON = "dje1abcdef";
const shift = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);

test("JE1: الخمس أحداث في القايمة البيضا بتسمياتها العربية، من غير خطوة في القمع، والمجهول لسه بيترفض", () => {
  assert.deepEqual([...J.PICKUP_OPTIN_EVENTS], FIVE);
  for (const n of FIVE) {
    assert.ok(J.WEB_EVENTS.includes(n), n);
    assert.equal(J.stepOf(n, { ord: NO }), null, n + " مش خطوة");
    assert.ok(J.PICKUP_OPTIN_LABELS[n] && /[؀-ۿ]/.test(J.PICKUP_OPTIN_LABELS[n]), n + " له تسمية عربية");
  }
  const p = J.parseBatch(JSON.stringify({ v: 1, sessionId: SID, anonId: ANON, events: [
    { n: "pickup_optin_shown", t: Date.now(), seq: 1, path: "/track/" + NO, p: { ord: NO, push: "ask", wa: "btn" } },
    { n: "pickup_optin_push_unsupported", t: Date.now(), seq: 2, path: "/track/" + NO, p: { ord: NO, why: "ios_install" } },
    { n: "pickup_optin_push_denied", t: Date.now(), seq: 3, p: { ord: NO, how: "pre" } },
    { n: "pickup_optin_push_ok", t: Date.now(), seq: 4, p: { ord: NO, how: "web" } },
    { n: "pickup_optin_wa_click", t: Date.now(), seq: 5, p: { ord: NO, mode: "ask" } },
    { n: "pickup_optin_hack", t: Date.now(), seq: 6, p: { ord: NO } },
    { n: "totally_unknown", t: Date.now(), seq: 7 },
  ] }), { now: Date.now() });
  assert.equal(p.events.length, 5);
  assert.equal(p.rejected.unknown, 2, "المجهول بيترفض زي الأول");
  assert.deepEqual(p.events.map((e) => e.name), FIVE.slice(0, 1).concat(["pickup_optin_push_unsupported", "pickup_optin_push_denied", "pickup_optin_push_ok", "pickup_optin_wa_click"]));
  assert.deepEqual(p.events[0].props, { ord: NO, push: "ask", wa: "btn" });
  assert.equal(p.events[1].props.why, "ios_install");
  assert.equal(p.events[2].props.how, "pre");
  assert.equal(p.events[0].path, "/track/:order", "رقم الطلب مش في المسار");
});

test("JE1: رقم الطلب بيعدّي من منضّف الجوال (W17925… = ٥ + ٨ أرقام) — في ord وorder_no، والجوال نفسه لسه بيتنضّف", () => {
  assert.match(J.sanitizeProps({ ord: NO }).ord, /\[redacted\]/, "من غير keepOrderIds الرقم كان بيضيع — ده السبب");
  const p = J.parseBatch(JSON.stringify({ sessionId: SID, anonId: ANON, events: [
    { n: "pickup_optin_shown", t: Date.now(), seq: 1, p: { ord: NO } },
    { n: "order_created", t: Date.now(), seq: 2, p: { order_no: NO, total: 96 } },
    { n: "pickup_optin_wa_click", t: Date.now(), seq: 3, p: { ord: "0551234567", phone: "0551234567" } },   // جوال مكان رقم الطلب: مايتحفظش
    { n: "pickup_optin_wa_click", t: Date.now(), seq: 4, p: { ord: 1792512345678 } },   // رقم مش نص: مايتعاملش كرقم طلب
  ] }));
  assert.equal(p.events[0].props.ord, NO);
  assert.equal(p.events[1].props.order_no, NO);
  assert.equal(p.events[1].props.total, 96);
  assert.doesNotMatch(JSON.stringify(p.events[2].props), /551234567/, "الجوال اتنضّف ومارجعش");
  assert.notEqual(typeof p.events[3].props.ord, "string");
  assert.equal(J.keepOrderIds(null, { a: 1 }).a, 1);
  assert.equal(J.keepOrderIds({ order_no: "abc" }, {}).order_no, undefined, "مش رقم طلب ⇒ مايتحطش");
});

test("JE1: أحداث الكارت ماتختمش الجلسة برقم الطلب (eventOrderNo = null) بس العمود بياخد ord (eventOrderRef) — والشيك أوت لسه بيختم", () => {
  for (const n of FIVE) {
    assert.equal(J.stampsSession(n), false, n);
    assert.equal(J.eventOrderNo({ name: n, props: { ord: NO } }), null, n + " / ord");
    assert.equal(J.eventOrderNo({ name: n, props: { order_no: NO } }), null, n + " / order_no (سكريبت قديم)");
    assert.equal(J.eventOrderRef({ name: n, props: { ord: NO } }), NO, n + " / العمود");
    assert.equal(J.eventOrderRef({ name: n, props: { ord: "x" } }), null);
  }
  assert.equal(J.stampsSession("order_created"), true);
  assert.equal(J.eventOrderNo({ name: "order_created", props: { order_no: NO } }), NO);
  assert.equal(J.eventOrderRef({ name: "order_created", props: { order_no: NO } }), NO);
  assert.equal(J.eventOrderRef({ name: "order_created", props: { ord: NO } }), null, "ord مش لأحداث الشيك أوت");
  // TRK6 زي ما هو
  assert.equal(J.eventOrderNo({ name: "wa_follow_tap", props: { order_no: NO } }), null);
  assert.equal(J.eventOrderRef({ name: "wa_follow_tap", props: { ord: NO } }), null);
});

/* ── المسارات بداتابيز مزيّفة ── */
function fakePool(data = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/INSERT INTO journey_events/.test(sql)) {
        const rows = [];
        for (let i = 0; i < params.length; i += 9) rows.push({ name: params[i + 2], step: params[i + 3], props: JSON.parse(params[i + 6]), order_no: params[i + 7] });
        return { rows, rowCount: rows.length };
      }
      if (/FROM shop_orders o\s+WHERE o\.option = 'pickup'/.test(sql)) return { rows: data.orders || [], rowCount: 0 };
      if (/WITH x AS/.test(sql)) return { rows: data.flags || [], rowCount: 0 };
      if (/e\.props->>'why'/.test(sql)) return { rows: data.events || [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}
async function mkApp(data) {
  const pool = fakePool(data);
  const app = new Hono();
  const api = J.register(app, {
    pool, jb: (v) => JSON.stringify(v), normPhone: (p) => String(p || "").replace(/\D/g, "").replace(/^(966|0)/, ""),
    getSettingsData: async () => ({ hours: null }),
    requireAdmin: async (c) => (c.req.header("Authorization") === "Bearer admin" ? null : c.json({ error: "Unauthorized" }, 401)),
  });
  await new Promise((r) => realST(r, 20)); // ensureSchema
  return { app, pool, api };
}
const GET = (app, path) => app.request(path, { headers: { Authorization: "Bearer admin" } });

test("POST /batch: أحداث الكارت بتتخزن برقم الطلب في العمود، من غير ما الجلسة ولا shop_orders.journey_sid يتختموا", async () => {
  const { app, pool } = await mkApp();
  const body = JSON.stringify({ v: 1, sessionId: SID, anonId: ANON, events: [
    { n: "pickup_optin_shown", t: Date.now(), seq: 1, path: "/track/" + NO, p: { ord: NO, push: "ask", wa: "btn" } },
    { n: "pickup_optin_push_ok", t: Date.now(), seq: 2, path: "/track/" + NO, p: { ord: NO, how: "web" } },
    { n: "nope_event", t: Date.now(), seq: 3 },
  ] });
  const r = await app.request("/api/journey/batch", { method: "POST", body, headers: { "content-type": "text/plain", "user-agent": "Mozilla/5.0 (iPhone) Safari" } });
  const j = await r.json();
  assert.equal(j.ok, true); assert.equal(j.accepted, 2); assert.equal(j.rejected, 1);
  const ins = pool.calls.find((c) => /INSERT INTO journey_events/.test(c.sql));
  assert.equal(ins.params[7], NO, "عمود order_no للحدث الأول");
  assert.equal(ins.params[16], NO, "عمود order_no للحدث التاني");
  assert.match(ins.params[6], new RegExp(`"ord":"${NO}"`), "ord في props زي ما هو");
  const up = pool.calls.find((c) => /UPDATE journey_sessions SET events/.test(c.sql));
  assert.equal(up.params[4], null, "الجلسة ماتختمتش");
  assert.ok(!pool.calls.some((c) => /UPDATE shop_orders SET journey_sid/.test(c.sql)), "shop_orders.journey_sid ماتلمسش");
  // والشيك أوت العادي لسه بيختم زي الأول
  const { app: app2, pool: pool2 } = await mkApp();
  await app2.request("/api/journey/batch", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ v: 1, sessionId: SID, anonId: ANON, events: [
    { n: "order_created", t: Date.now(), seq: 1, p: { order_no: NO } }] }) });
  assert.equal(pool2.calls.find((c) => /UPDATE journey_sessions SET events/.test(c.sql)).params[4], NO);
  assert.ok(pool2.calls.some((c) => /UPDATE shop_orders SET journey_sid/.test(c.sql)));
});

test("GET /api/journey/pickup-optin: محمي، وبيرجّع الشكل كامل (١٤ يوم × الأعمدة + إجمالي + نسب + موانع بالعربي + تسميات)", async () => {
  const today = J.bizDayOf(new Date()), yday = shift(today, -1);
  const data = {
    orders: [{ day: yday, orders: 3, customers: 3 }, { day: today, orders: 2, customers: 2 }, { day: null, orders: 5, customers: 4 }],
    events: [
      { day: yday, name: "pickup_optin_shown", sub: "", n: 3, orders: 3 },
      { day: yday, name: "pickup_optin_push_ok", sub: "web", n: 1, orders: 1 },
      { day: yday, name: "pickup_optin_push_unsupported", sub: "ios_install", n: 1, orders: 1 },
      { day: yday, name: "pickup_optin_push_denied", sub: "pre", n: 1, orders: 1 },
      { day: yday, name: "pickup_optin_wa_click", sub: "", n: 2, orders: 2 },
      { day: today, name: "pickup_optin_shown", sub: "", n: 2, orders: 2 },
      { day: today, name: "pickup_optin_push_unsupported", sub: "inapp", n: 1, orders: 1 },   // اسم بديل ⇒ iab
      { day: today, name: "pickup_optin_wa_click", sub: "", n: 1, orders: 1 },
      { day: today, name: "some_other_event", sub: "", n: 9, orders: 9 },                     // مش بتاعنا ⇒ بيتجاهل
    ],
    flags: [
      { day: yday, shown_orders: 3, push_orders: 1, wa_orders: 2, optin_orders: 2, both_orders: 1, denied_orders: 1, unsup_orders: 1, customers: 3 },
      { day: today, shown_orders: 2, push_orders: 0, wa_orders: 1, optin_orders: 1, both_orders: 0, denied_orders: 0, unsup_orders: 1, customers: 2 },
      { day: null, shown_orders: 5, push_orders: 1, wa_orders: 3, optin_orders: 3, both_orders: 1, denied_orders: 1, unsup_orders: 2, customers: 4 },
    ],
  };
  const { app, pool } = await mkApp(data);
  assert.equal((await app.request("/api/journey/pickup-optin")).status, 401, "محمي");
  const r = await GET(app, "/api/journey/pickup-optin?days=14");
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.days, 14); assert.equal(d.to, today); assert.equal(d.from, shift(today, -13));
  assert.equal(d.daily.length, 14);
  assert.equal(d.daily[13].day, today); assert.equal(d.daily[0].day, d.from);
  const KEYS = ["day", "orders", "shown", "pushOk", "pushDenied", "pushUnsupported", "waClick", "shownOrders", "pushOrders", "waOrders", "optinOrders", "bothOrders", "deniedOrders", "unsupportedOrders", "customers"];
  for (const row of d.daily) assert.deepEqual(Object.keys(row).sort(), KEYS.slice().sort(), row.day);
  const Y = d.daily[12], T = d.daily[13];
  assert.deepEqual([Y.orders, Y.shown, Y.pushOk, Y.pushDenied, Y.pushUnsupported, Y.waClick], [3, 3, 1, 1, 1, 2]);
  assert.deepEqual([Y.shownOrders, Y.pushOrders, Y.waOrders, Y.optinOrders, Y.bothOrders, Y.customers], [3, 1, 2, 2, 1, 3]);
  assert.deepEqual([T.orders, T.shown, T.pushUnsupported, T.waClick, T.shownOrders, T.waOrders, T.optinOrders], [2, 2, 1, 1, 2, 1, 1]);
  assert.equal(d.daily[5].orders, 0, "يوم من غير صفوف = أصفار مش ناقص");
  const t = d.totals;
  assert.deepEqual([t.orders, t.orderCustomers, t.shown, t.pushOk, t.pushDenied, t.pushUnsupported, t.waClick], [5, 4, 5, 1, 1, 2, 3]);
  assert.deepEqual([t.shownOrders, t.pushOrders, t.waOrders, t.optinOrders, t.bothOrders, t.deniedOrders, t.unsupportedOrders, t.customers], [5, 1, 3, 3, 1, 1, 2, 4]);
  assert.deepEqual(d.rates, { shownOfOrders: 1, pushOfShown: 0.2, waOfShown: 0.6, optinOfShown: 0.6, optinOfOrders: 0.6, bothOfShown: 0.2, deniedOfShown: 0.2, unsupportedOfShown: 0.4 });
  const bl = Object.fromEntries(d.blockers.map((b) => [b.key, b]));
  assert.equal(bl.ios_install.label, "آيفون من غير تثبيت"); assert.equal(bl.ios_install.n, 1);
  assert.equal(bl.iab.label, "متصفح داخل تطبيق"); assert.equal(bl.iab.n, 1);
  assert.equal(bl.denied.label, "مرفوض من المتصفح"); assert.equal(bl.denied.n, 1);
  assert.deepEqual(d.how.push.map((x) => [x.key, x.label, x.n]), [["web", "من المتصفح", 1]]);
  assert.deepEqual(d.how.denied.map((x) => [x.key, x.label, x.n]), [["pre", "كان رافض من قبل", 1]]);
  assert.deepEqual(d.labels, J.PICKUP_OPTIN_LABELS);
  assert.ok(d.generatedAt && d.note && d.source);
  // الاستعلامات: استلام بس، QA/موظفين/بوتات مستبعدين، التجربة مستبعدة، الخمس أسماء في البارامترات
  const q = pool.calls.filter((c) => /pickup/.test(c.sql) || /pickup/.test(JSON.stringify(c.params)));
  const qo = q.find((c) => /o\.option = 'pickup'/.test(c.sql)), qe = q.find((c) => /e\.props->>'why'/.test(c.sql)), qf = q.find((c) => /WITH x AS/.test(c.sql));
  assert.ok(qo && qe && qf, "٣ استعلامات");
  assert.match(qo.sql, /table_no/); assert.match(qo.sql, /is_test/); assert.match(qo.sql, /pending_payment/);
  assert.deepEqual([qo.params[0], qo.params[1]], [d.from, d.to]);
  for (const c of [qe, qf]) {
    assert.match(c.sql, /NOT s\.is_bot AND NOT s\.is_qa AND NOT s\.is_staff/);
    assert.match(c.sql, /is_test/);
    assert.deepEqual(c.params[2], FIVE);
    assert.deepEqual([c.params[0], c.params[1]], [d.from, d.to]);
  }
  // كاش ٦٠ ث + fresh=1 + حدود days
  assert.equal((await (await GET(app, "/api/journey/pickup-optin?days=14")).json()).cached, true);
  assert.equal((await (await GET(app, "/api/journey/pickup-optin?days=14&fresh=1")).json()).cached, undefined);
  assert.equal((await (await GET(app, "/api/journey/pickup-optin?days=999")).json()).days, 60);
  assert.equal((await (await GET(app, "/api/journey/pickup-optin?days=0")).json()).days, 14);
  assert.equal((await (await GET(app, "/api/journey/pickup-optin?days=3")).json()).daily.length, 3);
});

test("GET /api/journey/pickup-optin: مفيش طلبات ولا أحداث ⇒ أصفار ونسب صفر (مفيش قسمة على صفر ولا NaN)", async () => {
  const { app } = await mkApp({});
  const d = await (await GET(app, "/api/journey/pickup-optin?days=7")).json();
  assert.equal(d.ok, true);
  assert.equal(d.daily.length, 7);
  for (const row of d.daily) for (const [k, v] of Object.entries(row)) if (k !== "day") assert.equal(v, 0, `${row.day}.${k}`);
  for (const [k, v] of Object.entries(d.rates)) { assert.equal(v, 0, k); assert.ok(Number.isFinite(v), k); }
  for (const [k, v] of Object.entries(d.totals)) assert.equal(v, 0, k);
  assert.deepEqual(d.blockers, []); assert.deepEqual(d.how, { push: [], denied: [] });
  assert.doesNotMatch(JSON.stringify(d), /NaN|null/, "مفيش null ولا NaN في الرد");
});

test("pickupOptinSummary (صافي): من غير صف إجمالي بيجمع من الأيام، ومعدل الأحداث الكبيرة بيتحسب صح", () => {
  const s = J.pickupOptinSummary({ from: "2026-10-15", to: "2026-10-17",
    orderRows: [{ day: "2026-10-15", orders: 4, customers: 4 }, { day: "2026-10-17", orders: 6, customers: 5 }],
    eventRows: [{ day: "2026-10-15", name: "pickup_optin_shown", sub: "", n: 2, orders: 2 }, { day: "2026-10-17", name: "pickup_optin_push_ok", sub: "silent", n: 3, orders: 3 },
      { day: "2026-10-17", name: "pickup_optin_push_unsupported", sub: "weird", n: 1, orders: 1 }, { day: "2026-10-17", name: "pickup_optin_push_denied", sub: "", n: 2, orders: 2 }],
    flagRows: [{ day: "2026-10-15", shown_orders: 2, push_orders: 0, wa_orders: 0, optin_orders: 0, both_orders: 0, denied_orders: 0, unsup_orders: 0, customers: 2 },
      { day: "2026-10-17", shown_orders: 3, push_orders: 3, wa_orders: 0, optin_orders: 3, both_orders: 0, denied_orders: 2, unsup_orders: 1, customers: 3 }],
  });
  assert.equal(s.days, 3);
  assert.deepEqual(s.daily.map((d) => d.day), ["2026-10-15", "2026-10-16", "2026-10-17"]);
  assert.equal(s.totals.orders, 10); assert.equal(s.totals.shownOrders, 5); assert.equal(s.totals.pushOrders, 3); assert.equal(s.totals.optinOrders, 3);
  assert.equal(s.rates.shownOfOrders, 0.5); assert.equal(s.rates.pushOfShown, 0.6); assert.equal(s.rates.optinOfOrders, 0.3);
  assert.deepEqual(s.blockers.map((b) => [b.key, b.label, b.n]), [["denied", "مرفوض من المتصفح", 2], ["other", "سبب تاني", 1]]);
  assert.deepEqual(s.how.push.map((x) => [x.key, x.n]), [["silent", 3]]);
  assert.deepEqual(s.how.denied.map((x) => [x.key, x.label]), [["other", "غير معروف"]]);
  assert.deepEqual(J.dayList("2026-10-17", "2026-10-15"), []);
  assert.deepEqual(J.dayList("x", "y"), []);
  assert.deepEqual(J.pickupOptinSummary({ from: "2026-10-17", to: "2026-10-17" }).rates.optinOfOrders, 0);
});
