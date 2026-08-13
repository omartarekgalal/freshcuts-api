/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات الميزانية على مستوى المجموعة الإعلانية (ABO)

   المشكلة اللي بنصلّحها: الإيقاع كان بيشتغل على `dailyBudget != null` وبس،
   يعني الحملات اللي ميزانيتها على مستوى المجموعة كانت **مالهاش وجود** عنده
   — لا بيرفعها ولا بيرجّعها. وده مش تفصيلة: أحسن مجموعتين في الحساب كله
   (fc-wa-walkin-5km و fc-wa-delivery-10km) عايشين جوّه حملة ABO.

   البيانات: fixtures/meta-insights.json — لقطة حقيقية من Graph API v25.
   المجموعتين موجودين فيها بأرقام المالك الحقيقية: 3500 و1500 هللة = ٣٥ و١٥ ر.س.

   ملحوظة أمانة: اللقطة **مفيهاش** `learning_stage_info` (اتسجّلت قبل ما
   نطلب الحقل ده). فمرحلة التعلّم هنا بُعد **مركّب** بنحطه فوق مجموعات
   حقيقية عشان نجرّب المنطق — الأرقام والأسماء والحالات والهيكل كلها حقيقية،
   مرحلة التعلّم هي الوحيدة المفترَضة، ومكتوب ده صراحة في كل اختبار بيستعملها.

     node --test abo.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  paceTargetsOf, targetKeyOf, absorptionOf, activeBudgetOf, effectiveBudgetOf,
  guardBudget, decidePace, ADSET_MAX_STEP_PCT,
} from "./autopilot.js";

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/meta-insights.json", import.meta.url), "utf8"));

const WA = "120249876003980593";          // fc-wa-orders — ABO
const WALKIN = "120249876093640593";      // fc-wa-walkin-5km   → ٣٥ ر.س
const DELIVERY = "120249876095170593";    // fc-wa-delivery-10km → ١٥ ر.س

/* صفوف زي ما perfSnapshot بيبنيها بالظبط: كل حملة ومعاها مجموعاتها. */
function rowsFromFixture({ learning = {} } = {}) {
  return FX.campaigns.map((c) => ({
    platform: "meta", id: c.id, name: c.name, status: c.status,
    dailyBudget: c.daily_budget != null ? Number(c.daily_budget) / 100 : null,
    spend: 50, results: 10,
    adsets: FX.adsets.filter((a) => a.campaign_id === c.id).map((a) => ({
      platform: "meta", id: a.id, name: a.name, campaignId: a.campaign_id,
      status: a.status,
      dailyBudget: a.daily_budget != null ? Number(a.daily_budget) / 100 : null,
      spend: 20, spendToday: 20, results: 30,
      learning: learning[a.id] || null,
    })),
  }));
}

const LIVE = {
  targetCpa: 22, targetRoas: 3, minSpend: 50, minAgeDays: 7,
  scaleStepPct: 30, cutStepPct: 30, maxChangePct: 30,
  killMultiple: 3, killCpa: 66, maxCampaignBudget: 350, maxTotalBudget: 606,
  budgetCooldownHours: 24,
};

/* ═══ ١. فين الميزانية أصلاً ═══════════════════════════════════════════ */

test("حملة ABO بتتفكّ لمجموعاتها الشغالة — بأرقام المالك ٣٥ و١٥", () => {
  const rows = rowsFromFixture();
  const targets = paceTargetsOf(rows);
  const wa = targets.filter((t) => t.campaignId === WA);

  assert.equal(wa.length, 2, "المجموعة الموقوفة (fc-wa-winback) مش هدف");
  assert.deepEqual(wa.map((t) => t.level), ["adset", "adset"]);
  const byId = Object.fromEntries(wa.map((t) => [t.id, t]));
  assert.equal(byId[WALKIN].dailyBudget, 35);
  assert.equal(byId[WALKIN].name, "fc-wa-walkin-5km");
  assert.equal(byId[DELIVERY].dailyBudget, 15);
  assert.equal(byId[DELIVERY].name, "fc-wa-delivery-10km");
  // الحملة نفسها مش هدف — ميزانيتها مش موجودة أصلاً
  assert.equal(targets.some((t) => t.id === WA), false);
});

test("حملة CBO بتفضل هدف واحد على مستوى الحملة", () => {
  const targets = paceTargetsOf(rowsFromFixture());
  const asc = targets.filter((t) => t.campaignName === "fc-prospect-asc");
  assert.equal(asc.length, 1);
  assert.equal(asc[0].level, "campaign");
  assert.equal(asc[0].dailyBudget, 50);
});

test("الإيقاع كان بيشوف ١١٠ ر.س والحقيقة ٢٩٠ — والفرق كله ABO", () => {
  const rows = rowsFromFixture();
  const active = rows.filter((r) => r.status === "ACTIVE");
  const oldView = active.filter((r) => r.dailyBudget != null)
    .reduce((a, r) => a + r.dailyBudget, 0);
  assert.equal(oldView, 110);
  assert.equal(activeBudgetOf(active), 290);

  // واللي كان خارج المتناول تماماً = ١٨٠ ر.س، منهم ٥٠ في fc-wa-orders
  const targets = paceTargetsOf(rows);
  const adsetMoney = targets.filter((t) => t.level === "adset")
    .reduce((a, t) => a + t.dailyBudget, 0);
  assert.equal(adsetMoney, 180);
  assert.equal(targets.filter((t) => t.campaignId === WA)
    .reduce((a, t) => a + t.dailyBudget, 0), 50);
});

test("effectiveBudgetOf بيجمع المجموعات الشغالة بس", () => {
  const rows = rowsFromFixture();
  const wa = rows.find((r) => r.id === WA);
  assert.equal(effectiveBudgetOf(wa), 50);          // ٣٥ + ١٥، والموقوفة (٤٠) مش داخلة
});

/* ═══ ٢. مين يقدر يبلع الفلوس ═══════════════════════════════════════════ */
/* مرحلة التعلّم هنا **مركّبة** — اللقطة مفيهاش الحقل ده. */

test("المتخنقة في التعلّم مش بتتاخد، واللي خلصت تعلّمها بتتاخد", () => {
  const done = absorptionOf({ name: "خلصت", dailyBudget: 35, spendToday: 34,
    learning: { done: true, limited: false, learning: false } });
  assert.equal(done.absorbs, true);
  assert.match(done.why, /خارجة من التعلّم/);

  const limited = absorptionOf({ name: "متخنقة", dailyBudget: 80, spendToday: 78,
    learning: { done: false, limited: true, learning: false } });
  assert.equal(limited.absorbs, false);
  assert.match(limited.why, /متخنقة في التعلّم/);
  assert.match(limited.why, /مبتزوّدش صرف حقيقي/);
});

test("اللي مش بياكل ميزانيته الحالية مبنزوّدهاش", () => {
  /* الدرس العملي من ليلة ١٢ أغسطس: ضاعفنا ٣ حملات والصرف الإضافي طلع صفر. */
  const starved = absorptionOf({ name: "مش بتصرف", dailyBudget: 100, spendToday: 20,
    learning: { done: true } });
  assert.equal(starved.absorbs, false);
  assert.match(starved.why, /لسه مش بتاكل اللي معاها/);
  assert.match(starved.why, /المفروض يكونوا اتصرفوا/);
});

test("نسبة الامتلاء بتتقاس على الجزء اللي عدّى من اليوم مش على اليوم كله", () => {
  /* الساعة اللي عدّى فيها ربع يوم الحساب: مجموعة صارفة ٩ من ٣٥ ر.س بتكون
     ماشية مظبوط (المفروض ٨٫٧٥). من غير التطبيع كانت هتتقري ٢٦٪ = «متخنقة»
     وكل رفع الصبح كان هيتقفل. */
  const t = { name: "ماشية مظبوط", dailyBudget: 35, spendToday: 9, learning: null };
  assert.equal(absorptionOf(t, { dayFraction: 0.25 }).absorbs, true);
  assert.equal(absorptionOf(t, { dayFraction: 1 }).absorbs, false);

  /* واللي فعلاً متخنقة بتفضل متخنقة مهما كان الوقت. */
  const dead = { name: "متخنقة", dailyBudget: 35, spendToday: 1, learning: null };
  assert.equal(absorptionOf(dead, { dayFraction: 0.25 }).absorbs, false);
});

test("مفيش قراءة صرف ≠ صفر صرف — البوابة مبتتقفلش على عمى", () => {
  const blind = { name: "مش مقروءة", dailyBudget: 35, spendToday: null, learning: null };
  assert.equal(absorptionOf(blind).absorbs, true);
  assert.match(absorptionOf(blind).why, /مفيش قراءة صرف/);

  const zero = { name: "صفر حقيقي", dailyBudget: 35, spendToday: 0, learning: null };
  assert.equal(absorptionOf(zero).absorbs, false);
});

test("حملة CBO بتورث حالة التعلّم من مجموعاتها — درس ليلة ١٢ أغسطس", () => {
  /* ليلة ١٢ أغسطس: ضاعفنا ٣ حملات CBO والصرف الإضافي طلع **صفر**، لإن
     مجموعاتها كلها كانت لسه بتتعلّم. الميزانية على الحملة بس التعلّم عند
     المجموعات — فلازم الحملة ترث حالتهم وإلا بنكرر نفس الغلط.
     (مرحلة التعلّم مركّبة — اللقطة مفيهاش الحقل.) */
  const rows = rowsFromFixture({
    learning: Object.fromEntries(FX.adsets.map((a) => [a.id, { limited: true }])),
  }).map((r) => ({ ...r, adsets: r.adsets.map((a) => ({ ...a, spendToday: a.dailyBudget })) }));

  const asc = paceTargetsOf(rows).find((t) => t.name === "fc-prospect-asc");
  assert.equal(asc.level, "campaign");
  assert.equal(asc.learning.limited, true, "كل مجموعاتها متخنقة → الحملة متخنقة");
  assert.equal(absorptionOf(asc).absorbs, false);

  // ولو مجموعة واحدة بس خلصت تعلّمها، الحملة بقت تقدر تستوعب
  const mixed = rowsFromFixture({
    learning: { "120249864865030593": { done: true } },     // fc-prospect-asc-broad-12km
  }).map((r) => ({ ...r, adsets: r.adsets.map((a) => ({ ...a, spendToday: a.dailyBudget })) }));
  const asc2 = paceTargetsOf(mixed).find((t) => t.name === "fc-prospect-asc");
  assert.equal(asc2.learning.done, true);
  assert.equal(absorptionOf(asc2).absorbs, true);
});

test("الترتيب بيقدّم اللي بيصرف فعلاً على اللي متخنق", () => {
  const rank = (t) => absorptionOf(t).rank;
  const good = { name: "أ", dailyBudget: 35, spendToday: 35, learning: { done: true } };
  const learning = { name: "ب", dailyBudget: 35, spendToday: 35, learning: { learning: true } };
  const limited = { name: "ج", dailyBudget: 35, spendToday: 35, learning: { limited: true } };
  assert.ok(rank(good) > rank(learning));
  assert.ok(rank(learning) > rank(limited));
});

/* ═══ ٣. الأسوار على مستوى المجموعة ═══════════════════════════════════ */

test("خطوة أكبر من ١٩٪ على مجموعة مرفوضة — ميتا بتصفّر التعلّم", () => {
  const rows = rowsFromFixture();
  const ok = { writeOk: true, cooldown: new Set(), hardCap: 2000 };
  // ٣٥ → ٤١ = ١٧٪ → مسموح
  assert.equal(guardBudget({ platform: "meta", campaignId: WALKIN, amount: 41, level: "adset" }, LIVE, rows, ok), null);
  // ٣٥ → ٤٤ = ٢٦٪ → مرفوض رغم إن maxChangePct = ٣٠
  const no = guardBudget({ platform: "meta", campaignId: WALKIN, amount: 44, level: "adset" }, LIVE, rows, ok);
  assert.match(no, /فوق أقصى تغيير مسموح/);
  assert.match(no, /بتصفّر التعلّم/);
  assert.equal(ADSET_MAX_STEP_PCT, 19);
});

test("سقف الحملة الواحدة بيتقاس على مجموع المجموعات", () => {
  const rows = rowsFromFixture();
  const ok = { writeOk: true, cooldown: new Set(), hardCap: 2000 };
  /* سقف ٤٠ ر.س للحملة: fc-wa-orders مجموعها ٥٠ خلاص، فأي رفع مرفوض
     بالمجموع مش بالمجموعة لوحدها (١٥ لوحدها تحت الـ ٤٠). */
  const tight = { ...LIVE, maxCampaignBudget: 40 };
  const no = guardBudget({ platform: "meta", campaignId: DELIVERY, amount: 17, level: "adset" }, tight, rows, ok);
  assert.match(no, /مجموع مجموعات/);
  assert.match(no, /سقف الحملة الواحدة/);
});

test("الكتابة على حملة ABO نفسها مرفوضة، والرفض بيقول تكتب على إيه", () => {
  const rows = rowsFromFixture();
  const no = guardBudget({ platform: "meta", campaignId: WA, amount: 60 }, LIVE, rows,
    { writeOk: true, cooldown: new Set(), hardCap: 2000 });
  assert.match(no, /على مستوى المجموعة الإعلانية مش الحملة/);
  assert.match(no, /fc-wa-walkin-5km/);
  assert.match(no, /fc-wa-delivery-10km/);
});

test("السقف الكلي لسه بيربط على مستوى المجموعة", () => {
  const rows = rowsFromFixture();
  const capped = { ...LIVE, maxTotalBudget: 295 };     // الشغّال ٢٩٠
  const no = guardBudget({ platform: "meta", campaignId: WALKIN, amount: 41, level: "adset" }, capped, rows,
    { writeOk: true, cooldown: new Set(), hardCap: 2000 });
  assert.match(no, /فوق السقف الكلي/);
});

test("المستوى الغلط في الطلب بيترفض بدل ما يتنفّذ على الحاجة الغلط", () => {
  const rows = rowsFromFixture();
  const no = guardBudget({ platform: "meta", campaignId: WALKIN, amount: 40, level: "campaign" }, LIVE, rows,
    { writeOk: true, cooldown: new Set(), hardCap: 2000 });
  assert.match(no, /الرقم والمستوى لازم يتفقوا/);
});

/* ═══ ٤. الاسترجاع — الاختبار اللي كل ده عشانه ═══════════════════════ */

const paceInput = (over = {}) => ({
  accountDay: "2026-08-13", msToRoll: 6 * 3600_000,
  now: new Date("2026-08-13T17:00:00+03:00"),
  pulse: { pace: 1, pacePct: 35, riyadhHour: 20, riyadhMinute: 0, dow: 4, elapsedH: 16,
           today: { orders: 30, revenue: 2400 }, baseline: { days: 5, orders: 20, revenue: 1750 },
           confidence: { note: "" } },
  confirmed: { redemptions: 0, linkedOrders: 4 },
  ...over,
  s: { ...LIVE, pacing: true, paceStartHour: 13, paceLastRaiseHour: 1,
       paceUpThresholdPct: 20, paceDownThresholdPct: -15, paceMinBaselineDays: 2,
       paceMinOrders: 6, maxTotalBudget: 606, ...(over.s || {}) },
});

test("الإيقاع بقى يوصل المجموعتين — وبخطوة ≤ ١٩٪", () => {
  /* الاتنين خلصوا تعلّم وبيصرفوا ميزانيتهم (مركّب). */
  const learning = { [WALKIN]: { done: true }, [DELIVERY]: { done: true } };
  const rows = rowsFromFixture({ learning }).map((r) => ({
    ...r, adsets: r.adsets.map((a) => ({ ...a, spendToday: a.dailyBudget })),
  }));
  const out = decidePace(paceInput({ rows, state: new Map() }));
  const ups = out.actions.filter((a) => a.op === "up" && a.level === "adset");
  assert.ok(ups.length >= 1, "لازم يوصل المجموعات دلوقتي");

  const walkin = ups.find((a) => a.campaignId === WALKIN);
  assert.ok(walkin, "fc-wa-walkin-5km لازم تبقى في المتناول");
  assert.equal(walkin.from, 35);
  assert.ok((walkin.to - 35) / 35 * 100 <= ADSET_MAX_STEP_PCT + 0.001,
    `الخطوة ${walkin.to} من ٣٥ لازم تفضل ≤ ١٩٪`);
  assert.equal(walkin.parentId, WA);
  assert.match(walkin.reason, /المجموعة الإعلانية/);
});

test("الاسترجاع بيرجّع ٣٥ و١٥ بالظبط بعد ما يوم الحساب يلف", () => {
  /* ده بالظبط اللي كان ناقص: زيادة على مجموعة مبترجعش = بتبقى أساس اليوم
     اللي بعده في صمت. الليلة اللي فاتت المجموعتين كانوا على ٤١ و١٧. */
  const rows = rowsFromFixture().map((r) => (r.id !== WA ? r : {
    ...r,
    adsets: r.adsets.map((a) => (a.id === WALKIN ? { ...a, dailyBudget: 41 }
      : a.id === DELIVERY ? { ...a, dailyBudget: 17 } : a)),
  }));

  /* الدفتر زي ما pacingState بيبنيه: المستوى متسجّل، والأساس رقم المالك. */
  const state = new Map();
  for (const [id, base, cur] of [[WALKIN, 35, 41], [DELIVERY, 15, 17]]) {
    const e = { platform: "meta", campaignId: id, campaignName: null, level: "adset",
      parentId: WA, accountDay: "2026-08-12", baseBudget: base, currentBudget: cur,
      steps: 1, lastActionAt: Date.parse("2026-08-12T20:00:00Z") };
    state.set(`meta:adset:${id}`, e);
  }

  // يوم حساب جديد → الزيادات بقت قديمة → استرجاع متأخر
  const out = decidePace(paceInput({ rows, state, accountDay: "2026-08-13" }));
  const back = out.actions.filter((a) => a.op === "restore");
  assert.equal(back.length, 2, "الاتنين لازم يرجعوا");

  const byId = Object.fromEntries(back.map((a) => [a.campaignId, a]));
  assert.equal(byId[WALKIN].to, 35, "fc-wa-walkin-5km لازم ترجع ٣٥");
  assert.equal(byId[WALKIN].from, 41);
  assert.equal(byId[WALKIN].level, "adset");
  assert.equal(byId[DELIVERY].to, 15, "fc-wa-delivery-10km لازم ترجع ١٥");
  assert.equal(byId[DELIVERY].from, 17);
  assert.equal(byId[DELIVERY].level, "adset");
  // أسماء المجموعات بتتقري من اللقطة مش من الدفتر
  assert.equal(byId[WALKIN].campaignName, "fc-wa-walkin-5km");
});

test("رفع ثم لفّة يوم الحساب = رجوع للأساس بالظبط (الدورة كاملة)", () => {
  const learning = { [WALKIN]: { done: true }, [DELIVERY]: { done: true } };
  let rows = rowsFromFixture({ learning }).map((r) => ({
    ...r, adsets: r.adsets.map((a) => ({ ...a, spendToday: a.dailyBudget })),
  }));
  const state = new Map();

  // (١) الرفع
  const up = decidePace(paceInput({ rows, state }));
  const ups = up.actions.filter((a) => a.op === "up" && a.level === "adset");
  assert.ok(ups.length > 0);
  for (const a of ups) {
    state.set(`meta:adset:${a.campaignId}`, {
      platform: "meta", campaignId: a.campaignId, campaignName: a.campaignName,
      level: "adset", parentId: a.parentId, accountDay: a.accountDay,
      baseBudget: a.base, currentBudget: a.to, steps: 1, lastActionAt: Date.now(),
    });
    rows = rows.map((r) => (r.id !== WA ? r : {
      ...r, adsets: r.adsets.map((x) => (x.id === a.campaignId ? { ...x, dailyBudget: a.to } : x)),
    }));
  }
  const raised = paceTargetsOf(rows).filter((t) => t.campaignId === WA);
  assert.ok(raised.reduce((s, t) => s + t.dailyBudget, 0) > 50, "فعلاً اترفعوا");

  // (٢) اللفّة — نافذة الاسترجاع قبل ما يوم الحساب يقفل
  const done = decidePace(paceInput({ rows, state, msToRoll: 10 * 60_000 }));
  assert.equal(done.phase, "restore");
  const back = Object.fromEntries(done.actions.filter((a) => a.op === "restore")
    .map((a) => [a.campaignId, a.to]));
  assert.equal(back[WALKIN], 35);
  assert.equal(back[DELIVERY], 15);
});

test("الزيادات القديمة اللي اتسجّلت قبل عمود level لسه بترجع", () => {
  /* دفتر قديم: مفيش `level`، والمفتاح من غير مستوى. لازم يفضل يشتغل وإلا
     بنكون سبنا فلوس شغّالة محدش بيرجّعها. */
  const rows = rowsFromFixture();
  const asc = rows.find((r) => r.name === "fc-prospect-asc");
  const bumped = rows.map((r) => (r.id === asc.id ? { ...r, dailyBudget: 65 } : r));
  const state = new Map([[`meta:${asc.id}`, {
    platform: "meta", campaignId: asc.id, campaignName: asc.name,
    accountDay: "2026-08-12", baseBudget: 50, currentBudget: 65,
    steps: 1, lastActionAt: Date.parse("2026-08-12T20:00:00Z"),
  }]]);
  const out = decidePace(paceInput({ rows: bumped, state, accountDay: "2026-08-13" }));
  const back = out.actions.find((a) => a.op === "restore" && a.campaignId === asc.id);
  assert.ok(back, "الزيادة القديمة لازم ترجع");
  assert.equal(back.to, 50);
});

/* ═══ ٥. السقف لسه بيربط بعد ما فتحنا ABO ═══════════════════════════ */

test("يوم كل حاجة فيه ممتازة: المجموع لسه بيقف عند السقف", () => {
  const learning = Object.fromEntries(FX.adsets.map((a) => [a.id, { done: true }]));
  let rows = rowsFromFixture({ learning }).map((r) => ({
    ...r, adsets: r.adsets.map((a) => ({ ...a, spendToday: a.dailyBudget })),
  }));
  const ceiling = 330;
  const state = new Map();

  for (let i = 0; i < 30; i++) {
    const out = decidePace(paceInput({ rows, state, s: { maxTotalBudget: ceiling } }));
    const moves = out.actions.filter((a) => a.op === "up");
    if (!moves.length) break;
    for (const a of moves) {
      state.set(`meta:${a.level}:${a.campaignId}`, {
        platform: "meta", campaignId: a.campaignId, level: a.level, parentId: a.parentId,
        accountDay: a.accountDay, baseBudget: a.base, currentBudget: a.to,
        steps: 1, lastActionAt: 0,          // تبريد عدّى
      });
      rows = rows.map((r) => {
        if (a.level === "campaign" && r.id === a.campaignId) return { ...r, dailyBudget: a.to };
        if (a.level === "adset") return { ...r, adsets: r.adsets.map((x) => (x.id === a.campaignId ? { ...x, dailyBudget: a.to } : x)) };
        return r;
      });
    }
    const total = activeBudgetOf(rows.filter((r) => r.status === "ACTIVE"));
    assert.ok(total <= ceiling + 0.5, `الجولة ${i}: ${total} عدّى السقف ${ceiling}`);
  }
  const total = activeBudgetOf(rows.filter((r) => r.status === "ACTIVE"));
  assert.ok(total > 290, "لازم يكون كبّر فعلاً");
  assert.ok(total <= ceiling + 0.5, `المجموع النهائي ${total} لازم ≤ ${ceiling}`);
});

/* ═══ ٦. اللقطة التانية — بيانات حقيقية فيها مرحلة التعلّم ═══════════ */

test("اللقطة الحيّة: المجموعتين على أرقام المالك ٣٥ و١٥ بالظبط", () => {
  /* اتسجّلت من /api/ads/adsets يوم ٢٠٢٦-٠٨-١٣ بعد ما المنسّق رجّعهم —
     يعني دي قراءة-رجوع حقيقية مش كلام. */
  const live = FX.adsetsLive.adsets;
  const walkin = live.find((a) => a.name === "fc-wa-walkin-5km");
  const delivery = live.find((a) => a.name === "fc-wa-delivery-10km");
  assert.equal(walkin.dailyBudget, 35);
  assert.equal(delivery.dailyBudget, 15);
  assert.equal(walkin.status, "ACTIVE");
  assert.equal(delivery.status, "ACTIVE");
  assert.equal(walkin.campaignId, WA);
});

test("اللقطة الحيّة: الإيقاع بيوصل المجموعتين، والمتعلّمة بتتساب", () => {
  /* ميتا **مبترجّعش** learning_stage_info للمجموعتين بتوع واتساب (مش في
     مرحلة تعلّم)، وبترجّع LEARNING لـ fc-leads-broad-8km. فالتفرقة هنا
     بيانات حقيقية مش تركيب. */
  const live = FX.adsetsLive.adsets;
  const byCampaign = {};
  for (const a of live) (byCampaign[a.campaignId] ||= []).push(a);

  const rows = Object.entries(byCampaign).map(([cid, kids]) => {
    const c = FX.campaigns.find((x) => x.id === cid);
    return {
      platform: "meta", id: cid, name: c?.name || cid, status: "ACTIVE",
      dailyBudget: c?.daily_budget != null ? Number(c.daily_budget) / 100 : null,
      spend: 100, results: 20,
      adsets: kids.map((a) => ({
        platform: "meta", id: a.id, name: a.name, campaignId: cid, status: a.status,
        dailyBudget: a.dailyBudget, learning: a.learning,
        spend: a.recent?.spend ?? 0,
        /* صرف النهارده مش مقروء في اللقطة دي (الشباك ٣ أيام) — فبنسيبه
           null عن قصد، واللي بيثبت إن البوابة مبتتقفلش على عمى. */
        spendToday: null,
      })),
    };
  });

  const targets = paceTargetsOf(rows);
  const wa = targets.filter((t) => t.campaignId === WA);
  assert.deepEqual(wa.map((t) => t.name).sort(), ["fc-wa-delivery-10km", "fc-wa-walkin-5km"]);
  assert.deepEqual(wa.map((t) => t.dailyBudget).sort((a, b) => a - b), [15, 35]);
  for (const t of wa) assert.equal(absorptionOf(t).absorbs, true, `${t.name} لازم تبقى في المتناول`);

  /* fc-leads-broad-8km مرجّعة LEARNING فعلاً من ميتا — بتتاخد بخطوة صغيرة
     مش بتتمنع، لإنها بتصرف. اللي بيتمنع هو LEARNING_LIMITED. */
  const leads = targets.find((t) => t.name === "fc-leads-broad-8km");
  assert.equal(leads.learning.status, "LEARNING");
  assert.equal(leads.level, "adset");
  assert.equal(leads.dailyBudget, 90);
});

test("مفتاح الهدف بيفرّق بين الحملة والمجموعة", () => {
  assert.equal(targetKeyOf({ platform: "meta", level: "adset", id: "1" }), "meta:adset:1");
  assert.equal(targetKeyOf({ platform: "meta", level: "campaign", id: "1" }), "meta:campaign:1");
});
