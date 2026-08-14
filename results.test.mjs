/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات «إيه هي النتيجة» — كلها على لقطة حقيقية، ولا رقم واحد مخترع

   fixtures/meta-insights.json اتسحبت من Graph API v25 لحساب فريش كاتس
   الإعلاني يوم ٢٠٢٦-٠٨-١٢ (وسناب من adsapi.snapchat.com/v1 نفس اليوم).
   أي اختبار هنا بيقيس سلوك حقيقي على أرقام حقيقية — لإن الباج اللي بنصلّحه
   كان بالظبط من نوع «الكود سليم منطقياً بس المنصة مبتقولش الرقم ده».

     node --test results.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readMetaResult, META_RESULT_MODEL } from "./ads.js";
import { decide, decidePace, activeBudgetOf, effectiveBudgetOf, killLineOf, movingCeiling } from "./autopilot.js";

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/meta-insights.json", import.meta.url), "utf8"));
const rowsOf = (w) => FX.insights[w];
const byName = (w, name) => rowsOf(w).find((r) => r.campaign_name === name);
/* حقل conversions اتسحب في نداء منفصل — بنركّبه على الصف زي ما insights()
   بترجّعه لما الحقلين يتطلبوا مع بعض. */
const convOf = (name) => (FX.conversionsField.d30.find((r) => r.campaign_name === name)?.conversions) || [];
const full = (w, name) => ({ ...byName(w, name), conversions: w === "d30" ? convOf(name) : [] });

/* الإعدادات الحيّة يوم التصليح، عشان الاختبار يحكم على الواقع مش على
   الافتراضيات. minAgeDays=7 هو اللي كان هيخلي ١٤ أغسطس يوم المذبحة. */
const LIVE = {
  targetCpa: 12, targetRoas: 4, minSpend: 50, minAgeDays: 7,
  scaleStepPct: 30, cutStepPct: 30, maxChangePct: 30,
  killMultiple: 3, killCpa: 66, maxCampaignBudget: 350, maxTotalBudget: 1000,
};

/* ═══ ١. الموديل نفسه ═══════════════════════════════════════════════════ */

test("purchase مش موجود ولا مرة في اللقطة كلها — حتى في حملة OUTCOME_SALES", () => {
  const seen = new Set();
  for (const w of ["d30", "d7", "d3"]) {
    for (const r of rowsOf(w)) for (const a of r.actions || []) seen.add(a.action_type);
  }
  assert.equal(seen.has("purchase"), false);
  assert.equal(seen.has("offsite_conversion.fb_pixel_purchase"), false);

  /* الحملة دي اسمها fc-sales-purchase، هدفها OUTCOME_SALES، ومجموعاتها
     محسّنة على PURCHASE بالنص. ولا purchase واحد. */
  const sales = byName("d30", "fc-sales-purchase");
  assert.equal(sales.objective, "OUTCOME_SALES");
  const goals = FX.adsets.filter((a) => a.campaign_id === sales.campaign_id)
    .map((a) => a.promoted_object?.custom_event_type);
  assert.ok(goals.includes("PURCHASE"), "المجموعات محسّنة على PURCHASE فعلاً");
  assert.equal(readMetaResult(sales).resultBasis.purchase ?? 0, undefined ?? 0);
  assert.equal(Number(sales.spend) > 400, true);
  assert.equal((sales.actions.find((a) => a.action_type === "lead") || {}).value, "19");
});

test("القارئ القديم (purchase وبس) بيدّي صفر لكل حملة شغّالة — الباج نفسه", () => {
  const old = (r) => {
    const p = (r.actions || []).find((a) => a.action_type === "purchase"
      || a.action_type === "offsite_conversion.fb_pixel_purchase");
    return p ? Number(p.value) : null;
  };
  for (const r of rowsOf("d3")) assert.equal(old(r), null, `${r.campaign_name} كانت بتقرا صفر`);
});

test("fb_pixel_custom = حدث Contact — مش افتراض، حقل conversions بيقوله", () => {
  /* الأرقام لازم تطابق واحد لواحد. لو يوم اتغيّرت، الافتراض بطل. */
  for (const name of ["fc-prospect-asc", "fc-prospect-lal", "fc-retarget-engagers",
    "fc-sales-purchase", "fc-leads-contact"]) {
    const r = byName("d30", name);
    const custom = Number((r.actions.find((a) => a.action_type === "offsite_conversion.fb_pixel_custom") || {}).value || 0);
    const contact = Number((convOf(name).find((a) => a.action_type === "contact_total") || {}).value || 0);
    assert.equal(custom, contact, `${name}: fb_pixel_custom (${custom}) لازم = contact_total (${contact})`);
    assert.ok(custom > 0, `${name} عندها Contact فعلاً`);
  }
});

test("الجمع كان هيعدّ نفس الشخص مرتين: Lead ⊆ Contact في كل حملة", () => {
  /* صفحة الطلب بتولّع Contact و Lead على نفس دوسة زرار واتساب، وContact
     بيتولّع كمان لوحده من زرار «اتصل». فالأكبر هو العدد الصح. */
  for (const r of rowsOf("d30")) {
    const g = (t) => Number((r.actions.find((a) => a.action_type === t) || {}).value || 0);
    const contact = g("offsite_conversion.fb_pixel_custom");
    const lead = g("lead");
    if (contact === 0 && lead === 0) continue;
    assert.ok(contact >= lead, `${r.campaign_name}: Contact ${contact} لازم ≥ Lead ${lead}`);
    assert.equal(readMetaResult({ ...r, conversions: convOf(r.campaign_name) }).resultBasis.web_intent,
      Math.max(contact, lead), "بناخد الأكبر مش المجموع");
  }
});

test("ميتا بترجّع الحدث الواحد تحت تلات أسامي — مبنعدّهوش تلات مرات", () => {
  const r = byName("d30", "fc-prospect-asc");
  const g = (t) => Number((r.actions.find((a) => a.action_type === t) || {}).value || 0);
  assert.equal(g("lead"), 37);
  assert.equal(g("offsite_conversion.fb_pixel_lead"), 37);
  assert.equal(g("onsite_web_lead"), 37);
  // ٣٧+٣٧+٣٧+٤٧ = ١٥٨ لو جمعنا. الصح ٤٧ (Contact، وهو شامل الـ Lead).
  assert.equal(readMetaResult({ ...r, conversions: convOf("fc-prospect-asc") }).results, 47);
});

test("كل حملة شغّالة بترجّع نتيجة > 0 دلوقتي — مفيش صفر أبدي", () => {
  const active = new Set(FX.campaigns.filter((c) => c.status === "ACTIVE").map((c) => c.name));
  const seen = {};
  for (const r of rowsOf("d3")) {
    if (!active.has(r.campaign_name)) continue;
    const g = readMetaResult({ ...r, conversions: [] });
    seen[r.campaign_name] = g.results;
    assert.ok(g.results > 0, `${r.campaign_name} لسه بترجع ${g.results}`);
  }
  // اللقطة الحقيقية على شباك ٣ أيام (اللي decide بيحكم بيه)
  assert.deepEqual(seen, {
    "fc-prospect-asc": 17, "fc-prospect-lal": 5,
    "fc-retarget-engagers": 2, "fc-wa-orders": 66, "fc-leads-contact": 8,
  });
});

test("fc-wa-orders نتيجتها المحادثات — مالهاش بيكسل أصلاً", () => {
  const r = byName("d30", "fc-wa-orders");
  const goals = FX.adsets.filter((a) => a.campaign_id === r.campaign_id).map((a) => a.optimization_goal);
  assert.ok(goals.includes("CONVERSATIONS"));
  const g = readMetaResult(r);
  assert.equal(g.resultBasis.messaging, 230);
  assert.equal(g.resultBasis.web_intent, undefined);   // مفيش Contact ولا Lead خالص
  assert.equal(g.results, 230);
});

test("fc-leads-contact محسّنة على CONTACT — فنتيجتها لازم تتعدّ", () => {
  const r = byName("d30", "fc-leads-contact");
  const goals = FX.adsets.filter((a) => a.campaign_id === r.campaign_id)
    .map((a) => a.promoted_object?.custom_event_type);
  assert.deepEqual([...new Set(goals)], ["CONTACT"]);
  assert.equal(readMetaResult({ ...r, conversions: convOf("fc-leads-contact") }).results, 8);
});

test("الإيراد = الشرا وبس. قيمة السلة وقت النية بترجع منفصلة", () => {
  const r = byName("d30", "fc-prospect-asc");
  const g = readMetaResult(r);
  /* action_values بترجّع 1136 ر.س لـ lead — دي سلة العميل ناويها مش فلوس
     دخلت الدرج. لو دخلت resultValue كان ROAS هيبقى 2.1x على أمنيات، وشرط
     "winning" في decide() بيتحقق من ROAS كمان. */
  assert.equal(g.resultValue, null, "مفيش إيراد محقّق — وده الصح");
  assert.equal(g.resultValueIntent, 1136);
});

test("صف من غير أي نوع بنعرفه بيرجّع null مش صفر", () => {
  const blind = { spend: "200", actions: [{ action_type: "link_click", value: "50" }] };
  assert.equal(readMetaResult(blind).results, null);
  // وصف بأنواعنا بس كلها صفر بيرجّع صفر حقيقي
  assert.equal(readMetaResult({ actions: [{ action_type: "lead", value: "0" }] }).results, 0);
});

/* ═══ ٢. قاعدة القتل ═══════════════════════════════════════════════════ */

/* بنحوّل اللقطة لصفوف decide() زي ما gatherFacts بيعملها بالظبط.

   ملحوظة مهمة على اللقطة: حقل `conversions` اتسجّل لشباك ٣٠ يوم بس. وفي
   الإنتاج insights() بتطلب `actions` و`conversions` في نفس النداء بنفس
   الـ time_range، فالاتنين دايماً من نفس الشباك. لو حقنّا أرقام الـ ٣٠ يوم
   في صف الـ ٣ أيام هنا، readMetaResult بياخد الأكبر فيطلع رقم ٣٠ يوم على
   شباك ٣ أيام — مثلاً fc-retarget-engagers كانت هتقرا ١٠ بدل ٢، وتكلفة
   النتيجة ١٢٫٣ بدل ٦١٫٤. فالحقن مسموح لشباك d30 وبس. */
const convFor = (window, name) => (window === "d30" ? convOf(name) : []);

function liveRows({ window = "d3" } = {}) {
  const adsetBy = {};
  for (const a of FX.adsets) {
    if (a.status !== "ACTIVE" || a.daily_budget == null) continue;
    adsetBy[a.campaign_id] = (adsetBy[a.campaign_id] || 0) + Number(a.daily_budget) / 100;
  }
  const ins = new Map(rowsOf(window).map((r) => [r.campaign_id, r]));
  const ins7 = new Map(rowsOf("d7").map((r) => [r.campaign_id, r]));
  const AS_OF = new Date("2026-08-14T12:00:00Z");        // يوم المذبحة المفترض
  return FX.campaigns.map((c) => {
    const a = ins.get(c.id), b = ins7.get(c.id);
    const g = a ? readMetaResult({ ...a, conversions: convFor(window, c.name) }) : null;
    const g7 = b ? readMetaResult({ ...b, conversions: convFor("d7", c.name) }) : null;
    return {
      platform: "meta", id: c.id, name: c.name, status: c.status,
      dailyBudget: c.daily_budget != null ? Number(c.daily_budget) / 100 : null,
      adsetBudget: c.daily_budget == null ? (adsetBy[c.id] ?? null) : null,
      ageDays: Math.floor((AS_OF - new Date(c.start_time)) / 86400000),
      w3: { spend: Number(a?.spend || 0), results: g ? g.results : null, revenue: g?.resultValue || 0 },
      w7: { spend: Number(b?.spend || 0), results: g7 ? g7.results : null, revenue: g7?.resultValue || 0 },
    };
  });
}

test("١٤ أغسطس: القارئ القديم كان بيوقّف ٤ حملات — دي المذبحة اللي كانت جاية", () => {
  const rows = liveRows().map((r) => ({ ...r, w3: { ...r.w3, results: 0 }, w7: { ...r.w7, results: 0 } }));
  const paused = decide(rows, LIVE).filter((d) => d.kind === "pause").map((d) => d.campaignName).sort();
  assert.deepEqual(paused,
    ["fc-prospect-asc", "fc-prospect-lal", "fc-retarget-engagers", "fc-wa-orders"]);
});

test("١٤ أغسطس بالقارئ الجديد: مفيش ولا إيقاف واحد", () => {
  const paused = decide(liveRows(), LIVE).filter((d) => d.kind === "pause");
  assert.deepEqual(paused.map((d) => `${d.campaignName}: ${d.reason}`), []);
});

test("قاعدة القتل لسه بتقتل: صرف حقيقي وصفر نية طلب", () => {
  const dead = [{
    platform: "meta", id: "x", name: "حملة ميتة", status: "ACTIVE", dailyBudget: 60, ageDays: 30,
    w3: { spend: 180, results: 0, revenue: 0 }, w7: { spend: 400, results: 0, revenue: 0 },
  }];
  const out = decide(dead, LIVE);
  assert.equal(out.filter((d) => d.kind === "pause").length, 1);
  assert.match(out[0].reason, /من غير ولا نية طلب واحدة/);
});

test("قاعدة القتل مش بتقتل حملة عندها نيات طلب", () => {
  /* نفس الحملة بالظبط، بس المنصة قالت ١٥ نية بدل صفر. */
  const alive = [{
    platform: "meta", id: "x", name: "نفس الحملة", status: "ACTIVE", dailyBudget: 60, ageDays: 30,
    w3: { spend: 180, results: 15, revenue: 0 }, w7: { spend: 400, results: 30, revenue: 0 },
  }];
  assert.equal(decide(alive, LIVE).filter((d) => d.kind === "pause").length, 0);
});

/* ── عيّنة رفيعة: ليلة الزحمة ──────────────────────────────────────────────
   المنصات بتسجّل الصرف فوراً وبتبلّغ النتايج متأخر. في ليلة زحمة، الحملة
   اللي عندها نتيجة واحدة في ٣ أيام بيطلع عليها cpa فوق خط القتل من غير ما
   يكون حصل حاجة غير إن الليلة لسه بتتحسب — وتتقفل في عزّ الذروة.          */
test("عيّنة رفيعة: نتيجة واحدة غالية بتطلع ملاحظة مش إيقاف", () => {
  const thin = [{
    platform: "meta", id: "x", name: "نتيجة واحدة", status: "ACTIVE", dailyBudget: 60, ageDays: 30,
    w3: { spend: 180, results: 1, revenue: 0 }, w7: { spend: 400, results: 2, revenue: 0 },
  }];
  const out = decide(thin, LIVE);                       // cpa = ١٨٠ ر.س ≫ خط القتل ٦٦
  assert.equal(out.filter((d) => d.kind === "pause").length, 0);
  assert.equal(out[0].kind, "note");
  assert.match(out[0].reason, /عيّنة زي دي بتتقلب برقم واحد/);
});

test("عيّنة كافية وغالية: القتل لسه شغّال", () => {
  /* نفس الحملة، بس ٣ نتايج بدل ١ — بقى فيه قياس، فالحكم بيتاخد. */
  const solid = [{
    platform: "meta", id: "x", name: "غالية بجد", status: "ACTIVE", dailyBudget: 60, ageDays: 30,
    w3: { spend: 300, results: 3, revenue: 0 }, w7: { spend: 600, results: 6, revenue: 0 },
  }];
  const out = decide(solid, LIVE);                      // cpa = ١٠٠ ر.س > ٦٦
  assert.equal(out.filter((d) => d.kind === "pause").length, 1);
  assert.match(out[0].reason, /خط القتل/);
});

test("العيّنة الرفيعة مبتحميش حملة بصفر نتايج", () => {
  /* «صفر» مش عيّنة صغيرة — دي المنصة بتقول مفيش ولا نية طلب واحدة. */
  const zero = [{
    platform: "meta", id: "x", name: "صفر", status: "ACTIVE", dailyBudget: 60, ageDays: 30,
    w3: { spend: 180, results: 0, revenue: 0 }, w7: { spend: 400, results: 0, revenue: 0 },
  }];
  assert.equal(decide(zero, LIVE).filter((d) => d.kind === "pause").length, 1);
});

test("عمى القياس ≠ صفر: null بيطلع ملاحظة مش إيقاف", () => {
  const blind = [{
    platform: "meta", id: "x", name: "منصة عمياها", status: "ACTIVE", dailyBudget: 60, ageDays: 30,
    w3: { spend: 180, results: null, revenue: 0 }, w7: { spend: 400, results: null, revenue: 0 },
  }];
  const out = decide(blind, LIVE);
  assert.equal(out.filter((d) => d.kind === "pause").length, 0);
  assert.equal(out[0].kind, "note");
  assert.match(out[0].reason, /عمى قياس/);
});

test("تنزيل المستهدف من ٢٢ لـ ١٢ مبيضيّقش خط الإيقاف كأثر جانبي", () => {
  assert.equal(killLineOf({ killMultiple: 3, targetCpa: 22, killCpa: 66 }), 66);
  assert.equal(killLineOf({ killMultiple: 3, targetCpa: 12, killCpa: 66 }), 66);
  // ولو المالك رفع المستهدف بنفسه، الخط بيتحرك معاه زي الأول
  assert.equal(killLineOf({ killMultiple: 3, targetCpa: 40, killCpa: 66 }), 120);

  /* fc-retarget-engagers تكلفة نتيجتها ٦١٫٤ ر.س. من غير الأرضية كانت
     هتتقتل بمجرد ما المستهدف ينزل — قرار مالك اتاخد كأثر جانبي. */
  const rows = liveRows().filter((r) => r.name === "fc-retarget-engagers");
  assert.equal(Math.round(rows[0].w3.spend / rows[0].w3.results * 10) / 10, 61.4);
  assert.equal(decide(rows, LIVE).filter((d) => d.kind === "pause").length, 0);
  /* بنطفّي حارس العيّنة الرفيعة هنا عشان نختبر خط القتل لوحده. الحملة دي
     عندها نتيجتين بس، فبقى عليها حارسين مستقلين — والاختبار ده مسؤول عن
     الأرضية، والاختبار اللي فوق مسؤول عن العيّنة. */
  assert.equal(
    decide(rows, { ...LIVE, killCpa: 0, minKillResults: 1 }).filter((d) => d.kind === "pause").length, 1);
});

/* fc-retarget-engagers حية دلوقتي بهامش ٤٫٦ ر.س بس تحت خط القتل (٦١٫٤ من
   ٦٦) وعلى نتيجتين بس. ليلة زحمة: الصرف بيتسجّل فوري والنتايج بتتأخر، يعني
   البسط ثابت والمقام بيكبر → التكلفة بتعدّي الخط والحملة تتقفل في الذروة.
   الحارس ده هو اللي بيمنع ده، فالاختبار بيثبّته على أرقامها الحقيقية.     */
test("الريتارجيت الحية محميّة لو الصرف طلع والنتايج اتأخرت", () => {
  const [live] = liveRows().filter((r) => r.name === "fc-retarget-engagers");
  assert.equal(live.w3.results, 2);
  const rush = [{ ...live, w3: { ...live.w3, spend: live.w3.spend * 2 } }]; // ١٢٢٫٩ → ٢٤٥٫٧، النتايج زي ما هي
  assert.ok(rush[0].w3.spend / rush[0].w3.results > 66, "المفروض تعدّي خط القتل");
  const out = decide(rush, LIVE);
  assert.equal(out.filter((d) => d.kind === "pause").length, 0);
  assert.equal(out[0].kind, "note");
});

/* ═══ ٣. السقف ═══════════════════════════════════════════════════════════ */

test("الميزانيات على مستوى المجموعة كانت خفيّة عن السقف — ١٨٠ من ٢٩٠ ر.س", () => {
  const active = liveRows().filter((r) => r.status === "ACTIVE");
  const managed = active.filter((r) => r.dailyBudget != null)
    .reduce((a, r) => a + r.dailyBudget, 0);
  assert.equal(managed, 110);                       // اللي القديم كان بيشوفه
  assert.equal(activeBudgetOf(active), 290);        // الحقيقة = رقم المالك
  assert.equal(active.filter((r) => r.dailyBudget == null && r.adsetBudget > 0).length, 2);
});

test("يوم كل الحملات فيه كاسبة: المجموع بيقف عند السقف المكتسب بالظبط", () => {
  /* السقف المكتسب من دخل حقيقي دخل الدرج: ٢٠٪ × ١٬٦٥٠ = ٣٣٠ ر.س.
     متوسط الـ ٧ أيام متحطوط ١٬٠٠٠ عن قصد عشان أرضيته (٢٠٪ × ١٬٠٠٠ = ٢٠٠)
     تبقى تحت المكتسب — فاللي بيربط فعلاً هو **المكتسب**، وده اللي المفروض
     الاختبار يثبته. (لو المتوسط كان ١٬٦٥٢٫٧٦ زي الواقع، الأرضية ٣٣١ كانت
     هي اللي تربط بفارق ريال، والاختبار كان هيقيس الأرضية وهو فاكر إنه
     بيقيس المكتسب.) */
  const ceiling = movingCeiling({
    trailing7Avg: 1000, sharePct: 20, hardMax: 2000, floor: 150,
    earned: { revenueSoFar: 1650, highWater: 1650 },
  });
  assert.equal(ceiling.ceiling, 330);
  assert.equal(ceiling.binding, "earned", "اللي بيربط لازم يكون المكتسب مش الأرضية");

  // كل حملة تكلفة نتيجتها ١ ر.س — تحت المستهدف بـ ١٢ ضعف. أحسن يوم ممكن.
  let rows = liveRows().filter((r) => r.status === "ACTIVE")
    .map((r) => ({ ...r, ageDays: 30, w3: { spend: 200, results: 200, revenue: 0 } }));
  const before = activeBudgetOf(rows);
  assert.equal(before, 290);

  const s = { ...LIVE, maxTotalBudget: ceiling.ceiling };

  /* التكبير تدريجي (٣٠٪ للخطوة)، فجولة واحدة مش بتوصل السقف. بنلف لحد ما
     الوكيل يبطّل يتحرك — ده اليوم اللي كل حملة فيه ممتازة وكل ساعة بيحاول
     يكبّر. المهم إن نقطة الاستقرار هي السقف بالظبط، ولا ريال فوقه في أي
     جولة على الطريق. */
  let rounds = 0;
  for (; rounds < 50; rounds++) {
    const out = decide(rows, s);
    const moved = new Map(out.filter((d) => d.kind === "budget").map((d) => [d.campaignId, d.detail.to]));
    if (!moved.size) break;
    rows = rows.map((r) => (moved.has(r.id) ? { ...r, dailyBudget: moved.get(r.id) } : r));
    assert.ok(activeBudgetOf(rows) <= ceiling.ceiling,
      `الجولة ${rounds}: المجموع ${activeBudgetOf(rows)} عدّى السقف ${ceiling.ceiling}`);
  }
  const after = activeBudgetOf(rows);
  assert.ok(rounds > 0 && after > before, "لازم يكون كبّر فعلاً، وإلا الاختبار مش بيقيس حاجة");
  assert.ok(rounds < 50, "لازم يستقر، مش يفضل يكبّر للأبد");
  assert.equal(after, 330, "بيستقر على السقف بالظبط — لا فوقه ولا بيسيب مساحة");

  /* والميزانيات الخفيّة (١٨٠ ر.س على مستوى المجموعة) داخلة في الـ ٣٣٠ دي.
     يعني اللي الوكيل بيديره فعلاً وقف عند ١٥٠ مش ٣٣٠ — وده الصح. */
  assert.equal(rows.filter((r) => r.dailyBudget != null)
    .reduce((a, r) => a + r.dailyBudget, 0), 150);
});

test("السقف المطلق ٢٠٠٠ بيمسك حتى لو الدخل خرافي والحملات كلها كاسبة", () => {
  const ceiling = movingCeiling({
    trailing7Avg: 50000, sharePct: 20, hardMax: 2000, floor: 150,
    earned: { revenueSoFar: 100000, highWater: 100000 },
  });
  assert.equal(ceiling.ceiling, 2000);

  let rows = liveRows().filter((r) => r.status === "ACTIVE")
    .map((r) => ({ ...r, ageDays: 30, w3: { spend: 200, results: 200, revenue: 0 } }));
  const s = { ...LIVE, maxTotalBudget: 2000 };

  /* عشرين جولة — كل جولة بتاخد ناتج اللي قبلها. سقف الحملة الواحدة (٣٥٠)
     بيمسك الأول، فالمجموع بيقف عند ٣ × ٣٥٠ + ١٨٠ خفيّة = ١٢٣٠ من غير ما
     يقرب من الـ ٢٠٠٠ أصلاً. المهم إنه مبيعديش. */
  for (let i = 0; i < 20; i++) {
    const out = decide(rows, s);
    const moved = new Map(out.filter((d) => d.kind === "budget").map((d) => [d.campaignId, d.detail.to]));
    if (!moved.size) break;
    rows = rows.map((r) => (moved.has(r.id) ? { ...r, dailyBudget: moved.get(r.id) } : r));
    assert.ok(activeBudgetOf(rows) <= 2000, `الجولة ${i}: ${activeBudgetOf(rows)} عدّت ٢٠٠٠`);
  }
  assert.ok(activeBudgetOf(rows) <= 2000);
  for (const r of rows) if (r.dailyBudget != null) assert.ok(r.dailyBudget <= 350);
});

test("التسريع جوّه اليوم كمان بيعدّ الميزانيات الخفيّة", () => {
  /* السقف ٣٣٠ والشغّال ٢٩٠ (منهم ١٨٠ على مستوى المجموعة). القديم كان
     بيشوف ١١٠ فيفتكر إن فيه ٢٢٠ مساحة. */
  const rows = liveRows().filter((r) => r.status === "ACTIVE")
    .map((r) => ({ ...r, spend: 50, results: 10 }));
  const out = decidePace({
    rows, state: new Map(), accountDay: "2026-08-14", msToRoll: 6 * 3600_000,
    now: new Date("2026-08-14T17:00:00+03:00"),
    pulse: { pace: 1, pacePct: 5, riyadhHour: 20, riyadhMinute: 0, dow: 4, elapsedH: 16,
             today: { orders: 20, revenue: 1650 }, baseline: { days: 5, orders: 19, revenue: 1570 },
             confidence: { note: "" } },
    s: { ...LIVE, pacing: true, maxTotalBudget: 330, paceStartHour: 13, paceLastRaiseHour: 1,
         paceUpThresholdPct: 20, paceDownThresholdPct: -15, paceMinBaselineDays: 2, paceMinOrders: 6 },
  });
  // الإيقاع +٥٪ جوّه المنطقة الطبيعية ومفيش خرق (٢٩٠ ≤ ٣٣٠) → مفيش أي حركة
  assert.equal(out.actions.length, 0);
  assert.match(out.gate, /جوّه المنطقة الطبيعية/);
});

/* الشباك المشترك لاختبارات الإيقاع تحت. */
const paceInput = (over = {}) => ({
  state: new Map(), accountDay: "2026-08-14", msToRoll: 6 * 3600_000,
  now: new Date("2026-08-14T17:00:00+03:00"),
  pulse: { pace: 1, pacePct: 5, riyadhHour: 20, riyadhMinute: 0, dow: 4, elapsedH: 16,
           today: { orders: 20, revenue: 900 }, baseline: { days: 5, orders: 19, revenue: 860 },
           confidence: { note: "" } },
  ...over,
  s: { ...LIVE, pacing: true, paceStartHour: 13, paceLastRaiseHour: 1,
       paceUpThresholdPct: 20, paceDownThresholdPct: -15, paceMinBaselineDays: 2,
       paceMinOrders: 6, ...(over.s || {}) },
});

test("الخرق بيتشاف دلوقتي: الشغّال الحقيقي ٢٩٠ مش ١١٠ الظاهرة", () => {
  const rows = liveRows().filter((r) => r.status === "ACTIVE")
    .map((r) => ({ ...r, spend: 50, results: 10 }));
  /* ١٥٠ سقف. القديم كان بيشوف ١١٠ (الميزانيات اللي على الحملة بس) ويقول
     «مفيش خرق» ويسيب ١٨٠ ر.س على مستوى المجموعات بتصرف فوق السقف. */
  const out = decidePace(paceInput({ rows, s: { maxTotalBudget: 150 } }));
  assert.equal(out.breach, true, "لازم يشوف الخرق");
  assert.equal(out.phase, "down");
});

test("خرق من غير تسريع من عندنا: بيتقال بصوت عالي، ومبيقصّش ميزانية المالك", () => {
  /* الإيقاع بيسحب زيادته هو بس. هنا مفيش state خالص، يعني الـ ٢٩٠ كلها
     ميزانيات أساسية — فالصح إنه **ما يلمسش** حاجة ويطلّع ملاحظة للمالك.
     الاختبار ده بيحرس الحدّ ده: لو حد بكرة خلّى الإيقاع يقصّ الميزانية
     الأساسية، ده توسيع صلاحية من غير موافقة والاختبار هيقع. */
  const rows = liveRows().filter((r) => r.status === "ACTIVE")
    .map((r) => ({ ...r, spend: 50, results: 10 }));
  const out = decidePace(paceInput({ rows, s: { maxTotalBudget: 150 } }));

  assert.equal(out.actions.length, 0, "ممنوع يقصّ ميزانية أساسية من نفسه");
  const n = out.notes.find((x) => x.op === "breach-needs-owner");
  assert.ok(n, "لازم يطلّع ملاحظة — السكوت على خرق سقف هو المشكلة");
  assert.match(n.text, /على مستوى المجموعات الإعلانية/);
  assert.match(n.text, /قرار المالك/);
});

test("خرق مع تسريع من عندنا: بيسحبه، وبخطوة أكبر، ولحد الأساس بس", () => {
  /* fc-prospect-asc ميزانية المالك ٥٠ والإيقاع رفعها ٨٠ الصبح. */
  const asc = liveRows().find((r) => r.name === "fc-prospect-asc");
  const rows = liveRows().filter((r) => r.status === "ACTIVE")
    .map((r) => ({ ...r, spend: 50, results: 10, ...(r.id === asc.id ? { dailyBudget: 80 } : {}) }));
  const state = new Map([[`meta:${asc.id}`, {
    platform: "meta", campaignId: asc.id, campaignName: asc.name, accountDay: "2026-08-14",
    baseBudget: 50, currentBudget: 80, lastActionAt: Date.parse("2026-08-14T08:00:00+03:00"),
  }]]);

  const out = decidePace(paceInput({ rows, state, s: { maxTotalBudget: 150 } }));
  const down = out.actions.filter((a) => a.op === "down");
  assert.equal(down.length, 1);
  assert.equal(down[0].campaignId, asc.id);
  assert.equal(down[0].from, 80);
  assert.equal(down[0].breach, true);
  assert.ok(down[0].stepPct >= 25, "الخرق بينزل خطوة أكبر — مش زحف ١٥٪");
  assert.ok(down[0].to >= 50, `مبينزلش تحت ميزانية المالك (٥٠) — نزل لـ ${down[0].to}`);
  assert.equal(down[0].to, 60);            // round(80 × 0.75) = 60، وفوق الأساس
});

/* ═══ ٤. سناب ═══════════════════════════════════════════════════════════ */

test("سناب: صفر حقيقي مش صفر كاذب — كل عدّاداتها صفر على ٨٢ ر.س صرف", () => {
  const stats = Object.values(FX.snapchat.stats).find((s) => s && Number(s.spend) > 0);
  assert.ok(stats, "فيه حملة سناب صارفة في اللقطة");
  assert.equal(Number(stats.spend) / 1e6 > 80, true);
  assert.equal(Number(stats.impressions), 31791);
  // SIGN_UP هو Lead عندنا (funnel.js/SNAP_NAME). صفر يعني صفر فعلاً.
  assert.equal(Number(stats.conversion_sign_ups || 0), 0);
  assert.equal(Number(stats.conversion_purchases || 0), 0);
});

/* ═══ ٥. الحساب المكتوب في الإعدادات ═══════════════════════════════════ */

test("الأرقام اللي targetCpa اتبنى عليها لسه هي هي في اللقطة", () => {
  /* لو الأرقام دي اتغيّرت، الاشتقاق المكتوب في DEFAULT_SETTINGS محتاج
     يتقرا تاني — الاختبار ده هو اللي هيقول. */
  let results = 0, spend = 0;
  for (const r of rowsOf("d30")) {
    const g = readMetaResult({ ...r, conversions: convOf(r.campaign_name) });
    results += g.results || 0;
    spend += Number(r.spend || 0);
  }
  assert.equal(results, 329);
  assert.equal(Math.round(spend * 100) / 100, 2105.61);
  // تكلفة النتيجة المدمجة الحقيقية = ٦٫٤ ر.س، تحت المستهدف (١٢) وبعيد عن خط القتل (٦٦)
  const blended = spend / results;
  assert.equal(Math.round(blended * 100) / 100, 6.4);
  assert.ok(blended < LIVE.targetCpa);
  assert.ok(blended < killLineOf(LIVE) / 3);
});

test("الموديل مكتوب بترتيب واضح ومحدش بيتكرر بين المجموعات", () => {
  const seen = new Set();
  for (const g of META_RESULT_MODEL) {
    for (const a of g.actions) {
      assert.equal(seen.has(a), false, `${a} مكرر في أكتر من مجموعة — ده بيعدّ مرتين`);
      seen.add(a);
    }
  }
  assert.deepEqual(META_RESULT_MODEL.map((g) => g.key), ["web_intent", "messaging", "purchase"]);
});
