/* MC1 (١٧/١٠) — تكلفة التسويق في نافذة: كل مصدر بفيكستشر لوحده + يوم ١٦/١٠ كامل على داتابيز مزيّفة.
   node --test marketingcost.test.mjs   (أرقام وهمية؛ مفيش جوالات ولا شبكة) */
import test from "node:test";
import assert from "node:assert/strict";
import { waTemplateCost, waRepliesCost, smsSplit, llmOf, marketingSummary, makeMarketingCost, MARKETING_SMS_KINDS, isMarketingSms, SQL } from "./marketingcost.js";
import { WA_RATE_DEFAULTS } from "./waaicost.js";
import { SMS_PART_PRICE, SMS_KINDS } from "./smslog.js";
import { SMS_PART_PRICE as C360_PART_PRICE } from "./customer360.js";

const close = (a, b, eps = 0.005, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ""} ${a} ≠ ${b}`);
const S = new Date("2026-10-16T01:00:00Z"), E = new Date("2026-10-17T01:00:00Z");   // اليوم التشغيلي ١٦/١٠ (٤ الفجر → ٤ الفجر الرياض)

test("قوالب واتساب: سعر ميتا أولاً (billable=false = ٠)، وإلا الفئة × البطاقة ومعلّمة unpriced؛ تسويقي قصاد خدمي", () => {
  const w = waTemplateCost([
    { category: "marketing", billable: "true", n: 50 },
    { category: "marketing", billable: null, n: 5 },         // لسه مفيش حالة من ميتا ⇒ البطاقة (تقديري)
    { category: "marketing", billable: "false", n: 3 },      // ميتا: مجانية (نقطة دخول مجانية)
    { category: "utility", billable: "true", n: 20 },
    { category: "utility", billable: "false", n: 10 },       // خدمي جوّه نافذة مفتوحة ⇒ ٠
    { category: "authentication", billable: "true", n: 4 },
    { category: "", billable: null, n: 2 },                  // فئة مجهولة ⇒ خدمي بسعر الخدمي
    { category: "marketing", billable: "true", n: 0 },
  ], undefined);
  assert.equal(w.marketing.n, 58); assert.equal(w.marketing.free, 3); assert.equal(w.marketing.unpriced, 5);
  close(w.marketing.cost, 55 * WA_RATE_DEFAULTS.marketing, 0.0001, "٥٥ قالب تسويقي مدفوع × ٠٫٢١٥٩");
  assert.equal(w.utility.n, 36); assert.equal(w.utility.free, 10); assert.equal(w.utility.unpriced, 2);
  assert.equal(w.utility.authentication, 4); assert.equal(w.utility.unknownCategory, 2);
  close(w.utility.cost, 20 * WA_RATE_DEFAULTS.utility + 4 * WA_RATE_DEFAULTS.authentication + 2 * WA_RATE_DEFAULTS.utility, 0.0001);
  assert.equal(w.rateDate, WA_RATE_DEFAULTS.date);
  /* بطاقة أسعار من الإعدادات */
  const w2 = waTemplateCost([{ category: "marketing", billable: "true", n: 10 }], { marketing: 0.3, date: "2026-10-10" });
  close(w2.marketing.cost, 3, 0.0001); assert.equal(w2.rateDate, "2026-10-10");
  /* فئة ميتا بتغلب فئة القالب: صف اتجمّع على فئة ميتا marketing رغم إن القالب UTILITY */
  assert.equal(waTemplateCost([{ category: "MARKETING", billable: "true", n: 2 }]).marketing.n, 2, "الفئة بأي حالة حروف");
});

test("الردود الحرة: billable اللي ميتا علّمته بس × سعر الرد من الإعدادات", () => {
  const r = waRepliesCost([{ billable: "true", n: 7 }, { billable: "false", n: 40 }, { billable: null, n: 12 }], 0.05);
  assert.deepEqual([r.n, r.billable, r.unpriced, r.rateSar], [59, 7, 12, 0.05]);
  close(r.cost, 0.35, 0.0001);
  assert.equal(waRepliesCost([], "bad").rateSar, 0.0401, "سعر غلط ⇒ الافتراضي");
  assert.equal(waRepliesCost([{ billable: null, n: 30 }]).cost, 0, "من غير علامة من ميتا = مش بنحاسب (الرد الحر جوّه النافذة ببلاش)");
});

test("SMS: تسويقي (حملة/أتمتة/استرداد/ولاء/منتظرين/دعوة تقييم) قصاد تشغيلي، تكلفة فعلية + تقديري معلّم", () => {
  assert.deepEqual([...MARKETING_SMS_KINDS], ["campaign", "flow", "cart_recovery", "loyalty", "waitlist", "review_invite"]);
  for (const k of MARKETING_SMS_KINDS) assert.ok(SMS_KINDS[k], `${k} نوع معروف في smslog.js`);
  assert.equal(isMarketingSms("otp"), false); assert.equal(isMarketingSms("staff"), false); assert.equal(isMarketingSms("order_status"), false);
  const s = smsSplit([
    { kind: "campaign", n: 36, cost: 5.76, est_n: 0, est_parts: 0 },
    { kind: "cart_recovery", n: 4, cost: 0.64, est_n: 0, est_parts: 0 },
    { kind: "waitlist", n: 2, cost: 0.16, est_n: 0, est_parts: 0 },
    { kind: "loyalty", n: 1, cost: 0.16, est_n: 0, est_parts: 0 },
    { kind: "flow", n: 2, cost: 0, est_n: 2, est_parts: 4 },          // تقنيات مارجّعتش تكلفة ⇒ ٤ أجزاء × ٠٫٠٧٥
    { kind: "staff", n: 51, cost: 4.16, est_n: 0, est_parts: 0 },
    { kind: "order_status", n: 14, cost: 1.12, est_n: 0, est_parts: 0 },
    { kind: "otp", n: 9, cost: 0, est_n: 9, est_parts: 9 },
  ]);
  assert.equal(s.marketing.n, 45); close(s.marketing.cost, 6.72 + 4 * SMS_PART_PRICE, 0.0001);
  assert.equal(s.marketing.estimatedN, 2); close(s.marketing.estimatedCost, 0.3, 0.0001);
  assert.equal(s.operational.n, 74); assert.equal(s.operational.cost, Math.round((5.28 + 9 * SMS_PART_PRICE) * 100) / 100, "٥٫٩٥٥ ⇒ ٥٫٩٦ (هللتين)");
  assert.equal(s.estimated, true); assert.equal(s.partPrice, SMS_PART_PRICE);
  assert.equal(s.marketing.byKind.campaign.n, 36);
  const clean = smsSplit([{ kind: "campaign", n: 1, cost: 0.16, est_n: 0, est_parts: 0 }]);
  assert.equal(clean.estimated, false);
  assert.equal(C360_PART_PRICE, SMS_PART_PRICE, "سجل الرسايل وتكلفة التسويق بنفس سعر الجزء (مصدر واحد)");
});

test("الذكاء: ai_calls هو الدفتر؛ wa_assist_turns نفس النداءات ⇒ للمطابقة مش للجمع", () => {
  const l = llmOf([{ calls: 132, cost: 0.169598, estimated: 8 }], [{ n: 40, cost: 0.12 }]);
  assert.equal(l.calls, 132); close(l.total, 0.1696, 0.0001); assert.equal(l.estimatedCalls, 8);
  assert.deepEqual(l.assistTurns, { n: 40, cost: 0.12, includedInCalls: true });
  assert.equal(l.total, l.cost, "مش cost + assist");
  const none = llmOf(null, null);
  assert.equal(none.known, false); assert.equal(none.total, 0); assert.equal(none.assistTurns, null);
});

test("المجاميع: تسويقي = إعلانات + واتساب تسويقي + SMS تسويقي؛ تشغيلي = الباقي؛ التقديري معلّم", () => {
  const sum = marketingSummary({
    ads: { total: 526.43 },
    whatsapp: { marketing: { cost: 12.954, unpriced: 0 }, utility: { cost: 1.2, unpriced: 3 }, replies: { cost: 0.4 } },
    sms: { marketing: { cost: 6.72 }, operational: { cost: 5.28 }, estimated: false },
    llm: { total: 0.17, estimatedCalls: 0 },
  });
  close(sum.marketingTotal, 546.1, 0.001); close(sum.operationalTotal, 7.05, 0.001); close(sum.total, 553.15, 0.001);
  assert.deepEqual(sum.estimatedParts, ["wa_unpriced"]); assert.equal(sum.estimated, true);
  assert.deepEqual(sum.breakdown, { ads: 526.43, whatsapp: 12.95, sms: 6.72, waOperational: 1.6, smsOperational: 5.28, llm: 0.17 });
  const noAds = marketingSummary({ ads: { error: "down" }, sms: { marketing: { cost: 1 }, operational: { cost: 0 } } });
  assert.equal(noAds.marketingTotal, 1); assert.equal(noAds.estimated, false);
});

/* داتابيز مزيّفة: بتوجّه كل SQL لصفوفه وبتسجّل اللي اتسأل */
function fakePool(data, { fail = [] } = {}) {
  const asked = [];
  return {
    asked,
    async query(sql, params) {
      asked.push({ sql, params });
      const key = /cms_campaign_sends/.test(sql) ? "sms" : /wa_assist_turns/.test(sql) ? "assist" : /ai_calls/.test(sql) ? "ai"
        : /template IS NOT NULL/.test(sql) ? "tpl" : /template IS NULL/.test(sql) ? "rep" : "?";
      if (fail.includes(key)) throw new Error(`relation for ${key} does not exist`);
      return { rows: data[key] || [] };
    },
  };
}
/* يوم ١٦/١٠ (الجمعة): الإعلانات ٥٢٦٫٤٣ (ad_spend_hourly) + SMS التسويقية ٦٫٧٢ (نفس byKind بتاع سجل الرسايل) + قوالب واتساب من الصفوف */
const DAY1016 = {
  tpl: [
    { category: "marketing", billable: "true", n: 60 },     // حملة واتساب الجمعة: ميتا علّمتها billable
    { category: "marketing", billable: "false", n: 2 },     // اتنين مجانيين (نقطة دخول مجانية)
    { category: "utility", billable: "true", n: 15 },       // تحديثات طلبات برّه النافذة
    { category: "utility", billable: "false", n: 9 },       // جوّه نافذة مفتوحة ⇒ ٠
  ],
  rep: [{ billable: "false", n: 30 }],
  sms: [
    { kind: "campaign", n: 36, cost: 5.76, est_n: 0, est_parts: 0 }, { kind: "cart_recovery", n: 4, cost: 0.64, est_n: 0, est_parts: 0 },
    { kind: "waitlist", n: 2, cost: 0.16, est_n: 0, est_parts: 0 }, { kind: "loyalty", n: 1, cost: 0.16, est_n: 0, est_parts: 0 },
    { kind: "staff", n: 51, cost: 4.16, est_n: 0, est_parts: 0 }, { kind: "order_status", n: 14, cost: 1.12, est_n: 0, est_parts: 0 },
  ],
  ai: [{ calls: 20, cost: 0.03, estimated: 0 }],
  assist: [{ n: 6, cost: 0.02 }],
};
const ADS1016 = { total: 526.43, web: 526.43, meta: 242.1, google: 284.33, metaWhatsapp: 0 };

test("١٦/١٠ على داتابيز مزيّفة: التسويق = ٥٢٦٫٤٣ إعلانات + ٦٠ قالب تسويقي × ٠٫٢١٥٩ + SMS تسويقية ٦٫٧٢ — ولا mk_entries ولا سحب صرف تاني", async () => {
  const pool = fakePool(DAY1016);
  const spend = { calls: 0, async spendInWindow() { spend.calls++; return ADS1016; } };
  const mc = makeMarketingCost({ pool, getSettingsData: async () => ({ waBot: {} }), adspend: spend, log: () => {} });
  const m = await mc.marketingCostInWindow(S, E, { ads: ADS1016 });
  const waMk = 60 * WA_RATE_DEFAULTS.marketing;                                      // 12.954
  close(m.whatsapp.marketing.cost, waMk, 0.0001); assert.equal(m.whatsapp.marketing.n, 62); assert.equal(m.whatsapp.marketing.free, 2);
  close(m.whatsapp.utility.cost, 15 * WA_RATE_DEFAULTS.utility, 0.0001); assert.equal(m.whatsapp.replies.cost, 0); assert.equal(m.whatsapp.replies.n, 30);
  close(m.sms.marketing.cost, 6.72, 0.0001); assert.equal(m.sms.marketing.n, 43); close(m.sms.operational.cost, 5.28, 0.0001);
  close(m.llm.total, 0.03, 0.0001); assert.equal(m.llm.assistTurns.n, 6);
  close(m.marketingTotal, Math.round((526.43 + waMk + 6.72) * 100) / 100, 0.001, "marketingTotal");
  assert.equal(m.marketingTotal, 546.1);
  close(m.operationalTotal, 15 * WA_RATE_DEFAULTS.utility + 5.28 + 0.03, 0.006);
  assert.ok(m.marketingTotal >= m.ads.total, "التسويق ≥ الإعلانات دايماً");
  assert.equal(m.estimated, false); assert.deepEqual(m.errors, []);
  assert.equal(spend.calls, 0, "الصرف اتبعت جاهز ⇒ مااتسحبش تاني");
  assert.ok(pool.asked.every((x) => !/mk_entries/.test(x.sql)), "صرف مركز التسويق اليدوي عمره ما بيتقري (عدّ مزدوج)");
  assert.ok(pool.asked.every((x) => x.params[0].getTime() === S.getTime() && x.params[1].getTime() === E.getTime()), "كل الاستعلامات على نفس النافذة");
  assert.equal(pool.asked.length, 5, "٥ استعلامات: قوالب، ردود، SMS، ذكاء، مطابقة المساعد");
  assert.match(m.notes.join(" "), /١٣٪.*الإعلانات بس/);
});

test("من غير صرف جاهز بيسحبه من adspend؛ ومصدر واقع (جدول مش موجود) مابيوقّعش الباقي", async () => {
  const pool = fakePool(DAY1016, { fail: ["ai", "assist"] });
  const spend = { calls: 0, async spendInWindow(a, b) { spend.calls++; assert.equal(a.getTime(), S.getTime()); assert.equal(b.getTime(), E.getTime()); return ADS1016; } };
  const mc = makeMarketingCost({ pool, getSettingsData: async () => ({}), adspend: () => spend, log: () => {} });
  const m = await mc.marketingCostInWindow(S, E);
  assert.equal(spend.calls, 1); assert.equal(m.ads.total, 526.43);
  assert.deepEqual(m.errors, ["llm", "llm_assist"]); assert.equal(m.llm.known, false); assert.equal(m.llm.total, 0);
  assert.equal(m.marketingTotal, 546.1, "التسويق زي ما هو — الذكاء تشغيلي");
  /* الإعدادات: بطاقة أسعار وسعر رد من waBot */
  const mc2 = makeMarketingCost({ pool: fakePool({ tpl: [{ category: "marketing", billable: null, n: 10 }], rep: [{ billable: "true", n: 4 }] }),
    getSettingsData: async () => ({ waBot: { waRates: { marketing: 0.25 }, replyRateSar: 0.1 } }), log: () => {} });
  const m2 = await mc2.marketingCostInWindow(S, E, { ads: null });
  close(m2.whatsapp.marketing.cost, 2.5, 0.0001); close(m2.whatsapp.replies.cost, 0.4, 0.0001);
  assert.equal(m2.ads, null); assert.equal(m2.marketingTotal, 2.5); assert.deepEqual(m2.estimatedParts, ["wa_unpriced"]);
});

test("الاستعلامات: صادر + قالب غير فاضي + مش failed/skipped، نفس UNION سجل الرسايل من غير holdout، الحالة sent بس", () => {
  assert.match(SQL.waTemplates, /direction = 'out'/); assert.match(SQL.waTemplates, /template <> ''/); assert.match(SQL.waTemplates, /NOT IN \('failed','skipped'\)/);
  assert.match(SQL.waTemplates, /pricing->>'billable'/); assert.match(SQL.waTemplates, /pricing->>'category'/);
  assert.match(SQL.sms, /cms_campaign_sends cs WHERE cs.status <> 'holdout'/); assert.match(SQL.sms, /status = 'sent'/); assert.match(SQL.sms, /FROM sms_log l/);
  assert.match(SQL.aiCalls, /FROM ai_calls/); assert.match(SQL.assistTurns, /FROM wa_assist_turns/);
  for (const s of Object.values(SQL)) assert.ok(/\$1/.test(s) && /\$2/.test(s), "نافذة [start, end) في كل استعلام");
});
