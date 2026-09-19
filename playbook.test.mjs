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
