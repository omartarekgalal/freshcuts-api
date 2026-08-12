/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات الإيقاع اليومي — الفلوس دي حقيقية

   كل اختبار هنا بيشتغل على أيام حقيقية من ts_orders (fixtures/days.json =
   آخر ٧٠ يوم شغل، معمول منهم snapshot عشان الاختبار يجري من غير قاعدة
   بيانات). المنحنى بيتبني من الأيام اللي *قبل* اليوم اللي بنتوقّعه بس —
   لو بنينا المنحنى من نفس اليوم كنا هنقرا المستقبل ونطلع نتيجة كاذبة.

     node --test pacing.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildDayShape, shareAt, projectDayRevenue, movingCeiling, earnedCeiling, reconcileDay,
  deliveryEfficiency, platformScaling, decidePace, PACE_DEFAULTS, INTRADAY_DEFAULTS,
  spendDayNow, accountDayOf, ADS_ACCOUNT_TZ,
} from "./autopilot.js";

const DAYS = JSON.parse(fs.readFileSync(new URL("./fixtures/days.json", import.meta.url), "utf8"));
const byDay = new Map(DAYS.map((d) => [d.day, d]));
const before = (iso) => DAYS.filter((d) => d.day < iso);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const trailing7 = (iso) => {
  const p = before(iso).filter((d) => d.total > 0).slice(-7);
  return p.length ? mean(p.map((d) => d.total)) : null;
};
const shapeFor = (iso) => buildDayShape(before(iso), { lookbackDays: 56, minDowDays: 3 });
/* offset من يوم المطعم (٠ = ٤ صباحاً) لساعة حائط بالرياض */
const offsetOf = (clk) => ((Number(clk) - 4) + 24) % 24;

/* السقف زي ما السيرفر بيحسبه بالظبط، بس بمدخلات الاختبار.
   `highWater` بيحاكي الترباس المخزّن في ap_earned. */
function ceilingAt(iso, clk, { revOverride = null, ordersOverride = null, highWater = null, floorPct = 100 } = {}) {
  const d = byDay.get(iso);
  const e = offsetOf(clk);
  const rev = revOverride ?? d.cum[e - 1];
  const orders = ordersOverride ?? d.cumOrders[e - 1];
  const trailing = trailing7(iso);
  const projection = projectDayRevenue({
    shape: shapeFor(iso), dow: d.dow, elapsedH: e,
    revSoFar: rev, ordersSoFar: orders, trailingAvg: trailing,
    minSharePct: INTRADAY_DEFAULTS.projMinSharePct, minOrders: INTRADAY_DEFAULTS.projMinOrders,
  });
  const c = movingCeiling({
    trailing7Avg: trailing, sharePct: 20, hardMax: 2000, floor: 150, fallback: 1000, floorPct,
    earned: { revenueSoFar: rev, highWater: highWater ?? rev },
    projection,
  });
  return { ...c, projection, rev, orders, elapsedH: e };
}
/* سقف الأرضية لليوم ده — الرقم اللي السقف مبينزلش تحته */
const floorFor = (iso) => Math.max(150, Math.round(trailing7(iso) * 0.2));

/* ── ١. المنحنى نفسه: فريش كاتس مطعم ليلي ─────────────────────────────── */

test("منحنى اليوم: نص المبيعات بتحصل بعد ٨ بالليل", () => {
  const shape = buildDayShape(DAYS, { lookbackDays: 70, minDowDays: 3 });
  const at = (clk) => shareAt(shape, null, offsetOf(clk));
  assert.ok(at(15) < 0.10, `الساعة ٣ العصر المفروض أقل من ١٠٪، طلعت ${at(15)}`);
  assert.ok(at(17) < 0.25, `الساعة ٥ العصر المفروض أقل من ٢٥٪، طلعت ${at(17)}`);
  assert.ok(at(20) > 0.40 && at(20) < 0.60, `الساعة ٨ المفروض حوالي النص، طلعت ${at(20)}`);
  assert.ok(at(23) > 0.70, `الساعة ١١ بالليل المفروض فوق ٧٠٪، طلعت ${at(23)}`);
  // المنحنى لازم يبقى تصاعدي — حصة الساعة اللي بعدها عمرها ما تقل
  for (let i = 1; i < 24; i++) {
    assert.ok(shape.pooled[i] >= shape.pooled[i - 1] - 1e-9, `المنحنى رجع لورا عند الساعة ${i}`);
  }
});

test("shareAt بيملّس بين الساعتين مش بيقفز", () => {
  const shape = buildDayShape(DAYS, { lookbackDays: 70, minDowDays: 3 });
  const a = shareAt(shape, null, 15), b = shareAt(shape, null, 15.5), c = shareAt(shape, null, 16);
  assert.ok(b > a && b < c, `النص ساعة المفروض بين الساعتين: ${a} / ${b} / ${c}`);
});

/* ── ٢. القاعدة نفسها: ٢٠٪ من الدخل اللي دخل فعلاً ───────────────────── */

test("السقف = ٢٠٪ من دخل النهارده، بأرضية تحته", () => {
  const c = earnedCeiling({ revenueSoFar: 3000, sharePct: 20, floorCeiling: 290, hardMax: 2000, absoluteFloor: 150 });
  assert.equal(c.earned, 600);
  assert.equal(c.ceiling, 600);
  assert.equal(c.binding, "earned");

  const low = earnedCeiling({ revenueSoFar: 400, sharePct: 20, floorCeiling: 290, hardMax: 2000, absoluteFloor: 150 });
  assert.equal(low.earned, 80);
  assert.equal(low.ceiling, 290, "تحت الأرضية السقف بيقف على الأرضية");
  assert.equal(low.binding, "floor");
  assert.match(low.reason, /الإعلان لازم يشتغل قبل ما البيع ييجي/);
});

test("الخاصية اللي بتخلي القاعدة آمنة: الجزء المكتسب مستحيل يعدّي المستحق", () => {
  /* الادعاء: لأي يوم حقيقي وأي ساعة، ٢٠٪ من الدخل لحد دلوقتي ≤ ٢٠٪ من دخل
     اليوم كله. بنتحقق منه على كل يوم في العيّنة وكل ساعة فيه — من غير أرضية،
     عشان نقيس الجزء المكتسب لوحده. */
  for (const d of DAYS) {
    if (!(d.total > 0)) continue;
    const entitled = d.total * 0.2;
    for (let e = 1; e <= 24; e++) {
      const c = earnedCeiling({
        revenueSoFar: d.cum[e - 1], sharePct: 20,
        floorCeiling: 0, hardMax: 2000, absoluteFloor: 0,
      });
      assert.ok(c.earned <= entitled + 1,
        `${d.day} الساعة ${e}: المكتسب ${c.earned} عدّى المستحق ${entitled.toFixed(0)}`);
    }
  }
});

test("الترباس: مرتجع مبينزّلش السقف جوّه اليوم", () => {
  const before = earnedCeiling({ revenueSoFar: 2000, sharePct: 20, floorCeiling: 290 });
  assert.equal(before.ceiling, 400);
  // اتلغى طلب بـ ٦٠٠ ر.س → الدخل نزل، بس أعلى رقم شفناه لسه ٢٠٠٠
  const after = earnedCeiling({ revenueSoFar: 1400, highWaterRevenue: 2000, sharePct: 20, floorCeiling: 290 });
  assert.equal(after.ceiling, 400, "السقف مبيرجعش لورا");
  assert.equal(after.ratcheted, true);
  assert.match(after.reason, /مرتجع/);
});

test("الترباس مبيقصّش سقف تحت صرف اتعمل خلاص", () => {
  /* السيناريو الخطر: صرفنا ٣٩٠ ر.س على سقف ٤٠٠، وبعدين اتلغى طلب كبير.
     من غير ترباس السقف كان هينزل ٢٨٠ والوكيل هيقصّ ميزانيات على فلوس راحت. */
  const spentAlready = 390;
  const withRatchet = earnedCeiling({ revenueSoFar: 1400, highWaterRevenue: 2000, sharePct: 20, floorCeiling: 290 });
  const withoutRatchet = earnedCeiling({ revenueSoFar: 1400, sharePct: 20, floorCeiling: 290 });
  assert.ok(withRatchet.ceiling >= spentAlready, `السقف ${withRatchet.ceiling} لازم يفضل فوق الصرف ${spentAlready}`);
  assert.ok(withoutRatchet.ceiling < spentAlready, "ومن غير ترباس كان هينزل تحته — ده سبب وجوده");
});

test("إعادة تشغيل نص اليوم: الترباس محفوظ في القاعدة مش في الذاكرة", () => {
  /* بعد الريستارت الخدمة بتقرا ts_orders تاني (نفس الرقم) وبتقرا الترباس من
     ap_earned. اللي بنختبره هنا إن الدالة نفسها مالهاش ذاكرة داخلية: نفس
     المدخلات = نفس الناتج، فالحالة كلها جاية من بره وبتتخزّن. */
  const args = { revenueSoFar: 1400, highWaterRevenue: 2000, sharePct: 20, floorCeiling: 290 };
  assert.equal(earnedCeiling(args).ceiling, earnedCeiling(args).ceiling);
  // ولو الترباس ضاع (القاعدة مردّتش)، بنرجع للرقم الحيّ — أوطى بس مش كذّاب
  const lost = earnedCeiling({ revenueSoFar: 1400, highWaterRevenue: null, sharePct: 20, floorCeiling: 290 });
  assert.equal(lost.ceiling, 290);
});

test("التوقّع بقى للعرض بس — عمره ما بيحرّك السقف", () => {
  const withOutlook = movingCeiling({
    trailing7Avg: 1500, sharePct: 20, hardMax: 2000, floor: 150,
    earned: { revenueSoFar: 800, highWater: 800 },
    projection: { usable: true, projected: 9999, share: 40, reason: "اختبار" },
  });
  const without = movingCeiling({
    trailing7Avg: 1500, sharePct: 20, hardMax: 2000, floor: 150,
    earned: { revenueSoFar: 800, highWater: 800 },
    projection: null,
  });
  assert.equal(withOutlook.ceiling, without.ceiling, "توقّع ٩٬٩٩٩ ر.س المفروض ما يغيّرش ولا ريال");
  assert.equal(withOutlook.ceiling, 300, "الأرضية ٣٠٠ = ٢٠٪ من ١٥٠٠");
  assert.ok(withOutlook.outlook, "وبرضه بيترجع للعرض");
  assert.equal(withOutlook.outlook.projected, 9999);
});

test("طلب ضخم بدري بيرفع السقف بمقدار نسبته منه وبس", () => {
  /* تحت الموديل ده الطلب الشاذ مش خطر أصلاً: ٨٠٠ ر.س بيستحقوا ١٦٠ ر.س
     إعلانات — نسبتهم بالظبط — مش ٢٬٣٠٩ زي ما التوقّع كان هيطلّعهم. وهنا حتى
     مش بيحرّك السقف، لإن المكتسب لسه تحت الأرضية. */
  const plain = ceilingAt("2026-08-05", 16);
  const freak = ceilingAt("2026-08-05", 16, { revOverride: 245 + 800, ordersOverride: 5 });
  const floor = floorFor("2026-08-05");
  const projectionWouldSay = Math.round(((245 + 800) / (freak.projection.share / 100)) * 0.2);

  assert.equal(plain.ceiling, floor, "من غير الطلب الشاذ لسه على الأرضية");
  assert.equal(freak.ceiling, Math.max(floor, Math.round((245 + 800) * 0.2)));
  assert.ok(freak.ceiling - plain.ceiling <= 800 * 0.2 + 1,
    `الزيادة عمرها ما تعدّي ٢٠٪ من الطلب نفسه: +${freak.ceiling - plain.ceiling}`);
  assert.ok(projectionWouldSay > freak.ceiling * 2,
    `والتوقّع كان هيقول ${projectionWouldSay} — أضعاف الرقم ده`);
});

/* ── ٣. إعادة تشغيل اليومين المسمّيين ساعة بساعة ──────────────────────── */

test("أحسن يوم (الجمعة ٧ أغسطس، ٣٬٩١٧ ر.س): السقف بيفتح مع الدخل", () => {
  const floor = floorFor("2026-08-07");                  // ٢٩٠
  const path = [15, 17, 19, 21, 23, 1].map((clk) => ({ clk, ...ceilingAt("2026-08-07", clk) }));

  // بدري الدخل لسه صغير → الأرضية
  assert.equal(path[0].ceiling, floor);
  assert.equal(path[0].binding, "floor");

  // آخر الليل الدخل هو اللي بيحكم، والسقف تحت المستحق الحقيقي بالظبط
  const late = path.at(-1);
  assert.equal(late.binding, "earned");
  const entitled = Math.round(3916.93 * 0.2);            // ٧٨٣
  assert.ok(late.ceiling > floor * 2, `المفروض يعدّي ضعف الأرضية: ${late.ceiling} مقابل ${floor}`);
  assert.ok(late.ceiling <= entitled, `وعمره ما يعدّي المستحق: ${late.ceiling} > ${entitled}`);

  // ومبيرجعش لورا ولا مرة على مدار اليوم
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i].ceiling >= path[i - 1].ceiling,
      `السقف نزل: ${path[i - 1].clk}h=${path[i - 1].ceiling} → ${path[i].clk}h=${path[i].ceiling}`);
  }
});

test("أسوأ يوم (الأربعاء ٥ أغسطس، ٨٩٦ ر.س): السقف عمره ما فتح", () => {
  const floor = floorFor("2026-08-05");                  // ٣٢٣
  for (const clk of [15, 17, 19, 21, 23, 1]) {
    const c = ceilingAt("2026-08-05", clk);
    assert.equal(c.ceiling, floor, `الساعة ${clk} المفروض على الأرضية`);
    assert.equal(c.binding, "floor");
  }
  /* وده بالظبط التنازل اللي الموديل ده بيعمله: المستحق الحقيقي ١٧٩ ر.س
     والأرضية ٣٢٣ — يعني ١٤٤ ر.س فوق قاعدة الـ ٢٠٪ على يوم ميت. مقصودة
     (الإعلان بيشتغل قبل ما البيع يبان) ومكتوبة في تسوية آخر اليوم. */
  const entitled = Math.round(896.08 * 0.2);
  assert.ok(floor > entitled, "الأرضية أعلى من المستحق في اليوم الميت — ده التنازل");
  const rec = reconcileDay({ realisedRevenue: 896.08, spend: floor, sharePct: 20 });
  assert.equal(rec.tone, "over");
  assert.match(rec.reason, /أرضية السقف/);
});

test("الأرضية قابلة للتخفيض لما الأرضية دي تبقى غالية", () => {
  const full = ceilingAt("2026-08-05", 21, { floorPct: 100 }).ceiling;
  const tight = ceilingAt("2026-08-05", 21, { floorPct: 60 }).ceiling;
  assert.ok(tight < full, `earnedFloorPct=60 المفروض يقفّل الأرضية: ${tight} مقابل ${full}`);
  assert.ok(tight >= 150, "بس مش تحت الأرضية المطلقة");
});

test("انهيار بعد بداية قوية: السقف بيثبت مبينزلش", () => {
  const d = byDay.get("2026-08-07");
  const frozenRev = d.cum[offsetOf(19) - 1];
  const path = [19, 21, 23, 1].map((clk) =>
    ceilingAt("2026-08-07", clk, { revOverride: frozenRev, highWater: frozenRev }).ceiling);
  for (let i = 1; i < path.length; i++) {
    assert.equal(path[i], path[i - 1], `السقف المفروض يثبت والدخل واقف: ${path}`);
  }
  /* الفرق عن الموديل اللي قبله: التوقّع كان بينزّل السقف تدريجياً لما اليوم
     يقع (٣٧٦ → ٢٥٦). المكتسب مبينزلش — الفلوس دخلت خلاص وحقّه يصرف نسبتها.
     التكلفة إننا فقدنا الحماية دي، والمكسب إننا فقدنا معاها خطأ الـ ٥١٪. */
  assert.equal(path[0], Math.max(floorFor("2026-08-07"), Math.round(frozenRev * 0.2)));
});

test("أول ساعة في اليوم: دخل صفر → الأرضية، مش صفر", () => {
  const c = ceilingAt("2026-08-07", 11, { revOverride: 0, ordersOverride: 0 });
  assert.equal(c.ceiling, floorFor("2026-08-07"));
  assert.equal(c.earned, 0);
  assert.equal(c.binding, "floor");
});


/* ── ٤. حرس آخر الليل ──────────────────────────────────────────────────── */

test("كفاءة التوصيل بتقلّ كل ما الوقت يتأخر", () => {
  const at = (h) => deliveryEfficiency({ riyadhHour: h, riyadhMinute: 0, adsCloseHour: 3, accountRollHourRiyadh: 10 }).pct;
  assert.ok(at(18) > at(21) && at(21) > at(23) && at(23) > at(1), `المفروض تنزل: ${[18, 21, 23, 1].map(at)}`);
  assert.ok(at(19) >= 50 && at(19) <= 56, `الساعة ٧ المفروض حوالي ٥٣٪، طلعت ${at(19)}`);
  assert.ok(at(1) < 30, `الساعة ١ بالليل المفروض تحت ٣٠٪، طلعت ${at(1)}`);
});

test("الحرس بيمنع الرفع آخر الليل وبيكتب السبب", () => {
  const pulse = {
    riyadhHour: 1, riyadhMinute: 0, elapsedH: 21, dow: 2, pacePct: 60, pace: 0.6,
    today: { orders: 30, revenue: 2500 }, baseline: { orders: 20, revenue: 1500, days: 4 },
    confidence: { level: "عالي", note: "" },
  };
  const out = decidePace({
    rows: [{ platform: "meta", id: "1", name: "fc-prospect-asc", status: "ACTIVE", dailyBudget: 80, spend: 50, results: 2 }],
    state: new Map(), s: { ...PACE_DEFAULTS, maxTotalBudget: 1000, maxCampaignBudget: 500, mode: "auto" },
    now: new Date(), accountDay: "2026-08-11", msToRoll: 9 * 3600_000, pulse,
  });
  assert.equal(out.actions.length, 0, "مفيش رفع آخر الليل");
  assert.match(out.gate, /ضايعة|أقل من/, `السبب المفروض يبقى مكتوب: ${out.gate}`);
});

test("أول ساعة في النافذة: مفيش رفع، والسبب إن بدري", () => {
  const pulse = {
    riyadhHour: 12, riyadhMinute: 0, elapsedH: 8, dow: 2, pacePct: 80, pace: 0.8,
    today: { orders: 8, revenue: 400 }, baseline: { orders: 4, revenue: 220, days: 4 },
    confidence: { level: "عالي", note: "" },
  };
  const out = decidePace({
    rows: [{ platform: "meta", id: "1", name: "x", status: "ACTIVE", dailyBudget: 80, spend: 20, results: 0 }],
    state: new Map(), s: { ...PACE_DEFAULTS, maxTotalBudget: 1000, maxCampaignBudget: 500 },
    now: new Date(), accountDay: "2026-08-11", msToRoll: 20 * 3600_000, pulse,
  });
  assert.equal(out.actions.length, 0);
  assert.match(out.gate, /بدري/);
});

/* ── ٥. خرق السقف: الميزانية أعلى من سقف نزل ──────────────────────────── */

test("السقف نزل والميزانية فوقه → سحب حتى لو الإيقاع طبيعي", () => {
  const pulse = {
    riyadhHour: 21, riyadhMinute: 0, elapsedH: 17, dow: 2, pacePct: 5, pace: 0.05,
    today: { orders: 15, revenue: 900 }, baseline: { orders: 14, revenue: 860, days: 4 },
    confidence: { level: "عالي", note: "" },
  };
  const state = new Map([["meta:1", {
    platform: "meta", campaignId: "1", campaignName: "fc-prospect-asc",
    accountDay: "2026-08-11", baseBudget: 80, currentBudget: 160, lastActionAt: 0, steps: 3,
  }]]);
  const out = decidePace({
    rows: [{ platform: "meta", id: "1", name: "fc-prospect-asc", status: "ACTIVE", dailyBudget: 160, spend: 90, results: 1 }],
    state, s: { ...PACE_DEFAULTS, maxTotalBudget: 120, maxCampaignBudget: 500 },
    now: new Date(), accountDay: "2026-08-11", msToRoll: 13 * 3600_000, pulse,
  });
  assert.equal(out.breach, true);
  const down = out.actions.find((a) => a.op === "down");
  assert.ok(down, `المفروض يطلع سحب: ${JSON.stringify(out)}`);
  assert.ok(down.to < 160 && down.to >= 80, "السحب مش بينزل تحت رقم المالك");
  assert.match(down.reason, /السقف الحيّ نزل/);
});

/* ── ٦. الاسترجاع لسه شغّال (ما كسرناهوش) ─────────────────────────────── */

test("قبل لفّة يوم الحساب الإعلاني: استرجاع وبس، مفيش رفع", () => {
  const pulse = {
    riyadhHour: 9, riyadhMinute: 30, elapsedH: 5.5, dow: 2, pacePct: 200, pace: 2,
    today: { orders: 10, revenue: 900 }, baseline: { orders: 3, revenue: 300, days: 4 },
    confidence: { level: "عالي", note: "" },
  };
  const state = new Map([["meta:1", {
    platform: "meta", campaignId: "1", campaignName: "fc-prospect-asc",
    accountDay: "2026-08-11", baseBudget: 80, currentBudget: 160, lastActionAt: 0, steps: 4,
  }]]);
  const out = decidePace({
    rows: [{ platform: "meta", id: "1", name: "fc-prospect-asc", status: "ACTIVE", dailyBudget: 160, spend: 300, results: 3 }],
    state, s: { ...PACE_DEFAULTS, maxTotalBudget: 1000, maxCampaignBudget: 500 },
    now: new Date(), accountDay: "2026-08-11", msToRoll: 20 * 60_000, pulse,
  });
  assert.equal(out.phase, "restore");
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].op, "restore");
  assert.equal(out.actions[0].to, 80);
});

test("الخدمة رجعت بعد ما وقعت: زيادة على يوم حساب قديم بترجع فوراً", () => {
  const pulse = {
    riyadhHour: 14, riyadhMinute: 0, elapsedH: 10, dow: 2, pacePct: 5, pace: 0.05,
    today: { orders: 8, revenue: 300 }, baseline: { orders: 8, revenue: 285, days: 4 },
    confidence: { level: "عالي", note: "" },
  };
  const state = new Map([["meta:1", {
    platform: "meta", campaignId: "1", campaignName: "fc-prospect-asc",
    accountDay: "2026-08-09", baseBudget: 80, currentBudget: 128, lastActionAt: 0, steps: 4,
  }]]);
  const out = decidePace({
    rows: [{ platform: "meta", id: "1", name: "fc-prospect-asc", status: "ACTIVE", dailyBudget: 128, spend: 60, results: 1 }],
    state, s: { ...PACE_DEFAULTS, maxTotalBudget: 1000, maxCampaignBudget: 500 },
    now: new Date(), accountDay: "2026-08-11", msToRoll: 20 * 3600_000, pulse,
  });
  const restore = out.actions.find((a) => a.op === "restore");
  assert.ok(restore, "الزيادة القديمة لازم ترجع");
  assert.equal(restore.to, 80);
  assert.match(restore.reason, /استرجاع متأخر/);
});

/* ── ٧. قواعد المنصات ──────────────────────────────────────────────────── */

test("ميتا: الخطوة تحت ٢٠٪ عشان التعلّم ما يتصفّرش", () => {
  const p = platformScaling("meta", { s: { paceStepPct: 25, maxChangePct: 30 } });
  assert.ok(p.stepPct < 20, `ميتا المفروض تحت ٢٠٪، طلعت ${p.stepPct}`);
  assert.match(p.why, /التعلّم/);
});

test("تيك توك وسناب مقفولين للتوسّع بسبب مذكور", () => {
  for (const id of ["tiktok", "snapchat"]) {
    const p = platformScaling(id, { s: {} });
    assert.equal(p.allowed, false, `${id} المفروض مقفولة`);
    assert.ok(p.why.length > 40, `${id} لازم يبقى ليها سبب مكتوب`);
  }
});

test("جوجل: خطوة أكبر وتبريد أقصر، بسقف لحد ما تثبت نفسها", () => {
  const meta = platformScaling("meta", { s: {} });
  const g = platformScaling("google", { s: {}, proven: false });
  assert.ok(g.stepPct > meta.stepPct, "جوجل المفروض خطوتها أكبر من ميتا");
  assert.equal(g.cap, 100, "ومسقوفة لحد ما تجيب داتا");
  const gp = platformScaling("google", { s: {}, proven: true });
  assert.equal(gp.cap, null);
});

test("منصة لسه ما جابتش نتيجة: السقف الصغير بيمسك فعلاً", () => {
  /* ١١ أغسطس: جوجل اترفعت من ١٠٠ لـ ١٢٥ رغم إن قاعدتها بتقول مسقوفة عند
     ١٠٠ لحد ما تجيب أول عميل — لإن `proven` مكانش موصّل من اللقطة للقرار.
     الاختبار ده بيمسك الوصلة دي مش القاعدة لوحدها. */
  const pulse = {
    riyadhHour: 20, riyadhMinute: 0, elapsedH: 16, dow: 2, pacePct: 70, pace: 0.7,
    today: { orders: 25, revenue: 1800 }, baseline: { orders: 15, revenue: 1050, days: 4 },
    confidence: { level: "عالي", note: "" },
  };
  const mk = (proven) => decidePace({
    rows: [{ platform: "google", id: "g1", name: "FC-Search-Jeddah", status: "ACTIVE", dailyBudget: 100, spend: 60, results: 0, proven }],
    state: new Map(), s: { ...PACE_DEFAULTS, maxTotalBudget: 1000, maxCampaignBudget: 500 },
    now: new Date(), accountDay: "2026-08-11", msToRoll: 14 * 3600_000, pulse,
  });

  const unproven = mk(false);
  assert.equal(unproven.actions.length, 0, "منصة مش مثبتة ما تعدّيش سقفها");
  assert.ok(unproven.notes.some((n) => n.op === "capped"), "ولازم يتكتب السبب");

  const ok = mk(true);
  const up = ok.actions.find((a) => a.op === "up");
  assert.ok(up, "ولما تثبت نفسها تاخد رفع عادي");
  assert.ok(up.to > 100);
});

test("المنصة المقفولة مبتاخدش رفع حتى في يوم شغّال", () => {
  const pulse = {
    riyadhHour: 20, riyadhMinute: 0, elapsedH: 16, dow: 2, pacePct: 70, pace: 0.7,
    today: { orders: 25, revenue: 1800 }, baseline: { orders: 15, revenue: 1050, days: 4 },
    confidence: { level: "عالي", note: "" },
  };
  const out = decidePace({
    rows: [
      { platform: "tiktok", id: "t1", name: "tt-prospect", status: "ACTIVE", dailyBudget: 50, spend: 40, results: 0 },
      { platform: "meta", id: "m1", name: "fc-prospect-asc", status: "ACTIVE", dailyBudget: 80, spend: 70, results: 1 },
    ],
    state: new Map(), s: { ...PACE_DEFAULTS, maxTotalBudget: 1000, maxCampaignBudget: 500 },
    now: new Date(), accountDay: "2026-08-11", msToRoll: 14 * 3600_000, pulse,
  });
  assert.equal(out.actions.filter((a) => a.platform === "tiktok").length, 0, "تيك توك ما ياخدش رفع");
  const m = out.actions.find((a) => a.platform === "meta");
  assert.ok(m, "ميتا المفروض تاخد رفع");
  assert.ok((m.to - m.from) / m.from < 0.20, `خطوة ميتا لازم تفضل تحت ٢٠٪: ${m.from}→${m.to}`);
  assert.ok(out.notes.some((n) => n.op === "platform-blocked"), "لازم يتسجّل سبب المنع");
});

/* ── ٨. التسوية آخر اليوم ─────────────────────────────────────────────── */

test("التسوية بتقول الحقيقة في الاتجاهين", () => {
  const over = reconcileDay({ realisedRevenue: 896, spend: 400, sharePct: 20 });
  assert.equal(over.entitled, 179);
  assert.equal(over.tone, "over");
  assert.match(over.reason, /زيادة/);

  const under = reconcileDay({ realisedRevenue: 3917, spend: 400, sharePct: 20 });
  assert.equal(under.tone, "under");
  assert.match(under.reason, /على الأرض/);

  const on = reconcileDay({ realisedRevenue: 2000, spend: 400, sharePct: 20 });
  assert.equal(on.tone, "on");
});

/* ── ٩. الأسوار الصلبة عمرها ما تتكسر ─────────────────────────────────── */

test("السقف المطلق ٢٠٠٠ بيمسك مهما كان الدخل", () => {
  // يوم بـ ٥٠ ألف ر.س: المستحق ١٠ آلاف، بس رقم المالك ٢٠٠٠ ومفيش حساب بيعدّيه
  const huge = movingCeiling({
    trailing7Avg: 2000, sharePct: 20, hardMax: 2000, floor: 150,
    earned: { revenueSoFar: 50_000, highWater: 50_000 },
  });
  assert.equal(huge.ceiling, 2000);
  assert.equal(huge.capped, "السقف المطلق");
});

test("الأرضية المطلقة ١٥٠ بتمسك حتى لو المتوسط والدخل الاتنين على الأرض", () => {
  const tiny = movingCeiling({
    trailing7Avg: 200, sharePct: 20, hardMax: 2000, floor: 150,
    earned: { revenueSoFar: 0, highWater: 0 },
  });
  assert.equal(tiny.ceiling, 150, "٢٠٪ من ٢٠٠ = ٤٠، بس الأرضية المطلقة ١٥٠");
  assert.equal(tiny.binding, "floor");
});

test("مبيعات النهارده مش مقروءة → الأرضية، مش تخمين", () => {
  const blind = movingCeiling({
    trailing7Avg: 1500, sharePct: 20, hardMax: 2000, floor: 150, earned: null,
    projection: { usable: true, projected: 5000, share: 60, reason: "اختبار" },
  });
  assert.equal(blind.ceiling, 300, "٢٠٪ من متوسط ١٥٠٠ — والتوقّع متجاهَل");
  assert.equal(blind.earned, null);
  assert.match(blind.reason, /مبيعات النهارده لسه مش مقروءة/);
});

/* ── ١٠. جودة رقم العرض (outlook) ─────────────────────────────────────
   ده مش سور مالي — التوقّع مبيحركش ريال. بس لو هنعرضه للمالك على الشاشة
   لازم يبقى أحسن من مجرد المتوسط، وإلا نشيله بدل ما نشوّش عليه.        */

test("رقم العرض: خطأ التوقّع أقل من خطأ المتوسط من الساعة ٧", () => {
  const days = DAYS.slice(-58).filter((d) => d.total > 0 && d.orders >= 5);
  for (const clk of [19, 21, 23]) {
    const e = offsetOf(clk);
    const errModel = [], errBase = [];
    for (const d of days) {
      const t = trailing7(d.day); if (!t) continue;
      const p = projectDayRevenue({
        shape: shapeFor(d.day), dow: d.dow, elapsedH: e,
        revSoFar: d.cum[e - 1], ordersSoFar: d.cumOrders[e - 1], trailingAvg: t,
        minSharePct: INTRADAY_DEFAULTS.projMinSharePct, minOrders: INTRADAY_DEFAULTS.projMinOrders,
      });
      errModel.push(Math.abs(p.projected - d.total) / d.total);
      errBase.push(Math.abs(t - d.total) / d.total);
    }
    const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
    assert.ok(med(errModel) < med(errBase),
      `الساعة ${clk}: خطأ الموديل ${(med(errModel) * 100).toFixed(1)}٪ المفروض أقل من المتوسط ${(med(errBase) * 100).toFixed(1)}٪`);
  }
});

/* ══ الطريق لـ ١٠ آلاف ر.س في اليوم ═══════════════════════════════════════
   المالك مستعد يصرف لحد ٢٠٠٠ عشان يبيع ١٠ آلاف. النهارده بيبيع ~٢٬١٤٥
   وبيصرف ~٢٧٢. الاختبارات دي بتسأل: القواعد نفسها بتسمح بالطريق ده؟ وإيه
   اللي هيمسك الأول؟                                                        */

test("١٠ آلاف مبيعات: السقف بيوصل ٢٠٠٠ بالظبط — لا أقل ولا أكتر", () => {
  const c = movingCeiling({
    trailing7Avg: 10_000, sharePct: 20, hardMax: 2000, floor: 150,
    earned: { revenueSoFar: 10_000, highWater: 10_000 },
  });
  assert.equal(c.ceiling, 2000, "٢٠٪ من ١٠ آلاف = ٢٠٠٠، ودي نفسها حدود المالك");
});

test("السقف بيكبر مع الدخل خطوة بخطوة، مش بيقفز على وعد", () => {
  const at = (rev) => movingCeiling({
    trailing7Avg: 2200, sharePct: 20, hardMax: 2000, floor: 150,
    earned: { revenueSoFar: rev, highWater: rev },
  }).ceiling;
  // الدخل بيتضاعف → السقف بيتضاعف، لحد ما يوصل لحدود المالك ويقف
  assert.ok(at(2_500) < at(5_000), "الدخل زاد → السقف زاد");
  assert.ok(at(5_000) < at(9_000));
  assert.equal(at(12_000), 2000, "بعد ١٠ آلاف السقف بيثبت عند رقم المالك");
  assert.equal(at(40_000), 2000);
});

test("يوم المبيعات فيه وقعت: السقف بينزل للأرضية ويقف عندها", () => {
  /* اليوم اللي وقع مابيفتحش سقف — بس مابيقفلوش لحد الصفر كمان. الأرضية
     (٢٠٪ من متوسط الأسبوع) هي اللي بتمسك، عشان يوم واحد وحش مايوقّفش
     الإعلانات ويحوّل اليوم الوحش لأسبوع وحش. اللي المفروض يتأكد هنا إن
     اليوم الواقع عمره ما بيدّي سقف أكبر من الأرضية دي. */
  const floor = Math.round(2200 * 0.2);          // ٤٤٠ ر.س
  const collapse = movingCeiling({
    trailing7Avg: 2200, sharePct: 20, hardMax: 2000, floor: 150,
    earned: { revenueSoFar: 400, highWater: 400 },
  });
  assert.equal(collapse.ceiling, floor, "بيقف على الأرضية بالظبط، لا فوقها");
  assert.ok(collapse.ceiling >= 150, "ومابينزلش تحت الأرضية المطلقة");

  // ويوم بـ ١٠ آلاف بيدّي أربع أضعاف السقف ده — الفرق بين اليومين حقيقي
  const great = movingCeiling({
    trailing7Avg: 2200, sharePct: 20, hardMax: 2000, floor: 150,
    earned: { revenueSoFar: 10_000, highWater: 10_000 },
  });
  assert.ok(great.ceiling > collapse.ceiling * 4,
    "الدخل هو اللي بيفتح السقف — مش المتوسط ولا التوقّع");
});

test("سقف الحملة الواحدة هو اللي بيمسك الأول على الطريق لـ ٢٠٠٠", () => {
  /* ٢٠٠٠ ر.س/يوم مقسومة على سقف ٣٥٠ للحملة = ٦ حملات شغالة على الأقل.
     ده مش عيب في الكود — ده قيد حقيقي لازم المالك يعرفه: التوسّع محتاج
     حملات أكتر، مش بس ميزانية أكبر على نفس الحملات. */
  const maxCampaignBudget = 350, target = 2000;
  const needed = Math.ceil(target / maxCampaignBudget);
  assert.equal(needed, 6);
  assert.ok(needed > 4, "٤ حملات ميتا الشغالة دلوقتي مش كفاية لـ ٢٠٠٠ ر.س");
});

test("سرعة الوصول: ٣٠٪ في اليوم وتبريد ٢٤ ساعة = أسبوع ونص مش يوم", () => {
  /* من ٢٧٢ ر.س/يوم لـ ٢٠٠٠ مع سقف زيادة ٣٠٪ وتبريد يوم كامل بين الزيادات. */
  let spend = 272, days = 0;
  while (spend < 2000 && days < 60) { spend *= 1.3; days++; }
  assert.equal(days, 8, "تمن أيام على الأقل — والوكيل مش هيقدر يقصّرها من غير ما الأسوار تترخى");
  assert.ok(spend >= 2000);
});

/* ═══════════════════════════════════════════════════════════════════════════
   يوم الحساب الإعلاني مقابل تاريخ UTC — السطر اللي كذب على المالك

   في ٢٠٢٦-٠٨-١٢ الساعة ٩:١٩ بتوقيت جدة سجّل الوكيل: «صرفنا ٠ ر.س والمستحق
   كان ٥٣٦ — سبنا ٥٣٦ ر.س على الأرض». الصرف الحقيقي لنفس اليوم كان ٣١١٫١٢
   ر.س (مقروء من ميتا).

   السبب: الصرف كان بيتقرا بـ todayISO() = تاريخ UTC، وميتا بتفسّر
   time_range بتوقيت الحساب (America/Los_Angeles). تاريخ UTC بيسبق يوم
   الحساب من ٠٠:٠٠ UTC لحد ١٠ الصبح بجدة — فكنا بنطلب يوم لسه ما ابتداش،
   وميتا بترجّع HTTP 200 و data فاضية من غير أي خطأ.
   ═══════════════════════════════════════════════════════════════════════════ */

test("لحظة السطر الكاذب: تاريخ UTC ≠ يوم الحساب الإعلاني", () => {
  // ٩:١٩ صباحاً بتوقيت جدة = ٠٦:١٩ UTC — نفس اللحظة اللي التسوية اتكتبت فيها.
  const at = new Date("2026-08-12T06:19:00Z");
  assert.equal(at.toISOString().slice(0, 10), "2026-08-12", "todayISO() كانت بترجّع ده");
  assert.equal(spendDayNow(at), "2026-08-11", "ويوم الحساب الإعلاني كان لسه ٢٠٢٦-٠٨-١١");
  assert.notEqual(spendDayNow(at), at.toISOString().slice(0, 10),
    "الاتنين مختلفين — وده بالظبط اللي خلّى ميتا ترجّع صفر صفوف");
});

test("الشباك المكسور: من ٣ الفجر لحد ١٠ الصبح بتوقيت جدة كل يوم", () => {
  const broken = [];
  for (let h = 0; h < 24; h++) {
    const at = new Date(Date.UTC(2026, 7, 12, h, 30));
    if (spendDayNow(at) !== at.toISOString().slice(0, 10)) broken.push(h);
  }
  // ٠٠:٠٠ → ٠٦:٥٩ UTC = ٣ الفجر → ٩:٥٩ الصبح بجدة (لوس أنجلوس على UTC-7 صيفاً)
  assert.deepEqual(broken, [0, 1, 2, 3, 4, 5, 6],
    "سبع ساعات كل يوم كان الصرف فيها بيتقرا صفر — والتسوية بتشتغل جوّاها");
  assert.ok(broken.length === 7);
});

test("نفس اليوم بالصرف الصح بيقلب حكم التسوية من كذبة لرقم", () => {
  const entitled = 536, revenue = 2680;   // ٢٠٪ من ٢٬٦٨٠ ر.س مبيعات يوم ٠٨-١١
  const lie   = reconcileDay({ realisedRevenue: revenue, spend: 0,      sharePct: 20 });
  const truth = reconcileDay({ realisedRevenue: revenue, spend: 311.12, sharePct: 20 });

  assert.equal(lie.entitled, entitled);
  assert.equal(truth.entitled, entitled);
  assert.equal(lie.variance, -536, "السطر القديم قال سبنا المستحق كله على الأرض");
  assert.ok(Math.abs(truth.variance - (-224.88)) < 0.01, "الحقيقة: أقل بـ ٢٢٥ ر.س مش ٥٣٦");
  assert.ok(truth.spend > 0, "وأهم حاجة: مش صفر");
  // ٥٣٦ مقابل ٢٢٥ — نفس النبرة بس ضعف الرقم. المالك كان هيتصرف على الفرق ده.
  assert.ok(Math.abs(lie.variance) > Math.abs(truth.variance) * 2);
});
