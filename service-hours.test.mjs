/* ⏱ ترتيب الساعات في تقرير «ساعة بساعة» — الشرط اللي عمر قاله بالحرف:
   «مع اعتبار ان الساعة ١ و٢ و٣ صباحا يكونوا بعد ١٢ مساءا وليس قبلهم في اي
   ترتيب». الاختبارات دي هي اللي بتحرس الجملة دي، ومعاها مدى بيعدّي ٤ الفجر
   (قطع اليوم التشغيلي) ومدى بيعدّي نص الليل. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hourSlots, buildHourly, hourProfile, hourTotals, riyadhHourKey,
  resolveWindow, hourChannelOf, MAX_HOUR_SLOTS,
} from "./service.js";
import { bizHourIndex } from "./bizday.js";

/* الرياض = UTC+3 ثابت. ساعة الرياض 22:00 يوم 23/9 = 19:00Z. */
const R = (day, h, m = 0) => new Date(Date.UTC(2026, 8, day, h - 3, m, 0)).toISOString();
const hoursOf = (s) => s.slots.map((x) => x.hour);

test("riyadhHourKey: نفس شكل to_char(... AT TIME ZONE 'Asia/Riyadh','YYYY-MM-DD HH24')", () => {
  assert.equal(riyadhHourKey("2026-09-23T19:05:00Z"), "2026-09-23 22");
  // 23:30Z = 02:30 الرياض اليوم اللي بعده — الفخ اللي بيغلّط الساعات بـ٣
  assert.equal(riyadhHourKey("2026-09-23T23:30:00Z"), "2026-09-24 02");
  assert.equal(riyadhHourKey("2026-09-23T21:00:00Z"), "2026-09-24 00");
  assert.equal(riyadhHourKey("لا شيء"), null);
});

test("مدى بيعدّي نص الليل: ١ الفجر بعد ٢٣ — مش قبلها", () => {
  const s = hourSlots(R(23, 21), R(24, 3));            // ٢١ ← ٠٢:٥٩
  assert.deepEqual(hoursOf(s), [21, 22, 23, 0, 1, 2]);
  const i23 = s.slots.findIndex((x) => x.hour === 23);
  const i1 = s.slots.findIndex((x) => x.hour === 1);
  assert.ok(i1 > i23, "١ الفجر لازم تيجي بعد ٢٣ في الخط الزمني");
  // وكلهم على نفس اليوم التشغيلي، لأن القطع ٤ الفجر
  assert.deepEqual([...new Set(s.slots.map((x) => x.bizDay))], ["2026-09-23"]);
  // ترتيب اليوم التشغيلي تصاعدي على طول الخط
  const idx = s.slots.map((x) => x.bizHourIndex);
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  assert.deepEqual(idx, [17, 18, 19, 20, 21, 22]);
});

test("مدى بيعدّي ٤ الفجر: اليوم التشغيلي بيلف، والخط الزمني يفضل بترتيب الوقت", () => {
  const s = hourSlots(R(24, 2), R(24, 6));            // ٠٢ ← ٠٥:٥٩
  assert.deepEqual(hoursOf(s), [2, 3, 4, 5]);
  assert.deepEqual(s.slots.map((x) => x.bizDay),
    ["2026-09-23", "2026-09-23", "2026-09-24", "2026-09-24"]);
  // ٣ الفجر آخر ساعة في يومها (23) و٤ الفجر أول ساعة في اليوم اللي بعده (0)
  assert.deepEqual(s.slots.map((x) => x.bizHourIndex), [22, 23, 0, 1]);
});

test("١ الفجر بترتيب ٢١ و٢٣ بترتيب ١٩ — الرقم الخام يكدب والفهرس يصدق", () => {
  assert.equal(bizHourIndex(23), 19);
  assert.equal(bizHourIndex(0), 20);
  assert.equal(bizHourIndex(1), 21);
  assert.equal(bizHourIndex(3), 23);
  assert.equal(bizHourIndex(4), 0);
  assert.ok(bizHourIndex(1) > bizHourIndex(23));
  assert.ok(bizHourIndex(3) > bizHourIndex(12));
});

test("الخانة الأولى والأخيرة بيتقصّوا على حدود النافذة", () => {
  const s = hourSlots("2026-09-23T19:40:00Z", "2026-09-23T21:15:00Z");
  assert.equal(s.slots.length, 3);
  assert.equal(s.slots[0].hour, 22);
  assert.equal(s.slots[0].minutes, 20);
  assert.equal(s.slots[0].partial, true);
  assert.equal(s.slots[1].minutes, 60);
  assert.equal(s.slots[1].partial, false);
  assert.equal(s.slots[2].minutes, 15);
});

test("نافذة فاضية أو مقلوبة = مفيش خانات", () => {
  assert.deepEqual(hourSlots(R(23, 20), R(23, 20)).slots, []);
  assert.deepEqual(hourSlots(R(23, 22), R(23, 20)).slots, []);
  assert.deepEqual(hourSlots(null, "لا شيء").slots, []);
});

test("مدى طويل: بنعرض آخر MAX_HOUR_SLOTS ساعة وبنعلّم truncated", () => {
  const s = hourSlots("2026-08-01T00:00:00Z", "2026-09-24T00:00:00Z");
  assert.equal(s.truncated, true);
  assert.equal(s.slots.length, MAX_HOUR_SLOTS);
  assert.ok(s.total > MAX_HOUR_SLOTS);
  // آخر خانة لسه جوّه النافذة
  assert.ok(new Date(s.slots.at(-1).toUtc) <= new Date("2026-09-24T00:00:00Z"));
});

/* ── التجميع ────────────────────────────────────────────────────────────── */

const ord = (day, h, ch, total) => ({ ch, ts: R(day, h), total });

test("buildHourly: كل طلب بيقع في ساعة الرياض بتاعته وبقناته", () => {
  const { slots } = hourSlots(R(23, 22), R(24, 2));
  const h = buildHourly({
    slots,
    orders: [
      ord(23, 22, "hall", 100), ord(23, 22, "store", 50), ord(23, 23, "app:keeta", 80),
      ord(24, 0, "takeaway", 30), ord(24, 1, "store", 70), ord(24, 1, "app:hungerstation", 120),
      ord(24, 1, "own_delivery", 40),
    ],
    visitors: [{ hkey: "2026-09-24 01", sessions: 10, cart: 4, paid: 1, known: 2 }],
    stuck: [{ hkey: "2026-09-24 01", n: 3 }],
    spend: [{ hkey: "2026-09-23 22", sar: 45.5 }],
    flags: [{ hkey: "2026-09-24 00", kind: "closed" }, { hkey: "2026-09-24 00", kind: "open" }],
  });
  assert.deepEqual(h.hours.map((x) => x.hour), [22, 23, 0, 1]);
  assert.deepEqual(h.hours.map((x) => x.orders.n), [2, 1, 1, 3]);
  assert.equal(h.hours[0].ch.hall.n, 1);
  assert.equal(h.hours[0].ch.store.sar, 50);
  assert.equal(h.hours[1].ch.apps.n, 1);
  assert.deepEqual(h.hours[3].apps, { hungerstation: { n: 1, sar: 120 } });
  assert.equal(h.hours[3].visitors.sessions, 10);
  assert.equal(h.hours[3].stuck, 3);
  assert.equal(h.hours[0].spend, 45.5);
  assert.equal(h.hours[2].soldOut, 1);
  assert.equal(h.hours[2].reopened, 1);
  assert.deepEqual(h.apps, ["keeta", "hungerstation"]);
  assert.equal(h.hasOwnDelivery, true);
  // المجموع بيطابق مجموع الصفوف — الواجهة مابتجمعش بنفسها
  assert.equal(h.totals.orders.n, 7);
  assert.equal(h.totals.orders.sar, 490);
  assert.equal(h.totals.visitors.sessions, 10);
});

test("طلب برّه النافذة مابيتحسبش (مدى مقصوص)", () => {
  const { slots } = hourSlots(R(23, 22), R(23, 23));
  const h = buildHourly({ slots, orders: [ord(23, 22, "hall", 10), ord(24, 1, "hall", 99)] });
  assert.equal(h.hours.length, 1);
  assert.equal(h.totals.orders.n, 1);
  assert.equal(h.totals.orders.sar, 10);
});

test("قناة مش معروفة بتروح في «other» بدل ما تختفي", () => {
  assert.equal(hourChannelOf("app:keeta"), "apps");
  assert.equal(hourChannelOf("hall"), "hall");
  assert.equal(hourChannelOf("مش معروف"), "other");
  const { slots } = hourSlots(R(23, 22), R(23, 23));
  const h = buildHourly({ slots, orders: [ord(23, 22, "حاجة جديدة", 10)] });
  assert.equal(h.hasOther, true);
  assert.equal(h.totals.ch.other.n, 1);
  assert.equal(h.totals.orders.n, 1);
});

test("دقايق الإيقاف بتتقصّ على كل ساعة لوحدها ومابتزيدش عن ٦٠", () => {
  const { slots } = hourSlots(R(23, 22), R(24, 1));
  const h = buildHourly({
    slots,
    pauses: [
      { at: R(23, 22, 30), action: "service_pause", channel: "delivery" },  // ٢٢:٣٠
      { at: R(24, 0, 15), action: "service_resume", channel: "delivery" }, // ٠٠:١٥
    ],
  });
  assert.deepEqual(h.hours.map((x) => x.pausedMin.delivery), [30, 60, 15]);
  assert.deepEqual(h.hours.map((x) => x.pausedMin.pickup), [0, 0, 0]);
  assert.equal(h.totals.pausedMin.delivery, 105);
});

test("إيقاف بدأ قبل النافذة: كل ساعة فيها بتتحسب كاملة", () => {
  const { slots } = hourSlots(R(23, 22), R(24, 0));
  const h = buildHourly({
    slots,
    pauses: [{ at: R(24, 0, 59), action: "service_resume", channel: "both" }],
  });
  assert.deepEqual(h.hours.map((x) => x.pausedMin.delivery), [60, 60]);
  assert.deepEqual(h.hours.map((x) => x.pausedMin.pickup), [60, 60]);
});

/* ── ملف الساعات ────────────────────────────────────────────────────────── */

test("hourProfile: مرتّب بترتيب اليوم التشغيلي — ١ الفجر آخر الجدول مش أوله", () => {
  // يومين × الساعات ٢٢ ← ٠١
  const { slots } = hourSlots(R(23, 22), R(25, 2));
  const h = buildHourly({
    slots,
    orders: [ord(23, 23, "hall", 10), ord(24, 1, "store", 20), ord(25, 1, "store", 30), ord(24, 22, "hall", 40)],
  });
  const p = hourProfile(h.hours);
  const idx = p.map((x) => x.bizHourIndex);
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), "لازم مرتّب بـbizHourIndex");
  const first = p[0].hour, last = p.at(-1).hour;
  assert.equal(first, 4, "٤ الفجر أول ساعة في اليوم التشغيلي");
  assert.equal(last, 3, "٣ الفجر آخر ساعة");
  const pos = (hh) => p.findIndex((x) => x.hour === hh);
  assert.ok(pos(1) > pos(23), "١ الفجر بعد ٢٣ في ملف الساعات كمان");
  assert.ok(pos(2) > pos(0));
  assert.ok(pos(12) > pos(11));
  // الساعة ١ ظهرت في يومين تشغيليين، والمتوسط بيقسم على اليومين
  const h1 = p[pos(1)];
  assert.equal(h1.days, 2);
  assert.equal(h1.orders, 2);
  assert.equal(h1.sar, 50);
  assert.equal(h1.ordersPerDay, 1);
});

test("hourProfile على مدى يوم واحد: كل ساعة يوم واحد، وترتيبها تشغيلي", () => {
  const { slots } = hourSlots(R(23, 11), R(24, 4));   // اليوم التشغيلي كله
  const p = hourProfile(buildHourly({ slots }).hours);
  assert.deepEqual(p.map((x) => x.hour), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3]);
  assert.ok(p.every((x) => x.days === 1));
});

test("hourTotals على مصفوفة فاضية = أصفار مش undefined", () => {
  const t = hourTotals([]);
  assert.equal(t.orders.n, 0);
  assert.equal(t.orders.sar, 0);
  assert.equal(t.ch.store.n, 0);
  assert.equal(t.visitors.sessions, 0);
  assert.equal(t.pausedMin.delivery, 0);
});

/* ── نافذة الطلب ────────────────────────────────────────────────────────── */

const NOW = new Date("2026-09-24T00:30:00Z");   // ٠٣:٣٠ الرياض

test("resolveWindow: hours= بيرجع لورا من دلوقتي", () => {
  const w = resolveWindow({ hours: 3 }, NOW);
  assert.equal(w.custom, false);
  assert.equal(w.start.toISOString(), "2026-09-23T21:30:00.000Z");
  assert.equal(w.end.toISOString(), NOW.toISOString());
  assert.equal(w.partial, false);
});

test("resolveWindow: from/to صريحين، والقراية بتتقطع عند دلوقتي", () => {
  const w = resolveWindow({ from: R(23, 22), to: R(24, 4) }, NOW);
  assert.equal(w.custom, true);
  assert.equal(w.end.toISOString(), R(24, 4));      // المطلوب زي ما هو
  assert.equal(w.cut.toISOString(), NOW.toISOString()); // اللي بيتقرا فعلاً
  assert.equal(w.partial, true);
});

test("resolveWindow: مدخل بايظ بيرجع للافتراضي، والسقف شهر", () => {
  assert.equal(resolveWindow({ from: "خربان", to: "كمان" }, NOW).custom, false);
  assert.equal(resolveWindow({ hours: 0 }, NOW).hours, 24);
  assert.equal(resolveWindow({ hours: 99999 }, NOW).hours, 720);
  const long = resolveWindow({ from: "2026-01-01T00:00:00Z", to: R(24, 4) }, NOW);
  assert.ok(long.end - long.start <= 31 * 864e5);
});

test("النافذة والخانات مع بعض: «شِفت الليلة» بيبدأ ١١ الصبح وبيعدّي نص الليل", () => {
  const w = resolveWindow({ from: R(23, 11), to: NOW.toISOString() }, NOW);
  const s = hourSlots(w.start, w.cut);
  assert.equal(s.slots[0].hour, 11);
  assert.equal(s.slots.at(-1).hour, 3);
  assert.deepEqual([...new Set(s.slots.map((x) => x.bizDay))], ["2026-09-23"]);
  const idx = s.slots.map((x) => x.bizHourIndex);
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
});
