/* الفاصل المتدرّج بين الرسايل التسويقية + سطر الإيقاف (٢١ سبتمبر ٢٠٢٦).
   القرار: «قاعدة منكلمش العميل ٧ ايام دي قاعدة مش حلوة» + «رابط الإيقاف
   يبقى غير قابل للضغط». التستات دي بتثبّت الاتنين. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "./smsrules.js";

const cust = (o) => ({ pn: "500000000", orders: 2, appOrders: 0, online: 0, daysSince: 5, ...o });

test("الافتراضي: ٣ أيام للنشط، ٧ للغايب، ١٤ للبارد + سقف ٢/أسبوع و٤/شهر", () => {
  assert.deepEqual(R.gapOf({}), { minGapDays: 3, gapLapsedDays: 7, gapColdDays: 14, maxPerWeek: 2, maxPerMonth: 4 });
  // الإعدادات القديمة (رقم واحد ٧) بتفضل تشتغل: بتتقرا كطبقة recent بس
  assert.equal(R.gapOf({ minGapDays: 7 }).minGapDays, 7);
  assert.equal(R.gapOf({ minGapDays: 7 }).gapColdDays, 14);
  // قيم غلط بترجع للافتراضي
  assert.equal(R.gapOf({ minGapDays: -4 }).minGapDays, 3);
  assert.equal(R.gapOf({ maxPerWeek: "x" }).maxPerWeek, 2);
});

test("الطبقة بتتحدد من آخر طلب، ورقم التطبيق دايماً بارد", () => {
  assert.equal(R.gapTier(cust({ daysSince: 0 })), "recent");
  assert.equal(R.gapTier(cust({ daysSince: 30 })), "recent");
  assert.equal(R.gapTier(cust({ daysSince: 31 })), "lapsed");
  assert.equal(R.gapTier(cust({ daysSince: 90 })), "lapsed");
  assert.equal(R.gapTier(cust({ daysSince: 91 })), "cold");
  // كل طلباته من كيتا/هنقر → ماطلبش مننا مباشرة → بارد مهما كان قريب
  assert.equal(R.gapTier(cust({ daysSince: 1, orders: 4, appOrders: 4 })), "cold");
  // بس لو طلب من الموقع كمان فهو مباشر
  assert.equal(R.gapTier(cust({ daysSince: 1, orders: 4, appOrders: 4, online: 1 })), "recent");
});

test("gapReason: الفاصل بيتطبّق بالطبقة مش برقم واحد", () => {
  const g = R.gapOf({});
  const h = (days, in7 = 1, in30 = 1) => ({ days, in7, in30 });
  // زبون نشط اتكلمنا معاه من ٤ أيام → يعدّي (كان ممنوع بقاعدة الـ٧)
  assert.equal(R.gapReason(cust({ daysSince: 2 }), h(4), g), null);
  assert.equal(R.gapReason(cust({ daysSince: 2 }), h(2), g), "gap");
  // غايب ٤٠ يوم: ٤ أيام مش كفاية، ٨ كفاية
  assert.equal(R.gapReason(cust({ daysSince: 40 }), h(4), g), "gap");
  assert.equal(R.gapReason(cust({ daysSince: 40 }), h(8), g), null);
  // بارد: لازم ١٤
  assert.equal(R.gapReason(cust({ daysSince: 200 }), h(8), g), "gap");
  assert.equal(R.gapReason(cust({ daysSince: 200 }), h(15), g), null);
  // محدش كلّمه قبل كده
  assert.equal(R.gapReason(cust({ daysSince: 200 }), undefined, g), null);
});

test("السقف الأسبوعي والشهري فوق الطبقات كلها", () => {
  const g = R.gapOf({});
  // عدّى الفاصل (٩ أيام) بس خد ٢ في آخر ٧ أيام → سقف الأسبوع
  assert.equal(R.gapReason(cust({ daysSince: 2 }), { days: 9, in7: 2, in30: 2 }, g), "cap_week");
  assert.equal(R.gapReason(cust({ daysSince: 2 }), { days: 9, in7: 1, in30: 4 }, g), "cap_month");
  assert.equal(R.gapReason(cust({ daysSince: 2 }), { days: 9, in7: 1, in30: 3 }, g), null);
  // صفر = مفيش سقف
  assert.equal(R.gapReason(cust({ daysSince: 2 }), { days: 9, in7: 9, in30: 9 }, R.gapOf({ maxPerWeek: 0, maxPerMonth: 0 })), null);
});

test("filterAudience بالتاريخ: كل استبعاد بسببه", () => {
  const m = [
    cust({ pn: "500000001", daysSince: 2 }),                       // نشط، آخر رسالة ٤ أيام → يعدّي
    cust({ pn: "500000002", daysSince: 2 }),                       // نشط، آخر رسالة يومين → gap
    cust({ pn: "500000003", daysSince: 60 }),                      // غايب، آخر رسالة ٤ أيام → gap
    cust({ pn: "500000004", daysSince: 60 }),                      // غايب، آخر رسالة ٩ أيام → يعدّي
    cust({ pn: "500000005", daysSince: 2 }),                       // سقف الأسبوع
    cust({ pn: "500000006", orders: 3, appOrders: 3 }),            // تطبيقات بس
  ];
  const history = new Map([
    ["500000001", { days: 4, in7: 1, in30: 1 }],
    ["500000002", { days: 2, in7: 1, in30: 1 }],
    ["500000003", { days: 4, in7: 1, in30: 1 }],
    ["500000004", { days: 9, in7: 0, in30: 1 }],
    ["500000005", { days: 4, in7: 2, in30: 2 }],
  ]);
  const f = R.filterAudience(m, { history, gap: {} });
  assert.deepEqual(f.list.map((x) => x.pn), ["500000001", "500000004"]);
  assert.equal(f.excluded.gap, 2);
  assert.equal(f.excluded.cap_week, 1);
  assert.equal(f.excluded.apps_only, 1);
  // كل سبب له وصف بالعربي للوحة
  for (const k of Object.keys(f.excluded)) assert.ok(R.EXCLUDE_LABELS[k], k);
});

test("القاعدة الجديدة بتوسّع الوصول مقارنة بـ٧ أيام لكل الناس", () => {
  const m = Array.from({ length: 100 }, (_, i) => cust({ pn: `5000001${String(i).padStart(2, "0")}`, daysSince: 5 }));
  const history = new Map(m.map((x) => [x.pn, { days: 4, in7: 1, in30: 1 }])); // اتكلمنا معاهم من ٤ أيام
  assert.equal(R.filterAudience(m, { history, gap: { minGapDays: 7 } }).list.length, 0);   // القديمة
  assert.equal(R.filterAudience(m, { history, gap: {} }).list.length, 100);                // الجديدة
});

/* ── سطر الإيقاف ─────────────────────────────────────────────────────── */
const opts = { code: "ab12cd34ef", host: "https://freshcuts.sa", sender: "FreshCut-AD" };

test("الافتراضي keyword: مفيش رابط في الرسالة خالص", () => {
  const line = R.optoutLine({}, opts);
  assert.equal(line, "إيقاف: أرسل FreshCut-AD لـ801001");
  assert.ok(!/freshcuts\.sa|\/u\/|https?:/.test(line), "مايبقاش فيه حاجة تتضغط");
  // مش أطول من سطر الرابط القديم (اللي عمر اشتكى منه)
  assert.ok(line.length <= "إيقاف: freshcuts.sa/u/ab12cd34ef".length);
});

test("رابط العرض هو الوحيد اللي يتضغط في الرسالة كلها", () => {
  const body = `بوكس ٩٦ من فريش كاتس، اطلب: freshcuts.sa/l/96-a\n${R.optoutLine({}, opts)}`;
  assert.equal(body.match(/freshcuts\.sa/g).length, 1);
  assert.ok(R.smsParts(body) <= 2);
});

test("المالك يقدر يرجّع الرابط أو يحط الاتنين", () => {
  assert.equal(R.optoutLine({ optoutMode: "link" }, opts), "إيقاف: freshcuts.sa/u/ab12cd34ef");
  assert.equal(R.optoutLine({ optoutMode: "both" }, opts), "إيقاف: أرسل FreshCut-AD لـ801001 · إيقاف: freshcuts.sa/u/ab12cd34ef");
  assert.equal(R.optoutMode({ optoutMode: "حاجة غلط" }), "keyword");
});

test("وضع الرابط من غير كود بيرجع للكلمة بدل سطر مكسور", () => {
  assert.equal(R.optoutLine({ optoutMode: "link" }, { host: "freshcuts.sa", sender: "FreshCut-AD" }),
    "إيقاف: أرسل FreshCut-AD لـ801001");
});
