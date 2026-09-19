import test from "node:test";
import assert from "node:assert/strict";
import { judgeAd, optimizationAdvice, hourWeight, playbookPrompt, PLAYBOOK } from "./playbook.js";

test("judgeAd follows the 09 §3-3 table", () => {
  assert.equal(judgeAd({ spend: 200, impressions: 20000, clicks: 900, ourOrders: 5 }).verdict, "winner");
  assert.equal(judgeAd({ spend: 40, impressions: 3000, clicks: 20 }).verdict, "kill");          // CTR 0.67%
  assert.equal(judgeAd({ spend: 160, impressions: 9000, clicks: 400, atc: 12, ourOrders: 0 }).verdict, "kill");
  assert.equal(judgeAd({ spend: 70, impressions: 1000, clicks: 40, atc: 0 }).verdict, "kill");
  assert.equal(judgeAd({ spend: 70, impressions: 1000, clicks: 40, atc: 3, frequency: 3.1 }).verdict, "refresh");
  assert.equal(judgeAd({ spend: 20, impressions: 800, clicks: 30 }).verdict, "keep");
});

test("ATC→Purchase switch needs 3 finished days at ≥10 paid orders", () => {
  assert.equal(optimizationAdvice([2, 6, 16]).ready, false);
  assert.equal(optimizationAdvice([10, 12, 11]).ready, true);
  assert.equal(optimizationAdvice([]).ready, false);
});

test("hour weights: dinner heavier than lunch, closed hours zero", () => {
  assert.ok(hourWeight(19) > hourWeight(13));
  assert.equal(hourWeight(6), 0);
});

test("prompt carries the hard rules", () => {
  const p = playbookPrompt();
  for (const k of ["3000", "12:30", "01:30", "ستيك", "اقتراح"]) assert.ok(p.includes(k), k);
  assert.equal(PLAYBOOK.optimization.switchToPurchaseAt, 10);
});

/* ⭐ تقييم جوجل الحي (عمر ١٩/٩: «الرقم بيتغيّر — عايزه ديناميكي») */
import { setLiveGoogleRating, googleRatingText, PLAYBOOK as PB2, playbookPrompt as pp2 } from "./playbook.js";
test("playbook google rating is live, not hardcoded", () => {
  assert.doesNotMatch(JSON.stringify(PB2), /٤٫٨|١٨١/);
  setLiveGoogleRating({ rating: 4.9, count: 186 });
  assert.equal(googleRatingText(), "⭐٤٫٩ على جوجل (+١٨٠ تقييم)");
  assert.match(PB2.creative.winners, /٤٫٩ على جوجل \(\+١٨٠ تقييم\)/);
  assert.match(JSON.stringify(PB2), /٤٫٩/);          // getters survive JSON (mkhub → dashboard)
  assert.match(pp2(), /٤٫٩ على جوجل/);
  setLiveGoogleRating({ rating: 0, count: 5 });         // bad data ignored — keeps last good
  assert.match(googleRatingText(), /٤٫٩/);
});
