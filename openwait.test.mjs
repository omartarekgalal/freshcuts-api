/* «نبّهني لما تفتحوا» + نافذة السكوت بتاعة رسالة التقييم — قواعد صافية. */
import test from "node:test";
import assert from "node:assert/strict";
import { openWaitCfg, waitBody, minutesSinceOpen, OPENWAIT_DEFAULTS } from "./openwait.js";
import { inAskQuiet, askBody, DEFAULTS as REVIEW_DEFAULTS } from "./reviews.js";
import { isOpenNow } from "./carts.js";

/* مواعيد فريش كاتس الحقيقية: ١٢ الضهر → ٢ الفجر، والخميس/الجمعة لـ٣ */
const HOURS = {
  enabled: true,
  days: {
    sat: { open: "12:00", close: "02:00" }, sun: { open: "12:00", close: "02:00" },
    mon: { open: "12:00", close: "02:00" }, tue: { open: "12:00", close: "02:00" },
    wed: { open: "12:00", close: "02:00" }, thu: { open: "12:00", close: "03:00" },
    fri: { open: "12:00", close: "03:00" },
  },
};
// وقت الرياض = UTC+3 بدون توقيت صيفي، فالساعة المحلية = UTC + ٣
const riyadh = (iso) => new Date(iso);

test("المتجر مقفول الساعة ٥ الفجر ومفتوح ٩ بالليل", () => {
  assert.equal(isOpenNow(HOURS, riyadh("2026-09-17T02:00:00Z")), false); // ٥ الفجر رياض
  assert.equal(isOpenNow(HOURS, riyadh("2026-09-17T18:00:00Z")), true);  // ٩ بالليل رياض
  assert.equal(isOpenNow(HOURS, riyadh("2026-09-17T22:30:00Z")), true);  // ١:٣٠ بعد نص الليل
});

test("دقايق من الفتح: بتعد من ١٢ الضهر، وبتعدّي النافذة بعد نص الليل", () => {
  assert.equal(minutesSinceOpen(HOURS, riyadh("2026-09-17T09:00:00Z")), 0);    // ١٢:٠٠ بالظبط
  assert.equal(minutesSinceOpen(HOURS, riyadh("2026-09-17T10:30:00Z")), 90);   // ١:٣٠ بعد الفتح
  // ١:٠٠ بعد نص الليل = ١٣ ساعة من فتح امبارح ⇒ بره نافذة الـ٤ ساعات
  assert.ok(minutesSinceOpen(HOURS, riyadh("2026-09-17T22:00:00Z")) > 240);
  // ١١ الصبح (قبل الفتح) = ٢٣ ساعة من فتح امبارح ⇒ بره النافذة برضه
  assert.ok(minutesSinceOpen(HOURS, riyadh("2026-09-17T08:00:00Z")) > 240);
  assert.equal(minutesSinceOpen(null), null);
  assert.equal(minutesSinceOpen({ enabled: true, days: { ...HOURS.days, thu: { closed: true } } },
    riyadh("2026-09-17T10:00:00Z")), null); // الخميس مقفول في النسخة دي
});

test("الرسالة بتاخد الرابط، ولو المالك مسح {link} بنلزقه في الآخر", () => {
  assert.equal(waitBody("فريش كاتس فتح! كمّل طلبك: {link}", "freshcuts.sa/c/ab12"),
    "فريش كاتس فتح! كمّل طلبك: freshcuts.sa/c/ab12");
  assert.equal(waitBody("فتحنا", "L"), "فتحنا L");
  assert.ok(waitBody("", "L").endsWith("L"));
});

test("الإعدادات بتتقصّ في مدى آمن", () => {
  const c = openWaitCfg({ openWait: { capPerRun: 99999, openWindowMinutes: 5, maxAgeHours: 0, enabled: false } });
  assert.equal(c.capPerRun, 500);
  assert.equal(c.openWindowMinutes, 30);
  assert.equal(c.maxAgeHours, 2);
  assert.equal(c.enabled, false);
  assert.deepEqual(openWaitCfg({}), { ...OPENWAIT_DEFAULTS });
});

/* ── رسالة التقييم بعد التوصيل ───────────────────────────────────────── */

test("نافذة سكوت ٢ → ١١ بتلف حوالين نص الليل صح", () => {
  assert.equal(inAskQuiet(3, 2, 11), true);    // ٣ الفجر: سكوت
  assert.equal(inAskQuiet(10, 2, 11), true);   // ١٠ الصبح: لسه سكوت
  assert.equal(inAskQuiet(11, 2, 11), false);  // ١١: نبعت
  assert.equal(inAskQuiet(23, 2, 11), false);  // ١١ بالليل: نبعت (وقت الذروة)
  assert.equal(inAskQuiet(1, 2, 11), false);   // ١ بعد نص الليل: المطعم لسه شغال
  assert.equal(inAskQuiet(23, 22, 12), true);  // نافذة لافّة
  assert.equal(inAskQuiet(5, 0, 0), false);    // متساويين = مفيش سكوت
});

test("نص طلب التقييم فيه الرابط دايماً", () => {
  const link = "https://freshcuts.sa/r?c=ab12cd34";
  assert.ok(askBody(REVIEW_DEFAULTS.askText, link).includes(link));
  assert.ok(askBody("رأيك يهمنا", link).endsWith(link));
  assert.equal(REVIEW_DEFAULTS.askAfterMinutes, 30);
  assert.equal(REVIEW_DEFAULTS.askAfterDelivery, true);
});
