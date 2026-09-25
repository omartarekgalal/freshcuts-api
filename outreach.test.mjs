/* قايمة التواصل اليدوي — الاختبارات (٢٥/٩)

   الرسالة دي بتروح لعميل حقيقي من موبايل المحل. الغلط هنا مش باج في شاشة،
   ده اسم غلط أو طلب غلط في رسالة شخصية — بيضر أكتر ما ينفع. */
import test from "node:test";
import assert from "node:assert/strict";
import { agoAr, itemsPhrase, renderMessage, waLink, DEFAULT_TEMPLATE, AUDIENCES } from "./outreach.js";

const DAY = 86400000;
const NOW = Date.parse("2026-09-25T18:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();

test("«من امتى» بالعربي الطبيعي", () => {
  assert.equal(agoAr(ago(0), NOW), "النهاردة");
  assert.equal(agoAr(ago(1), NOW), "امبارح");
  assert.equal(agoAr(ago(3), NOW), "من 3 أيام");
  assert.equal(agoAr(ago(10), NOW), "من أسبوع");
  assert.equal(agoAr(ago(21), NOW), "من 3 أسابيع");
  assert.equal(agoAr(ago(45), NOW), "من شهر");
  assert.equal(agoAr(ago(120), NOW), "من 4 شهور");
});

test("تاريخ باظ = نص فاضي، مش «NaN»", () => {
  for (const v of [null, undefined, "", "مش تاريخ", {}]) assert.equal(agoAr(v, NOW), "");
});

test("الأصناف: صنفين وبعدين «وكذا تاني»", () => {
  assert.equal(itemsPhrase(["كيلو مشاوي"]), "كيلو مشاوي");
  assert.equal(itemsPhrase(["كيلو مشاوي", "أرز"]), "كيلو مشاوي وأرز");
  assert.equal(itemsPhrase(["كيلو مشاوي", "أرز", "سلطة"]), "كيلو مشاوي وأرز و1 صنف تانية");
  assert.equal(itemsPhrase(["أ", "ب", "ج", "د"]), "أ وب و2 أصناف تانية");
});

test("أصناف فاضية أو باظة مابترميش", () => {
  assert.equal(itemsPhrase([]), "");
  assert.equal(itemsPhrase(null), "");
  assert.equal(itemsPhrase(["", "  ", null]), "");
});

test("الرسالة بتتعبّى بالمتغيرات", () => {
  const m = renderMessage(DEFAULT_TEMPLATE, {
    name: "محمد", last_items: "كيلو مشاوي", last_when: "من أسبوع", site: "freshcuts.sa" });
  assert.ok(m.includes("محمد"));
  assert.ok(m.includes("كيلو مشاوي"));
  assert.ok(m.includes("من أسبوع"));
  assert.ok(!/\{\w+\}/.test(m), "مفيش متغير فاضل من غير ما يتعبّى");
});

test("متغير ناقص = فاضي، مش الاسم الحرفي", () => {
  const m = renderMessage("أهلاً {name}، {mystery}!", { name: "سارة" });
  assert.equal(m, "أهلاً سارة، !");
});

test("رابط واتساب بالصيغة السعودية", () => {
  const l = waLink("501234567", "أهلاً");
  assert.ok(l.startsWith("https://wa.me/966501234567?text="));
  assert.ok(decodeURIComponent(l.split("text=")[1]) === "أهلاً");
});

test("جوال غلط = مفيش رابط (مانبعتش لرقم مش متأكدين منه)", () => {
  for (const v of ["", null, "12345", "0501234567", "96650123456789", "abc"]) {
    assert.equal(waLink(v, "x"), null, `${v} المفروض null`);
  }
});

test("النص العربي بيتشفّر صح في الرابط", () => {
  const txt = "كيلو مشاوي + أرز مجاناً ٩٦ ر.س";
  const l = waLink("512345678", txt);
  assert.equal(decodeURIComponent(l.split("text=")[1]), txt);
  assert.ok(!/[؀-ۿ]/.test(l), "مفيش حروف عربية خام في الرابط");
});

test("الشرايح الخمسة معرّفة بوصف", () => {
  for (const k of ["ad_blocked", "never_online", "lapsed", "vip_lapsed", "online_once"]) {
    assert.ok(AUDIENCES[k], `${k} ناقصة`);
    assert.ok(AUDIENCES[k].label && AUDIENCES[k].hint);
  }
});

test("القالب الافتراضي فيه الاسم — غير كده بتبقى رسالة جماعية", () => {
  assert.ok(/\{name\}/.test(DEFAULT_TEMPLATE));
  assert.ok(/\{last_items\}/.test(DEFAULT_TEMPLATE));
});
