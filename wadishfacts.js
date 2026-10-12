/* ═══════════════════════════════════════════════════════════════════════════
   حقايق الأصناف — إجابة «هل X فيه <مكوّن / مسبّب حساسية>؟» (١٢/١٠/٢٠٢٦)

   قاعدة عمر: «نجاوب على قد السؤال» + «مش عايز حد يكشف الريسبي». فالملف ده **بيانات مطابقة داخلية**:
   بيرجّع حالة واحدة للسؤال الواحد — present_removable (ومعاها اسم الجزء اللي يتشال بس) / present_fixed / not_found / unknown_staff —
   وعمره ما بيرجّع قايمة مكونات ولا أي حقل داخلي. مفيش «خالٍ من» ولا «آمن». حساسية شديدة ⇒ موظف من غير أي نصيحة عن صنف.

   البيانات: wadishfacts.data.json — نسخة مقصوصة من ملف الشيف (slices/B13…/make-data.py)، فيها اللي المطابقة محتاجاه بس.
   التغطية: الأصناف اللي بياناتها كاملة (u = none) أو كاملة لو اتشال صوص/جانبي (removable_only). الباقي (core) ⇒ موظف.
═══════════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import { normalize } from "./wabot.js";

let DATA = null;
export function loadFacts(file = new URL("./wadishfacts.data.json", import.meta.url)) {
  if (DATA) return DATA;
  try { DATA = JSON.parse(fs.readFileSync(file, "utf8")); } catch { DATA = { revision: null, dishes: {} }; }
  return DATA;
}
export function _setFactsForTests(d) { DATA = d; }

/* كلمات العميل ⇒ مجموعة مسبّب الحساسية. soy و sulphites مش متقيّمين في بياناتنا ⇒ دايماً موظف. */
const GROUPS = [
  ["gluten_wheat", /جلوتين|غلوتين|قمح|gluten|wheat/],
  ["milk", /حليب|لاكتوز|البان|الالبان|مشتقات الحليب|dairy|lactose|\bmilk\b/],
  ["egg", /بيض|\beggs?\b/],
  ["sesame", /سمسم|sesame/],
  ["mustard", /خردل|mustard/],
  ["soy", /صويا|\bsoy/],
  ["fish", /سمك|اسماك|\bfish\b/],
  ["crustaceans_molluscs", /قشريات|جمبري|روبيان|ربيان|محار|shrimp|prawn|shellfish|crustacean/],
  ["tree_nuts", /مكسرات|لوز|جوز|فستق|كاجو|بندق|\bnuts?\b|almond|walnut|pistachio|cashew|hazelnut/],
  ["peanuts", /فول سوداني|peanut/],
  ["celery", /كرفس|celery/],
  ["sulphites", /كبريت|sulphite|sulfite/],
];
const NOT_ASSESSED = new Set(["soy", "sulphites"]);
export const SEVERE_RE = /شديد|قوي(ه)?|خطير|مفرط|تاق|ابره|ايبي بن|مستشفى|مستشفي|يموت|اختناق|anaphyla|epi ?pen|severe|hospital|life.?threat/i;
export const groupsIn = (text) => { const n = normalize(String(text || "")); return GROUPS.filter(([, re]) => re.test(n)).map(([g]) => g); };

/* (رقم الصنف، نص السؤال) ⇒ { status, dish, dishEn, asked, part?, partEn?, fryer } أو { status:"unknown_staff" | "severe" }.
   asked = الكلمة اللي العميل سأل عنها (للعرض)، مش أي حاجة من البيانات. */
export function lookupFact(dishId, askText, { askedWord = null, remove = false } = {}) {
  const d = loadFacts().dishes[String(dishId)];
  const text = String(askText || ""), n = normalize(text);
  if (SEVERE_RE.test(n) || SEVERE_RE.test(text)) return { status: "severe" };
  if (!d) return { status: "unknown_staff", why: "dish_not_in_facts" };
  const base = { dish: d.ar, dishEn: d.en || d.ar };
  /* عقد الشيف: اللي **متسجّل** في بيانات الصنف (مسبّب موجود، مكوّن بيتشال، مكوّن ثابت) بيتجاوب لأي صنف. اللي **مش متسجّل** مايتقالش إنه مش موجود
     إلا لو بيانات الصنف كاملة (u = none)؛ غير كده ⇒ موظف. */
  const gs = groupsIn(text);
  if (gs.length > 1) return { ...base, status: "unknown_staff", why: "several_allergens" };
  if (gs.length === 1) {
    const g = gs[0], a = (d.a || {})[g];
    const asked = askedWord || (GROUPS.find(([k]) => k === g)[1].exec(n) || [g])[0];
    if (NOT_ASSESSED.has(g)) return { ...base, status: "unknown_staff", asked, why: "not_assessed" };
    const fryer = Array.isArray(d.fry) && d.fry.includes(g);
    if (a && remove) return a.r && a.ar ? { ...base, status: "can_remove", asked, part: a.ar, partEn: a.en || a.ar, kind: "allergen", fryer } : { ...base, status: "cannot_remove", asked, kind: "allergen", fryer };
    if (remove) return { ...base, status: "unknown_staff", asked, why: "not_recorded" };
    if (a) return a.r && a.ar ? { ...base, status: "present_removable", asked, part: a.ar, partEn: a.en || a.ar, kind: "allergen", fryer } : { ...base, status: "present_fixed", asked, kind: "allergen", fryer };
    return d.u === "none" ? { ...base, status: "not_found", asked, kind: "allergen", fryer } : { ...base, status: "unknown_staff", asked, why: "has_unlabelled_part" };
  }
  /* مكوّن عادي: الكلمة لازم تطابق مكوّن مسجّل إنه بيتشال أو إنه ثابت. أي كلمة تانية ⇒ موظف (عمرنا ما نستنتج إن مكوّن مش موجود). */
  const ws = n.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).map((w) => w.replace(/^(ال|بال|وال|لل)(?=.{2,})/, "")).filter((w) => w.length > 1);
  const has = (m) => { const k = normalize(String(m)).replace(/^(ال)(?=.{2,})/, ""); return k.length > 1 && (ws.includes(k) || (k.includes(" ") && n.includes(k))); };
  const rm = (d.rm || []).find((r) => (r.m || []).some(has));
  if (rm && remove) return { ...base, status: "can_remove", asked: rm.ar, part: rm.ar, partEn: rm.en || rm.ar, kind: "ingredient", fryer: false };
  if (rm) return { ...base, status: "present_removable", asked: rm.ar, part: rm.ar, partEn: rm.en || rm.ar, kind: "ingredient", fryer: false };
  const fx = (d.fx || []).find(has);
  if (fx) return { ...base, status: remove ? "cannot_remove" : "present_fixed", asked: fx, kind: "ingredient", fryer: false };
  return { ...base, status: "unknown_staff", why: "ingredient_not_recorded" };
}
/* صنف واحد من أسماء اتذكرت: الاسم الكامل اللي ورد في النص بيكسب («وجبة الكفتة» = «وجبة كفتة» مش «وجبة كفتة وطرب»)، والأطول أولاً.
   مفيش اسم كامل وفيه أكتر من مرشّح ⇒ null (مانخمّنش أنهي صنف). */
export function pickDish(text, candidates) {
  const strip = (x) => normalize(String(x || "")).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).map((w) => w.replace(/^(ال|بال|وال|لل)(?=.{2,})/, "")).filter(Boolean).join(" ");
  const t = ` ${strip(text)} `;
  const list = (candidates || []).filter((c) => c && c.id != null);
  const full = list.filter((c) => { const k = strip(c.name); return k && t.includes(` ${k} `); }).sort((a, b) => strip(b.name).length - strip(a.name).length);
  if (full.length) return String(full[0].id);
  return list.length === 1 ? String(list[0].id) : null;
}
export const factsCoverage = () => { const ds = Object.values(loadFacts().dishes); return { revision: loadFacts().revision, dishes: ds.length, covered: ds.filter((d) => d.u === "none" || d.u === "removable_only").length }; };
