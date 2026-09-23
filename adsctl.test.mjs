import test from "node:test";
import assert from "node:assert/strict";
import {
  ctlCfg, normRule, ruleLabel, hhmmToMin, minToHhmm, bizMinuteOf, bizDayOf, bizDowOf,
  dueRules, applyCeiling, budgetVerdict, planRule, openGate, budgetOf, CTL_DEFAULTS, fxOf,
} from "./adsctl.js";

/* ── الوقت واليوم التجاري ──────────────────────────────────────────────── */

test("hhmmToMin بيقبل HH:MM بس", () => {
  assert.equal(hhmmToMin("11:00"), 660);
  assert.equal(hhmmToMin("02:00"), 120);
  assert.equal(hhmmToMin("9:05"), 545);
  assert.equal(hhmmToMin("24:00"), null);
  assert.equal(hhmmToMin("11:60"), null);
  assert.equal(hhmmToMin("حاجة"), null);
  assert.equal(hhmmToMin(""), null);
});

test("minToHhmm عكس hhmmToMin", () => {
  for (const v of ["00:00", "04:00", "11:30", "23:59"]) assert.equal(minToHhmm(hhmmToMin(v)), v);
});

test("محور اليوم التجاري: ٠٢:٠٠ آخر اليوم مش أوله", () => {
  // ٠ = ٤ الفجر. ١١:٠٠ الصبح جوّه اليوم، و٠٢:٠٠ بالليل بعدها بكتير.
  assert.equal(bizMinuteOf(hhmmToMin("04:00")), 0);
  assert.equal(bizMinuteOf(hhmmToMin("11:00")), 420);
  assert.equal(bizMinuteOf(hhmmToMin("02:00")), 1320);
  assert.ok(bizMinuteOf(hhmmToMin("02:00")) > bizMinuteOf(hhmmToMin("11:00")),
    "الساعة اتنين بالليل لازم تيجي بعد إحداشر الصبح في نفس اليوم التجاري");
});

test("bizDayOf بيلف ٤ الفجر بتوقيت الرياض", () => {
  // ٠١:٣٠ فجر ٢٤/٩ بتوقيت جدة = 22:30 UTC يوم ٢٣ ⇒ لسه يوم ٢٣ التجاري
  assert.equal(bizDayOf(new Date("2026-09-23T22:30:00Z")), "2026-09-23");
  // ٠٥:٠٠ صباح ٢٤/٩ جدة = 02:00 UTC يوم ٢٤ ⇒ يوم ٢٤
  assert.equal(bizDayOf(new Date("2026-09-24T02:00:00Z")), "2026-09-24");
  assert.equal(bizDowOf(new Date("2026-09-23T22:30:00Z")), 3); // الأربعاء
});

/* ── تحقّق القواعد ─────────────────────────────────────────────────────── */

test("normRule بيرفض الميعاد والنوع الغلط", () => {
  assert.equal(normRule({ action: "off", at: "بكرة" }), null);
  assert.equal(normRule({ action: "stop", at: "11:00" }), null);
  assert.equal(normRule({ at: "11:00" }), null);
});

test("normRule: أيام فاضية = كل يوم، ومنصة مش معروفة بتتشال", () => {
  const r = normRule({ action: "off", at: "2:0".replace("2:0", "02:00"), days: [], platforms: ["meta", "hamada"] });
  assert.deepEqual(r.days, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(r.platforms, ["meta"]);
  assert.equal(r.at, "02:00");
  assert.equal(r.enabled, true);
});

test("ctlCfg بيرمي قاعدة بايظة وبينضّف fired اليتيم", () => {
  const cfg = ctlCfg({
    adsControl: {
      enabled: true, dailyCeiling: 900,
      rules: [{ id: "a", action: "off", at: "02:00" }, { id: "b", action: "off", at: "خمسة" }],
      fired: { a: "2026-09-23", zzz: "2026-09-01" },
    },
  });
  assert.equal(cfg.rules.length, 1);
  assert.equal(cfg.dailyCeiling, 900);
  assert.deepEqual(Object.keys(cfg.fired), ["a"]);
});

test("ctlCfg الافتراضي مقفول — الجدولة مابتشتغلش من نفسها", () => {
  const cfg = ctlCfg({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.dailyCeiling, CTL_DEFAULTS.dailyCeiling);
});

test("ruleLabel بيكتب القاعدة بالعربي", () => {
  const r = normRule({ action: "off", at: "02:00", days: [4, 5], platforms: [] });
  const t = ruleLabel(r);
  assert.match(t, /اقفل الإعلانات الساعة 02:00/);
  assert.match(t, /الخميس/);
  assert.match(t, /كل المنصات/);
});

/* ── الجدولة: الاستحقاق والتكرار ───────────────────────────────────────── */

const cfgWith = (rules, over = {}) => ctlCfg({ adsControl: { enabled: true, rules, ...over } });
const D = "2026-09-23";

test("القاعدة مابتتنفّذش قبل ميعادها", () => {
  const cfg = cfgWith([{ id: "r1", action: "off", at: "02:00" }]);
  const { due, skipped } = dueRules({ cfg, nowBizMin: bizMinuteOf(hhmmToMin("23:00")), bizDay: D, bizDow: 3 });
  assert.equal(due.length, 0);
  assert.match(skipped[0].why, /لسه بدري/);
});

test("القاعدة بتتنفّذ في ميعادها", () => {
  const cfg = cfgWith([{ id: "r1", action: "off", at: "02:00" }]);
  const { due } = dueRules({ cfg, nowBizMin: bizMinuteOf(hhmmToMin("02:03")), bizDay: D, bizDow: 3 });
  assert.deepEqual(due.map((r) => r.id), ["r1"]);
});

test("مابتتنفّذش مرتين في نفس اليوم (idempotent)", () => {
  const cfg = cfgWith([{ id: "r1", action: "off", at: "02:00" }], { fired: { r1: D } });
  const { due, skipped } = dueRules({ cfg, nowBizMin: bizMinuteOf(hhmmToMin("02:30")), bizDay: D, bizDow: 3 });
  assert.equal(due.length, 0);
  assert.match(skipped[0].why, /اتنفّذت النهارده/);
  // بكرة نفس القاعدة بتتنفّذ عادي
  const t = dueRules({ cfg, nowBizMin: bizMinuteOf(hhmmToMin("02:30")), bizDay: "2026-09-24", bizDow: 4 });
  assert.equal(t.due.length, 1);
});

test("مهلة اللحاق: السيرفر رجع بعد ساعة ⇒ بتتنفّذ · بعد يوم ⇒ لأ", () => {
  const cfg = cfgWith([{ id: "r1", action: "on", at: "11:00" }], { graceMinutes: 90 });
  const late60 = dueRules({ cfg, nowBizMin: bizMinuteOf(hhmmToMin("12:00")), bizDay: D, bizDow: 3 });
  assert.equal(late60.due.length, 1);
  const late300 = dueRules({ cfg, nowBizMin: bizMinuteOf(hhmmToMin("16:00")), bizDay: D, bizDow: 3 });
  assert.equal(late300.due.length, 0);
  assert.match(late300.skipped[0].why, /عدّى بأكتر من ٩?90 دقيقة|عدّى بأكتر من 90 دقيقة/);
});

test("يوم الأسبوع بيتحترم", () => {
  const cfg = cfgWith([{ id: "r1", action: "off", at: "02:00", days: [5] }]);
  const wed = dueRules({ cfg, nowBizMin: bizMinuteOf(hhmmToMin("02:10")), bizDay: D, bizDow: 3 });
  assert.equal(wed.due.length, 0);
  const fri = dueRules({ cfg, nowBizMin: bizMinuteOf(hhmmToMin("02:10")), bizDay: D, bizDow: 5 });
  assert.equal(fri.due.length, 1);
});

test("الجدولة مقفولة ⇒ مفيش أي قاعدة مستحقة", () => {
  const cfg = ctlCfg({ adsControl: { enabled: false, rules: [{ id: "r1", action: "off", at: "02:00" }] } });
  const { due, skipped } = dueRules({ cfg, nowBizMin: 1400, bizDay: D, bizDow: 3 });
  assert.equal(due.length, 0);
  assert.equal(skipped[0].why, "الجدولة مقفولة");
});

test("لو اتجمّعت قاعدتين بيتنفّذوا بالترتيب الزمني", () => {
  const cfg = cfgWith([
    { id: "open", action: "on", at: "11:00" },
    { id: "close", action: "off", at: "09:00" },
  ], { graceMinutes: 600 });
  const { due } = dueRules({ cfg, nowBizMin: bizMinuteOf(hhmmToMin("12:00")), bizDay: D, bizDow: 3 });
  assert.deepEqual(due.map((r) => r.id), ["close", "open"]);
});

/* ── السقف ─────────────────────────────────────────────────────────────── */

test("applyCeiling بيشغّل اللي يوسّع تحت السقف ويسيب الباقي بسبب مكتوب", () => {
  const r = applyCeiling({
    candidates: [{ id: "a", name: "أ", budget: 300 }, { id: "b", name: "ب", budget: 50 }, { id: "c", name: "ج", budget: 100 }],
    activeBudget: 100, ceiling: 300,
  });
  assert.deepEqual(r.allowed.map((x) => x.id), ["b", "c"]);   // الأرخص الأول
  assert.deepEqual(r.blocked.map((x) => x.id), ["a"]);
  assert.equal(r.after, 250);
  assert.match(r.blocked[0].why, /السقف اليومي 300/);
});

test("السقف صفر/غير مضبوط = مفيش سقف", () => {
  const r = applyCeiling({ candidates: [{ id: "a", budget: 9999 }], activeBudget: 0, ceiling: 0 });
  assert.equal(r.allowed.length, 1);
  assert.equal(r.ceiling, null);
});

test("السقف متعدّى خلاص ⇒ مفيش حاجة بتتشغّل", () => {
  const r = applyCeiling({ candidates: [{ id: "a", name: "أ", budget: 10 }], activeBudget: 500, ceiling: 300 });
  assert.equal(r.allowed.length, 0);
  assert.equal(r.blocked.length, 1);
});

/* ── حكم الميزانية ─────────────────────────────────────────────────────── */

const cfgB = { dailyCeiling: 1000, confirmAbove: 200 };

test("رفع ميزانية فوق حد التأكيد بيطلب تأكيد، وبيعدّي مع التأكيد", () => {
  const a = budgetVerdict({ current: 100, next: 400, othersBudget: 0, cfg: cfgB });
  assert.equal(a.ok, false);
  assert.equal(a.needsConfirm, true);
  const b = budgetVerdict({ current: 100, next: 400, othersBudget: 0, cfg: cfgB, confirmed: true });
  assert.equal(b.ok, true);
});

test("تنزيل الميزانية مابيحتاجش تأكيد حتى لو الرقم كبير", () => {
  const v = budgetVerdict({ current: 900, next: 500, othersBudget: 0, cfg: cfgB });
  assert.equal(v.ok, true);
  assert.equal(v.raise, -400);
});

test("السقف اليومي بيرفض حتى مع التأكيد", () => {
  const v = budgetVerdict({ current: 100, next: 400, othersBudget: 800, cfg: cfgB, confirmed: true });
  assert.equal(v.ok, false);
  assert.equal(v.needsConfirm, undefined);
  assert.match(v.error, /السقف اليومي 1000/);
});

test("ميزانية غلط بترفض", () => {
  assert.equal(budgetVerdict({ current: 10, next: 0, cfg: cfgB }).ok, false);
  assert.equal(budgetVerdict({ current: 10, next: "حاجة", cfg: cfgB }).ok, false);
  assert.equal(budgetVerdict({ current: 10, next: -5, cfg: cfgB }).ok, false);
});

test("فوق الحاجز الصلب (ADS_MAX_DAILY_BUDGET) مرفوض ومش بيتسأل عنه تأكيد", () => {
  const v = budgetVerdict({ current: 10, next: 99999, cfg: { dailyCeiling: 0, confirmAbove: 1 } });
  assert.equal(v.ok, false);
  assert.equal(v.needsConfirm, undefined);
  assert.match(v.error, /السقف الصلب/);
});

/* ── خطة القاعدة: idempotency والدفتر ──────────────────────────────────── */

const CAMPS = [
  { platform: "meta", id: "1", name: "شغّالة", status: "ACTIVE", dailyBudget: 100 },
  { platform: "meta", id: "2", name: "موقوفة بإيد المالك", status: "PAUSED", dailyBudget: 50 },
  { platform: "meta", id: "3", name: "CBO", status: "ACTIVE", dailyBudget: null },
  { platform: "google", id: "g1", name: "جوجل", status: "ACTIVE", dailyBudget: 80 },
];
const BY_CAMPAIGN = { 3: 200 };

test("budgetOf بيقرا ميزانية حملة CBO من مجموع المجموعات", () => {
  assert.equal(budgetOf(CAMPS[2], BY_CAMPAIGN), 200);
  assert.equal(budgetOf(CAMPS[0], BY_CAMPAIGN), 100);
  assert.equal(budgetOf(CAMPS[1], {}), 50);
});

/* سناب بيفوتر بالدولار — لو السقف حسب رقمه زي ما هو بيبقى بيكدب ٣٫٧٥ ضعف. */
test("ميزانية سناب بتتحوّل للريال قبل ما السقف يحسبها", () => {
  assert.equal(fxOf("snapchat"), 3.75);
  assert.equal(fxOf("meta"), 1);
  assert.equal(fxOf("google"), 1);
  assert.equal(budgetOf({ platform: "snapchat", id: "s", dailyBudget: 200 }, {}), 750);
  assert.equal(budgetOf({ platform: "meta", id: "m", dailyBudget: 200 }, {}), 200);
});

test("السقف بيمنع سناب اللي بيبان رخيص وهو غالي", () => {
  const paused = [{ platform: "snapchat", id: "s1", name: "سناب", status: "PAUSED", dailyBudget: 100 }];
  const r = planRule({
    rule: normRule({ id: "y", action: "on", at: "11:00" }),
    campaigns: paused, book: new Map([["snapchat:s1", {}]]), cfg: { dailyCeiling: 300 }, activeBudget: 0,
  });
  // ١٠٠ دولار = ٣٧٥ ر.س > سقف ٣٠٠ ⇒ مايشتغلش
  assert.equal(r.targets.length, 0);
  assert.match(r.skipped[0].why, /السقف اليومي 300/);
});

test("«اقفل»: الموقوف خلاص مابيتبعتلوش أمر تاني", () => {
  const r = planRule({ rule: normRule({ id: "x", action: "off", at: "02:00" }), campaigns: CAMPS, byCampaign: BY_CAMPAIGN });
  assert.deepEqual(r.targets.map((t) => t.id).sort(), ["1", "3", "g1"]);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].why, /موقوفة خلاص/);
});

test("«اقفل» بمنصة واحدة بس", () => {
  const r = planRule({ rule: normRule({ id: "x", action: "off", at: "02:00", platforms: ["google"] }), campaigns: CAMPS, byCampaign: BY_CAMPAIGN });
  assert.deepEqual(r.targets.map((t) => t.id), ["g1"]);
});

test("«اقفل» مرتين ورا بعض = القايمة التانية فاضية", () => {
  const rule = normRule({ id: "x", action: "off", at: "02:00" });
  const first = planRule({ rule, campaigns: CAMPS, byCampaign: BY_CAMPAIGN });
  const after = CAMPS.map((c) => (first.targets.some((t) => t.id === c.id) ? { ...c, status: "PAUSED" } : c));
  const second = planRule({ rule, campaigns: after, byCampaign: BY_CAMPAIGN });
  assert.equal(second.targets.length, 0);
});

test("«افتح» بيرجّع اللي إحنا وقّفناه بس — مش حملة المالك", () => {
  const paused = CAMPS.map((c) => ({ ...c, status: "PAUSED" }));
  const book = new Map([["meta:1", { platform: "meta", object_id: "1" }]]);
  const r = planRule({
    rule: normRule({ id: "y", action: "on", at: "11:00" }),
    campaigns: paused, book, byCampaign: BY_CAMPAIGN, cfg: { dailyCeiling: 1000 },
  });
  assert.deepEqual(r.targets.map((t) => t.id), ["1"]);
  assert.ok(r.skipped.some((s) => /مش إحنا اللي وقّفناها/.test(s.why)));
});

test("«افتح» بيحترم السقف — والباقي بيتسجّل بسببه", () => {
  const paused = CAMPS.map((c) => ({ ...c, status: "PAUSED" }));
  const book = new Map([["meta:1", {}], ["meta:3", {}], ["google:g1", {}]]);
  const r = planRule({
    rule: normRule({ id: "y", action: "on", at: "11:00" }),
    campaigns: paused, book, byCampaign: BY_CAMPAIGN, cfg: { dailyCeiling: 200 },
  });
  // الأرخص الأول: جوجل ٨٠ ثم ميتا ١٠٠ = ١٨٠ ≤ ٢٠٠، و CBO بـ٢٠٠ اتمنعت
  assert.deepEqual(r.targets.map((t) => t.id).sort(), ["1", "g1"]);
  assert.ok(r.skipped.some((s) => /السقف اليومي/.test(s.why)));
});

test("«افتح» على حملة شغّالة خلاص = مفيش أمر", () => {
  const book = new Map([["meta:1", {}]]);
  const r = planRule({
    rule: normRule({ id: "y", action: "on", at: "11:00" }),
    campaigns: CAMPS, book, byCampaign: BY_CAMPAIGN, cfg: { dailyCeiling: 5000 },
  });
  assert.equal(r.targets.length, 0);
  assert.ok(r.skipped.some((s) => /شغّالة خلاص/.test(s.why)));
});

/* ── حارس المطعم ───────────────────────────────────────────────────────── */

const ON = { action: "on" }, OFF = { action: "off" };
const C = { respectService: true, respectHours: true };

test("مانشغّلش إعلانات والخدمة موقوفة", () => {
  const g = openGate({ rule: ON, cfg: C, service: { allPaused: true }, windowOpen: true });
  assert.equal(g.ok, false);
  assert.match(g.why, /الخدمة موقوفة/);
});

test("مانشغّلش إعلانات والمطعم قافل", () => {
  const g = openGate({ rule: ON, cfg: C, service: { allPaused: false }, windowOpen: false });
  assert.equal(g.ok, false);
  assert.match(g.why, /المطعم قافل/);
});

test("«اقفل» مابيتمنعش أبداً — الإيقاف مابيصرفش", () => {
  assert.equal(openGate({ rule: OFF, cfg: C, service: { allPaused: true }, windowOpen: false }).ok, true);
});

test("الحارس بيتقفل من الإعدادات لو المالك عايز", () => {
  const g = openGate({ rule: ON, cfg: { respectService: false, respectHours: false }, service: { allPaused: true }, windowOpen: false });
  assert.equal(g.ok, true);
});

test("حالة مش معروفة (مقدرناش نقرا) مابتمنعش التشغيل بالغلط", () => {
  // windowOpen === null معناه «مانعرفش» — بنمنع بس لما نعرف إنه قافل.
  const g = openGate({ rule: ON, cfg: C, service: null, windowOpen: null });
  assert.equal(g.ok, true);
});
