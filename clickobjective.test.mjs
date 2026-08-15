/* ═══════════════════════════════════════════════════════════════════════════
   «النتيجة» بتتحدد بالهدف — اختبار على أرقام ليلة ١٤/١٥ أغسطس الحقيقية

   ليلة ١٥ أغسطس الطيار قفل حملتين بأمر «صفر نتايج»:
     fc-tiktok-prospect  TRAFFIC / CLICK  → ٧٤.٣٠ ر.س، ٤٢٬٤٩٣ ظهور، ٣٧٩ نقرة
     fc-snap-prospect    SWIPES           → ٧٨.٩٣ ر.س، ١٧٧ نقرة (٢.٧٪ CTR)
   الاتنين على بيكسل ملوش أي تاريخ تحويلات، يعني عدّاد `results` بتاعهم
   مستحيل هندسياً يبقى غير صفر — الصفر ده قياس ناقص مش أداء وحش.

   الأرقام هنا كلها من سجل القرارات ومن /report/integrated/get/ الحقيقي.

     node --test clickobjective.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import {
  decide, guardPause, resultModelOf, isClickObjective,
  killLineOf, numbersSettling,
} from "./autopilot.js";

/* الإعدادات الحيّة ليلة الحادثة. */
const LIVE = {
  targetCpa: 22, targetRoas: 3, minSpend: 50, minAgeDays: 7,
  scaleStepPct: 30, cutStepPct: 30, maxChangePct: 30,
  killMultiple: 3, killCpa: 66, minKillResults: 3,
  maxCampaignBudget: 350, maxTotalBudget: 1000,
  targetCpc: 1.0, killCpc: 3.0,
};

/* الحملتين زي ما اللقطة شافتهم بالظبط: صرف حقيقي، نقرات كتير، results=0.
   `ageDays: 7` عن قصد — عشان نعدّي بوابة minAgeDays ونوصل لقاعدة القتل
   نفسها. لو سبناها ١ الاختبار كان هيعدّي لسبب غلط. */
const TIKTOK = {
  platform: "tiktok", id: "1873489118877970", name: "fc-tiktok-prospect",
  status: "ACTIVE", objective: "TRAFFIC", dailyBudget: 100, ageDays: 7,
  w3: { spend: 74.30, results: 0, revenue: 0, clicks: 379 },
  w7: { spend: 74.30, results: 0, revenue: 0, clicks: 379 },
};
const SNAP = {
  platform: "snapchat", id: "1dfaed1e-1fab-47ec-8e94-90f7a5d25c61",
  name: "fc-snap-prospect", status: "ACTIVE",
  objective: "AWARENESS_AND_ENGAGEMENT", dailyBudget: 75, ageDays: 8,
  w3: { spend: 78.93, results: 0, revenue: 0, clicks: 177 },
  w7: { spend: 99.03, results: 0, revenue: 0, clicks: 177 },
};

/* ═══ ١. الباج نفسه: القاعدة القديمة كانت بتقتل الاتنين ═══════════════════ */

test("القاعدة القديمة (results=0 + صرف) كانت بتوقّف الحملتين", () => {
  const old = (r, s) => (r.w3.results === 0 && r.w3.spend >= s.minSpend * 2)
    || (r.w3.results > 0 && r.w3.spend / r.w3.results > killLineOf(s));
  // تيك توك ٧٤.٣٠ فوق ١٠٠؟ لأ — بس الوكيل استعمل minSpend (٥٠) مش ضعفه.
  const agentThreshold = (r, s) => r.w3.results === 0 && r.w3.spend >= s.minSpend;
  assert.equal(agentThreshold(TIKTOK, LIVE), true, "الوكيل شاف تيك توك مستاهلة القتل");
  assert.equal(agentThreshold(SNAP, LIVE), true, "والوكيل شاف سناب كمان");
  assert.equal(old(SNAP, LIVE), false); // ٧٨.٩٣ < ١٠٠ — قواعد التشغيل ما كانتش هتقتلها
});

/* ═══ ٢. الموديل الجديد: النتيجة = النقرة ═══════════════════════════════ */

test("هدف النقرات بيتعرف على التلات منصات", () => {
  assert.equal(isClickObjective("tiktok", "TRAFFIC"), true);
  assert.equal(isClickObjective("snapchat", "AWARENESS_AND_ENGAGEMENT"), true);
  assert.equal(isClickObjective("meta", "OUTCOME_TRAFFIC"), true);
  // وأهداف التحويل مابتتخلطش
  assert.equal(isClickObjective("meta", "OUTCOME_SALES"), false);
  assert.equal(isClickObjective("meta", "OUTCOME_LEADS"), false);
  assert.equal(isClickObjective("tiktok", "REACH"), false);
});

test("تيك توك: تكلفة النتيجة = تكلفة النقرة ٠.٢٠ ر.س، مش ما لا نهاية", () => {
  const rm = resultModelOf(TIKTOK, LIVE);
  assert.equal(rm.kind, "click");
  assert.equal(rm.count, 379);
  assert.equal(Math.round(rm.cost * 100) / 100, 0.2);
  assert.equal(rm.killLine, 3.0);          // خط النقرة، مش killCpa=66
  assert.equal(rm.blind, false);
});

test("سناب: ٠.٤٥ ر.س للنقرة", () => {
  const rm = resultModelOf(SNAP, LIVE);
  assert.equal(rm.kind, "click");
  assert.equal(rm.count, 177);
  assert.equal(Math.round(rm.cost * 100) / 100, 0.45);
});

test("ممنوع نحسب تكلفة لما مفيش إشارة موصولة — null مش صفر", () => {
  // المنصة ما رجّعتش نقرات خالص
  const blindClick = { ...TIKTOK, w3: { ...TIKTOK.w3, clicks: null } };
  const rm = resultModelOf(blindClick, LIVE);
  assert.equal(rm.blind, true);
  assert.equal(rm.cost, null);
  // حملة تحويلات والمنصة عمياها
  const blindConv = {
    platform: "meta", objective: "OUTCOME_LEADS",
    w3: { spend: 300, results: null, revenue: 0, clicks: 50 },
  };
  assert.equal(resultModelOf(blindConv, LIVE).cost, null);
  assert.equal(resultModelOf(blindConv, LIVE).blind, true);
});

/* ═══ ٣. المحاكاة: قرار امبارح ما كانش هيتاخد النهارده ═══════════════════ */

test("محاكاة ليلة ١٥ أغسطس: ولا واحدة من الحملتين بتتقفل دلوقتي", () => {
  const out = decide([TIKTOK, SNAP], LIVE);
  const paused = out.filter((d) => d.kind === "pause");
  assert.deepEqual(paused, [], "مفيش أي أمر إيقاف");

  // ولا حتى تقليل ميزانية — النقرة تحت المستهدف
  assert.deepEqual(out.filter((d) => d.kind === "budget"), []);

  // والسبب بيتقال بلغة النقرة
  const tt = out.find((d) => d.campaignName === "fc-tiktok-prospect");
  assert.match(tt.reason, /نقرة/);
  assert.equal(tt.kind, "note");
});

test("حملة نقرات كاسبة مبتتكبّرش أوتوماتيك — التحويل لسه مش مقيس", () => {
  const out = decide([TIKTOK], LIVE);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "note");
  assert.match(out[0].reason, /مش هنكبّرها أوتوماتيك/);
});

/* ═══ ٤. الحملة الميتة فعلاً لسه بتتقفل ══════════════════════════════════ */

test("صرف حقيقي + صفر نقرة فعلاً → الإيقاف لسه شغّال", () => {
  const dead = {
    platform: "tiktok", id: "dead-1", name: "fc-tiktok-dead",
    status: "ACTIVE", objective: "TRAFFIC", dailyBudget: 100, ageDays: 30,
    w3: { spend: 220, results: 0, revenue: 0, clicks: 0 },
    w7: { spend: 400, results: 0, revenue: 0, clicks: 0 },
  };
  const out = decide([dead], LIVE);
  const pause = out.find((d) => d.kind === "pause");
  assert.ok(pause, "الحملة الميتة فعلاً لازم تتقفل");
  assert.match(pause.reason, /من غير ولا نقرة واحدة/);
});

test("نقرة غالية جداً → الإيقاف شغّال بخط النقرة", () => {
  const pricey = {
    platform: "tiktok", id: "pricey-1", name: "fc-tiktok-pricey",
    status: "ACTIVE", objective: "TRAFFIC", dailyBudget: 100, ageDays: 30,
    w3: { spend: 300, results: 0, revenue: 0, clicks: 20 },   // ١٥ ر.س للنقرة
    w7: { spend: 300, results: 0, revenue: 0, clicks: 20 },
  };
  const pause = decide([pricey], LIVE).find((d) => d.kind === "pause");
  assert.ok(pause);
  assert.match(pause.reason, /أعلى من خط القتل/);
});

test("حملة التحويلات لسه بتتحاكم بـ killCpa زي ما هي", () => {
  const conv = {
    platform: "meta", id: "m1", name: "fc-conv-bad", status: "ACTIVE",
    objective: "OUTCOME_LEADS", dailyBudget: 100, ageDays: 30,
    w3: { spend: 400, results: 4, revenue: 0, clicks: 900 },  // ١٠٠ ر.س/نتيجة
    w7: { spend: 400, results: 4, revenue: 0, clicks: 900 },
  };
  const pause = decide([conv], LIVE).find((d) => d.kind === "pause");
  assert.ok(pause, "١٠٠ ر.س/نتيجة فوق ٦٦ — تتقفل");
  assert.match(pause.reason, /نتيجة/);
});

/* ═══ ٥. حماية العمر لسه شغّالة ═══════════════════════════════════════════ */

test("minAgeDays لسه بيمنع الحكم على حملة جديدة", () => {
  const fresh = { ...TIKTOK, ageDays: 1, w3: { spend: 220, results: 0, revenue: 0, clicks: 0 } };
  const out = decide([fresh], LIVE);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "note");
  assert.match(out[0].reason, /حملة جديدة/);
});

/* ═══ ٦. الأرقام اللي لسه بتستقر ═════════════════════════════════════════ */

test("جوّه النافذة: الإيقاف بيستنى الأرقام تستقر", () => {
  const dead = {
    platform: "tiktok", id: "dead-2", name: "fc-tiktok-dead", status: "ACTIVE",
    objective: "TRAFFIC", dailyBudget: 100, ageDays: 30, settling: true,
    w3: { spend: 220, results: 0, revenue: 0, clicks: 0 },
    w7: { spend: 400, results: 0, revenue: 0, clicks: 0 },
  };
  const out = decide([dead], LIVE);
  assert.equal(out.filter((d) => d.kind === "pause").length, 0);
  assert.match(out[0].reason, /لسه بتستقر/);

  // وبعد ما المطعم يقفل، نفس الحملة بتتقفل عادي
  assert.ok(decide([{ ...dead, settling: false }], LIVE).find((d) => d.kind === "pause"));
});

test("numbersSettling بيقول أيوه جوّه النافذة ولأ برّاها", () => {
  const S = { adsOpenHour: 11, adsCloseHour: 3, adsLateCloseHour: 4, adsLateNightDows: [4, 5] };
  // السبت ١٥ أغسطس ١٦:٣٥ بتوقيت جدة = ١٣:٣٥ UTC — جوّه النافذة
  assert.equal(numbersSettling(new Date("2026-08-15T13:35:00Z"), S), true);
  // ٠١:٤٣ بتوقيت جدة (وقت قتل تيك توك) = ٢٢:٤٣ UTC ١٤ أغسطس — جوّه النافذة برضه
  assert.equal(numbersSettling(new Date("2026-08-14T22:43:00Z"), S), true);
  // ٠٩:٠٠ بتوقيت جدة = ٠٦:٠٠ UTC — المطعم قافل، الأرقام مستقرة
  assert.equal(numbersSettling(new Date("2026-08-15T06:00:00Z"), S), false);
});

/* ═══ ٧. السور اللي ما اشتغلش — الوكيل هو اللي قفل الحملتين ═══════════════ */

test("guardPause بيرفض إيقاف حملة نقرات شغّالة", () => {
  const rows = [
    { ...TIKTOK, spend: TIKTOK.w3.spend, clicks: TIKTOK.w3.clicks, results: 0, cpa: null },
  ];
  const msg = guardPause(
    { platform: "tiktok", campaignId: "1873489118877970" },
    LIVE, rows, { writeOk: true });
  assert.ok(msg, "لازم يرفض");
  assert.match(msg, /مرفوض/);
  assert.match(msg, /نقرة/);
});

test("guardPause لسه بيسمح بإيقاف حملة نقرات ميتة فعلاً", () => {
  const rows = [{
    platform: "tiktok", id: "dead-3", name: "fc-tiktok-dead", status: "ACTIVE",
    objective: "TRAFFIC", spend: 220, clicks: 0, results: 0, cpa: null,
  }];
  assert.equal(
    guardPause({ platform: "tiktok", campaignId: "dead-3" }, LIVE, rows, { writeOk: true }),
    null, "الميتة فعلاً مفيش سور بيحميها");
});
