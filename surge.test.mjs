/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات بروتوكول المضاعفة — كل رقم هنا مقيس مش مفترض

   العيّنات اللي جوّه الاختبارات دي متاخدة حرفياً من:
     • /tmp/fcads/spend-log.tsv (عيّنة كل ١٥ دقيقة، ١٤ أغسطس ٢٠٢٦)
     • insights ساعة بساعة على act_210662083554074 (١٢/١٣/١٤ أغسطس)
     • learning_stage_info وقت القراءة ١٤ أغسطس ١٩:١٥ بتوقيت جدة

     node --test surge.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import {
  SURGE_K, SURGE_DEFAULTS, fillRatio, classifyAdset, learningViability,
  projectLift, planSurge, judgeSurge, dueRestores, structureFloor,
} from "./surge.js";

/* ── ١) القانون: Δ ريال ÷ ساعات فاضلة ────────────────────────────────── */

test("القانون بيتنبّأ بقفزة ١٤ أغسطس (٨٠→٣٥٠ الساعة ١٢:١٣) في حدود المقيس", () => {
  /* يوم الحساب بيلف ١٠:٠٠ بتوقيت جدة → الساعة ١٢:١٣ فاضل ٢١٫٨ ساعة */
  const p = projectLift({ fromBudget: 80, toBudget: 350, accountHoursLeft: 21.8, sellingHoursLeft: 15.8 });
  /* المقيس بعد الاستقرار: +١٤٫٥ إلى +١٦٫٥ ر.س/ساعة فوق خط أساس ٥٫٤٩ */
  assert.ok(p.liftPerHour >= 14 && p.liftPerHour <= 18,
    `متوقّع ١٤–١٨ ر.س/ساعة، طلع ${p.liftPerHour}`);
});

test("القانون بيفسّر ليه خطوة ١٥٪ الساعة ٢١:٤٣ يوم ١٢ أغسطس ما اتشافتش", () => {
  /* ٨٧ → ١٠٠ ر.س، فاضل ١٢٫٣ ساعة من يوم الحساب */
  const p = projectLift({ fromBudget: 87, toBudget: 100, accountHoursLeft: 12.3, sellingHoursLeft: 6.3 });
  assert.ok(p.liftPerHour < 2,
    `الزيادة المتوقّعة لازم تبقى تحت الضوضاء، طلعت ${p.liftPerHour}`);
  /* والمقيس فعلاً: الصرف بالساعة فضل ٤٫٢٠ ثم ٥٫٣٢ — فرق داخل التذبذب اليومي */
});

test("كفاءة التوصيل بتوقع مضاعفة متأخرة بالليل", () => {
  /* الساعة ٢٣:٠٠ — فاضل ١١ ساعة يوم حساب، منها ٥ ساعات بيع بس */
  const p = projectLift({ fromBudget: 100, toBudget: 300, accountHoursLeft: 11, sellingHoursLeft: 5 });
  assert.equal(p.deliveryEfficiencyPct, 45);
  assert.ok(p.sellingExtraSpend < p.totalExtraSpend / 2 + 1);
});

/* ── ٢) التصنيف: مين مخنوق بالميزانية ومين مخنوق بالجمهور ─────────────── */

test("asc بعد المضاعفة = pinned (عيّنات حقيقية ١٧:٠٦→١٨:٠٦)", () => {
  const c = classifyAdset({
    samples: [
      { atMin: 1026, cum: 83.24 }, // 17:06
      { atMin: 1041, cum: 86.85 }, // 17:21
      { atMin: 1056, cum: 90.58 }, // 17:36
      { atMin: 1071, cum: 93.84 }, // 17:51
      { atMin: 1086, cum: 96.91 }, // 18:06
    ],
    dailyBudget: 245,
  });
  assert.equal(c.class, "pinned");
  assert.ok(c.fill >= 1.15, `نسبة الامتلاء ${c.fill} لازم تعدّي ١٫١٥`);
});

test("rt-warm = throttled — مخنوقة بالجمهور مش بالميزانية", () => {
  /* المقيس: ~١٫٥ ر.س/ساعة على ميزانية ٤٨ (المسطّح ٢٫٠) → امتلاء ٠٫٧٥ */
  const c = classifyAdset({
    samples: [
      { atMin: 1026, cum: 14.74 },
      { atMin: 1041, cum: 15.25 },
      { atMin: 1056, cum: 15.54 },
      { atMin: 1071, cum: 15.75 },
    ],
    dailyBudget: 48,
  });
  assert.equal(c.class, "throttled");
});

test("rt-hot = cold — واقفة عملياً، المضاعفة مش هتصحّيها", () => {
  const c = classifyAdset({
    samples: [{ atMin: 1026, cum: 0.18 }, { atMin: 1041, cum: 0.18 }, { atMin: 1056, cum: 0.18 }],
    dailyBudget: 8,
  });
  assert.equal(c.class, "cold");
});

test("fillRatio بيرجّع null لو الميزانية صفر بدل ما يقسم على صفر", () => {
  assert.equal(fillRatio({ hourlySpend: 5, dailyBudget: 0 }), null);
});

/* ── ٣) مرحلة التعلّم: قابلة للخروج ولا لأ ────────────────────────────── */

test("Purchase مقفول — صفر حدث في ٧ أيام يعني أرضية لا نهائية", () => {
  const v = learningViability({ costPerEvent: null, eventsPer7d: 0, affordableDaily: 880 });
  assert.equal(v.exitable, false);
  assert.equal(v.floorBudget, null);
});

test("InitiateCheckout قابل للخروج — أرضية ٣٠ ر.س/يوم", () => {
  /* المقيس ١٤ أغسطس: asc صرفت ١٠٩٫٧٥ ر.س وجابت ٢٦ IC → ٤٫٢٢ ر.س للحدث */
  const v = learningViability({ costPerEvent: 4.22, eventsPer7d: 26 * 7, affordableDaily: 880 });
  assert.equal(v.exitable, true);
  assert.equal(v.floorBudget, 31);
});

test("CONVERSATIONS أرخص أرضية في الحساب — ١٢ ر.س/يوم", () => {
  /* المقيس: ٥٩ محادثة في ٣ أيام بـ٩٨٫٩١ ر.س → ١٫٦٨ ر.س للمحادثة */
  const v = learningViability({ costPerEvent: 1.68, eventsPer7d: 59 * 7 / 3, affordableDaily: 880 });
  assert.equal(v.exitable, true);
  assert.equal(v.floorBudget, 12);
});

test("حدث بتكلفة ٦٠ ر.س محتاج ٤٢٩ ر.س/يوم — مش قابل للتحمّل عند ٣٠٠", () => {
  const v = learningViability({ costPerEvent: 60, eventsPer7d: 7, affordableDaily: 300 });
  assert.equal(v.floorBudget, 429);
  assert.equal(v.exitable, false);
});

/* ── ٤) قرار المضاعفة ─────────────────────────────────────────────────── */

const pinned = { class: "pinned", fill: 1.35, trend: 0.2, hourly: 13.3, why: "مخنوقة بالميزانية." };

test("مضاعفة مقبولة الساعة ١٩ مع مساحة كافية تحت السقف", () => {
  const p = planSurge({
    name: "fc-wa-walkin-5km", dailyBudget: 35, baseBudget: 35, classification: pinned,
    riyadhHour: 19, accountHoursLeft: 14.75, sellingHoursLeft: 8.75,
    ceilingHeadroom: 200, openSurges: 0,
  });
  assert.equal(p.ok, true);
  assert.ok(p.multiple >= 2 && p.multiple <= 3);
  assert.equal(p.to, 105);
});

test("مرفوضة الساعة ١٣ — بدري، السقف المستحق لسه ما اتجمّعش", () => {
  const p = planSurge({
    name: "fc-prospect-asc", dailyBudget: 80, baseBudget: 80, classification: pinned,
    riyadhHour: 13, accountHoursLeft: 21, sellingHoursLeft: 15, ceilingHeadroom: 400,
  });
  assert.equal(p.ok, false);
  assert.match(p.why, /بدري/);
});

test("مرفوضة لو المجموعة throttled مهما كانت المساحة", () => {
  const p = planSurge({
    name: "fc-rt-warm-30d", dailyBudget: 48, baseBudget: 48,
    classification: { class: "throttled", fill: 0.75, why: "مخنوقة بالجمهور." },
    riyadhHour: 19, accountHoursLeft: 14.75, sellingHoursLeft: 8.75, ceilingHeadroom: 500,
  });
  assert.equal(p.ok, false);
  assert.match(p.why, /throttled/);
});

test("مرفوضة لو السقف المستحق مش سايب مساحة للمضاعفة", () => {
  const p = planSurge({
    name: "fc-prospect-asc", dailyBudget: 245, baseBudget: 245, classification: pinned,
    riyadhHour: 19, accountHoursLeft: 14.75, sellingHoursLeft: 8.75, ceilingHeadroom: 100,
  });
  assert.equal(p.ok, false);
  assert.match(p.why, /السقف/);
});

test("مرفوضة لو أغلب الزيادة هتقع بعد ما المطبخ يقفل", () => {
  const p = planSurge({
    name: "fc-prospect-asc", dailyBudget: 100, baseBudget: 100, classification: pinned,
    riyadhHour: 23, accountHoursLeft: 11, sellingHoursLeft: 4, ceilingHeadroom: 400,
  });
  assert.equal(p.ok, false);
  assert.match(p.why, /ساعات بيع/);
});

test("مرفوضة لو فيه مضاعفتين مفتوحين خلاص", () => {
  const p = planSurge({
    name: "x", dailyBudget: 50, baseBudget: 50, classification: pinned,
    riyadhHour: 19, accountHoursLeft: 14, sellingHoursLeft: 9, ceilingHeadroom: 500, openSurges: 2,
  });
  assert.equal(p.ok, false);
  assert.match(p.why, /مفتوحة/);
});

test("مرفوضة لو الميزانية مرفوعة أصلاً — منع المضاعفة فوق المضاعفة", () => {
  const p = planSurge({
    name: "x", dailyBudget: 150, baseBudget: 50, classification: pinned,
    riyadhHour: 19, accountHoursLeft: 14, sellingHoursLeft: 9, ceilingHeadroom: 500,
  });
  assert.equal(p.ok, false);
  assert.match(p.why, /رجّعها/);
});

/* ── ٥) الحكم: ساعتين قصيرة ─────────────────────────────────────────── */

test("مفيش حكم قبل ٧٥ دقيقة — الحكم بدري بيقيس الهبوط نفسه", () => {
  /* لو حكمنا على asc بعد ٢٥ دقيقة كنا هنشوف ١٫٧ ر.س/ساعة ونرجّعها،
     ونخسر الـ٢٧٫١٨ ر.س اللي جت في الساعة اللي بعدها */
  const j = judgeSurge({ minutesSince: 25, hourlySpendNow: 1.7, newBudget: 350 });
  assert.equal(j.verdict, "hold");
});

test("رجوع فوري لو الفلوس مانزلتش بعد فترة السماح", () => {
  const j = judgeSurge({ minutesSince: 90, hourlySpendNow: 3, newBudget: 300 });
  assert.equal(j.verdict, "revert");
  assert.equal(j.reason, "delivery");
});

test("استنّى لو التوصيل شغّال بس لسه بدري على حكم التكلفة", () => {
  const j = judgeSurge({ minutesSince: 90, hourlySpendNow: 18, newBudget: 300 });
  assert.equal(j.verdict, "hold");
});

test("رجوع بعد ١٥٠ دقيقة لو التكلفة فوق ٢× المستهدف", () => {
  /* الحالة الحقيقية: asc سجّلت ٦٨٫٨٥ ر.س للنتيجة مقابل مستهدف ٢٢ */
  const j = judgeSurge({ minutesSince: 160, hourlySpendNow: 20, newBudget: 350, costPerEvent: 68.85, targetCpa: 22 });
  assert.equal(j.verdict, "revert");
  assert.equal(j.reason, "cost");
});

test("تفضل شغّالة لو التكلفة تحت ٢× المستهدف", () => {
  const j = judgeSurge({ minutesSince: 160, hourlySpendNow: 20, newBudget: 350, costPerEvent: 4.2, targetCpa: 22 });
  assert.equal(j.verdict, "keep");
});

test("صرف من غير ولا حدث = رجوع، ومكتوب صريح ليه", () => {
  const j = judgeSurge({ minutesSince: 160, hourlySpendNow: 20, newBudget: 300, events: 0 });
  assert.equal(j.verdict, "revert");
  assert.equal(j.reason, "no-events");
});

/* ── ٦) الاسترجاع: الدَين اللي بينسى ─────────────────────────────────── */

test("الاسترجاع بيبقى متأخر بعد ساعة الاسترجاع", () => {
  const out = dueRestores({
    surges: [{ name: "fc-wa-walkin-5km", currentBudget: 150, baseBudget: 35 }],
    riyadhHour: 4, minutesToAccountRoll: 360,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].overdue, true);
  assert.equal(out[0].to, 35);
});

test("الاسترجاع بيبقى متأخر برضه لو يوم الحساب هيلف خلال ٤٥ دقيقة", () => {
  const out = dueRestores({
    surges: [{ name: "x", currentBudget: 300, baseBudget: 100 }],
    riyadhHour: 9, minutesToAccountRoll: 30,
  });
  assert.equal(out[0].overdue, true);
});

test("ميزانية مرجّعة خلاص مش بتتحسب دَين", () => {
  const out = dueRestores({
    surges: [{ name: "x", currentBudget: 100, baseBudget: 100 }],
    riyadhHour: 4, minutesToAccountRoll: 360,
  });
  assert.equal(out.length, 0);
});

/* ── ٧) أرضية الهيكل من الصفر ────────────────────────────────────────── */

test("بميزانية ٣٠٠ ر.س الحساب بيشيل عدد محدود من المجموعات", () => {
  const s = structureFloor({
    dailyBudget: 300,
    events: [
      { name: "CONVERSATIONS", costPerEvent: 1.68, eventsPer7d: 138 },
      { name: "InitiateCheckout", costPerEvent: 4.22, eventsPer7d: 182 },
      { name: "Purchase", costPerEvent: null, eventsPer7d: 0 },
    ],
  });
  assert.equal(s.cheapestFloor, 12);
  assert.equal(s.rows.find((r) => r.event === "Purchase").exitable, false);
  assert.ok(s.maxViableAdsets >= 4);
});

test("SURGE_K متقاس مش مفترض — بين ١٫٢٥ و١٫٥", () => {
  assert.ok(SURGE_K >= 1.25 && SURGE_K <= 1.5);
  assert.equal(SURGE_DEFAULTS.maxConcurrentSurges, 2);
});
