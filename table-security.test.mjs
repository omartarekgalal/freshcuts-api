/* 🍽 QR الطاولات — مراجعة الأمان + القيمة (٥/١٠/٢٠٢٦).
   node --test table-security.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  cleanKey, newTableKey, keyMatches, verifyTableKey, tableBusy, tableCfg, cleanCustomerText,
  tableTrackLabel, tableLink, summarizeTables, callPushPayload, register, TABLE_DEFAULTS,
  geoVerdict, branchPoint, liveTables, tableGate, SESSION_RE,
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

/* ── السياج + الجلسات (قرارات عمر ٥/١٠) ───────────────────────────────────── */
const BR = { lat: 21.5881404, lng: 39.1521236 };
/* نقطة على بعد ~d متر شمال الفرع */
const north = (m) => ({ lat: BR.lat + m / 111195, lng: BR.lng });

test("السياج: داخل نصف القطر ينجح، بره يفشل، والدقة بتتحسب لحد ١٠٠ م بس", () => {
  const cfg = tableCfg({});
  assert.equal(cfg.geoEnabled, true);
  assert.equal(cfg.geoRadiusM, 150);
  const at = (m, accuracy) => geoVerdict({ ...north(m), accuracy }, cfg, BR);
  assert.equal(at(20, 10).ok, true);
  assert.equal(at(140, 0).ok, true);
  assert.equal(at(180, 0).ok, false);
  assert.equal(at(180, 0).error, "geo_far");
  assert.equal(at(180, 40).ok, true);          // 180 − 40 = 140 ≤ 150
  assert.equal(at(240, 5000).ok, true);        // الدقة متقصوصة على ١٠٠: 240 − 100 = 140
  assert.equal(at(300, 5000).ok, false);       // 300 − 100 = 200 > 150
  assert.equal(at(3000, 50).ok, false);
  const v = at(180, 0);
  assert.ok(Math.abs(v.distanceM - 180) <= 1, String(v.distanceM));
  assert.deepEqual(Object.keys(v).sort(), ["accuracyM", "distanceM", "error", "ok"]); // مفيش إحداثيات راجعة
});

test("السياج: من غير موقع = مرفوض، والمفتاح بتاع الطوارئ بيعدّي", () => {
  const cfg = tableCfg({});
  for (const g of [null, undefined, {}, { lat: "x", lng: 1 }, { lat: 0, lng: 0 }, { lat: 91, lng: 39 }, "21,39"]) {
    assert.equal(geoVerdict(g, cfg, BR).error, "geo_required", JSON.stringify(g));
  }
  const off = tableCfg({ tables: { geoEnabled: false } });
  assert.deepEqual(geoVerdict(null, off, BR), { ok: true, skipped: true, distanceM: null, accuracyM: null });
  assert.equal(geoVerdict(north(10), cfg, { lat: NaN, lng: NaN }).error, "geo_unconfigured");
  // نقطة من اللوحة بتغلب نقطة التوصيل
  const custom = tableCfg({ tables: { geoLat: 24.7, geoLng: 46.7 } });
  assert.deepEqual(branchPoint(custom), { lat: 24.7, lng: 46.7, source: "settings" });
  assert.equal(branchPoint(cfg).source, "delivery");
  assert.equal(tableCfg({ tables: { geoRadiusM: 5 } }).geoRadiusM, 150);
  assert.equal(tableCfg({ tables: { sessionIdleMin: 45 } }).sessionIdleMin, 45);
});

test("شريط الطاولات: جلسات + طلبات من بعد «فضيت» بس، والجاهز بيتعدّ", () => {
  const live = liveTables({
    sessions: [{ table_no: 3, sessions: 2, since: "2026-10-05T17:00:00Z", last_at: "2026-10-05T17:30:00Z" }],
    orders: [
      { order_no: "W1", table_no: 3, total: 50, created_at: "2026-10-05T17:10:00Z", pos_ready_at: "2026-10-05T17:25:00Z" },
      { order_no: "W2", table_no: 5, total: 80, created_at: "2026-10-05T16:00:00Z" },   // قبل «فضيت»
      { order_no: "W3", table_no: 6, total: 20.5, created_at: "2026-10-05T17:40:00Z" },
    ],
    freed: [{ table_no: 5, freed_at: "2026-10-05T16:30:00Z" }],
  });
  assert.deepEqual(live.map((t) => t.table), [3, 6]);
  assert.deepEqual([live[0].sessions, live[0].orders, live[0].ready, live[0].total], [2, 1, 1, 50]);
  assert.equal(live[0].since, "2026-10-05T17:00:00.000Z");
  assert.equal(live[1].sessions, 0); // طلب جاهز والطاولة فاضية: يفضل ظاهر (مفيش تحويل لاستلام)
});

/* ── المسارات (Hono حقيقي + بول وهمي) ────────────────────────────────────── */
const DEV = "dev_0123456789abcdef";
const DEV2 = "dev_fedcba9876543210";
function mkApp({ rows = [{ table_no: 7, key: KEY, active: true }], settings = {}, admin = true } = {}) {
  const calls = [];
  const pushes = [];
  const sessions = [];
  const state = { rows: rows.map((r) => ({ ...r })), settings, sessions };
  const endWhere = (pred, reason, by = null) => {
    let n = 0;
    for (const s of sessions) if (!s.ended && pred(s)) { s.ended = true; s.reason = reason; s.by = by; n++; }
    return { rowCount: n, rows: [] };
  };
  const pool = fakePool({
    "CREATE TABLE": () => ({ rows: [] }),
    "SELECT table_no, key, active FROM table_qr WHERE": ([n]) => ({ rows: state.rows.filter((r) => r.table_no === n) }),
    "SELECT table_no, key, active, rotated_at": () => ({ rows: state.rows }),
    "UPDATE table_qr SET key=": ([n, k]) => {
      const r = state.rows.find((x) => x.table_no === n);
      if (r) r.key = k;
      return { rowCount: r ? 1 : 0, rows: r ? [{ table_no: n }] : [] };
    },
    "UPDATE table_qr SET active=": ([n, a]) => {
      const r = state.rows.find((x) => x.table_no === n);
      if (r) r.active = a;
      return { rowCount: r ? 1 : 0, rows: r ? [{ table_no: n }] : [] };
    },
    "UPDATE table_qr SET freed_at": () => ({ rowCount: 1 }),
    "UPDATE table_sessions SET last_at=NOW()\n": ([n, dh]) => {
      const s = sessions.find((x) => x.table_no === n && x.dh === dh && !x.ended && !x.idle);
      return { rows: s ? [{ id: s.id }] : [] };
    },
    "INSERT INTO table_sessions": ([id, n, dh, viaKey]) => { sessions.push({ id, table_no: n, dh, viaKey, orders: 0 }); return { rows: [] }; },
    "FROM table_sessions s LEFT JOIN": ([id]) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) return { rows: [] };
      const q = state.rows.find((r) => r.table_no === s.table_no);
      return { rows: [{ table_no: s.table_no, device_hash: s.dh, via_key: s.viaKey, ended_at: s.ended ? new Date() : null, end_reason: s.reason || null, idle: !!s.idle, active: q ? q.active : null }] };
    },
    "SET last_at=NOW(), orders=orders+1": ([id]) => { const s = sessions.find((x) => x.id === id); if (s) s.orders++; return { rowCount: 1 }; },
    "end_reason=$2, ended_by=$3 WHERE id=$1": ([id, reason]) => endWhere((s) => s.id === id, reason),
    "end_reason='freed', ended_by=$2 WHERE table_no=$1": ([n, by]) => endWhere((s) => s.table_no === n, "freed", by),
    "end_reason='rotated' WHERE table_no=$1": ([n]) => endWhere((s) => s.table_no === n, "rotated"),
    "end_reason='rotated' WHERE ended_at IS NULL": () => endWhere(() => true, "rotated"),
    "end_reason='disabled' WHERE table_no=$1": ([n]) => endWhere((s) => s.table_no === n, "disabled"),
    "end_reason='idle'\n": () => endWhere((s) => !!s.idle, "idle"),
    "FROM table_sessions WHERE ended_at IS NULL GROUP BY": () => {
      const by = {};
      for (const s of sessions) if (!s.ended) by[s.table_no] = (by[s.table_no] || 0) + 1;
      return { rows: Object.entries(by).map(([t, n]) => ({ table_no: Number(t), sessions: n, since: "2026-10-05T17:00:00Z", last_at: "2026-10-05T17:00:00Z" })) };
    },
    "UPDATE table_calls SET done_at=NOW(), done_by=$2 WHERE table_no=$1": ([n]) => { for (const c of calls) if (c.n === n) c.done = true; return { rowCount: 1 }; },
    "SELECT id FROM table_calls": ([n, kind]) => ({ rows: calls.filter((c) => c.n === n && c.kind === kind && !c.done).slice(0, 1).map((c) => ({ id: c.id })) }),
    "INSERT INTO table_calls": ([n, kind]) => { calls.push({ id: calls.length + 1, n, kind }); return { rows: [{ id: calls.length }] }; },
    "SELECT id, table_no, kind, created_at FROM table_calls": () => ({ rows: calls.filter((c) => !c.done).map((c) => ({ id: c.id, table_no: c.n, kind: c.kind, created_at: "2026-10-05T17:00:00Z" })) }),
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
  const scan = async (dev = DEV, key = KEY, table = 7) => (await post("/api/tables/scan", { table, key, device: dev })).json();
  return { app, api, post, scan, calls, pushes, state, pool, sessions };
}
const IN = { ...north(30), accuracy: 15 };
const FAR = { ...north(2500), accuracy: 20 };
const PORTAL = { authorization: "Bearer portal:ok" };

test("مسار المسح: المفتاح الصح بس بيفتح جلسة — والرد مافيهوش المفتاح", async () => {
  const { post, scan, sessions } = mkApp();
  const r = await scan();
  assert.equal(r.ok, true);
  assert.match(r.session, SESSION_RE);
  assert.deepEqual({ ...r, session: "x" }, { ok: true, table: 7, session: "x", idleMin: 90, calls: true, geo: true, open: true });
  assert.equal(sessions.length, 1);
  assert.notEqual(sessions[0].dh, DEV); // الجهاز متخزن hash بس
  // نفس الجهاز يمسح تاني = نفس الجلسة، جهاز تاني = جلسة جديدة
  assert.equal((await scan()).session, r.session);
  assert.notEqual((await scan(DEV2)).session, r.session);
  assert.equal((await (await post("/api/tables/scan", { table: 7, device: DEV })).json()).ok, false);
  assert.equal((await (await post("/api/tables/scan", { table: 7, key: "WrongKey123", device: DEV })).json()).error, "table_invalid");
  assert.equal((await (await post("/api/tables/scan", { table: "7<script>", key: KEY, device: DEV })).json()).ok, false);
  assert.equal((await post("/api/tables/scan", { table: 7, key: KEY, device: "x" })).status, 400);
});

test("الجلسة: «الطاولة فضيت» بتقفل كل جلسات الطاولة، والمسح من جديد بيفتح جلسة جديدة", async () => {
  const { app, post, scan } = mkApp();
  const a = (await scan()).session, b = (await scan(DEV2)).session;
  const chk = async (session, device = DEV) => (await (await post("/api/tables/session", { session, device })).json());
  assert.equal((await chk(a)).ok, true);
  assert.equal((await chk(a, DEV2)).reason, "device");          // جلسة جهاز تاني مابتشتغلش
  assert.equal((await post("/api/tables/7/free", {})).status, 401); // البوابة بس
  const live1 = await (await app.request("/api/tables/live", { headers: PORTAL })).json();
  assert.equal(live1.tables[0].sessions, 2);
  const f = await (await post("/api/tables/7/free", {}, PORTAL)).json();
  assert.deepEqual(f, { ok: true, table: 7, ended: 2, served: 0 });
  assert.equal((await chk(a)).reason, "freed");
  assert.equal((await chk(b, DEV2)).ok, false);
  const fresh = (await scan()).session;
  assert.notEqual(fresh, a);
  assert.equal((await chk(fresh)).ok, true);
  const live2 = await (await app.request("/api/tables/live", { headers: PORTAL })).json();
  assert.equal(live2.tables[0].sessions, 1);
});

test("الجلسة: بتخلص لوحدها بعد sessionIdleMin، ومع تدوير المفتاح وإيقاف الطاولة", async () => {
  const { post, scan, sessions } = mkApp();
  const chk = async (session) => (await (await post("/api/tables/session", { session, device: DEV })).json());
  const a = (await scan()).session;
  sessions[0].idle = true;
  assert.equal((await chk(a)).reason, "idle");
  assert.equal(sessions[0].reason, "idle");
  const b = (await scan()).session;
  assert.notEqual(b, a);
  await post("/api/tables/admin/rotate", { table: 7 });
  assert.equal((await chk(b)).reason, "rotated");
  const { post: post2, scan: scan2 } = mkApp();
  const c = (await scan2()).session;
  await post2("/api/tables/admin/active", { table: 7, active: false });
  assert.equal((await (await post2("/api/tables/session", { session: c, device: DEV })).json()).ok, false);
});

test("tableGate (الدفع): جلسة + سياج، وفشل السياج بيقفل الجلسة", async () => {
  const { pool, scan, sessions } = mkApp();
  const cfg = tableCfg({});
  const s = (await scan()).session;
  assert.deepEqual(await tableGate(pool, { session: s, device: DEV, geo: { ...IN } }, cfg, { endOnFar: true }).then((g) => [g.ok, g.table]), [true, 7]);
  const none = await tableGate(pool, { session: s, device: DEV }, cfg, { endOnFar: true });
  assert.equal(none.error, "geo_required");
  assert.equal(sessions[0].ended, undefined); // الإذن مرفوض مابيقفلش الجلسة — يفعّل الموقع ويكمّل
  const far = await tableGate(pool, { session: s, device: DEV, geo: FAR }, cfg, { endOnFar: true });
  assert.equal(far.error, "geo_far");
  assert.equal(sessions[0].reason, "geofence");
  assert.equal((await tableGate(pool, { session: s, device: DEV, geo: IN }, cfg)).error, "table_invalid");
  // السياج مقفول من اللوحة (طوارئ) ⇒ الجلسة لوحدها كفاية
  const s2 = (await scan(DEV2)).session;
  const off = await tableGate(pool, { session: s2, device: DEV2 }, tableCfg({ tables: { geoEnabled: false } }));
  assert.equal(off.ok, true);
  assert.equal(off.geo.skipped, true);
  assert.equal((await tableGate(pool, { session: "AbCdEfGhIjKlMnOpQrStUv", device: DEV, geo: IN }, cfg)).reason, "unknown_session");
});

test("نداء الويتر: جلسة بمفتاح + موقع جوّه المطعم، تهدئة لكل طاولة+نوع، وإشعار للبوابة", async () => {
  const { post, scan, pushes, calls } = mkApp();
  const s = (await scan()).session;
  assert.equal((await post("/api/tables/call", { table: 7, key: KEY, kind: "waiter", geo: IN })).status, 403); // المفتاح لوحده مابقاش كفاية
  assert.equal((await (await post("/api/tables/call", { session: s, device: DEV, kind: "waiter" })).json()).error, "geo_required");
  assert.equal((await (await post("/api/tables/call", { session: s, device: DEV, kind: "waiter", geo: FAR })).json()).error, "geo_far");
  const r1 = await (await post("/api/tables/call", { session: s, device: DEV, kind: "waiter", geo: IN })).json();
  assert.equal(r1.ok, true);
  assert.equal((await (await post("/api/tables/call", { session: s, device: DEV, kind: "waiter", geo: IN })).json()).already, true);
  await post("/api/tables/call", { session: s, device: DEV, kind: "water", geo: IN });
  assert.equal(calls.length, 2);
  assert.equal(pushes.length, 2);
  // الوضع القديم (من غير مفتاح): الطلبات ممكن، النداء لأ
  const legacy = mkApp({ settings: { tables: { requireKey: false } } });
  const ls = (await (await legacy.post("/api/tables/scan", { table: 7, device: DEV })).json()).session;
  assert.equal((await legacy.post("/api/tables/call", { session: ls, device: DEV, geo: IN })).status, 403);
  // المطعم مقفول
  const closed = mkApp({ settings: { hours: { days: { sun: { closed: true }, mon: { closed: true }, tue: { closed: true }, wed: { closed: true }, thu: { closed: true }, fri: { closed: true }, sat: { closed: true } } } } });
  assert.equal((await closed.post("/api/tables/call", { session: s, device: DEV, geo: IN })).status, 409);
  const off = mkApp({ settings: { tables: { callsEnabled: false } } });
  assert.equal((await off.post("/api/tables/call", { session: s, device: DEV, geo: IN })).status, 403);
});

test("نداء الويتر: حد لكل IP (ضد الإغراق)", async () => {
  const { post } = mkApp();
  let last;
  for (let i = 0; i < 14; i++) last = await post("/api/tables/call", { session: "x", kind: "napkins" }, { "cf-connecting-ip": "9.9.9.9" });
  assert.equal(last.status, 429);
});

test("البوابة: النداءات وشريط الطاولات للبوابة بس، و«فضيت» بتقفل نداءات الطاولة", async () => {
  const { app, post, scan } = mkApp();
  assert.equal((await app.request("/api/tables/calls")).status, 401);
  assert.equal((await app.request("/api/tables/live")).status, 401);
  assert.equal((await app.request("/api/tables/calls", { headers: PORTAL })).status, 200);
  assert.equal((await app.request("/api/tables/calls/abc/done", { method: "POST", headers: PORTAL })).status, 400);
  const s = (await scan()).session;
  await post("/api/tables/call", { session: s, device: DEV, kind: "water", geo: IN });
  assert.equal((await (await app.request("/api/tables/live", { headers: PORTAL })).json()).calls.length, 1);
  await post("/api/tables/7/free", {}, PORTAL);
  assert.equal((await (await app.request("/api/tables/live", { headers: PORTAL })).json()).calls.length, 0);
  assert.equal((await post("/api/tables/abc/free", {}, PORTAL)).status, 400);
});

test("اللوحة: التدوير بيبطّل المفتاح القديم فوراً، والمسارات محمية", async () => {
  const { post, app, state, scan } = mkApp();
  const r = await (await post("/api/tables/admin/rotate", { table: 7 })).json();
  assert.equal(r.ok, true);
  assert.notEqual(state.rows[0].key, KEY);
  assert.equal((await scan()).ok, false);
  assert.equal((await scan(DEV, state.rows[0].key)).ok, true);
  assert.equal(r.tables[0].link, `https://freshcuts.sa/l/table-7?tk=${state.rows[0].key}`);
  const locked = mkApp({ admin: false });
  assert.equal((await locked.app.request("/api/tables/admin")).status, 401);
  assert.equal((await locked.post("/api/tables/admin/rotate", { table: 7 })).status, 401);
  const adm = await (await app.request("/api/tables/admin")).json();
  assert.equal(adm.branch.source, "delivery");
  assert.ok(Number.isFinite(adm.branch.lat));
});

test("اللوحة: الإعدادات بترفض الأرقام برّه الحدود بدل ما تصحّحها بالسكات", async () => {
  const { post, state } = mkApp();
  assert.equal((await post("/api/tables/admin/config", { maxOpenPerTable: 0 })).status, 400);
  assert.equal((await post("/api/tables/admin/config", { count: 50, maxNo: 20 })).status, 400);
  assert.equal((await post("/api/tables/admin/config", { geoRadiusM: 10 })).status, 400);
  assert.equal((await post("/api/tables/admin/config", { sessionIdleMin: 1000 })).status, 400);
  assert.equal((await post("/api/tables/admin/config", { geoLat: 21.5 })).status, 400); // نقطة ناقصة
  const ok = await (await post("/api/tables/admin/config", { count: 10, requireKey: true, maxOpenPerTable: 4, geoEnabled: false, geoRadiusM: 200, sessionIdleMin: 60 })).json();
  assert.equal(ok.ok, true);
  assert.equal(state.settings.tables.count, 10);
  assert.equal(state.settings.tables.maxOpenPerTable, 4);
  assert.equal(state.settings.tables.geoEnabled, false);
  assert.equal(state.settings.tables.geoRadiusM, 200);
  assert.equal(state.settings.tables.sessionIdleMin, 60);
  const pt = await (await post("/api/tables/admin/config", { geoLat: 21.58, geoLng: 39.15 })).json();
  assert.deepEqual([pt.config.geoLat, pt.config.geoLng], [21.58, 39.15]);
  const clr = await (await post("/api/tables/admin/config", { geoLat: null, geoLng: null })).json();
  assert.deepEqual([clr.config.geoLat, clr.config.geoLng], [null, null]);
});
