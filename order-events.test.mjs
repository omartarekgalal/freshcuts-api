/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات ناقل أحداث الطلب (order-events.js — W1-01، الخطة §٤-١)
     ١) التصنيف = نفس قايمة الخطة بالظبط، والاسم المجهول بيترفض
     ٢) emitOrder مابترميش أبداً (مستمع بيرمي sync/async، مدخلات بايظة)
     ٣) المخزن بيكتب fire-and-forget، ومفيش 5\d{8} ولا عنوان في data المحفوظة
     ٤) DDL الجدول كله IF NOT EXISTS + الفهرسين
     node --test order-events.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

const ev = await import("./order-events.js");
const { ORDER_EVENTS, emitOrder, bus, subscribe, sanitizeData, startEventStore, stopEventStore, EVENTS_DDL, CHANNEL } = ev;

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };
const PHONE_DIGITS = /5\d{8}/;

function fakePool({ failInsert = false } = {}) {
  return {
    sql: [], inserts: [],
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      this.sql.push(s);
      if (/^INSERT INTO shop_order_events/i.test(s)) {
        if (failInsert) throw new Error("db down");
        this.inserts.push(params);
      }
      if (/to_regclass/i.test(s)) return { rows: [{ t: null }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

test("ORDER_EVENTS matches master plan §4-1 exactly", () => {
  assert.deepEqual([...ORDER_EVENTS].sort(), [
    "order_status", "payment_execute", "payment_check", "order_paid", "order_expired",
    "pos_push", "partner_fallback", "pos_ready", "portal_ack",
    "courier_dispatch", "courier_update", "courier_cancel", "courier_manual",
    "sla_alert", "notify_sent", "refund", "staff_note", "staff_call", "staff_action",
  ].sort());
  assert.equal(new Set(ORDER_EVENTS).size, ORDER_EVENTS.length);
  assert.ok(Object.isFrozen(ORDER_EVENTS));
});

test("unknown event name is rejected (both call forms), nothing emitted", () => {
  let seen = 0;
  const off = subscribe(() => { seen++; });
  const origErr = console.error; console.error = () => {};
  try {
    assert.equal(emitOrder("order_shipped", { orderNo: "W1001" }), null);
    assert.equal(emitOrder("W1001", "kind:note", {}), null);
    assert.equal(emitOrder("W1001", "ORDER_PAID", {}), null);
    assert.equal(emitOrder(undefined), null);
    assert.equal(emitOrder(), null);
  } finally { console.error = origErr; off(); }
  assert.equal(seen, 0);
});

test("both call forms produce the same normalized event", () => {
  const got = [];
  const off = subscribe((e) => got.push(e));
  try {
    const a = emitOrder("notify_sent", { orderNo: "W2001", source: "notify", channel: "sms", ok: true, data: { stage: "paid", channel: "sms", ok: true } });
    const b = emitOrder("W2001", "notify_sent", { stage: "paid", channel: "sms", ok: true, source: "notify" });
    assert.ok(a && b);
    for (const e of [a, b]) {
      assert.equal(e.orderNo, "W2001");
      assert.equal(e.name, "notify_sent");
      assert.equal(e.source, "notify");
      assert.equal(e.channel, "sms");
      assert.equal(e.ok, true);
      assert.deepEqual(e.data, { stage: "paid", channel: "sms", ok: true });
      assert.ok(e.summary && e.summary.length <= 300);
      assert.ok(!Number.isNaN(Date.parse(e.at)));
    }
    assert.equal(got.length, 2);
  } finally { off(); }
});

test("per-name channel also fires", () => {
  let n = 0;
  const off = subscribe(() => n++, "order_paid");
  try {
    emitOrder("W3001", "order_paid", {});
    emitOrder("W3001", "order_expired", { executed: false });
  } finally { off(); }
  assert.equal(n, 1);
});

test("emitOrder never throws: throwing sync/async listeners and raw bus listeners", async () => {
  const origErr = console.error; console.error = () => {};
  const raw = () => { throw new Error("raw boom"); };
  bus.on(CHANNEL, raw);
  const off1 = subscribe(() => { throw new Error("sync boom"); });
  const off2 = subscribe(async () => { throw new Error("async boom"); });
  let later = 0;
  const off3 = subscribe(() => { later++; }, "pos_push");
  try {
    let r;
    assert.doesNotThrow(() => { r = emitOrder("W4001", "pos_push", { ok: false, attempt: 3, error: "timeout" }); });
    assert.ok(r);
    assert.equal(later, 1, "per-name listeners still run when channel listener throws");
    // مدخلات بايظة
    const circ = {}; circ.self = circ;
    assert.doesNotThrow(() => emitOrder("W4001", "staff_note", circ));
    assert.doesNotThrow(() => emitOrder("staff_note", null));
    assert.doesNotThrow(() => emitOrder("staff_note", { orderNo: { toString() { throw new Error("x"); } } }));
    assert.doesNotThrow(() => emitOrder("staff_note", { orderNo: "W4001", data: { get bad() { throw new Error("getter"); } } }));
    assert.doesNotThrow(() => emitOrder("W4001", "refund", { amount: 10n, fn() {}, at: new Date("bad") }));
    await flush();
  } finally {
    bus.off(CHANNEL, raw); off1(); off2(); off3();
    console.error = origErr;
  }
});

test("raw bus listeners: a sync throw does not starve later listeners; an async rejection is caught (no unhandledRejection)", async () => {
  const origErr = console.error; console.error = () => {};
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const rawSync = () => { throw new Error("raw first"); };
  const rawAsync = async () => { throw new Error("raw async"); };
  let after = 0, once = 0;
  bus.on(CHANNEL, rawSync);
  bus.on(CHANNEL, rawAsync);
  const off = subscribe(() => { after++; });
  bus.once("order_paid", () => { once++; });
  try {
    assert.doesNotThrow(() => emitOrder("W4100", "order_paid", {}));
    emitOrder("W4100", "order_paid", {});
    assert.equal(after, 2, "listener registered after a throwing raw listener still runs");
    assert.equal(once, 1, "once() listeners fire exactly once");
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled.length, 0);
  } finally {
    bus.off(CHANNEL, rawSync); bus.off(CHANNEL, rawAsync); off();
    process.off("unhandledRejection", onUnhandled);
    console.error = origErr;
  }
});

test("Arabic-Indic / Persian digit phones are masked too", async () => {
  const d = sanitizeData({ note: "رقمه ٠٥٥١٢٣٤٥٦٧ أو ۰۵۵۱۲۳۴۵۶۷ أو +٩٦٦٥٥١٢٣٤٥٦٧ والطلب W1789000000000", n: "٥٥١٢٣٤٥٦٧" });
  const ascii = JSON.stringify(d).replace(/[٠-٩۰-۹]/g, (c) => String(c.charCodeAt(0) & 0xf));
  assert.ok(!PHONE_DIGITS.test(ascii.replace("W1789000000000", "")), ascii);
  assert.match(d.note, /^رقمه \*\*\*567 أو \*\*\*567 أو \*\*\*567 والطلب W1789000000000$/);
  assert.equal(d.n, "***567");
});

test("missing / empty orderNo is rejected", () => {
  assert.equal(emitOrder("order_paid", { data: {} }), null);
  assert.equal(emitOrder("", "order_paid", {}), null);
  assert.equal(emitOrder("   ", "order_paid", {}), null);
});

test("sanitizeData strips phones in every format, address/location keys and secrets", () => {
  const nul = String.fromCharCode(0);
  const d = sanitizeData({
    phone: "0551234567",
    customerPhone: "+966551234567",
    address: { street: "شارع التحلية", lat: 21.5, lng: 39.1 },
    location: { lat: 21.5 },
    token: "abc", note: `اتصل على 0551234567 أو +966 55 123 4567 أو 00966551234567 أو 55-123-4567${nul}`,
    nested: { deep: [{ msg: "966551234567" }, 551234567, 966551234567] },
    driver: { name: "أحمد", mobile: "0501112222" },
    stage: "paid", amount: 125.5, attempt: 2, ok: true,
    pos_order_id: "12345", mf_payment_id: "07074521234567890",
  });
  const json = JSON.stringify(d);
  assert.ok(!PHONE_DIGITS.test(json.replace(/07074521234567890/, "")), json);
  assert.ok(!/شارع/.test(json));
  assert.equal(d.address, undefined);
  assert.equal(d.location, undefined);
  assert.equal(d.token, undefined);
  assert.equal(d.driver.mobile, undefined);
  assert.equal(d.driver.name, "أحمد");
  assert.equal(d.stage, "paid");
  assert.equal(d.amount, 125.5);
  assert.equal(d.attempt, 2);
  assert.equal(d.pos_order_id, "12345");
  assert.ok(!json.includes(nul));
  assert.match(d.note, /\*\*\*567/);
});

test("sanitizeData caps size and handles non-objects", () => {
  assert.deepEqual(sanitizeData(null), {});
  assert.deepEqual(sanitizeData("hi"), { value: "hi" });
  const big = sanitizeData({ list: Array.from({ length: 50 }, () => "x".repeat(400)) });
  assert.equal(big.truncated, true);
  const long = sanitizeData({ s: "y".repeat(5000) });
  assert.ok(long.s.length <= 500);
});

test("persistence subscriber: fire-and-forget insert with sanitized data, never 5\\d{8}", async () => {
  const pool = fakePool();
  await startEventStore(pool, { log: { error() {} } });
  try {
    assert.ok(pool.sql.some((s) => /CREATE TABLE IF NOT EXISTS shop_order_events/.test(s)));
    const phones = ["0551234567", "551234567", "966551234567", "+966551234567", "+966 55 123 4567", "05 5123 4567"];
    for (const p of phones) {
      const r = emitOrder("staff_call", {
        orderNo: "W5001", source: "orders_hub", actor: { id: 7, name: "منى", role: "operations" },
        summary: `مكالمة للعميل ${p}`,
        data: { outcome: "no_answer", phone: p, dialed: p, text: `رقمه ${p}`, customer: { name: "علي", phone_norm: p, address: "حي الروضة" } },
      });
      assert.ok(r);
    }
    assert.equal(pool.inserts.length, 0, "insert must not happen synchronously in caller tick");
    await flush();
    assert.equal(pool.inserts.length, phones.length);
    for (const params of pool.inserts) {
      const [orderNo, at, name, source, channel, ok, actorId, actorName, actorRole, summary, dataJson, auditId] = params;
      assert.equal(orderNo, "W5001");
      assert.equal(name, "staff_call");
      assert.equal(source, "orders_hub");
      assert.equal(channel, null);
      assert.equal(ok, null);
      assert.equal(actorId, 7);
      assert.equal(actorName, "منى");
      assert.equal(actorRole, "operations");
      assert.equal(auditId, null);
      assert.ok(!Number.isNaN(Date.parse(at)));
      assert.ok(!PHONE_DIGITS.test(dataJson), dataJson);
      assert.ok(!PHONE_DIGITS.test(summary), summary);
      assert.ok(!/الروضة/.test(dataJson));
      const data = JSON.parse(dataJson);
      assert.equal(data.outcome, "no_answer");
      assert.equal(data.customer.name, "علي");
    }
  } finally {
    stopEventStore();
  }
});

test("persistence failure never reaches the caller; store is idempotent; stop unsubscribes", async () => {
  const pool = fakePool({ failInsert: true });
  const errors = [];
  const log = { error: (m) => errors.push(m) };
  startEventStore(pool, { log });
  startEventStore(pool, { log }); // نداء تاني مابيضاعفش الاشتراك
  try {
    assert.doesNotThrow(() => emitOrder("W6001", "sla_alert", { code: "late_pos", level: "warn", notified: true }));
    await flush();
    assert.equal(pool.sql.filter((s) => /^INSERT INTO shop_order_events/.test(s)).length, 1);
    assert.equal(errors.filter((e) => /persist/.test(e)).length, 1);
    assert.ok(ev.eventStoreStats().failed >= 1);
  } finally {
    stopEventStore();
  }
  emitOrder("W6001", "sla_alert", {});
  await flush();
  assert.equal(pool.sql.filter((s) => /^INSERT INTO shop_order_events/.test(s)).length, 1);
});

test("non-integer actor ids go to data.actor_ref, not actor_id", async () => {
  const e = emitOrder("portal_ack", { orderNo: "W7001", actor: { id: "st_abc", name: "كاشير", role: "cashier" }, data: { by: "st_abc" } });
  assert.equal(e.actor.id, null);
  assert.equal(e.data.actor_ref, "st_abc");
  const e2 = emitOrder("portal_ack", { orderNo: "W7001", actor: { id: "12" } });
  assert.equal(e2.actor.id, 12);
});

test("table DDL snapshot: all IF NOT EXISTS, required columns and both indexes", () => {
  for (const s of EVENTS_DDL) assert.match(s, /^CREATE (TABLE|INDEX) IF NOT EXISTS /);
  const table = EVENTS_DDL[0];
  for (const col of ["id", "order_no", "at", "name", "source", "channel", "ok", "actor_id", "actor_name", "actor_role", "summary", "data", "audit_id"]) {
    assert.match(table, new RegExp(`\\n\\s*${col}\\s`), col);
  }
  assert.ok(EVENTS_DDL.some((s) => /ON shop_order_events\(order_no, at DESC\)/.test(s)));
  assert.ok(EVENTS_DDL.some((s) => /ON shop_order_events\(name, at DESC\)/.test(s)));
});

test("register() is safe without a pool and does not add routes", () => {
  const app = { get() { throw new Error("no routes"); }, post() { throw new Error("no routes"); } };
  let api;
  assert.doesNotThrow(() => { api = ev.register(app, {}); });
  assert.equal(typeof api.emitOrder, "function");
  assert.equal(api.bus, bus);
});
