/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات Clarity (clarity.js) — أوفلاين، بداتابيز وfetch مزيّفين

     node --test clarity.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

const realSI = globalThis.setInterval, realST = globalThis.setTimeout;
globalThis.setInterval = (...a) => { const t = realSI(...a); t?.unref?.(); return t; };
globalThis.setTimeout = (...a) => { const t = realST(...a); t?.unref?.(); return t; };

const { Hono } = await import("hono");
const C = await import("./clarity.js");

// شكل رد Clarity الموثّق: مصفوفة مقاييس، كل واحد فيه information[] بقيم التقسيمات
const SAMPLE = [
  { metricName: "Traffic", information: [
    { totalSessionCount: "120", totalBotSessionCount: "4", distinctUserCount: "100", PagesPerSessionPercentage: 2.4, URL: "https://freshcuts.sa/" },
    { totalSessionCount: "40", totalBotSessionCount: "0", distinctUserCount: "38", PagesPerSessionPercentage: 1.2, URL: "https://freshcuts.sa/checkout" },
    { totalSessionCount: "3", totalBotSessionCount: "0", URL: "https://freshcuts.sa/rare" },
  ] },
  { metricName: "RageClickCount", information: [
    { sessionsCount: "120", sessionsWithMetricPercentage: 2.5, URL: "https://freshcuts.sa/" },
    { sessionsCount: "40", sessionsWithMetricPercentage: 15, URL: "https://freshcuts.sa/checkout" },
    { sessionsCount: "3", sessionsWithMetricPercentage: 66.7, URL: "https://freshcuts.sa/rare" },
  ] },
  { metricName: "DeadClickCount", information: [
    { sessionsCount: "120", sessionsWithMetricPercentage: 10, URL: "https://freshcuts.sa/" },
  ] },
  { metricName: "ScrollDepth", information: [{ averageScrollDepth: 55.55, URL: "https://freshcuts.sa/" }] },
  { metricName: "EngagementTime", information: [{ totalTime: 300, activeTime: 90.4, URL: "https://freshcuts.sa/" }] },
  { metricName: "ScriptErrorCount", information: [{ sessionsCount: "40", sessionsWithMetricPercentage: 5, URL: "https://freshcuts.sa/checkout" }] },
];

test("buildUrl: التقسيمات وحد الأيام", () => {
  const u = new URL(C.buildUrl(["Device", "Source", "URL", "Extra"], 9));
  assert.equal(u.searchParams.get("numOfDays"), "3");
  assert.equal(u.searchParams.get("dimension1"), "Device");
  assert.equal(u.searchParams.get("dimension3"), "URL");
  assert.equal(u.searchParams.get("dimension4"), null);
});

test("normalize: صف لكل صفحة فيه الجلسات والإشارات", () => {
  const rows = C.normalize(SAMPLE, ["URL"]);
  const home = rows.find((r) => r.dims.URL === "https://freshcuts.sa/");
  assert.equal(home.sessions, 120);
  assert.equal(home.bots, 4);
  assert.equal(home.rageClickPct, 2.5);
  assert.equal(home.deadClickPct, 10);
  assert.equal(home.scrollDepth, 55.6);
  assert.equal(home.activeTime, 90);
  const co = rows.find((r) => r.dims.URL.endsWith("/checkout"));
  assert.equal(co.scriptErrorPct, 5);
  assert.ok(co.score > home.score, "صفحة الدفع فيها rage أعلى");
});

test("normalize: رد مش مصفوفة أو صفوف ناقصة مايكسرش", () => {
  assert.deepEqual(C.normalize(null, ["URL"]), []);
  const rows = C.normalize([{ metricName: "Traffic", information: [null, { totalSessionCount: "5" }] }], ["Device"]);
  assert.equal(rows[0].dims.Device, "(غير معروف)");
  assert.equal(rows[0].sessions, 5);
});

test("topSignals: بيتجاهل الصفحات اللي جلساتها قليلة", () => {
  const rows = C.normalize(SAMPLE, ["URL"]);
  const t = C.topSignals(rows);
  assert.ok(!t.worst.some((r) => r.dims.URL.endsWith("/rare")));
  assert.equal(t.bySignal.rageClickPct[0].dims.URL, "https://freshcuts.sa/checkout");
  assert.equal(t.worst[0].dims.URL, "https://freshcuts.sa/checkout");
});

test("totals: متوسط مرجّح بالجلسات", () => {
  const t = C.totals([{ sessions: 100, rageClickPct: 10 }, { sessions: 300, rageClickPct: 2 }]);
  assert.equal(t.sessions, 400);
  assert.equal(t.rageClickPct, 4);
});

test("shouldPull: مرة يومياً بعد ٦ الصبح ومن غير مايعدّي السقف", () => {
  const at = (h) => new Date(Date.UTC(2026, 8, 18, h - 3, 0)); // ساعة الرياض h
  assert.equal(C.shouldPull({ lastOkDay: null, usedToday: 0, now: at(5) }), false);
  assert.equal(C.shouldPull({ lastOkDay: null, usedToday: 0, now: at(7) }), true);
  assert.equal(C.shouldPull({ lastOkDay: "2026-09-18", usedToday: 3, now: at(9) }), false);
  assert.equal(C.shouldPull({ lastOkDay: "2026-09-17", usedToday: 7, now: at(9) }), false);
  assert.equal(C.shouldPull({ lastOkDay: "2026-09-17", usedToday: 6, now: at(9) }), true);
});

test("cfg: من غير توكن الموديول نايم، والمشروع الافتراضي", () => {
  assert.deepEqual(C.cfg({}), { token: "", project: "yk019wcypa", enabled: false });
  assert.equal(C.cfg({ CLARITY_API_TOKEN: "x".repeat(40), CLARITY_PROJECT_ID: "abc123" }).enabled, true);
});

test("links: رابط التسجيلات والخرائط + وصف الفلتر", () => {
  const l = C.links("yk019wcypa", { Device: "Mobile", URL: "(غير معروف)" });
  assert.match(l.recordings, /projects\/view\/yk019wcypa\/impressions$/);
  assert.match(l.heatmaps, /\/heatmaps$/);
  assert.equal(l.filterHint, "Device: Mobile");
});

/* ── المسارات ببول مزيّف ── */
function fakePool() {
  const pulls = [];
  return {
    pulls,
    async query(sql, p = []) {
      if (/CREATE TABLE/.test(sql)) return { rows: [] };
      if (/INSERT INTO clarity_pulls/.test(sql)) {
        pulls.push({ day: p[0], dims: p[1], num_days: p[2], trigger: p[3], ok: p[4], status: p[5], error: p[6], rows: p[7] ? JSON.parse(p[7]) : null, pulled_at: new Date().toISOString() });
        return { rows: [] };
      }
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: pulls.filter((x) => x.day === p[0] && x.status != null).length }] };
      if (/DISTINCT ON \(dims\)/.test(sql)) {
        const m = {};
        for (const x of pulls) if (x.ok) m[x.dims] = x;
        return { rows: Object.values(m) };
      }
      if (/WHERE NOT ok/.test(sql)) return { rows: pulls.filter((x) => !x.ok).slice(-1) };
      return { rows: [] };
    },
  };
}

test("المسارات: refresh بيسحب ٣ طلبات ويحترم السقف، والتقرير بيقرا من الجدول", async () => {
  process.env.CLARITY_API_TOKEN = "t".repeat(40);
  const pool = fakePool();
  const calls = [];
  const app = new Hono();
  C.register(app, { pool, requireAdmin: async () => null }, {
    fetch: async (url, opts) => {
      calls.push({ url, auth: opts.headers.Authorization });
      const dims = [...new URL(url).searchParams.entries()].filter(([k]) => k.startsWith("dimension")).map(([, v]) => v);
      const body = dims[0] === "URL" ? SAMPLE : [{ metricName: "Traffic", information: [{ totalSessionCount: "50", Device: "Mobile", Source: "facebook", Campaign: "nd96" }] }];
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });

  const empty = await (await app.request("/api/journey/clarity")).json();
  assert.equal(empty.enabled, true);
  assert.equal(empty.totals, null);

  const r1 = await (await app.request("/api/journey/clarity/refresh", { method: "POST" })).json();
  assert.equal(r1.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].auth, `Bearer ${"t".repeat(40)}`);

  const rep = await (await app.request("/api/journey/clarity")).json();
  assert.equal(rep.usedToday, 3);
  assert.equal(rep.totals.sessions, 50);
  assert.equal(rep.pages.worst[0].dims.URL, "https://freshcuts.sa/checkout");
  assert.match(rep.pages.worst[0].links.recordings, /impressions/);
  assert.equal(rep.campaigns[0].dims.Campaign, "nd96");

  await app.request("/api/journey/clarity/refresh", { method: "POST" });
  await app.request("/api/journey/clarity/refresh", { method: "POST" });
  assert.equal(calls.length, 9);
  const capped = await (await app.request("/api/journey/clarity/refresh", { method: "POST" })).json();
  assert.equal(capped.error, "daily_cap");
  assert.equal(calls.length, 9, "مفيش طلب عاشر");
  delete process.env.CLARITY_API_TOKEN;
});

test("المسارات: من غير توكن مفيش أي طلب لـClarity", async () => {
  delete process.env.CLARITY_API_TOKEN;
  const app = new Hono();
  let called = 0;
  C.register(app, { pool: fakePool(), requireAdmin: async () => null }, { fetch: async () => { called++; return new Response("[]"); } });
  const r = await (await app.request("/api/journey/clarity/refresh", { method: "POST" })).json();
  assert.equal(r.error, "no_token");
  assert.equal(called, 0);
  const rep = await (await app.request("/api/journey/clarity")).json();
  assert.equal(rep.enabled, false);
});

test("HTTP خطأ بيتسجّل ومابيوقعش", async () => {
  process.env.CLARITY_API_TOKEN = "t".repeat(40);
  const pool = fakePool();
  const app = new Hono();
  C.register(app, { pool, requireAdmin: async () => null }, { fetch: async () => new Response("quota", { status: 429 }) });
  const r = await (await app.request("/api/journey/clarity/refresh", { method: "POST" })).json();
  assert.equal(r.ok, false);
  assert.match(pool.pulls[0].error, /429/);
  const rep = await (await app.request("/api/journey/clarity")).json();
  assert.match(rep.lastError.error, /429/);
  delete process.env.CLARITY_API_TOKEN;
});
