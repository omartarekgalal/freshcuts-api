import { test } from "node:test";
import assert from "node:assert/strict";
import { senderCfg, pacing, inWindow, withFooter, MIN_GAP_DAYS } from "./wasender.js";

// ٢٦/٩ ٥ العصر الرياض = ١٤:٠٠ UTC (يوم سبت)
const AT_17 = Date.parse("2026-09-26T14:00:00Z");
const AT_03 = Date.parse("2026-09-26T00:00:00Z"); // ٣ الفجر الرياض
const on = (x = {}) => senderCfg({ waSender: { enabled: true, ...x } });
const idle = { today: 0, lastHour: 0, failStreak: 0, sinceBreak: 0, lastSentAt: null };

test("قاعدة عمر: الفاصل لكل رقم مابيقلّش عن ٣ أيام أبداً", () => {
  assert.equal(MIN_GAP_DAYS, 3);
  assert.equal(senderCfg({ waSender: { gapDays: 1 } }).gapDays, 3);
  assert.equal(senderCfg({ waSender: { gapDays: 0 } }).gapDays, 3);
  assert.equal(senderCfg({ waSender: { gapDays: 7 } }).gapDays, 7);
  assert.equal(senderCfg({}).gapDays, 3);
});

test("مقفول افتراضياً", () => {
  assert.equal(senderCfg({}).enabled, false);
  assert.equal(pacing(senderCfg({}), idle, AT_17).reason, "disabled");
});

test("ساعات الإرسال بتوقيت الرياض", () => {
  assert.equal(inWindow(on(), AT_17), true);
  assert.equal(inWindow(on(), AT_03), false);
  assert.equal(pacing(on(), idle, AT_03).reason, "outside_hours");
  assert.equal(inWindow(on({ days: ["fri"] }), AT_17), false); // السبت مش في الأيام
  assert.equal(inWindow(on({ startHour: 20, endHour: 2 }), AT_03 - 2 * 3600e3), true); // ١ الفجر
});

test("السقف اليومي وسقف الساعة وإيقاف الفشل", () => {
  assert.equal(pacing(on({ dailyCap: 40 }), { ...idle, today: 40 }, AT_17).reason, "daily_cap");
  assert.equal(pacing(on({ hourCap: 15 }), { ...idle, lastHour: 15 }, AT_17).reason, "hour_cap");
  const f = pacing(on({ failStop: 3 }), { ...idle, failStreak: 3 }, AT_17);
  assert.equal(f.reason, "fail_stop"); assert.equal(f.wait, null);
});

test("الفاصل العشوائي بين رسالتين + استراحة بعد الدفعة", () => {
  const cfg = on({ minDelaySec: 60, maxDelaySec: 120, batchSize: 10, batchPauseMin: 12 });
  const ok = pacing(cfg, idle, AT_17, () => 0.5);
  assert.equal(ok.wait, 0); assert.equal(ok.nextGapSec, 90);
  const early = pacing(cfg, { ...idle, lastSentAt: new Date(AT_17 - 30e3).toISOString(), nextGapSec: 90, sinceBreak: 3 }, AT_17);
  assert.equal(early.reason, "delay"); assert.equal(early.wait, 60);
  const brk = pacing(cfg, { ...idle, lastSentAt: new Date(AT_17 - 100e3).toISOString(), nextGapSec: 90, sinceBreak: 10 }, AT_17);
  assert.equal(brk.reason, "batch_pause"); assert.equal(brk.wait, 12 * 60 - 100);
});

test("الحدود بتتظبط لو اتكتبت غلط", () => {
  const c = senderCfg({ waSender: { minDelaySec: 5, maxDelaySec: 1, dailyCap: 99999 } });
  assert.equal(c.minDelaySec, 20); assert.equal(c.maxDelaySec, 20); assert.equal(c.dailyCap, 300);
});

test("سطر آخر الرسالة", () => {
  assert.equal(withFooter("أهلاً", ""), "أهلاً");
  assert.equal(withFooter("أهلاً", "للإيقاف ردّ: إيقاف"), "أهلاً\n\nللإيقاف ردّ: إيقاف");
});
