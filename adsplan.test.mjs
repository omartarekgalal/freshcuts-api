/* خطة الإعلانات المدفوعة — W1-07 (مسار ٠٩ P1).
   مفيش شبكة ولا داتابيز: pool مزيّف، ومنصات مزيّفة بترمي لو أي نداء كتابة
   اتنده. بيغطي اختبارات ٠٩ §7.1 (9، 10) + البذرة والحارس وعقود الـroutes.
     node --test adsplan.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  register, PLAN_LINES, PLAN_CREATIVES, plannedDaily, plannedSpend, guardCopy, validateLinePatch,
  validateCreativePatch, lineOfSlug, buildPerformance, buildGate, signalOf, ensureSchema, GATE_0924, fbcFresh,
} from "./adsplan.js";

const norm = (s) => String(s).replace(/\s+/g, " ").trim();

/* ── pool مزيّف ─────────────────────────────────────────────────────────── */
function fakeDb({ orders = [], isTest = true, apSettings = null, clicksTable = true } = {}) {
  const db = { lines: new Map(), creatives: new Map(), sql: [], orderSql: [], orders, links: [] };
  db.pool = {
    async query(sql, p = []) {
      const s = norm(sql);
      db.sql.push(s);
      if (/^CREATE TABLE/i.test(s)) return { rows: [], rowCount: 0 };
      if (/^INSERT INTO ads_plan_lines/i.test(s)) {
        if (db.lines.has(p[0])) return { rows: [], rowCount: 0 };
        db.lines.set(p[0], { id: p[0], platform: p[1], name: p[2], objective: p[3], optimisation_event: p[4],
          geo: JSON.parse(p[5]), budget_plan: JSON.parse(p[6]), gate: p[7], target_cpa: p[8], kill_cpa: p[9],
          status: p[10], notes: p[11], platform_campaign_id: null, platform_adset_id: null, updated_by: "seed" });
        return { rows: [], rowCount: 1 };
      }
      if (/^INSERT INTO ads_plan_creatives/i.test(s)) {
        if (db.creatives.has(p[0])) return { rows: [], rowCount: 0 };
        db.creatives.set(p[0], { id: p[0], offer_id: p[1], format: p[2], hook: p[3], copy: p[4], lines: p[5],
          media_ids: [], guard: null, status: "draft" });
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT \* FROM ads_plan_lines/i.test(s)) return { rows: [...db.lines.values()] };
      if (/^SELECT \* FROM ads_plan_creatives WHERE id=\$1/i.test(s)) {
        const r = db.creatives.get(p[0]); return { rows: r ? [r] : [] };
      }
      if (/^SELECT \* FROM ads_plan_creatives/i.test(s)) return { rows: [...db.creatives.values()] };
      if (/^UPDATE ads_plan_lines SET/i.test(s)) {
        const row = db.lines.get(p[0]);
        if (!row) return { rows: [], rowCount: 0 };
        const cols = s.match(/SET (.*), updated_at=NOW\(\)/)[1].split(", ").map((x) => x.split("=")[0]);
        cols.forEach((k, i) => { row[k] = k === "budget_plan" ? JSON.parse(p[i + 1]) : p[i + 1]; });
        row.updated_by = p[cols.length + 1];
        return { rows: [row], rowCount: 1 };
      }
      if (/^UPDATE ads_plan_creatives/i.test(s)) {
        const row = db.creatives.get(p[0]);
        Object.assign(row, { status: p[1], media_ids: p[2], copy: p[3], hook: p[4], guard: JSON.parse(p[5]) });
        return { rows: [row], rowCount: 1 };
      }
      if (/FROM cms_links l/i.test(s)) return { rows: db.links.map((j) => ({ j })) };
      if (/FROM cms_link_clicks_daily/i.test(s)) {
        if (!clicksTable) throw new Error('relation "cms_link_clicks_daily" does not exist');
        return { rows: [] };
      }
      if (/information_schema\.columns/i.test(s)) return { rows: isTest ? [{ "?column?": 1 }] : [] };
      if (/FROM shop_orders o/i.test(s) && /LEFT JOIN LATERAL/i.test(s)) { db.orderSql.push(s); return { rows: db.orders }; }
      if (/FROM funnel_events WHERE \(created_at/i.test(s)) return { rows: [] };
      if (/FROM ap_settings/i.test(s)) return { rows: apSettings ? [{ data: apSettings }] : [] };
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

/* منصات مزيّفة: القراءة بس مسموحة. أي دالة كتابة بترمي. */
function fakePlatforms(calls) {
  const boom = (name) => () => { throw new Error(`WRITE CALLED: ${name}`); };
  return [
    { id: "meta", label: "Meta",
      async insights() { calls.push("meta.insights"); return { ok: true, rows: [{ campaignId: "C1", spend: 100 }] }; },
      async adsetInsights() { calls.push("meta.adsetInsights"); return { ok: true, rows: [{ adsetId: "AS2", spend: 612.4 }, { adsetId: "X", spend: 5 }] }; },
      updateBudget: boom("updateBudget"), setStatus: boom("setStatus"), createCampaign: boom("createCampaign") },
    { id: "google", label: "Google", async insights() { calls.push("google.insights"); throw new Error("revoked"); },
      updateBudget: boom("google.updateBudget") },
    { id: "tiktok", label: "TikTok", updateBudget: boom("tiktok.updateBudget") },
  ];
}

const ctxOf = (db) => ({
  pool: db.pool, requireAdmin: async () => null, normPhone: (s) => String(s || "").replace(/\D/g, ""),
  getSettingsData: async () => ({ cms: { staffPhones: ["0555000111"] } }),
});

async function app(db, deps = {}) {
  const a = new Hono();
  const api = register(a, ctxOf(db), { now: () => Date.parse("2026-09-24T09:00:00Z"), ...deps });
  await api.ready;
  return { a, api };
}
const put = (a, url, body) => a.request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/* ── البذرة ─────────────────────────────────────────────────────────────── */
test("البذرة: الإجمالي اليومي = ٠٩ §3.4 (150 · 290 · 320 أساسي · 520 بوابة)", () => {
  const total = (d, p) => PLAN_LINES.reduce((a, l) => a + plannedDaily(l, d, p), 0);
  assert.equal(total("2026-09-15", "base"), 150);
  assert.equal(total("2026-09-17", "base"), 290);
  assert.equal(total("2026-09-24", "base"), 320);
  assert.equal(total("2026-09-24", "gate"), 520);
  assert.equal(total("2026-10-01", "gate"), 0, "مفيش ميزانية بعد ٣٠ سبتمبر");
  assert.deepEqual(PLAN_LINES.map((l) => l.id), ["M1", "M2", "M3", "M4", "G1", "TT"]);
  assert.equal(plannedSpend(PLAN_LINES[1], "2026-09-17", "2026-09-23"), 630);
});

test("البذرة: كل الإعلانات بتعدّي الحارس، والمصفوفة كاملة", () => {
  assert.deepEqual(PLAN_CREATIVES.map((c) => c.id),
    ["K-V1", "K-S1", "K-ST1", "B-V1", "B-S1", "B-C1", "D-V1", "R-S1", "A-S1", "G-RSA", "O-ND"]);
  for (const c of PLAN_CREATIVES) assert.equal(guardCopy(c).ok, true, c.id);
});

test("ensureSchema: DDL idempotent والبذرة ON CONFLICT DO NOTHING، ومايدوسش على تعديل المالك", async () => {
  const db = fakeDb();
  await ensureSchema(db.pool);
  db.lines.get("M2").status = "live";
  await ensureSchema(db.pool);
  assert.equal(db.lines.get("M2").status, "live");
  assert.equal(db.lines.size, 6);
  assert.equal(db.creatives.size, 11);
  for (const s of db.sql) {
    if (/^CREATE TABLE/.test(s)) assert.match(s, /CREATE TABLE IF NOT EXISTS ads_plan_lines .*CREATE TABLE IF NOT EXISTS ads_plan_creatives/);
    if (/^INSERT/.test(s)) assert.match(s, /ON CONFLICT \(id\) DO NOTHING$/);
  }
});

/* ── الحارس ─────────────────────────────────────────────────────────────── */
test("guardCopy: توفير/نسبة/علم/صالة للبوكس/ستيك ممنوعين", () => {
  const codes = (x) => guardCopy(x).problems.map((p) => p.code).sort();
  assert.deepEqual(codes({ offer_id: "nd96_kilo", copy: "وفّر على الكيلو" }), ["savings"]);
  assert.deepEqual(codes({ copy: "خصم كبير اليوم" }), ["savings"]);
  assert.deepEqual(codes({ copy: "٢٠٪ على كل شي" }), ["percent"]);
  assert.deepEqual(codes({ copy: "20% off" }), ["percent", "savings"]);
  assert.deepEqual(codes({ copy: "بدل ١٢٠ بـ٩٦" }), ["instead_of_price"]);
  assert.deepEqual(codes({ copy: "كان بـ120 صار ٩٦" }), ["was_now"]);
  assert.deepEqual(codes({ copy: "أرخص من التطبيقات" }), ["savings"]);
  assert.deepEqual(codes({ offer_id: "nd96_kilo", copy: "كيلو بـ٩٦ 🇸🇦 والأرز علينا" }), ["flag"]);
  assert.deepEqual(codes({ offer_id: "nd96_box", copy: "بوكس ٩٦ داخل الصالة" }), ["box_dine_in"]);
  assert.deepEqual(codes({ copy: "البوكس متاح داخل الصاله" }), ["box_dine_in"], "بدون offer_id بس النص عن البوكس");
  assert.deepEqual(codes({ offer_id: "nd96_kilo", copy: "كيلو ٩٦ داخل الصالة والأرز" }), [], "الكيلو مسموح في الصالة");
  assert.deepEqual(codes({ offer_id: "nd96_kilo", hook: "ستيك على الفحم", copy: "أرز" }), ["steak"]);
  assert.deepEqual(codes({ offer_id: "nd96_kilo", copy: "كيلو + بيبسي + أرز" }), ["kilo_pepsi"]);
  assert.deepEqual(codes({ offer_id: "nd96_box", copy: "بوكس سي فود أونلاين" }), ["box_seafood"]);
  // مش false positive: «متوفر» مش «وفّر»، و«مكان» مش «كان + سعر»
  assert.equal(guardCopy({ copy: "متوفر الحين في مكان قريب — ٩٦" }).ok, true);
  assert.equal(guardCopy({ copy: "كل عام ووطننا بخير 💚" }).ok, true, "القلب الأخضر مش علم");
});

test("validate: الحالات والمعرّفات والميزانية", () => {
  assert.equal(validateLinePatch({ status: "running" }).ok, false);
  assert.equal(validateLinePatch({}).ok, false);
  assert.equal(validateLinePatch({ platform_adset_id: "x y; DROP" }).ok, false);
  assert.equal(validateLinePatch({ budget_plan: [{ from: "2026-09-20", to: "2026-09-17", daily: 10 }] }).ok, false);
  assert.equal(validateLinePatch({ budget_plan: [{ from: "2026-09-17", to: "2026-09-20", daily: -1 }] }).ok, false);
  assert.equal(validateLinePatch({ budget_plan: [{ from: "2026-09-17", to: "2026-09-20", daily: 5, requires: ["nope"] }] }).ok, false);
  const ok = validateLinePatch({ status: "live", platform_adset_id: "120210000", budget_plan: [{ from: "2026-09-17", to: "2026-09-20", daily: "90" }], notes: "x" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.patch.budget_plan, [{ from: "2026-09-17", to: "2026-09-20", daily: 90, path: "base" }]);
  assert.equal(validateCreativePatch({ status: "published" }).ok, false);
  assert.deepEqual(validateCreativePatch({ media_ids: ["a", 7] }).patch.media_ids, ["a", "7"]);
});

test("lineOfSlug: قاعدة التسمية 96-<منصة>-<خط>-<عرض>", () => {
  assert.equal(lineOfSlug("96-m2-box"), "M2");
  assert.equal(lineOfSlug("96-m3-kilo"), "M3");
  assert.equal(lineOfSlug("96-wa-kilo"), "M1");
  assert.equal(lineOfSlug("96-g-box"), "G1");
  assert.equal(lineOfSlug("96-tt-box"), "TT");
  assert.equal(lineOfSlug("bag-keeta"), "bag");
  assert.equal(lineOfSlug("96-counter"), "counter");
  assert.equal(lineOfSlug("summer"), null);
});

/* ── الأداء (٠٩ §7.1-9) ─────────────────────────────────────────────────── */
const lines = PLAN_LINES.map((l) => ({ ...l, platform_campaign_id: null, platform_adset_id: null }));
const order = (o) => ({ total: 100, attributed: true, kind: "new", purchases: 1, withContents: true, websiteClaims: 1, fbc: true, via: "fc_link", ...o });

test("performance: منصة قراءتها فشلت → spend:null وunavailable فيه المنصة وCPA null مش 0/Infinity", () => {
  const res = buildPerformance({
    from: "2026-09-17", to: "2026-09-23", by: "line", lines, links: [], clicks: null, funnel: [],
    orders: [order({ order_no: "W1", slug: "96-tt-box" }), order({ order_no: "W2", slug: "96-m2-box" })],
    spend: { platforms: { meta: 500 }, lines: { M2: { spend: 300, source: "meta_insights" }, TT: { spend: 0, source: "x" } },
      unavailable: [{ platform: "tiktok", why: "allowed:false" }] },
  });
  const tt = res.rows.find((r) => r.key === "TT");
  assert.equal(tt.spend, null);
  assert.equal(tt.cpa, null);
  assert.equal(tt.roas, null);
  assert.equal(tt.breakevenOrders, null);
  assert.equal(tt.orders, 1);
  assert.deepEqual(res.unavailable, ["tiktok"]);
  assert.equal(res.totals.platformSpend.tiktok, null);
  assert.equal(res.totals.spendComplete, false);
  const m3 = res.rows.find((r) => r.key === "M3");
  assert.equal(m3.spend, null, "مفيش صرف مقروء للخط → null مش صفر");
  assert.equal(m3.cpa, null);
  for (const r of res.rows) {
    for (const k of ["cpa", "roas", "breakevenOrders"]) assert.ok(r[k] === null || Number.isFinite(r[k]), `${r.key}.${k}`);
  }
  assert.equal(res.clicks, undefined);
  assert.equal(res.rows.find((r) => r.key === "M2").clicks, null, "نقرات غير مقروءة = null");
});

test("performance: حساب الصف والحكم + moved/new/existing + الإشارة", () => {
  const orders = [
    ...Array.from({ length: 6 }, (_, i) => order({ order_no: `N${i}`, slug: "96-m2-box", total: 102 })),
    order({ order_no: "E1", slug: "96-m2-kilo", kind: "existing", withContents: false, fbc: false }),
    order({ order_no: "E2", slug: "96-m2-kilo", kind: "existing", purchases: 3 }),
    order({ order_no: "U1", slug: "96-m2-kilo", kind: "unknown", via: "click" }),
    order({ order_no: "B1", slug: "bag-keeta" }),
    order({ order_no: "X", slug: null, attributed: false }),
  ];
  const res = buildPerformance({
    from: "2026-09-17", to: "2026-09-23", by: "line", lines, orders,
    links: [{ slug: "96-m2-box", line: "M2", platform: "meta" }],
    clicks: new Map([["96-m2-box", { clicks: 820, withClickId: 700 }]]),
    funnel: [{ slug: "96-m2-box", term: "B-V1", sessions: 640, atc: 71, checkout: 22 }],
    spend: { platforms: { meta: 800 }, lines: { M2: { spend: 612.4, source: "meta_insights" } }, unavailable: [] },
  });
  const m2 = res.rows.find((r) => r.key === "M2");
  assert.equal(m2.orders, 9);
  assert.equal(m2.newConfirmed, 6);
  assert.equal(m2.existing, 2);
  assert.equal(m2.clicks, 820);
  assert.equal(m2.atc, 71);
  assert.equal(m2.cpa, 68.04);
  assert.equal(m2.breakevenOrders, 20.41);
  assert.equal(m2.verdict.kind, "cut");
  assert.equal(m2.planned.base, 630);
  assert.equal(m2.signal.withFbc, 0.89);
  assert.equal(m2.signal.purchaseOnce, 0.89);
  const bag = res.rows.find((r) => r.key === "bag");
  assert.equal(bag.moved, 1);
  assert.equal(res.totals.orders, 10, "الطلب غير المربوط مش محسوب");
  assert.ok(res.notes.some((n) => /click id/.test(n)));

  const kill = buildPerformance({ from: "2026-09-17", to: "2026-09-23", lines, orders: [], links: [], clicks: new Map(),
    funnel: [{ slug: "96-m2-box", sessions: 50, atc: 4, checkout: 1 }],
    spend: { platforms: { meta: 250 }, lines: { M2: { spend: 250, source: "meta_insights" } }, unavailable: [] } });
  assert.equal(kill.rows.find((r) => r.key === "M2").verdict.kind, "kill");
  assert.equal(kill.rows.find((r) => r.key === "M1").verdict.kind, "none");
});

test("performance by=creative: utm_term بيحدد الإعلان والصرف null", () => {
  const res = buildPerformance({
    from: "2026-09-17", to: "2026-09-18", by: "creative", lines, creatives: PLAN_CREATIVES,
    links: [{ slug: "96-m2-box", line: "M2", creative_id: "B-S1" }], clicks: null,
    funnel: [{ slug: "96-m2-box", term: "B-V1", sessions: 3, atc: 1, checkout: 0 }],
    orders: [order({ order_no: "A", slug: "96-m2-box", term: "B-V1" }), order({ order_no: "B", slug: "96-m2-box", term: "junk" })],
    spend: { platforms: { meta: 10 }, lines: {}, unavailable: [] },
  });
  assert.equal(res.rows.find((r) => r.key === "B-V1").orders, 1);
  assert.equal(res.rows.find((r) => r.key === "B-S1").orders, 1);
  assert.ok(res.rows.every((r) => r.spend === null && r.verdict === null));
});

/* ── البوابة (٠٩ §7.1-10) ──────────────────────────────────────────────── */
test("gate-0924: ٤ طلبات مربوطة → pass:false وattributedOrders=4", () => {
  const g = buildGate({ attributedOrders: 4, spend: 200, sales7d: 18200, signal: 0.95 });
  assert.equal(g.pass, false);
  const c = Object.fromEntries(g.checks.map((x) => [x.id, x]));
  assert.equal(c.attributedOrders.value, 4);
  assert.equal(c.attributedOrders.need, 5);
  assert.equal(c.attributedOrders.ok, false);
  assert.equal(c.cpa.value, 50);
  assert.equal(c.cpa.ok, true);
  assert.equal(c.sales7d.ok, true);
  assert.equal(buildGate({ attributedOrders: 5, spend: 250, sales7d: 17500, signal: 0.9 }).pass, true);
  const blind = buildGate({ attributedOrders: 6, spend: null, sales7d: null, signal: null });
  assert.equal(blind.pass, false);
  assert.equal(blind.checks.find((x) => x.id === "cpa").value, null);
  assert.equal(signalOf([]), null);
});

test("GET gate-0924 route: fixture بـ٤ طلبات مربوطة + طلب مش مربوط", async () => {
  const row = (o) => ({ total: 100, pos_order_id: "P", fc_link: null, utm_term: null, fbc: null, click_id: null,
    click_slug: null, click_term: null, purchases: 1, with_contents: true, website_claims: 1, seen_before: false, ...o });
  const db = fakeDb({ orders: [
    row({ order_no: "W1", fc_link: "96-m2-box" }), row({ order_no: "W2", fc_link: "96-m2-kilo" }),
    row({ order_no: "W3", click_id: "fbclid-1", click_slug: "96-m2-box" }), row({ order_no: "W4", fbc: `fb.1.${Date.parse("2026-09-18T10:00:00Z")}.IwAR1`, created_at: "2026-09-18T12:00:00Z" }),
    row({ order_no: "W5" }),
    // _fbc قديم (أغسطس) لوحده مايتحسبش ربط
    row({ order_no: "W6", fbc: `fb.1.${Date.parse("2026-08-01T10:00:00Z")}.IwAR2`, created_at: "2026-09-18T12:00:00Z" }),
    row({ order_no: "W7", fbc: "fb.1.x", created_at: "2026-09-18T12:00:00Z" }),
  ] });
  let spendRange = null;
  const { a } = await app(db, {
    platforms: fakePlatforms([]),
    ads: () => ({ async dailySpendData(f, t) { spendRange = [f, t]; return { days: [{ day: f, meta: 240, tiktok: null }], platformsRead: ["meta"], unavailable: [{ platform: "tiktok", why: "x" }] }; } }),
    scorecard: { async buildLedger() { return { totals: { revenue: 18200 } }; } },
  });
  const res = await (await a.request("/api/ads/plan/gate-0924")).json();
  assert.equal(res.pass, false);
  const c = Object.fromEntries(res.checks.map((x) => [x.id, x]));
  assert.equal(c.attributedOrders.value, 4);
  assert.equal(c.cpa.value, 60, "240 ÷ 4 — تيك توك مش لازم (مفيش خط شغّال عليها)");
  assert.equal(c.sales7d.value, 18200);
  assert.equal(c.signal.value, 1);
  assert.deepEqual(spendRange, ["2026-09-17", "2026-09-24"]);
  assert.deepEqual(res.sales7dRange, { from: "2026-09-17", to: "2026-09-23" });
});

/* ── الـroutes ─────────────────────────────────────────────────────────── */
test("GET /api/ads/plan: الخطوط والإعلانات والروابط المربوطة بخط", async () => {
  const db = fakeDb();
  db.links = [{ id: 1, slug: "bag-keeta", clicks: 1, active: true }, { id: 2, slug: "96-m2-box", clicks: 3, active: true },
    { id: 3, slug: "summer", active: true }, { id: 4, slug: "odd", line: "M3", active: true }];
  const { a } = await app(db, { platforms: fakePlatforms([]) });
  const res = await (await a.request("/api/ads/plan")).json();
  assert.equal(res.ok, true);
  assert.equal(res.lines.length, 6);
  assert.equal(res.creatives.length, 11);
  assert.equal(res.writesPlatforms, false);
  assert.deepEqual(res.links.map((l) => [l.slug, l.line, l.lineDerived]),
    [["bag-keeta", "bag", true], ["96-m2-box", "M2", true], ["odd", "M3", false]]);
  const m1 = res.lines.find((l) => l.id === "M1");
  assert.deepEqual(m1.plannedToday, { base: 150, gate: 170 });
});

test("PUT lines/:id: تسجيل بس (مفيش نداء منصة) + 400 للحالة الغلط + 404", async () => {
  const db = fakeDb();
  const calls = [];
  const { a } = await app(db, { platforms: fakePlatforms(calls) });
  const bad = await put(a, "/api/ads/plan/lines/M2", { status: "running" });
  assert.equal(bad.status, 400);
  const r = await put(a, "/api/ads/plan/lines/M2", {
    status: "live", platform_campaign_id: "120200", platform_adset_id: "AS2",
    budget_plan: [{ from: "2026-09-17", to: "2026-09-30", daily: 90 }], notes: "اتعملت يدوي",
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.line.status, "live");
  assert.equal(j.line.platform_adset_id, "AS2");
  assert.deepEqual(j.line.budget_plan, [{ from: "2026-09-17", to: "2026-09-30", daily: 90, path: "base" }]);
  assert.equal(j.line.updated_by, "admin");
  assert.equal((await put(a, "/api/ads/plan/lines/ZZ", { status: "paused" })).status, 404);
  assert.deepEqual(calls, [], "PUT مابيلمسش المنصة خالص");
});

test("PUT creatives/:id: approved من غير حارس ok → 409 guard_required ومايتحفظش", async () => {
  const db = fakeDb();
  const { a } = await app(db, { platforms: fakePlatforms([]) });
  const r = await put(a, "/api/ads/plan/creatives/B-S1", { status: "approved", copy: "وفّر ٢٠٪ — البوكس داخل الصالة 🇸🇦" });
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.error, "guard_required");
  assert.deepEqual(j.guard.problems.map((p) => p.code).sort(), ["box_dine_in", "flag", "percent", "savings"]);
  assert.equal(db.creatives.get("B-S1").status, "draft");
  assert.match(db.creatives.get("B-S1").copy, /freshcuts\.sa/);

  // الإعلان approved ماينفعش يتعدّل لنص مكسور
  const ok = await put(a, "/api/ads/plan/creatives/K-V1", { status: "approved", media_ids: ["m1"] });
  assert.equal(ok.status, 200);
  const cj = await ok.json();
  assert.equal(cj.creative.status, "approved");
  assert.equal(cj.creative.guard.ok, true);
  assert.equal((await put(a, "/api/ads/plan/creatives/K-V1", { copy: "ستيك بـ٩٦" })).status, 409);
  assert.equal(db.creatives.get("K-V1").status, "approved");

  // draft بنص مكسور مسموح يتحفظ (والحارس متسجّل عليه)
  const d = await put(a, "/api/ads/plan/creatives/D-V1", { copy: "خصم اليوم" });
  assert.equal(d.status, 200);
  assert.equal((await d.json()).creative.guard.ok, false);
  assert.equal((await put(a, "/api/ads/plan/creatives/NOPE", { status: "draft" })).status, 404);
});

test("GET performance route: صرف ميتا من adsetInsights (قراءة) + تيك توك واقعة → null + SQL الربط", async () => {
  const db = fakeDb({ clicksTable: false, orders: [
    { order_no: "W1", total: 120, fc_link: "96-m2-box", purchases: 1, with_contents: true, website_claims: 1, seen_before: false },
    { order_no: "W2", total: 80, fc_link: "96-tt-box", purchases: 1, with_contents: true, website_claims: 1, seen_before: true },
  ] });
  const calls = [];
  const { a } = await app(db, {
    platforms: fakePlatforms(calls),
    ads: { async dailySpendData() {
      return { days: [{ day: "2026-09-20", meta: 700, tiktok: null, google: null }], platformsRead: ["meta"],
        unavailable: [{ platform: "tiktok", why: "allowed:false" }, { platform: "google", why: "revoked" }] };
    } },
  });
  db.lines.get("M2").platform_adset_id = "AS2";
  db.lines.get("M2").status = "live";
  const res = await (await a.request("/api/ads/plan/performance?from=2026-09-17&to=2026-09-23&by=line")).json();
  assert.equal(res.ok, true);
  const m2 = res.rows.find((r) => r.key === "M2");
  assert.equal(m2.spend, 612.4);
  assert.equal(m2.spendSource, "meta_insights");
  assert.equal(m2.cpa, 612.4);
  const tt = res.rows.find((r) => r.key === "TT");
  assert.equal(tt.spend, null);
  assert.equal(tt.cpa, null);
  assert.deepEqual(res.unavailable.sort(), ["google", "tiktok"]);
  assert.equal(res.rows.find((r) => r.key === "M1").spend, null, "M1 وM2 الاتنين شغّالين على ميتا → مفيش نسب لإجمالي المنصة");
  assert.deepEqual(calls, ["meta.adsetInsights"], "قراءة بس، ومنصة واقعة ماتتندهش");
  const sql = db.orderSql[0];
  assert.match(sql, /attribution->>'fc_link'/);
  assert.match(sql, /AND NOT o\.is_test/);
  assert.match(sql, /o\.status = ANY\(\$3::text\[\]\)/);
  assert.ok(res.notes.some((n) => /cms_link_clicks_daily/.test(n)));
});

test("loadOrders: is_test بيتستبعد بس لو العمود موجود", async () => {
  const db = fakeDb({ isTest: false });
  const { a } = await app(db, { platforms: fakePlatforms([]),
    ads: { async dailySpendData() { return { days: [], platformsRead: [], unavailable: [] }; } } });
  await a.request("/api/ads/plan/performance");
  assert.doesNotMatch(db.orderSql[0], /is_test/);
});

test("readiness: بنود X1–X11، والطيار على auto = X1 أحمر", async () => {
  const db = fakeDb({ apSettings: { mode: "auto", absoluteMaxTotalBudget: 2000, syncAudiences: true } });
  const { a } = await app(db, { platforms: fakePlatforms([]), canManage: (p) => p.id === "meta" });
  const res = await (await a.request("/api/ads/plan/readiness")).json();
  assert.equal(res.ok, true);
  assert.deepEqual(res.items.map((i) => i.id), ["X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10", "X11"]);
  const x = Object.fromEntries(res.items.map((i) => [i.id, i]));
  assert.equal(x.X1.ok, false);
  assert.match(x.X1.detail, /mode=auto/);
  assert.equal(x.X5.ok, false);
  assert.equal(x.X8.ok, null);
  assert.equal(x.X9.ok, false);
  assert.equal(res.ready, false);
});

test("adsplan.js مافيهوش أي نداء كتابة على منصة", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./adsplan.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /sendPlatformWrite|guardedWrite|updateBudget|setStatus\(|method:\s*"(POST|DELETE)"/);
  assert.equal(GATE_0924.from, "2026-09-17");
});

test("fbcFresh: _fbc لوحده بيتحسب بس خلال ٧ أيام قبل الطلب", () => {
  const at = "2026-09-20T12:00:00Z";
  assert.equal(fbcFresh(`fb.1.${Date.parse("2026-09-19T12:00:00Z")}.abc`, at), true);
  assert.equal(fbcFresh(`fb.1.${Math.floor(Date.parse("2026-09-19T12:00:00Z") / 1000)}.abc`, at), true);
  assert.equal(fbcFresh(`fb.1.${Date.parse("2026-09-01T12:00:00Z")}.abc`, at), false);
  assert.equal(fbcFresh("fb.1.x", at), false);
  assert.equal(fbcFresh(null, at), false);
  assert.equal(fbcFresh(`fb.1.${Date.parse("2026-09-19T12:00:00Z")}.abc`, null), false);
});

test("guardCopy: بادئات متتالية («وبخصم»، «وللتوفير») بتتمسك", () => {
  for (const c of ["وبخصم خاص", "وللتوفير اطلب", "فبخصم"]) assert.equal(guardCopy({ copy: c }).ok, false, c);
  for (const c of ["متوفر الحين", "كيلو + أرز مجاناً بـ٩٦"]) assert.equal(guardCopy({ copy: c }).ok, true, c);
});

test("readiness X1/X9: المفاتيح الغايبة من ap_settings = افتراضيات الطيار", async () => {
  const db = fakeDb({ apSettings: { absoluteMaxTotalBudget: 550, syncAudiences: false } });
  const { a } = await app(db, { platforms: fakePlatforms([]) });
  const res = await (await a.request("/api/ads/plan/readiness")).json();
  const x = Object.fromEntries(res.items.map((i) => [i.id, i]));
  assert.equal(x.X1.ok, true, x.X1.detail);
  assert.equal(x.X9.ok, true);
  const db2 = fakeDb({ apSettings: {} });
  const { a: a2 } = await app(db2, { platforms: fakePlatforms([]) });
  const r2 = await (await a2.request("/api/ads/plan/readiness")).json();
  const y = Object.fromEntries(r2.items.map((i) => [i.id, i]));
  assert.equal(y.X1.ok, false, "absoluteMaxTotalBudget الافتراضي 2000 > 550");
  assert.match(y.X1.detail, /mode=suggest/);
  assert.equal(y.X9.ok, false);
});
