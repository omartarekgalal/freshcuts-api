import test from "node:test";
import assert from "node:assert/strict";
import { parseQuery, normalizeAr, digitsOf, normPhone, scoreOf, groupResults, TYPES } from "./search.js";
import { phoneOut, roleSeesPhones } from "./phones.js";
import { DEFAULT_PERMS } from "./cms.js";

/* ═══ تحليل اللي المستخدم بيكتبه ═══ */

test("رقم طلب الموقع", () => {
  const p = parseQuery("W17588123");
  assert.equal(p.orderNo, "W17588123");
  assert.ok(p.kinds.includes("web_order"));
});

test("رقم طلب بحروف صغيرة ومسافات", () => {
  assert.equal(parseQuery(" w1758 8123 ").orderNo, "W17588123");
});

test("الجوال بكل الصيغ بيوصل لنفس الرقم", () => {
  for (const q of ["0512345678", "512345678", "966512345678", "00966512345678", "+966 51 234 5678", "051-234-5678"]) {
    assert.equal(parseQuery(q).phone, "512345678", `فشل في: ${q}`);
  }
});

test("الجوال بالأرقام العربية", () => {
  assert.equal(parseQuery("٠٥١٢٣٤٥٦٧٨").phone, "512345678");
  assert.equal(parseQuery("۰۵۱۲۳۴۵۶۷۸").phone, "512345678");
});

test("جزء من الرقم (آخر ٤ أرقام) بيتعامل كبحث جزئي مش رقم كامل", () => {
  const p = parseQuery("5678");
  assert.equal(p.phone, undefined);
  assert.equal(p.phoneTail, "5678");
  assert.ok(p.kinds.includes("phone_part"));
  assert.ok(p.kinds.includes("receipt"), "٤ أرقام كمان ممكن تكون فاتورة");
});

test("رقم فاتورة قصير", () => {
  const p = parseQuery("١٢٣٤");
  assert.equal(p.receipt, "1234");
});

test("الأصفار البادية في الفاتورة بتتشال", () => {
  assert.equal(parseQuery("0042").receipt, "42");
});

test("نص عربي = بحث نصي، مش أرقام", () => {
  const p = parseQuery("محمد العتيبي");
  assert.ok(p.kinds.includes("text"));
  assert.equal(p.onlyDigits, false);
  assert.equal(p.phone, undefined);
});

test("كود لاتيني = code + text", () => {
  const p = parseQuery("FIRST15");
  assert.ok(p.kinds.includes("code"));
  assert.ok(p.kinds.includes("text"));
});

test("حرف واحد مابيدوّرش", () => {
  assert.equal(parseQuery("م").norm.length, 1);
});

/* ═══ التطبيع العربي ═══ */

test("التطبيع بيوحّد الهمزات والتاء المربوطة", () => {
  assert.equal(normalizeAr("أحمد"), normalizeAr("احمد"));
  assert.equal(normalizeAr("كفتة"), normalizeAr("كفته"));
  assert.equal(normalizeAr("مصطفى"), normalizeAr("مصطفي"));
});

test("التطبيع بيشيل التشكيل", () => {
  assert.equal(normalizeAr("مُحَمَّد"), "محمد");
});

test("digitsOf بيقرا الأرقام العربية", () => {
  assert.equal(digitsOf("طلب ٩٦ ريال"), "96");
});

test("normPhone بيقصّ المقدمات", () => {
  assert.equal(normPhone("00966512345678"), "512345678");
  assert.equal(normPhone("0512345678"), "512345678");
});

/* ═══ الترتيب ═══ */

test("التطابق التام بياخد أعلى درجة", () => {
  assert.ok(scoreOf("FIRST", "first") > scoreOf("FIRST15", "first"));
  assert.ok(scoreOf("FIRST15", "first") > scoreOf("MYFIRST", "first"));
  assert.equal(scoreOf("لا علاقة", "كفتة"), 0);
});

test("بداية كلمة جوّه الجملة أعلى من مجرد احتواء", () => {
  assert.ok(scoreOf("كفتة مشوية", "مشوي") > scoreOf("مشاوي مشكلة", "شاوي"));
});

test("المجموعات بتترتب بأعلى تطابق، والأعضاء جوّاها كمان", () => {
  const groups = groupResults([
    { type: "review", score: 30, title: "t" },
    { type: "customer", score: 95, title: "a" },
    { type: "customer", score: 40, title: "b" },
    { type: "web_order", score: 120, title: "o" },
  ]);
  assert.deepEqual(groups.map((g) => g.type), ["web_order", "customer", "review"]);
  assert.deepEqual(groups[1].items.map((x) => x.title), ["a", "b"]);
  assert.equal(groups[1].total, 2);
});

test("limitPerGroup بيقصّ بس مابيغيّرش العدد الكلي", () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ type: "item", score: i, title: String(i) }));
  const [g] = groupResults(items, 3);
  assert.equal(g.items.length, 3);
  assert.equal(g.total, 9);
  assert.equal(g.items[0].title, "8");
});

test("كل نوع نتيجة له قسم صلاحية معروف", () => {
  const sections = new Set(["home", "growth", "orders", "products", "customers", "discounts", "delivery", "analytics", "finance", "settings"]);
  for (const [k, t] of Object.entries(TYPES)) {
    assert.ok(sections.has(t.section), `${k} قسمه غلط: ${t.section}`);
    assert.ok(t.screen && t.screen.includes("/"), `${k} مالوش شاشة`);
  }
});

/* ═══ إظهار الجوال ═══ */

test("المالك بيشوف الرقم كامل", () => {
  assert.equal(roleSeesPhones("owner", DEFAULT_PERMS), true);
});

test("التسويق والعمليات بيشوفوا الرقم (عندهم العملاء)", () => {
  assert.equal(roleSeesPhones("marketing", DEFAULT_PERMS), true);
  assert.equal(roleSeesPhones("operations", DEFAULT_PERMS), true);
});

test("المحاسبة والمطبخ مايشوفوش الرقم (العملاء = none)", () => {
  assert.equal(roleSeesPhones("accounting", DEFAULT_PERMS), false);
  assert.equal(roleSeesPhones("kitchen", DEFAULT_PERMS), false);
});

test("دور مش موجود = مايشوفش", () => {
  assert.equal(roleSeesPhones("ghost", DEFAULT_PERMS), false);
  assert.equal(roleSeesPhones("marketing", null), false);
});

test("phoneOut بيرجع الرقم كامل بصفر قدامه لما يكون مسموح", () => {
  assert.deepEqual(phoneOut("512345678", true), { phone: "0512345678", phoneMasked: "05•••••78" });
});

test("phoneOut بيقنّع لما مايكونش مسموح — والرقم مش بيتبعت خالص", () => {
  const out = phoneOut("512345678", false);
  assert.equal(out.phone, null);
  assert.ok(!JSON.stringify(out).includes("512345678"));
});

test("phoneOut بيتحمّل الفاضي", () => {
  assert.deepEqual(phoneOut("", true), { phone: null, phoneMasked: "" });
  assert.deepEqual(phoneOut(null, false), { phone: null, phoneMasked: "" });
});
