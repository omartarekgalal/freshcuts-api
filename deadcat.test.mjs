import { test } from "node:test";
import assert from "node:assert/strict";
import { deadCategoryItemIds } from "./soldout.js";

/* ٢٣/٩: «وجبات» و«مشاوي بالوزن» اتقفلوا بالكامل وفضلوا معروضين — ٤ شاشات
   موبايل من «خلص النهارده» قبل البيتزا. الاختبارات دي بتثبت إن القسم الميت
   بس هو اللي بيختفي، ومحدش تاني. */
const rows = [
  { id: "13", category: "وجبات" }, { id: "18", category: "وجبات" },
  { id: "91", category: "مشاوي بالوزن" }, { id: "94", category: "مشاوي بالوزن" },
  { id: "40", category: "بيتزا" }, { id: "41", category: "بيتزا" },
  { id: "60", category: "حواوشي" }, { id: "61", category: "حواوشي" },
];
const so = (...ids) => Object.fromEntries(ids.map((i) => [i, { name: "x" }]));

test("قسم كل أصنافه خلصت ⇒ كل ids بتاعته", () => {
  const out = deadCategoryItemIds(rows, so("13", "18"));
  assert.deepEqual(out.sort(), ["13", "18"]);
});

test("قسمين ميتين ⇒ الاتنين", () => {
  const out = deadCategoryItemIds(rows, so("13", "18", "91", "94")).sort();
  assert.deepEqual(out, ["13", "18", "91", "94"]);
});

test("قسم نصه خلصان ⇒ **مايختفيش** — «خلص» جنب متاح معلومة مفيدة", () => {
  assert.deepEqual(deadCategoryItemIds(rows, so("60")), [],
    "حواوشي فيها صنف متاح ⇒ القسم يفضل");
});

test("مفيش خلصان = مفيش إخفاء", () => {
  assert.deepEqual(deadCategoryItemIds(rows, {}), []);
});

test("كل المنيو خلصان ⇒ كله (المتجر بيبقى مقفول فعلياً وده صح)", () => {
  const all = rows.map((r) => r.id);
  assert.deepEqual(deadCategoryItemIds(rows, so(...all)).sort(), [...all].sort());
});

test("مدخلات بايظة ماتكسرش — صفوف بلا قسم أو بلا id بتتجاهل", () => {
  assert.deepEqual(deadCategoryItemIds(null, so("13")), []);
  assert.deepEqual(deadCategoryItemIds([{ id: "9" }, { category: "بيتزا" }, {}], so("9")), []);
  assert.deepEqual(deadCategoryItemIds(rows, null), []);
});

test("القسم بمسافات زيادة = نفس القسم مش قسمين", () => {
  const r = [{ id: "1", category: " وجبات " }, { id: "2", category: "وجبات" }];
  assert.deepEqual(deadCategoryItemIds(r, so("1", "2")).sort(), ["1", "2"]);
  assert.deepEqual(deadCategoryItemIds(r, so("1")), [], "واحد بس خلصان ⇒ القسم يفضل");
});

test("cat بدل category مقبولة — الشكلين موجودين في الكود", () => {
  assert.deepEqual(deadCategoryItemIds([{ id: "5", cat: "برجر" }], so("5")), ["5"]);
});
