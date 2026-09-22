import test from "node:test";
import assert from "node:assert/strict";
import {
  preorderCfg, PREORDER_DEFAULTS, riyadhDay, riyadhAt, ar12, slotKey,
  parseSlotKey, slotWindow, slotLabel, slotsFor, validateSlot, isDueNow, dayLabel,
} from "./preorder.js";

/* ٢٢ سبتمبر ٢٠٢٦، ٩ مساءً بتوقيت الرياض = 18:00 UTC */
const NOW = Date.parse("2026-09-22T21:00:00+03:00");

test("يوم الرياض بيلف بعد نص الليل مش بعد نص ليل جرينتش", () => {
  assert.equal(riyadhDay(Date.parse("2026-09-22T23:30:00+03:00")), "2026-09-22");
  assert.equal(riyadhDay(Date.parse("2026-09-23T00:30:00+03:00")), "2026-09-23");
  assert.equal(riyadhDay(NOW, 1), "2026-09-23");
});

test("الساعة بالعربي ١٢ ساعة", () => {
  assert.equal(ar12("12:00"), "١٢:٠٠م");
  assert.equal(ar12("00:00"), "١٢:٠٠ص");
  assert.equal(ar12("17:30"), "٥:٣٠م");
  assert.equal(ar12("01:00"), "١:٠٠ص");
});

test("المفتاح بيتقري وبيترجع زي ما هو", () => {
  const k = slotKey("2026-09-23", { start: "17:00", end: "20:00" });
  assert.equal(k, "2026-09-23#17:00-20:00");
  assert.deepEqual(parseSlotKey(k), { day: "2026-09-23", start: "17:00", end: "20:00" });
  assert.equal(parseSlotKey("لا"), null);
  assert.equal(parseSlotKey("2026-09-23#25:00-26:00"), null);
});

test("شباك بينتهي بعد نص الليل بيعدّي لليوم اللي بعده", () => {
  const w = slotWindow("2026-09-23", "23:00", "01:00");
  assert.equal(w.start.toISOString(), "2026-09-23T20:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-09-23T22:00:00.000Z");
  assert.ok(w.end > w.start);
});

test("النص العربي للموعد", () => {
  assert.equal(dayLabel("2026-09-23", NOW), "بكرة");
  assert.equal(dayLabel("2026-09-22", NOW), "النهارده");
  assert.equal(slotLabel("2026-09-23#17:00-20:00", NOW), "بكرة ٥:٠٠م – ٨:٠٠م");
});

test("الإعدادات بتتقصّ في حدودها والشبابيك الغلط بتتشال", () => {
  const c = preorderCfg({ preorder: { daysAhead: 99, cutoffMin: -5, slots: [{ start: "99:00", end: "1", cap: 5 }] } });
  assert.equal(c.daysAhead, 7);
  assert.equal(c.cutoffMin, 0);
  assert.deepEqual(c.slots.map((s) => s.start), PREORDER_DEFAULTS.slots.map((s) => s.start));
});

test("القايمة: بكرة كله مفتوح، والنهارده اللي فات اتشال", () => {
  const cfg = preorderCfg({});
  const list = slotsFor(cfg, new Map(), NOW);
  // ٩ مساءً: شبابيك النهارده ١٢-٢ و٢-٥ و٥-٨ خلصوا
  const today = list.filter((s) => s.day === "2026-09-22");
  assert.deepEqual(today.map((s) => s.start), ["20:00", "23:00"]);
  assert.ok(today[0].closed, "شباك ٨-١١ بدأ خلاص ⇒ مقفول للحجز");
  const tom = list.filter((s) => s.day === "2026-09-23");
  assert.equal(tom.length, 5);
  assert.ok(tom.every((s) => !s.closed && !s.full));
  assert.equal(list.filter((s) => s.day === "2026-09-24").length, 0, "daysAhead=1");
});

test("السقف بيقفل الشباك", () => {
  const cfg = preorderCfg({});
  const key = "2026-09-23#17:00-20:00";
  const counts = new Map([[key, 40]]);
  const s = slotsFor(cfg, counts, NOW).find((x) => x.key === key);
  assert.equal(s.left, 0);
  assert.ok(s.full);
  assert.equal(validateSlot(key, cfg, counts, NOW).error, "slot_full");
  assert.ok(validateSlot(key, cfg, new Map([[key, 39]]), NOW).ok);
});

test("التحقق بيرفض الغلط وبيقبل الصح", () => {
  const cfg = preorderCfg({});
  assert.ok(validateSlot("2026-09-23#12:00-14:00", cfg, new Map(), NOW).ok);
  assert.equal(validateSlot("", cfg, new Map(), NOW).error, "bad_slot");
  assert.equal(validateSlot("2026-09-23#13:00-14:00", cfg, new Map(), NOW).error, "unknown_slot");
  assert.equal(validateSlot("2026-09-25#12:00-14:00", cfg, new Map(), NOW).error, "slot_out_of_range");
  // شباك النهارده ٨-١١ بدأ ⇒ مقفول
  assert.equal(validateSlot("2026-09-22#20:00-23:00", cfg, new Map(), NOW).error, "slot_closed");
  assert.equal(validateSlot("2026-09-23#12:00-14:00", preorderCfg({ preorder: { enabled: false } }), new Map(), NOW).error, "preorder_disabled");
});

test("مهلة القفل بتمنع الحجز قبل الشباك بساعة ونص", () => {
  const cfg = preorderCfg({});
  const key = "2026-09-23#12:00-14:00";
  const justBefore = Date.parse("2026-09-23T10:31:00+03:00"); // فاضل ٨٩ دقيقة
  assert.equal(validateSlot(key, cfg, new Map(), justBefore).error, "slot_closed");
  const wellBefore = Date.parse("2026-09-23T10:00:00+03:00"); // فاضل ١٢٠ دقيقة
  assert.ok(validateSlot(key, cfg, new Map(), wellBefore).ok);
});

test("وقت التنفيذ: المندوب والمطبخ بيصحّوا قبل الشباك بمهلة التحضير", () => {
  const cfg = preorderCfg({}); // prepLeadMin=60
  const start = riyadhAt("2026-09-23", "19:00");
  assert.equal(isDueNow(null, cfg, NOW), true, "الطلب العادي دايماً فوراً");
  assert.equal(isDueNow(start, cfg, NOW), false);
  assert.equal(isDueNow(start, cfg, start.getTime() - 61 * 60_000), false);
  assert.equal(isDueNow(start, cfg, start.getTime() - 59 * 60_000), true);
  assert.equal(isDueNow("مش تاريخ", cfg, NOW), true, "قيمة بايظة ⇒ نعامله عادي مش نضيّعه");
});

/* ملاحظات نقطة البيع لازم تصرخ بالموعد — الكاشير والمطبخ بيقروا السطر ده */
import { posNotesOf } from "./shop.js";

test("ملاحظة نقطة البيع: الموعد أول حاجة، ووقت الاستلام المفترض بيختفي", () => {
  const base = {
    order_no: "W1", option: "delivery", created_at: "2026-09-22T18:00:00Z",
    delivery_fee: 9, notes: "بدون بصل", address: { latitude: 21.5, longitude: 39.1 },
  };
  const plain = posNotesOf(base, { withFee: true, now: NOW });
  assert.ok(!plain.includes("لموعد"), "الطلب العادي مالوش موعد");

  const sched = posNotesOf({ ...base, scheduled_slot: "2026-09-23#17:00-20:00" }, { withFee: true, now: NOW });
  assert.ok(sched.startsWith("📅 لموعد بكرة ٥:٠٠م – ٨:٠٠م"), sched);
  assert.ok(sched.includes("مدفوع أونلاين✅"));

  // استلام محجوز: «استلام HH:MM» الوهمي (دلوقتي+٤٠ د) مايتكتبش — الموعد هو الحقيقة
  const pick = posNotesOf({ ...base, option: "pickup", scheduled_slot: "2026-09-23#12:00-14:00" }, { now: NOW });
  assert.ok(pick.startsWith("📅 لموعد بكرة ١٢:٠٠م – ٢:٠٠م"), pick);
  assert.ok(!/استلام \d\d:\d\d/.test(pick), pick);
  const pickNow = posNotesOf({ ...base, option: "pickup" }, { now: NOW });
  assert.ok(/استلام \d\d:\d\d/.test(pickNow), pickNow);
});
