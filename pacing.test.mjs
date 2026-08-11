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
  buildDayShape, shareAt, projectDayRevenue, movingCeiling, reconcileDay,
  deliveryEfficiency, platformScaling, decidePace, PACE_DEFAULTS, INTRADAY_DEFAULTS,
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

/* السقف زي ما السيرفر بيحسبه بالظبط، بس بمدخلات الاختبار */
function ceilingAt(iso, clk, { revOverride = null, ordersOverride = null } = {}) {
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
    trailing7Avg: trailing, sharePct: 20, stretchPct: 25, pacePct: null,
    hardMax: 2000, floor: 150, fallback: 1000, projection,
  });
  return { ...c, projection, rev, orders, elapsedH: e };
}

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

/* ── ٢. البوابة: «الساعة ٥ العصر» مقفولة عن قصد ───────────────────────── */

test("الساعة ٣ العصر: التوقّع مقفول والسقف على المتوسط", () => {
  const c = ceilingAt("2026-08-07", 15);
  assert.equal(c.projection.usable, false);
  assert.equal(c.projection.source, "too-early");
  assert.equal(c.live, false);
  assert.match(c.reason, /متوسط مبيعات آخر ٧ أيام/);
});

test("الساعة ٥ العصر: لسه مقفول — ده الرد على مثال المالك", () => {
  const c = ceilingAt("2026-08-07", 17);
  assert.equal(c.projection.usable, false, "الساعة ٥ التوقّع لازم يفضل مقفول");
  // والسبب لازم يبقى مكتوب بالعربي وفيه رقم المضاعف
  assert.match(c.projection.reason, /مطعم ليلي/);
});

test("طلب ضخم بدري مبيفتحش السقف", () => {
  // ٨٠٠ ر.س طلب واحد الساعة ٣ العصر على أسوأ يوم
  const naive = ceilingAt("2026-08-05", 16, { revOverride: 245 + 800, ordersOverride: 5 });
  assert.equal(naive.projection.usable, false, "٥ طلبات مش عيّنة");
  assert.equal(naive.ceiling, ceilingAt("2026-08-05", 16).ceiling, "السقف المفروض ما يتغيّرش");
});

test("الخلط بيقصّ أثر الطلب الشاذ حتى بعد ما البوابة تفتح", () => {
  const blended = ceilingAt("2026-08-05", 18, { revOverride: 387 + 800, ordersOverride: 8 });
  const share = blended.projection.share / 100;
  const unblended = Math.round((1187 / share) * 0.2);
  assert.ok(blended.ceiling < unblended * 0.6,
    `الخلط المفروض يقصّ الرقم للنص على الأقل: ${blended.ceiling} مقابل ${unblended} من غير خلط`);
});

/* ── ٣. إعادة تشغيل اليومين المسمّيين ساعة بساعة ──────────────────────── */

test("أحسن يوم (الجمعة ٧ أغسطس، ٣٬٩١٧ ر.س): السقف بيكبر مع اليوم", () => {
  const trailing = trailing7("2026-08-07");
  const oldCeiling = Math.round(trailing * 0.2);          // السقف القديم الثابت
  const path = [15, 17, 19, 21, 23, 1].map((clk) => ({ clk, ...ceilingAt("2026-08-07", clk) }));

  // بدري: زي القديم بالظبط
  assert.equal(path[0].ceiling, oldCeiling);
  // بعد ما اليوم يثبت نفسه: بيعدّي القديم بفرق واضح
  const late = path.at(-1);
  assert.ok(late.ceiling > oldCeiling * 2,
    `آخر الليل السقف المفروض يبقى أكتر من ضعف القديم: ${late.ceiling} مقابل ${oldCeiling}`);
  // وبيقرب من الاستحقاق الحقيقي (٢٠٪ من ٣٬٩١٧ = ٧٨٣)
  const entitled = Math.round(3916.93 * 0.2);
  assert.ok(Math.abs(late.ceiling - entitled) / entitled < 0.15,
    `السقف آخر الليل ${late.ceiling} المفروض يقرب من المستحق ${entitled}`);
  // والمسار تصاعدي بعد ما البوابة تفتح
  const open = path.filter((p) => p.projection.usable);
  for (let i = 1; i < open.length; i++) {
    assert.ok(open[i].ceiling >= open[i - 1].ceiling - 5,
      `السقف نزل من غير سبب: ${open[i - 1].clk}h=${open[i - 1].ceiling} → ${open[i].clk}h=${open[i].ceiling}`);
  }
});

test("أسوأ يوم (الأربعاء ٥ أغسطس، ٨٩٦ ر.س): السقف بينزل ويحمي المالك", () => {
  const trailing = trailing7("2026-08-05");
  const oldCeiling = Math.round(trailing * 0.2);
  const late = ceilingAt("2026-08-05", 1);
  const entitled = Math.round(896.08 * 0.2);              // ١٧٩ ر.س

  assert.ok(late.ceiling < oldCeiling,
    `اليوم الميت المفروض السقف ينزل تحت القديم: ${late.ceiling} مقابل ${oldCeiling}`);
  assert.ok(late.ceiling < oldCeiling * 0.7, "النزول المفروض يبقى محسوس مش تجميلي");
  assert.ok(late.ceiling >= entitled * 0.9,
    `وبرضه مش المفروض ينزل تحت المستحق الحقيقي ${entitled}`);
});

test("انهيار بعد بداية قوية: السقف بيرجع لورا لوحده", () => {
  const d = byDay.get("2026-08-07");
  const frozenRev = d.cum[offsetOf(19) - 1], frozenOrd = d.cumOrders[offsetOf(19) - 1];
  const path = [19, 21, 23, 1].map((clk) =>
    ceilingAt("2026-08-07", clk, { revOverride: frozenRev, ordersOverride: frozenOrd }).ceiling);
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i] < path[i - 1], `السقف المفروض ينزل كل ساعة والمبيعات واقفة: ${path}`);
  }
  assert.ok(path.at(-1) < path[0] * 0.75, `النزول المفروض يبقى حقيقي: ${path}`);
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

test("السقف المطلق ٢٠٠٠ والأرضية ١٥٠ بيمسكوا مهما كان التوقّع", () => {
  const huge = movingCeiling({
    trailing7Avg: 2000, sharePct: 20, hardMax: 2000, floor: 150,
    projection: { usable: true, projected: 999_999, reason: "اختبار" },
  });
  assert.equal(huge.ceiling, 2000);
  assert.equal(huge.capped, "السقف المطلق");

  const tiny = movingCeiling({
    trailing7Avg: 2000, sharePct: 20, hardMax: 2000, floor: 150,
    projection: { usable: true, projected: 10, reason: "اختبار" },
  });
  assert.equal(tiny.ceiling, 150);
  assert.equal(tiny.capped, "أرضية السقف");
});

test("التوقّع الحيّ بيقفل التوسّع لـ ٢٥٪ عشان ما نحسبش اليوم الحلو مرتين", () => {
  const c = movingCeiling({
    trailing7Avg: 1500, sharePct: 20, stretchPct: 25, pacePct: 90, hotThresholdPct: 20,
    hardMax: 2000, floor: 150, projection: { usable: true, projected: 3000, reason: "اختبار" },
  });
  assert.equal(c.hot, false, "مع التوقّع الحيّ مفيش stretch");
  assert.equal(c.ceiling, 600, "٢٠٪ من ٣٠٠٠ = ٦٠٠");
});

/* ── ١٠. الدقّة الإجمالية: الموديل لازم يكسب على المتوسط لوحده ────────── */

test("على ٥٨ يوم حقيقي: خطأ التوقّع أقل من خطأ المتوسط من الساعة ٧", () => {
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
