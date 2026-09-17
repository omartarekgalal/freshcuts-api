/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات رحلة العميل (journey.js) — أوفلاين بداتابيز مزيّفة

     node --test journey.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

const realSI = globalThis.setInterval, realST = globalThis.setTimeout;
globalThis.setInterval = (...a) => { const t = realSI(...a); t?.unref?.(); return t; };
globalThis.setTimeout = (...a) => { const t = realST(...a); t?.unref?.(); return t; };

const { Hono } = await import("hono");
const J = await import("./journey.js");
const { sectionOf } = await import("./cms.js");

test("stepOf: الخطوات والمتصفح مايقدرش يعلن الدفع", () => {
  assert.equal(J.stepOf("session_start"), 0);
  assert.equal(J.stepOf("picker_open"), 1);
  assert.equal(J.stepOf("item_add"), 2);
  assert.equal(J.stepOf("checkout_view"), 3);
  assert.equal(J.stepOf("address_set", { deliverable: true }), 4);
  assert.equal(J.stepOf("address_set", { deliverable: false }), 3);
  assert.equal(J.stepOf("otp_verified"), 5);
  assert.equal(J.stepOf("payment_sheet_open"), 6);
  assert.equal(J.stepOf("order_paid", {}, "web"), null);
  assert.equal(J.stepOf("order_paid", {}, "server"), 7);
  assert.equal(J.stepOf("checkout_result", { ok: false }, "server"), null);
  assert.equal(J.stepOf("checkout_result", { ok: true }, "server"), 6);
});

test("sanitizeProps: مفيش جوال ولا اسم ولا إحداثيات", () => {
  const p = J.sanitizeProps({
    phone: "0551234567", name: "محمد", lat: 21.5, lng: 39.1, address: "x", token: "abc",
    reason: "wrong_code for 0551234567", km: 7.456, deliverable: false, nested: { a: 1 },
    note: "+966551234567",
  });
  assert.equal(p.phone, undefined);
  assert.equal(p.name, undefined);
  assert.equal(p.lat, undefined);
  assert.equal(p.token, undefined);
  assert.equal(p.nested, undefined);
  assert.equal(p.note, undefined);
  assert.match(p.reason, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(p), /5\d{8}/);
  assert.equal(p.km, 7.46);
  assert.equal(p.deliverable, false);
});

test("classifyChannel", () => {
  assert.equal(J.classifyChannel({ utm_source: "meta", utm_medium: "paid", click_ids: ["fbclid"] }), "meta_ads");
  assert.equal(J.classifyChannel({ utm_source: "fb", utm_medium: "paid" }), "meta_ads");
  assert.equal(J.classifyChannel({ utm_source: "qa", utm_medium: "qa" }), "qa");
  assert.equal(J.classifyChannel({ utm_source: "cro-audit", utm_medium: "internal" }), "qa");
  assert.equal(J.classifyChannel({ utm_source: "instagram", utm_medium: "bio" }), "instagram");
  assert.equal(J.classifyChannel({ utm_source: "qr", utm_medium: "offline" }), "qr");
  assert.equal(J.classifyChannel({ utm_source: "google", utm_medium: "cpc" }), "google_ads");
  assert.equal(J.classifyChannel({ referrer_host: "www.google.com" }), "google");
  assert.equal(J.classifyChannel({ utm_source: "direct", utm_medium: "offer-link" }), "offer_link");
  assert.equal(J.classifyChannel({ utm_source: "sms", utm_medium: "sms" }), "sms");
  assert.equal(J.classifyChannel({ in_app: "instagram" }), "instagram");
  assert.equal(J.classifyChannel({ click_ids: ["fbclid"], in_app: "facebook" }), "facebook");
  assert.equal(J.classifyChannel({}), "direct");
});

test("device / in-app من الـUA", () => {
  const ig = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 339.0.0";
  const fb = "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0]";
  assert.equal(J.deviceOf(ig), "iphone");
  assert.equal(J.inAppOf(ig), "instagram");
  assert.equal(J.deviceOf(fb), "android");
  assert.equal(J.inAppOf(fb), "facebook");
  assert.equal(J.inAppOf("Mozilla/5.0 (iPhone) Safari/604.1"), null);
});

test("parseBatch: أسماء مجهولة بتترفض والمعرّفات لازم تكون سليمة", () => {
  const now = Date.now();
  assert.equal(J.parseBatch("{bad").error, "bad_payload");
  assert.equal(J.parseBatch({ sessionId: "x", anonId: "d1" }).error, "bad_ids");
  const p = J.parseBatch(JSON.stringify({
    sessionId: "sabc12345xyz", anonId: "dlk3abc",
    session: { utm_source: "meta", landing_path: "/?utm_source=meta&fbclid=zzz", click_ids: ["fbclid"] },
    events: [
      { n: "session_start", t: now, seq: 1, path: "/?a=1" },
      { n: "hack_event", t: now, seq: 2 },
      { n: "item_add", t: now, seq: 3, p: { item_id: "12", cart_subtotal: 96, phone: "0551234567" } },
    ],
  }), { now });
  assert.equal(p.events.length, 2);
  assert.equal(p.rejected.unknown, 1);
  assert.equal(p.session.landing_path, "/");
  assert.equal(p.events[0].path, "/");
  assert.equal(p.events[1].step, 2);
  assert.equal(p.events[1].props.phone, undefined);
});

test("buildFunnel + leaksFrom: أكبر ٣ فجوات بالعربي", () => {
  const f = J.buildFunnel([100, 20, 10, 8, 4, 3, 2, 1]);
  assert.equal(f[1].lost, 80);
  assert.equal(Math.round(f[1].dropPct * 100), 80);
  const leaks = J.leaksFrom(f, { closedShare: 0.6, inAppShare: 0.8, reasons: { 3: [{ label: "العنوان خارج نطاق التوصيل", n: 3 }] }, outOfZone: 3, avgKm: 14 });
  assert.equal(leaks.length, 3);
  assert.equal(leaks[0].fromStep, 0);
  assert.match(leaks[0].why, /مقفول/);
  const addr = leaks.find((l) => l.fromStep === 3);
  assert.ok(addr, "فجوة العنوان ضمن الأكبر");
  assert.match(addr.why, /خارج نطاق/);
  assert.deepEqual(J.leaksFrom(J.buildFunnel([0, 0, 0, 0, 0, 0, 0, 0])), []);
});

test("maskPhone / adMatches / rangeOf", () => {
  assert.equal(J.maskPhone("0551234567"), "5••••••67");
  assert.equal(J.maskPhone(null), null);
  assert.ok(J.adMatches("KILO-A", "96-m2-kilo-a"));
  assert.ok(J.adMatches("BOX-B", "96-m2-box-b"));
  assert.ok(!J.adMatches("BOX-A", "96-m2-box-b"));
  const now = new Date("2026-09-17T00:30:00Z"); // ٣:٣٠ الفجر الرياض = لسه يوم ١٦
  assert.equal(J.bizDayOf(now), "2026-09-16");
  assert.deepEqual(J.rangeOf("7d", now), { key: "7d", from: "2026-09-10", to: "2026-09-16", days: 7 });
  assert.equal(J.rangeOf("yesterday", now).from, "2026-09-15");
});

test("الصلاحيات: /api/journey → التحليلات", () => {
  assert.equal(sectionOf("/api/journey/report"), "analytics");
  assert.equal(sectionOf("/api/journey/sessions/sabc"), "analytics");
});

/* ── المسارات بداتابيز مزيّفة ── */
function fakePool() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/INSERT INTO journey_events/.test(sql)) {
        const rows = [];
        for (let i = 0; i < params.length; i += 8) {
          rows.push({ name: params[i + 2], step: params[i + 3], props: JSON.parse(params[i + 6]), order_no: params[i + 7] });
        }
        return { rows, rowCount: rows.length };
      }
      if (/FROM acct_sessions/.test(sql)) return { rows: [{ phone_norm: "551234567" }], rowCount: 1 };
      if (/UPDATE journey_sessions SET phone_norm/.test(sql)) return { rows: [{ anon_id: "dlk3abc" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}
async function mkApp() {
  const pool = fakePool();
  const app = new Hono();
  const api = J.register(app, {
    pool, jb: (v) => JSON.stringify(v), normPhone: (p) => String(p || "").replace(/\D/g, "").replace(/^(966|0)/, ""),
    getSettingsData: async () => ({ delivery: { alertPhones: ["0559999999"] }, hours: null }),
    requireAdmin: async (c) => (c.req.header("Authorization") === "Bearer admin" ? null : c.json({ error: "Unauthorized" }, 401)),
  });
  await new Promise((r) => realST(r, 20)); // ensureSchema
  return { app, pool, api };
}

test("POST /batch: QA بيتعلّم، والجوال مابيتخزنش", async () => {
  const { app, pool } = await mkApp();
  const body = JSON.stringify({
    sessionId: "sqa1234567890", anonId: "dqa123", session: { utm_source: "qa", utm_medium: "qa", landing_path: "/" },
    events: [{ n: "session_start", t: Date.now(), seq: 1 }, { n: "otp_failed", t: Date.now(), seq: 2, p: { reason: "wrong_code", phone: "0551234567" } }],
  });
  const r = await app.request("/api/journey/batch", { method: "POST", body, headers: { "content-type": "text/plain", "user-agent": "Mozilla/5.0 (iPhone) Safari" } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.accepted, 2);
  const ins = pool.calls.find((c) => /INSERT INTO journey_sessions/.test(c.sql));
  assert.equal(ins.params[20], true, "is_qa");
  assert.equal(ins.params[14], "qa");
  const ev = pool.calls.find((c) => /INSERT INTO journey_events/.test(c.sql));
  assert.doesNotMatch(JSON.stringify(ev.params), /551234567/);
});

test("POST /batch: جسم غلط = 200 مع ok:false (Cloudflare بيبلع الـ5xx)", async () => {
  const { app } = await mkApp();
  const r = await app.request("/api/journey/batch", { method: "POST", body: "nope" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, false);
});

test("POST /identify: الربط بالتوكن، ورقم الإدارة = موظف", async () => {
  const { app, pool } = await mkApp();
  const tok = "a".repeat(48);
  const r = await app.request("/api/journey/identify", {
    method: "POST", body: JSON.stringify({ sessionId: "sqa1234567890" }), headers: { Authorization: `Bearer cust:${tok}` },
  });
  assert.equal((await r.json()).ok, true);
  const up = pool.calls.find((c) => /UPDATE journey_sessions SET phone_norm/.test(c.sql));
  assert.equal(up.params[1], "551234567");
  assert.equal(up.params[2], false);
  const noTok = await app.request("/api/journey/identify", { method: "POST", body: JSON.stringify({ sessionId: "sqa1234567890" }) });
  assert.equal((await noTok.json()).ok, false);
});

test("emit(checkout_result) بيربط الطلب بالجلسة", async () => {
  const { api, pool } = await mkApp();
  await api.emit("checkout_result", { ok: true, order_no: "W1789635876034", total: 96, journey_sid: "sqa1234567890", client: "web" });
  const up = pool.calls.find((c) => /UPDATE shop_orders SET journey_sid/.test(c.sql));
  assert.deepEqual(up.params, ["W1789635876034", "sqa1234567890"]);
  const before = pool.calls.length;
  await api.emit("checkout_result", { ok: true, journey_sid: "bad sid" });
  assert.equal(pool.calls.length, before);
});

test("التقرير محمي", async () => {
  const { app } = await mkApp();
  const r = await app.request("/api/journey/report?range=today");
  assert.equal(r.status, 401);
});
