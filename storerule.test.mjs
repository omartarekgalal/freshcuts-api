/* قاعدة المتجر — W1-08 (٠٩ §3.6، اختبارات §7.1 بند ٧ و٨).
   decideStoreAdset دالة صافية؛ والتسجيل (runStoreRules) بـ pool مزيّف:
   pending في suggest بس، ومفيش أي نداء على منصة.
     node --test storerule.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideStoreAdset, STORE_RULES, PLATFORM_SCALING, ADSET_MAX_STEP_PCT, register,
} from "./autopilot.js";

const NOW = new Date("2026-09-19T12:00:00Z");          // برّه تجميد ٢٢–٢٤
const S = { mode: "suggest", minSpend: 50, maxChangePct: 30, maxCampaignBudget: 180,
  maxTotalBudget: 320, budgetCooldownHours: 24 };
const base = (over = {}) => ({
  key: "M2", platform: "meta", adsetId: "A1", campaignId: "C1", name: "JED7KM-BROAD-ATC-v1",
  days: 3, dailyBudget: 100, learning: { status: "SUCCESS", done: true, learning: false, limited: false },
  spend: 300, orders: 0, atc: 0, cpa: null, roas: null, ...over,
});
const snap = (budget = 100, others = 0) => [
  { platform: "meta", id: "C1", name: "FC-96-WEB-ABO", status: "ACTIVE", dailyBudget: null,
    adsets: [{ id: "A1", name: "JED7KM-BROAD-ATC-v1", status: "ACTIVE", dailyBudget: budget }] },
  ...(others ? [{ platform: "meta", id: "C2", name: "fc-wa-orders", status: "ACTIVE", dailyBudget: others, adsets: [] }] : []),
];
const ACTIONS = ["kill", "cut", "scale"];

/* ═══ §7.1 بند ٧ ═══════════════════════════════════════════════════════════ */

test("٧أ: صرف 250، صفر طلبات، ATC 4 → kill", () => {
  const d = decideStoreAdset(base({ spend: 250, orders: 0, atc: 4 }), S, { now: NOW });
  assert.equal(d.kind, "store_rule");
  assert.equal(d.action, "kill");
  assert.equal(d.detail.state, "PAUSED");
  assert.equal(d.adsetId, "A1");
});

test("٧أ: صرف 250 وصفر طلبات بس ATC 12 → مش kill", () => {
  const d = decideStoreAdset(base({ spend: 250, orders: 0, atc: 12 }), S, { now: NOW });
  assert.notEqual(d.action, "kill");
});

test("٧ب: CPA 60 → cut بخطوة ≤ 19٪", () => {
  const d = decideStoreAdset(base({ spend: 240, orders: 4, atc: 30, cpa: 60, roas: 1.2 }), S, { now: NOW, rows: snap() });
  assert.equal(d.action, "cut");
  assert.equal(d.detail.from, 100);
  assert.ok(d.detail.to < 100);
  assert.ok((100 - d.detail.to) / 100 * 100 <= ADSET_MAX_STEP_PCT + 1e-9);
});

test("٧ب: CPA > 80 على 3 أيام → kill", () => {
  const d = decideStoreAdset(base({ spend: 270, orders: 3, atc: 20, cpa: 90, roas: 0.8 }), S, { now: NOW });
  assert.equal(d.action, "kill");
  // عيّنة رفيعة (طلبين < minKillResults 3) → ملاحظة مش قتل
  assert.equal(decideStoreAdset(base({ spend: 180, orders: 2, atc: 20, cpa: 90 }), S, { now: NOW }).action, "note");
});

test("٧ج: CPA 25، 4 طلبات، ROAS 3.4 → scale بخطوة ≤ 19٪ لميتا", () => {
  const d = decideStoreAdset(base({ spend: 100, orders: 4, atc: 30, cpa: 25, roas: 3.4 }), S, { now: NOW, rows: snap() });
  assert.equal(d.action, "scale");
  assert.equal(d.detail.from, 100);
  assert.ok(d.detail.to > 100);
  const pct = (d.detail.to - 100) / 100 * 100;
  assert.ok(pct <= PLATFORM_SCALING.meta.maxStepPct + 1e-9, `step ${pct}%`);
  assert.ok(pct <= STORE_RULES.stepPct + 1e-9);
});

test("٧ج: خطوة التوسيع مابتعدّيش 19٪ حتى على ميزانية بكسور", () => {
  const d = decideStoreAdset(base({ spend: 100, orders: 4, cpa: 25, roas: 3.4, dailyBudget: 37 }), S, { now: NOW });
  assert.equal(d.action, "scale");
  assert.ok((d.detail.to - 37) / 37 * 100 <= 19 + 1e-9);
});

test("٧د: صرف 100 → لا فعل", () => {
  for (const over of [{ orders: 0, atc: 2 }, { orders: 1, atc: 5, cpa: 100 }, { orders: 0, atc: 0 }]) {
    const d = decideStoreAdset(base({ spend: 100, ...over }), S, { now: NOW });
    assert.ok(!ACTIONS.includes(d.action), `${JSON.stringify(over)} → ${d.action}`);
  }
});

/* ═══ §7.1 بند ٨ — التبريد ═════════════════════════════════════════════════ */

test("٨: نفس المجموعة اتغيّرت من 10 ساعات → لا scale", () => {
  const lastBudgetChangeAt = new Date(NOW.getTime() - 10 * 3600_000).toISOString();
  const d = decideStoreAdset(base({ spend: 100, orders: 4, cpa: 25, roas: 3.4, lastBudgetChangeAt }), S, { now: NOW, rows: snap() });
  assert.notEqual(d.action, "scale");
  assert.equal(d.action, "note");
});

test("٨: التبريد من الـSet بتاع budgetCooldownSet → لا scale", () => {
  const d = decideStoreAdset(base({ spend: 100, orders: 4, cpa: 25, roas: 3.4 }), S,
    { now: NOW, rows: snap(), cooldown: new Set(["meta:A1"]) });
  assert.notEqual(d.action, "scale");
});

test("٨: التوسيع كل 48 ساعة — بعد 30 ساعة لسه لا، والقص مسموح", () => {
  const lastBudgetChangeAt = new Date(NOW.getTime() - 30 * 3600_000).toISOString();
  const up = decideStoreAdset(base({ spend: 100, orders: 4, cpa: 25, roas: 3.4, lastBudgetChangeAt }), S, { now: NOW });
  assert.notEqual(up.action, "scale");
  const down = decideStoreAdset(base({ spend: 240, orders: 4, cpa: 60, roas: 1, lastBudgetChangeAt }), S, { now: NOW });
  assert.equal(down.action, "cut");
  const later = new Date(NOW.getTime() - 49 * 3600_000).toISOString();
  assert.equal(decideStoreAdset(base({ spend: 100, orders: 4, cpa: 25, roas: 3.4, lastBudgetChangeAt: later }), S, { now: NOW }).action, "scale");
});

/* ═══ الأسوار التانية ═════════════════════════════════════════════════════ */

test("PLATFORM_SCALING: تيك توك allowed:false → لا scale ولا cut", () => {
  const up = decideStoreAdset(base({ key: "TT", platform: "tiktok", spend: 100, orders: 4, cpa: 25, roas: 3.4 }), S, { now: NOW });
  const down = decideStoreAdset(base({ key: "TT", platform: "tiktok", spend: 240, orders: 4, cpa: 60, roas: 1 }), S, { now: NOW });
  assert.equal(up.action, "note");
  assert.equal(down.action, "note");
});

test("guardBudget: السقف الكلي بيرفض التوسيع", () => {
  const d = decideStoreAdset(base({ spend: 100, orders: 4, cpa: 25, roas: 3.4 }), S,
    { now: NOW, rows: snap(100, 215) });
  assert.equal(d.action, "note");
  assert.ok(d.detail.refusal);
});

test("guardBudget: مجموعة مش في اللقطة → ملاحظة مش اقتراح", () => {
  const d = decideStoreAdset(base({ spend: 100, orders: 4, cpa: 25, roas: 3.4, adsetId: "NOPE" }), S, { now: NOW, rows: snap() });
  assert.equal(d.action, "note");
});

test("لا توسيع 22–24 سبتمبر، ولا في التعلّم، ولا مع الطوارئ", () => {
  const win = base({ spend: 100, orders: 4, cpa: 25, roas: 3.4 });
  assert.equal(decideStoreAdset(win, S, { now: new Date("2026-09-23T10:00:00Z") }).action, "note");
  assert.equal(decideStoreAdset({ ...win, learning: { status: "LEARNING", learning: true, done: false } }, S, { now: NOW }).action, "note");
  assert.equal(decideStoreAdset({ ...win, learning: null }, S, { now: NOW }).action, "note");   // ميتا من غير دليل خروج
  assert.equal(decideStoreAdset(win, S, { now: NOW, emergency: true }).action, "note");
});

test("سقف الحملة: maxCampaignBudget بيقص الزيادة", () => {
  const d = decideStoreAdset(base({ spend: 100, orders: 4, cpa: 25, roas: 3.4, dailyBudget: 170 }), S, { now: NOW });
  assert.equal(d.action, "scale");
  assert.equal(d.detail.to, 180);
  assert.equal(decideStoreAdset(base({ spend: 100, orders: 4, cpa: 25, roas: 3.4, dailyBudget: 180 }), S, { now: NOW }).action, "note");
});

test("حكم مبكر، صرف غير مقروء، M1، شباك أقل من 3 أيام، أرقام بتستقر", () => {
  assert.equal(decideStoreAdset(base({ spend: 300, ageHours: 40 }), S, { now: NOW }).action, "note");
  assert.equal(decideStoreAdset(base({ spend: null }), S, { now: NOW }).action, "none");
  assert.equal(decideStoreAdset(base({ key: "M1" }), S, { now: NOW }).action, "none");
  assert.equal(decideStoreAdset(base({ spend: 240, orders: 4, cpa: 60, days: 2 }), S, { now: NOW }).action, "note");
  assert.equal(decideStoreAdset(base({ spend: 250, orders: 0, atc: 1, settling: true }), S, { now: NOW }).action, "note");
});

test("الدالة مابتعدّلش المدخلات", () => {
  const row = base({ spend: 100, orders: 4, cpa: 25, roas: 3.4 });
  const copy = JSON.parse(JSON.stringify(row));
  const rows = snap();
  const rowsCopy = JSON.parse(JSON.stringify(rows));
  decideStoreAdset(row, S, { now: NOW, rows });
  assert.deepEqual(row, copy);
  assert.deepEqual(rows, rowsCopy);
});

/* ═══ التسجيل في الدورة — pending في suggest بس ═════════════════════════════ */

function fakeApp() {
  const noop = () => {};
  return { get: noop, post: noop, put: noop, delete: noop, patch: noop, use: noop, all: noop };
}
function fakePool({ open = [] } = {}) {
  const inserts = [];
  const pool = {
    async query(sql, params = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (/^INSERT INTO ap_decisions/i.test(s)) { inserts.push({ sql: s, params }); return { rows: [], rowCount: 1 }; }
      if (/FROM ads_plan_lines/i.test(s)) {
        return { rows: [
          { id: "M2", platform: "meta", platform_campaign_id: "C1", platform_adset_id: "A1" },
          { id: "M3", platform: "meta", platform_campaign_id: "C3", platform_adset_id: "A3" },
        ] };
      }
      if (/kind='store_rule' AND status='pending'/i.test(s)) return { rows: open };
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool, inserts };
}
function makeApi({ pool, adsplan }) {
  const ctx = {
    pool, requireAdmin: async () => null, jb: (v) => JSON.stringify(v ?? null),
    todayISO: () => "2026-09-19", daysAgoISO: (n) => new Date(Date.parse("2026-09-19") - n * 86400000).toISOString().slice(0, 10),
  };
  return register(fakeApp(), ctx, { adsplan });
}
const facts = {
  campaigns: [
    { platform: "meta", id: "C1", name: "FC-96-WEB-ABO", status: "ACTIVE", dailyBudget: null,
      adsets: [{ id: "A1", name: "M2 adset", status: "ACTIVE", dailyBudget: 90, learning: { done: true } }] },
    { platform: "meta", id: "C3", name: "FC-96-RMK-ABO", status: "ACTIVE", dailyBudget: null,
      adsets: [{ id: "A3", name: "M3 adset", status: "ACTIVE", dailyBudget: 60, learning: { done: true } }] },
  ],
};
const perfRows = [
  { key: "M1", platform: "meta", spend: 400, orders: 0, atc: 0, cpa: null, roas: null },
  { key: "M2", platform: "meta", spend: 260, orders: 0, atc: 3, cpa: null, roas: null },      // kill
  { key: "M3", platform: "meta", spend: 240, orders: 4, atc: 20, cpa: 60, roas: 1.1 },        // cut
];

test("runStoreRules: suggest → kind=store_rule بحالة pending، ومفيش تنفيذ", async () => {
  const { pool, inserts } = fakePool();
  let calls = 0;
  const adsplan = { performance: async (q) => { calls++; assert.equal(q.by, "line"); return { rows: perfRows }; } };
  const api = makeApi({ pool, adsplan });
  const r = await api.runStoreRules("run-1", { ...S, mode: "suggest" }, facts, new Set());
  assert.equal(calls, 1);
  assert.equal(r.recorded, 2);
  assert.equal(inserts.length, 2);
  for (const ins of inserts) {
    assert.match(ins.sql, /'store_rule'/);
    assert.match(ins.sql, /'pending'\)$/);
    assert.doesNotMatch(ins.sql, /executed_at/);
  }
  const actions = inserts.map((x) => JSON.parse(x.params[5]).action).sort();
  assert.deepEqual(actions, ["cut", "kill"]);
  assert.deepEqual(inserts.map((x) => x.params[3]).sort(), ["A1", "A3"]);
});

test("runStoreRules: auto/off → مفيش تسجيل خالص (مابيطبّقش أوتوماتيك)", async () => {
  for (const mode of ["auto", "off"]) {
    const { pool, inserts } = fakePool();
    let calls = 0;
    const api = makeApi({ pool, adsplan: { performance: async () => { calls++; return { rows: perfRows }; } } });
    const r = await api.runStoreRules("run-2", { ...S, mode }, facts, new Set());
    assert.equal(r.skipped, `mode=${mode}`);
    assert.equal(calls, 0);
    assert.equal(inserts.length, 0);
  }
});

test("runStoreRules: اقتراح pending مفتوح لنفس المجموعة والفعل → مايتكررش؛ ومن غير adsplan → skip", async () => {
  const { pool, inserts } = fakePool({ open: [{ platform: "meta", campaign_id: "A1", action: "kill" }] });
  const api = makeApi({ pool, adsplan: () => ({ performance: async () => ({ rows: perfRows }) }) });
  const r = await api.runStoreRules("run-3", S, facts, new Set());
  assert.equal(r.recorded, 1);
  assert.equal(JSON.parse(inserts[0].params[5]).action, "cut");

  const bare = makeApi({ pool: fakePool().pool, adsplan: null });
  assert.equal((await bare.runStoreRules("run-4", S, facts, new Set())).skipped, "adsplan غير مربوط");
});

/* ═══ مراجعة W1-08 — ثغرات اتقفلت ═══════════════════════════════════════════ */

test("صرف كبير على طلب أو اتنين مش «عيّنة رفيعة» → kill", () => {
  assert.equal(decideStoreAdset(base({ spend: 600, orders: 2, atc: 40, cpa: 300 }), S, { now: NOW }).action, "kill");
  assert.equal(decideStoreAdset(base({ spend: 250, orders: 1, atc: 40, cpa: 250 }), S, { now: NOW }).action, "kill");
});

test("القص مايترفضش بسبب السقف الكلي لو الحساب أصلاً فوقه", () => {
  const d = decideStoreAdset(base({ spend: 240, orders: 4, atc: 30, cpa: 60, roas: 1 }), S,
    { now: NOW, rows: snap(100, 400), hardCap: 150 });
  assert.equal(d.action, "cut");
  // والتوسيع على نفس اللقطة مرفوض
  assert.equal(decideStoreAdset(base({ spend: 100, orders: 4, cpa: 25, roas: 3.4 }), S,
    { now: NOW, rows: snap(100, 400) }).action, "note");
});

test("runStoreRules: طوارئ مفتوحة → مفيش scale؛ والتوسيع بيتحكم بـROAS ٧ أيام", async () => {
  const win = [{ key: "M2", platform: "meta", spend: 100, orders: 4, atc: 30, cpa: 25, roas: 3.4 }];
  const run = async ({ emergency = false, roas7 = 3.4 } = {}) => {
    const { pool, inserts } = fakePool();
    const q = pool.query.bind(pool);
    pool.query = async (sql, params) => (/kind='emergency'/.test(sql) ? { rows: emergency ? [{ "?column?": 1 }] : [] } : q(sql, params));
    const froms = [];
    const adsplan = { performance: async ({ from }) => { froms.push(from); return { rows: froms.length > 1 ? [{ ...win[0], roas: roas7 }] : win }; } };
    const r = await makeApi({ pool, adsplan }).runStoreRules("run-x", S, facts, new Set());
    return { r, inserts, froms };
  };
  const ok = await run();
  assert.equal(ok.inserts.length, 1);
  assert.equal(JSON.parse(ok.inserts[0].params[5]).action, "scale");
  assert.equal(ok.froms.length, 2);
  assert.equal(ok.froms[1], "2026-09-13");
  assert.equal((await run({ roas7: 1.5 })).inserts.length, 0);
  assert.equal((await run({ emergency: true })).inserts.length, 0);
});
