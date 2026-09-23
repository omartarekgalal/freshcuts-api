import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpenNow } from "./carts.js";

/* ٢٤/٩ — عمر أكّد المواعيد: خميس وجمعة لحد ٣ الفجر، والباقي لحد ٢.
   الوردية بتتنسب لليوم اللي بدأت فيه. الباج اللي كان: ذيل الفجر كان بياخد
   قفلة النهاردة بدل امبارح، فالموقع فضل «مفتوح» لحد ٣ الفجر يوم الخميس
   والجمعة والسبت والمطبخ ماشي من ٢. */
const HOURS = {
  enabled: true,
  days: {
    sun: { open: "12:00", close: "02:00" }, mon: { open: "12:00", close: "02:00" },
    tue: { open: "12:00", close: "02:00" }, wed: { open: "12:00", close: "02:00" },
    thu: { open: "12:00", close: "03:00" }, fri: { open: "12:00", close: "03:00" },
    sat: { open: "12:00", close: "02:00" },
  },
};
/* لحظة بتوقيت الرياض — isOpenNow بتحوّل داخلياً، فبنبني UTC ناقص ٣ */
const at = (iso) => new Date(Date.parse(iso + "+03:00"));
const open = (iso) => isOpenNow(HOURS, at(iso));

test("الخميس ٢:١٨ الفجر = مقفول — وردية الأربع خلصت ٢:٠٠", () => {
  assert.equal(open("2026-09-24T02:18:00"), false);
});
test("الخميس ١:٣٠ الفجر = مفتوح — لسه في ذيل وردية الأربع", () => {
  assert.equal(open("2026-09-24T01:30:00"), true);
});
test("الجمعة ٢:٣٠ الفجر = مفتوح — وردية الخميس بتقفل ٣", () => {
  assert.equal(open("2026-09-25T02:30:00"), true);
});
test("السبت ٢:٣٠ الفجر = مفتوح — وردية الجمعة بتقفل ٣", () => {
  assert.equal(open("2026-09-26T02:30:00"), true);
});
test("الأحد ٢:٣٠ الفجر = مقفول — وردية السبت بتقفل ٢", () => {
  assert.equal(open("2026-09-27T02:30:00"), false);
});
test("قفلة الخميس ٣:٠٠ **ما تفتحش** فجر الخميس نفسه", () => {
  assert.equal(open("2026-09-24T02:59:00"), false, "ده فجر الخميس = وردية الأربع");
  assert.equal(open("2026-09-25T02:59:00"), true, "وده فجر الجمعة = وردية الخميس");
});
test("قبل الفتح بدقيقة مقفول، وبعده بدقيقة مفتوح", () => {
  assert.equal(open("2026-09-24T11:59:00"), false);
  assert.equal(open("2026-09-24T12:01:00"), true);
});
test("الذروة مفتوحة، ونص الليل مفتوح", () => {
  assert.equal(open("2026-09-24T20:00:00"), true);
  assert.equal(open("2026-09-25T00:30:00"), true, "نص ليل الخميس = وردية الخميس");
});
test("بالظبط على ساعة القفل = مقفول", () => {
  assert.equal(open("2026-09-24T02:00:00"), false, "٢:٠٠ الخميس = وردية الأربع خلصت");
});
test("يوم مقفول بالكامل", () => {
  const h = { enabled: true, days: { ...HOURS.days, wed: { open: "12:00", close: "02:00", closed: true } } };
  assert.equal(isOpenNow(h, at("2026-09-23T20:00:00")), false, "الأربع مقفول");
  assert.equal(isOpenNow(h, at("2026-09-24T01:00:00")), false, "ومالوش ذيل فجر");
});
test("المواعيد مطفية أو ناقصة = مانمنعش الطلب", () => {
  assert.equal(isOpenNow(null, at("2026-09-24T05:00:00")), true);
  assert.equal(isOpenNow({ enabled: false, days: HOURS.days }, at("2026-09-24T05:00:00")), true);
});
test("مواعيد نهارية عادية (مش بعد نص الليل) بتشتغل صح", () => {
  const h = { enabled: true, days: { thu: { open: "09:00", close: "17:00" } } };
  assert.equal(isOpenNow(h, at("2026-09-24T12:00:00")), true);
  assert.equal(isOpenNow(h, at("2026-09-24T18:00:00")), false);
  assert.equal(isOpenNow(h, at("2026-09-25T01:00:00")), false, "مفيش ذيل لوردية نهارية");
});
