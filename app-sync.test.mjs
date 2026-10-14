/* ربط الأصناف بين منيونا وكيتا وهنقرستيشن (app_sync.js) — بالأسماء الحقيقية ١٤/١٠. */
import test from "node:test";
import assert from "node:assert/strict";
import { normName, canonName, bestMatch, buildMap, portalUntil } from "./app_sync.js";
import { sectionOf } from "./cms.js";

const KEETA = [
  ["114062423", "كباب ثلث كيلو"], ["114055755", "كفته ثلث كيلو"], ["114059530", "سجق مشوى ثلث كيلو"],
  ["114054760", "شيش طاووق  ثلث كيلو"], ["114051756", "مشكل مخصوص ثلث كيلو"], ["114050843", "ريش ثلث كيلو"],
  ["114063344", "بنا بيف كازرول"], ["114058560", "بنا بيف الفريدو"], ["114046025", "بنا سي فود الفريدو"],
  ["114048890", "تشيكن بنا الفريدو"], ["114064345", "حواوشي موتزريلا"], ["114065319", "فرايد موتزريلا"],
  ["114058556", "كلوسلو"], ["114064344", "مياة"], ["114046986", "وجبه كفته وطرب"], ["114057544", "وجبة كفتة"],
].map(([id, name]) => ({ id, name }));
const HS = KEETA.map((k, i) => ({ id: String(126034700 + i), name: k.name }));
const OURS = [
  ["97", "كباب مشوي بالوزن"], ["91", "كفتة مشوية بالوزن"], ["105", "سجق مشوي بالوزن"], ["114", "شيش طاووق مشوي بالوزن"],
  ["103", "مشكل مخصوص بالوزن"], ["100", "ريش مشوية بالوزن"], ["55", "بيف الفريدو"], ["63", "سي فود الفريدو"],
  ["19", "حواوشي موتزاريلا"], ["74", "فرايد موتزاريلا"], ["72", "كولسلو"], ["40", "مياة"], ["50", "وجبة كفتة"],
  ["51", "وجبه كفته وطرب"], ["123", "طبق أرز بسمتي"],
].map(([id, name]) => ({ id, name }));

test("normalisation", () => {
  assert.equal(normName("كفتة  مشويّة"), "كفته مشويه");
  assert.equal(canonName("كباب مشوي بالوزن"), canonName("كباب ثلث كيلو"));
  assert.equal(canonName("بيف الفريدو"), canonName("بنا بيف الفريدو"));
});

test("every real naming gap links to the right app item", () => {
  const { rows } = buildMap(OURS, KEETA, HS);
  const k = Object.fromEntries(rows.map((r) => [r.ourId, r.keeta?.name || null]));
  assert.equal(k["97"], "كباب ثلث كيلو");
  assert.equal(k["91"], "كفته ثلث كيلو");
  assert.equal(k["105"], "سجق مشوى ثلث كيلو");
  assert.equal(k["114"], "شيش طاووق  ثلث كيلو");
  assert.equal(k["103"], "مشكل مخصوص ثلث كيلو");
  assert.equal(k["100"], "ريش ثلث كيلو");
  assert.equal(k["55"], "بنا بيف الفريدو");
  assert.equal(k["63"], "بنا سي فود الفريدو");
  assert.equal(k["19"], "حواوشي موتزريلا");
  assert.equal(k["74"], "فرايد موتزريلا");
  assert.equal(k["72"], "كلوسلو");
  assert.equal(k["50"], "وجبة كفتة");        // مش «وجبه كفته وطرب»
  assert.equal(k["51"], "وجبه كفته وطرب");
  assert.equal(k["123"], null);                // مش موجود في التطبيقات
});

test("hungerstation follows keeta's name exactly", () => {
  const { rows } = buildMap(OURS, KEETA, HS);
  for (const r of rows) if (r.keeta) assert.equal(r.hs?.name, r.keeta.name, r.ourName);
});

test("a manual choice wins, and '' means not on that app", () => {
  const manual = new Map([["97", { keetaId: "114055755", hsId: null }]]);
  const { rows } = buildMap(OURS, KEETA, HS, manual);
  const r = rows.find((x) => x.ourId === "97");
  assert.equal(r.how, "manual");
  assert.equal(r.keeta.name, "كفته ثلث كيلو");
  assert.equal(r.hs, null);
  // كفته اتاخدت يدوي، فالأوتوماتيك مايديهاش لـ«كفتة مشوية بالوزن»
  assert.notEqual(rows.find((x) => x.ourId === "91").keeta?.id, "114055755");
});

test("no guessing between two close candidates", () => {
  assert.equal(bestMatch("بيتزا", [{ id: "1", name: "بيتزا خضروات" }, { id: "2", name: "بيتزا تونة" }]), null);
});

test("portal until → apps", () => {
  assert.equal(portalUntil(null), "manual");
  assert.equal(portalUntil("reopen_next_open"), "open");
  assert.equal(portalUntil(undefined), "open");
  assert.equal(portalUntil("2026-10-15T09:00:00.000Z"), "2026-10-15T09:00:00.000Z");
});

test("permission: /api/apps = products", () => {
  assert.equal(sectionOf("/api/apps/map"), "products");
  assert.equal(sectionOf("/api/apps/map/97"), "products");
});
