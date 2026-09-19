import { test } from "node:test";
import assert from "node:assert/strict";
import { shiftState, metaSpendToday, buildActions, riyadhClock } from "./growthnow.js";
import { weekKey, nextPayday, nextDow, buildCalendar, autoSignals, periodKey } from "./readiness.js";

// الرياض = UTC+3
const at = (riyadh) => new Date(Date.parse(riyadh + ":00+03:00"));

test("shiftState: وردية بتعدّي نص الليل بتتحسب من يوم فتحها", () => {
  assert.equal(shiftState(null, at("2026-09-19T11:30")).open, false);
  const s = shiftState(null, at("2026-09-19T15:00"));
  assert.equal(s.open, true); assert.equal(s.minutesOpen, 180);
  // السبت ١:٠٠ الفجر = وردية الجمعة (لين ٣)
  const f = shiftState(null, at("2026-09-19T01:00"));
  assert.equal(f.open, true); assert.equal(f.minutesOpen, 13 * 60);
  // الأحد ٢:٣٠ = وردية السبت اتقفلت ٢
  assert.equal(shiftState(null, at("2026-09-20T02:30")).open, false);
});

test("riyadhClock: يوم الشغل بيدوّر ٤ الفجر", () => {
  assert.equal(riyadhClock(at("2026-09-19T03:30")).bizDay, "2026-09-18");
  assert.equal(riyadhClock(at("2026-09-19T04:10")).bizDay, "2026-09-19");
});

test("metaSpendToday: من ٤ لـ١٠ الصبح رقم الحساب بتاع امبارح", () => {
  const g = (iso, acct) => ({ lastRun: { at: at(iso).toISOString(), acctToday: acct, isOpen: false } });
  assert.equal(metaSpendToday(g("2026-09-19T04:00", 723.6), at("2026-09-19T04:05")).spend, 0);
  assert.equal(metaSpendToday(g("2026-09-19T18:00", 300), at("2026-09-19T18:03")).spend, 300);
  const stale = metaSpendToday(g("2026-09-19T18:00", 300), at("2026-09-19T19:00"));
  assert.equal(stale.stale, true);
  // دورة من يوم شغل تاني = مش معروف
  assert.equal(metaSpendToday(g("2026-09-18T20:00", 500), at("2026-09-19T13:00")).spend, null);
  assert.equal(metaSpendToday(null).stale, true);
});

const calm = {
  clock: { hour: 15 }, shift: { open: true, minutesOpen: 180 },
  online: { today: 4, ySame: 4 }, revenue: { total: 2000 },
  ads: { spend: 200, guard: { stale: false, ageMin: 3 }, lastReport: { day: "2026-09-18", rec: { code: "SCALE", ar: "كبّر" } } },
  carts: { enabled: true, smsEnabled: true, open: 3, reachable: 1 },
  sms: { brake: null, held: [] }, soldOut: [], approvals: { hub: 0, autopilot: 0 },
  content: { next24: 2, failed: 0 }, offers: [{ id: "nd96_kilo", title: "كيلو", status: "live", daysLeft: 11 }],
};

test("buildActions: مفيش حاجة غلط = allGood ومفيش شغل مخترع", () => {
  const r = buildActions(calm);
  assert.equal(r.allGood, true);
  assert.equal(r.actions.length, 0);
});

test("buildActions: الترتيب bad قبل warn قبل info، وحد أقصى ٥", () => {
  const s = {
    ...calm,
    ads: { ...calm.ads, guard: { stale: true, ageMin: 45 } },
    online: { today: 0, ySame: 5 },
    sms: { brake: { at: "2026-09-19T10:00:00Z" }, held: [{ id: 9, name: "كيتا بوكس" }] },
    carts: { enabled: true, smsEnabled: true, open: 60, reachable: 3, openValue: 5000 },
    soldOut: [{ id: "108", name: "كبدة", until: null, hoursAgo: 14 }],
    approvals: { hub: 4, autopilot: 11 },
    content: { next24: 0, failed: 1 },
    offers: [{ id: "nd96_kilo", title: "كيلو", status: "live", daysLeft: 2, until: "2026-09-30", provisional: true }],
  };
  const r = buildActions(s);
  assert.equal(r.actions.length, 5);
  assert.ok(r.more > 0);
  assert.equal(r.allGood, false);
  const lv = r.actions.map((a) => a.level);
  assert.deepEqual([...lv].sort((a, b) => ["bad", "warn", "info"].indexOf(a) - ["bad", "warn", "info"].indexOf(b)), lv);
  assert.ok(r.actions.every((a) => Array.isArray(a.go) && a.go.length === 2));
  assert.ok(r.actions.some((a) => a.key === "no_orders"));
});

test("buildActions: نسبة الصرف بتتقاس بس آخر اليوم", () => {
  const early = buildActions({ ...calm, clock: { hour: 16 }, ads: { ...calm.ads, spend: 900 }, revenue: { total: 1000 } });
  assert.ok(!early.actions.some((a) => a.key === "share_live"));
  const late = buildActions({ ...calm, clock: { hour: 23 }, ads: { ...calm.ads, spend: 900 }, revenue: { total: 1000 } });
  assert.ok(late.actions.some((a) => a.key === "share_live"));
});

test("readiness: الأسبوع بيبدأ السبت، والراتب ٢٧", () => {
  assert.equal(weekKey("2026-09-19"), "2026-09-19"); // سبت
  assert.equal(weekKey("2026-09-25"), "2026-09-19"); // جمعة
  assert.equal(weekKey("2026-09-26"), "2026-09-26");
  assert.equal(periodKey("daily", "2026-09-19"), "d2026-09-19");
  assert.equal(nextPayday("2026-09-19"), "2026-09-27");
  assert.equal(nextPayday("2026-12-28"), "2027-01-27");
  assert.equal(nextDow("2026-09-19", 4), "2026-09-24");
});

test("readiness: التقويم مترتب ومحسوب المهلة، ومفيش تاريخ غلط لليوم الوطني", () => {
  const cal = buildCalendar("2026-09-19", at("2026-09-19T12:00"));
  const nd = cal.find((o) => o.id === "nd96");
  assert.equal(nd.date, "2026-09-23");
  assert.equal(nd.daysLeft, 4);
  assert.equal(nd.startNow, true);
  const dated = cal.filter((o) => o.date).map((o) => o.date);
  assert.deepEqual([...dated].sort(), dated);
  assert.ok(cal.find((o) => o.id === "ramadan").approx);
  for (const o of cal) for (const k of ["content", "ads", "ops"]) assert.ok(Array.isArray(o[k]), `${o.id}.${k}`);
});

test("readiness: الإشارات التلقائية من اللقطة", () => {
  const s = autoSignals({ ...calm, soldOut: [{ id: "1", name: "كبدة", until: null, hoursAgo: 20 }] }, "2026-09-19");
  assert.equal(s.queue24.ok, true);
  assert.equal(s.guardFresh.ok, true);
  assert.equal(s.reportFresh.ok, true);
  assert.equal(s.soldOut.ok, false);
  assert.deepEqual(autoSignals(null, "2026-09-19"), {});
});
