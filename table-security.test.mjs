/* 🍽 QR الطاولات — مراجعة الأمان + القيمة (٥/١٠/٢٠٢٦).
   node --test table-security.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  cleanKey, newTableKey, keyMatches, verifyTableKey, tableBusy, tableCfg, cleanCustomerText,
  tableTrackLabel, tableLink, summarizeTables, callPushPayload, register, TABLE_DEFAULTS,
} from "./table-order.js";
import { safeTip, posNotesOf } from "./shop.js";
import { SERVER_OWNED_PATHS, mergeForPut } from "./settings-guard.js";

const KEY = "Ab3_dE-9xYz";

/* بول وهمي: كل استعلام بيتطابق بنص فيه */
function fakePool(handlers = {}) {
  const log = [];
  return {
    log,
    async query(sql, params = []) {
      log.push({ sql, params });
      for (const [needle, fn] of Object.entries(handlers)) {
        if (sql.includes(needle)) return fn(params, sql);
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test("المفتاح: ١١ حرف base64url عشوائي، والتنضيف بيرفض أي شكل تاني", () => {
  const a = newTableKey(), b = newTableKey();
  assert.match(a, /^[A-Za-z0-9_-]{11}$/);
  assert.notEqual(a, b);
  assert.equal(cleanKey(` ${KEY} `), KEY);
  for (const bad of ["", "short", "a".repeat(33), "abc def ghi", "<script>xx", "١٢٣٤٥٦٧٨٩", null, 12345678, {}, ["x"]]) {
    assert.equal(cleanKey(bad), null, JSON.stringify(bad));
  }
});

test("keyMatches: مطابقة كاملة بس، والطاولة الموقوفة مابتقبلش حتى بالمفتاح الصح", () => {
  const row = { table_no: 7, key: KEY, active: true };
  assert.equal(keyMatches(row, KEY), true);
  assert.equal(keyMatches(row, KEY.slice(0, -1) + "Q"), false);
  assert.equal(keyMatches(row, KEY + "x"), false);
  assert.equal(keyMatches({ ...row, active: false }, KEY), false);
  assert.equal(keyMatches(null, KEY), false);
  assert.equal(keyMatches(row, undefined), false);
});

test("verifyTableKey: من غير مفتاح = مرفوض (spoofing ?t=7 من البيت)، ووضع قديم بيتقفل من الإعدادات بس", async () => {
  const cfg = tableCfg({});
  const pool = fakePool({ "FROM table_qr": ([n]) => ({ rows: n === 7 ? [{ table_no: 7, key: KEY, active: true }] : n === 8 ? [{ table_no: 8, key: KEY, active: false }] : [] }) });
  assert.deepEqual(await verifyTableKey(pool, 7, KEY, cfg), { ok: true, reason: "key" });
  assert.equal((await verifyTableKey(pool, 7, undefined, cfg)).reason, "no_key");
  assert.equal((await verifyTableKey(pool, 7, "WrongKey123", cfg)).reason, "bad_key");
  assert.equal((await verifyTableKey(pool, 8, KEY, cfg)).reason, "inactive");
  assert.equal((await verifyTableKey(pool, 9, KEY, cfg)).reason, "unknown_table");
  assert.equal((await verifyTableKey(pool, null, KEY, cfg)).ok, false);
  assert.equal((await verifyTableKey(pool, 7, KEY, { ...cfg, enabled: false })).reason, "disabled");
  // الوضع القديم (رقم من غير مفتاح) لازم يتقفل صراحة من اللوحة
  assert.equal(TABLE_DEFAULTS.requireKey, true);
  assert.equal((await verifyTableKey(pool, 7, undefined, tableCfg({ tables: { requireKey: false } }))).ok, true);
  // عطل داتابيز = مش طلب طاولة (fail closed)
  const broken = { query: async () => { throw new Error("relation table_qr does not exist"); } };
  assert.deepEqual(await verifyTableKey(broken, 7, KEY, cfg), { ok: false, reason: "db_error" });
});

test("tableBusy: الحد الأقصى للطلبات المدفوعة على نفس الطاولة، والعمود الناقص مايوقفش الطلبات", async () => {
  const cfg = tableCfg({ tables: { maxOpenPerTable: 3, openWindowMin: 60 } });
  const at = (n) => fakePool({ "FROM shop_orders": () => ({ rows: [{ n }] }) });
  assert.equal(await tableBusy(at(2), 7, cfg), false);
  assert.equal(await tableBusy(at(3), 7, cfg), true);
  const p = at(0); await tableBusy(p, 7, cfg);
  assert.deepEqual(p.log[0].params, [7, 60]);
  assert.match(p.log[0].sql, /pending_payment/); // اللي مادفعش مابيتعدّش (ماحدش يقفل طاولة بطلبات مش مدفوعة)
  assert.equal(await tableBusy({ query: async () => { throw new Error("no column"); } }, 7, cfg), false);
});

test("tableCfg: حدود الأرقام والافتراضي", () => {
  const d = tableCfg({});
  assert.equal(d.maxOpenPerTable, 5);
  assert.equal(d.openWindowMin, 90);
  assert.equal(d.callsEnabled, true);
  assert.equal(tableCfg({ tables: { maxOpenPerTable: 0, openWindowMin: 5 } }).maxOpenPerTable, 5);
  assert.equal(tableCfg({ tables: { openWindowMin: 5 } }).openWindowMin, 90);
});

test("cleanCustomerText: اتجاه النص/حروف التحكم/سطور جديدة/🍽 مزوّر — مابيوصلوش نقطة البيع والمطبخ", () => {
  assert.equal(cleanCustomerText("بدون‮بصل"), "بدونبصل");
  assert.equal(cleanCustomerText("a⁦b⁩c‏d﻿"), "abcd");
  assert.equal(cleanCustomerText("سطر\nسطر\r\nتالت\t!"), "سطر سطر تالت !");
  assert.equal(cleanCustomerText("🍽 طاولة 3 — يتقدّم على الطاولة"), "طاولة 3 — يتقدّم على الطاولة");
  assert.equal(cleanCustomerText("🍽️🍽 x"), "x");
  assert.equal(Array.from(cleanCustomerText("😀".repeat(500), 200)).length, 200);
  assert.equal(cleanCustomerText(null), "");
  assert.equal(cleanCustomerText({ a: 1 }), "[object Object]");
  // الملاحظة المزوّرة مابقتش أول سطر في نقطة البيع
  const notes = posNotesOf({ order_no: "W1", option: "pickup", created_at: "2026-10-05T17:00:00Z", notes: cleanCustomerText("🍽 طاولة 3") });
  assert.ok(notes.startsWith("استلام"), notes);
});

test("safeTip: سالب/نص/لانهائي = صفر، والسقف ١٠٠٠", () => {
  assert.equal(safeTip(-50), 0);
  assert.equal(safeTip("abc"), 0);
  assert.equal(safeTip(Infinity), 0);
  assert.equal(safeTip(undefined), 0);
  assert.equal(safeTip("7.555"), 7.56);
  assert.equal(safeTip(99999), 1000);
});

test("التتبع: طلب الطاولة بيقول «جاي لطاولتك» مش «جاهز للاستلام من الفرع»", () => {
  const r = { option: "pickup", table_no: 4, status: "pos_created" };
  assert.match(tableTrackLabel(r).label, /طاولة 4/);
  assert.match(tableTrackLabel(r, { ready: true }).label, /جاي لطاولتك/);
  assert.equal(tableTrackLabel({ ...r, status: "delivered" }).step, 5);
  assert.equal(tableTrackLabel({ ...r, table_no: null }), null);
  assert.equal(tableTrackLabel({ ...r, option: "delivery" }), null);
  assert.equal(tableTrackLabel({ ...r, status: "pending_payment" }), null);
});

test("رابط الـQR: /l/table-N?tk=المفتاح على دوميننا بس", () => {
  assert.equal(tableLink("https://freshcuts.sa/", 7, KEY), `https://freshcuts.sa/l/table-7?tk=${KEY}`);
  assert.equal(tableLink(undefined, 1, "a+b/c"), "https://freshcuts.sa/l/table-1?tk=a%2Bb%2Fc");
});

test("التحليلات: مسح ← طلب ← إيراد لكل طاولة + ساعات الذروة + الأصناف + زمن الرد على النداء", () => {
  const s = summarizeTables({
    count: 3,
    scans: [{ table_no: 1, scans: 10 }, { table_no: 2, scans: 4 }],
    orders: [
      { table_no: 1, total: 100, hour: 19, items: [{ name: "برجر", quantity: 2 }] },
      { table_no: 1, total: 50, hour: 19, items: [{ name: "برجر", quantity: 1 }, { name: "بيبسي", quantity: 1 }] },
      { table_no: 2, total: 80, hour: 23, items: [] },
    ],
    calls: [{ table_no: 1, created_at: "2026-10-05T17:00:00Z", done_at: "2026-10-05T17:01:30Z" }, { table_no: 3, created_at: "2026-10-05T17:00:00Z" }],
  });
  const t1 = s.tables.find((t) => t.table === 1);
  assert.deepEqual([t1.orders, t1.revenue, t1.aov, t1.conversion, t1.calls, t1.avgResponseSec], [2, 150, 75, 20, 1, 90]);
  assert.equal(s.tables.find((t) => t.table === 3).conversion, null);
  assert.deepEqual(s.topItems[0], { name: "برجر", qty: 3 });
  assert.deepEqual(s.hours.map((h) => h.hour), [19, 23]);
  assert.equal(s.totals.orders, 3);
  assert.equal(s.totals.conversion, 21.4);
});

test("إشعار نداء الويتر: tag لكل طاولة (مايتكررش) ونوع مجهول = الويتر", () => {
  const p = callPushPayload(5, "water", "https://x/portal/");
  assert.equal(p.tag, "table-call-5");
  assert.match(p.title, /طاولة 5/);
  assert.match(callPushPayload(5, "<img>").title, /الويتر/);
});

test("settings.tables ملك مساره: الـPUT الكامل من شاشة قديمة مايرجّعش إعدادات قديمة", () => {
  assert.ok(SERVER_OWNED_PATHS.includes("tables"));
  const merged = mergeForPut({ tables: { requireKey: true } }, { tables: { requireKey: false }, other: 1 });
  assert.deepEqual(merged.tables, { requireKey: true });
});

/* ── المسارات (Hono حقيقي + بول وهمي) ────────────────────────────────────── */
function mkApp({ rows = [{ table_no: 7, key: KEY, active: true }], settings = {}, admin = true } = {}) {
  const calls = [];
  const pushes = [];
  const state = { rows: rows.map((r) => ({ ...r })), settings };
  const pool = fakePool({
    "CREATE TABLE": () => ({ rows: [] }),
    "SELECT table_no, key, active FROM table_qr WHERE": ([n]) => ({ rows: state.rows.filter((r) => r.table_no === n) }),
    "SELECT table_no, key, active, rotated_at": () => ({ rows: state.rows }),
    "UPDATE table_qr SET key=": ([n, k]) => {
      const r = state.rows.find((x) => x.table_no === n);
      if (r) r.key = k;
      return { rowCount: r ? 1 : 0, rows: r ? [{ table_no: n }] : [] };
    },
    "SELECT id FROM table_calls": ([n, kind]) => ({ rows: calls.filter((c) => c.n === n && c.kind === kind && !c.done).slice(0, 1).map((c) => ({ id: c.id })) }),
    "INSERT INTO table_calls": ([n, kind]) => { calls.push({ id: calls.length + 1, n, kind }); return { rows: [{ id: calls.length }] }; },
    "INSERT INTO table_scans": () => ({ rows: [] }),
    "UPDATE settings SET data": ([json]) => { state.settings = { ...state.settings, tables: JSON.parse(json) }; return { rowCount: 1 }; },
  });
  const app = new Hono();
  const api = register(app, {
    pool,
    requireAdmin: async (c) => (admin ? null : c.json({ error: "Unauthorized" }, 401)),
    getSettingsData: async () => state.settings,
  }, {
    portal: () => ({
      requirePortal: async (c) => (c.req.header("authorization") === "Bearer portal:ok" ? { user: { name: "كاشير" } } : { res: c.json({ ok: false }, 401) }),
      push: { sendToSubs: async (p) => { pushes.push(p); return { sent: 1 }; } },
    }),
  });
  const post = (path, body, headers = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { app, api, post, calls, pushes, state, pool };
}

test("مسار المسح: المفتاح الصح بس بيفتح وضع الطاولة", async () => {
  const { post } = mkApp();
  assert.deepEqual(await (await post("/api/tables/scan", { table: 7, key: KEY })).json(), { ok: true, table: 7, calls: true, open: true });
  assert.equal((await (await post("/api/tables/scan", { table: 7 })).json()).ok, false);
  assert.equal((await (await post("/api/tables/scan", { table: 7, key: "WrongKey123" })).json()).error, "table_invalid");
  assert.equal((await (await post("/api/tables/scan", { table: "7<script>", key: KEY })).json()).ok, false);
});

test("نداء الويتر: مفتاح إجباري، تهدئة لكل طاولة+نوع، وإشعار للبوابة", async () => {
  const { post, pushes, calls } = mkApp();
  assert.equal((await post("/api/tables/call", { table: 7, kind: "waiter" })).status, 403);
  const r1 = await (await post("/api/tables/call", { table: 7, key: KEY, kind: "waiter" })).json();
  assert.equal(r1.ok, true);
  const r2 = await (await post("/api/tables/call", { table: 7, key: KEY, kind: "waiter" })).json();
  assert.equal(r2.already, true);
  await post("/api/tables/call", { table: 7, key: KEY, kind: "water" });
  assert.equal(calls.length, 2);
  assert.equal(pushes.length, 2);
  // حتى لو الطلبات شغّالة من غير مفتاح (وضع قديم)، النداء دايماً بمفتاح
  const legacy = mkApp({ settings: { tables: { requireKey: false } } });
  assert.equal((await legacy.post("/api/tables/call", { table: 7 })).status, 403);
  // المطعم مقفول
  const closed = mkApp({ settings: { hours: { days: { sun: { closed: true }, mon: { closed: true }, tue: { closed: true }, wed: { closed: true }, thu: { closed: true }, fri: { closed: true }, sat: { closed: true } } } } });
  assert.equal((await closed.post("/api/tables/call", { table: 7, key: KEY })).status, 409);
  // مقفول من الإعدادات
  const off = mkApp({ settings: { tables: { callsEnabled: false } } });
  assert.equal((await off.post("/api/tables/call", { table: 7, key: KEY })).status, 403);
});

test("نداء الويتر: حد لكل IP (ضد الإغراق)", async () => {
  const { post } = mkApp();
  let last;
  for (let i = 0; i < 14; i++) last = await post("/api/tables/call", { table: 7, key: KEY, kind: "napkins" }, { "cf-connecting-ip": "9.9.9.9" });
  assert.equal(last.status, 429);
});

test("البوابة: النداءات للبوابة بس", async () => {
  const { app } = mkApp();
  assert.equal((await app.request("/api/tables/calls")).status, 401);
  assert.equal((await app.request("/api/tables/calls", { headers: { authorization: "Bearer portal:ok" } })).status, 200);
  assert.equal((await app.request("/api/tables/calls/abc/done", { method: "POST", headers: { authorization: "Bearer portal:ok" } })).status, 400);
});

test("اللوحة: التدوير بيبطّل المفتاح القديم فوراً، والمسارات محمية", async () => {
  const { post, app, state } = mkApp();
  const r = await (await post("/api/tables/admin/rotate", { table: 7 })).json();
  assert.equal(r.ok, true);
  assert.notEqual(state.rows[0].key, KEY);
  assert.equal((await (await post("/api/tables/scan", { table: 7, key: KEY })).json()).ok, false);
  assert.equal((await (await post("/api/tables/scan", { table: 7, key: state.rows[0].key })).json()).ok, true);
  assert.equal(r.tables[0].link, `https://freshcuts.sa/l/table-7?tk=${state.rows[0].key}`);
  const locked = mkApp({ admin: false });
  assert.equal((await locked.app.request("/api/tables/admin")).status, 401);
  assert.equal((await locked.post("/api/tables/admin/rotate", { table: 7 })).status, 401);
  assert.equal((await app.request("/api/tables/admin")).status, 200);
});

test("اللوحة: الإعدادات بترفض الأرقام برّه الحدود بدل ما تصحّحها بالسكات", async () => {
  const { post, state } = mkApp();
  assert.equal((await post("/api/tables/admin/config", { maxOpenPerTable: 0 })).status, 400);
  assert.equal((await post("/api/tables/admin/config", { count: 50, maxNo: 20 })).status, 400);
  const ok = await (await post("/api/tables/admin/config", { count: 10, requireKey: true, maxOpenPerTable: 4 })).json();
  assert.equal(ok.ok, true);
  assert.equal(state.settings.tables.count, 10);
  assert.equal(state.settings.tables.maxOpenPerTable, 4);
});
