/* ═══════════════════════════════════════════════════════════════════════════
   COSTING — the recipe-level cost model behind `item_costs`.

   `finance.js` answers "what did this cost?" by joining `ts_order_items.name`
   to `item_costs` on string equality, falling back to a blended 43%. That
   works, but it cannot answer the question Omar actually asks before he
   changes a price: *where does this number come from, and can I trust it?*

   This module holds the answer. It ships Omar's recipe workbook
   (`tabsense_costing_master_final.xlsx`, 130 raw materials, 20 production
   batches, 575 recipe lines, 78 menu items) plus the restaurant/platform
   two-tier prices from the older `freshcuts_full_food_cost_master.xlsx`, seeds
   them into editable tables, and exposes three things:

     GET /api/costing/coverage  — how much of the money is really measured
     GET /api/costing/recipe    — one dish, ingredient by ingredient, with the
                                  provenance and confidence of every line
     GET /api/costing/health    — the audit, machine-readable, ranked by the
                                  sales value riding on each bad number
     GET /api/costing/menu      — the index the recipe route is picked from

   ── WHAT THIS MODULE BELIEVES, AND WHY ────────────────────────────────────

   1. THE WORKBOOK'S ARITHMETIC IS SOUND; ITS INPUTS ARE NOT.
      Recomputing all 78 menu items from ingredients reproduces the workbook's
      own Total Cost to the cent. Every discrepancy this module reports is
      therefore about an INPUT being a guess, never about a sum being wrong.
      Omar called the workbook "85% correct" — the missing 15% is provenance,
      not arithmetic. `/health` is the list.

   2. A COST IS ONLY AS GOOD AS ITS WEAKEST INGREDIENT.
      Every recipe line carries a `confidence`. A dish inherits the worst
      confidence of its ingredients, and `/health` ranks the damage by the
      SALES VALUE that rides on it — because a 16%-wrong cost on the
      best-selling item matters more than a 100%-wrong cost on a dish nobody
      orders. Three loud REVIEW flags in the workbook cover SAR 163 of risk;
      one flag the workbook marks 'OK' covers SAR 8,400.

   3. MODIFIERS ARE NOT THEIR PARENT DISH.
      The POS writes a modifier as its own line, `"<parent> <qty> <modifier>"`,
      carrying ZERO revenue because the money sits on the parent row. Costing
      such a line as the parent double-counts the dish — it once did exactly
      that to every stuffed-crust pizza. `isModifierLine()` detects the shape
      and coverage keeps those lines in their own bucket, so they can never
      inflate either the numerator or the denominator of a value-weighted
      coverage figure.

   4. GRILLS SCALE ON TWO DIFFERENT MULTIPLIERS.
      Weight-sold grills (ثلث / نص / كيلو) are not one dish x a factor. Omar's
      rule: MEAT scales 1 / 1.5 / 3, ACCOMPANIMENTS scale 1 / 2 / 3 — ثلث gets
      1 salad + 1 tahini + 2 bread, نص gets 2 + 2 + 4, كيلو gets 3 + 3 + 6.
      `WEIGHT_MODEL` below is the authority; `/health` re-checks every
      weight-sold `item_costs` row against it and reports drift.

   5. A وجبة IS ALREADY COMPLETE. Settled with Omar: a وجبة recipe genuinely
      includes 350 g cooked rice, tahini and salad. Meal costs from the
      workbook need nothing added. Do not "fix" them.

   5b. MOST BATCHES HERE ARE RAW PREP, AND OUTPUT = INPUT IS CORRECT.
      Settled with Omar: he makes 5 kg of marinated chicken breast and it stays
      5 kg; a meal takes 300 g of it and that 300 g is a PRE-COOKING weight,
      scooped and weighed raw. So raw grams × raw price is the complete cost
      and there is NO cooking loss to model on those batches — the shrinkage
      happens on the grill, after the portion has been costed. A yield belongs
      only on a batch that is cooked BEFORE it is portioned (a reduced sauce, a
      béchamel, a braise); `COOKED_BATCHES` names the four and says why.
      An earlier version of this file raised SAR 3,288 / 2,263 / 1,929 of false
      alarms on الصدور / الكفتة / شيش طاووق for exactly this reason. They are
      gone. Do not bring them back.

   5c. THE REAL YIELD LOSS IS ON THE PREP BENCH, NOT THE GRILL.
      Buy 1 kg of ribs, clean it, get 820 g. The bone and fat cap were paid for
      and cannot be sold, so every usable gram cost more than the invoice says.
      That is `cost_raw_materials.trim_bought_g` / `trim_usable_g` — TWO WEIGHTS
      off one scale, never a percentage — and because it scales the price per
      gram it flows into every recipe line, batch line and nested batch through
      `effRaw()` automatically. There is exactly one place it is applied.

   6. COSTS ARE VAT-EXCLUSIVE, REVENUE IS VAT-INCLUSIVE.
      Same convention as finance.js: `item_costs.cost` and every workbook cost
      are VAT-free (a COGS carries no output VAT), while `ts_order_items.amount`
      is VAT-inclusive and pre-discount. Any food-cost percentage here divides
      by `amount / 1.15`.

   7. THE SEED IS A STARTING POINT, NOT A LOCK.
      Reference tables are seeded ONLY when empty. Once Omar refines a raw
      material price in the DB, redeploying never overwrites it. That is the
      whole point — he said the workbook will be refined.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { registerCostingAuth } from "./costing_auth.js";
/* Read-only borrows. The delivery contracts live in ONE place — finance.js —
   and the "what would this earn on Keeta?" calculator below imports them
   rather than restating them. A second copy of an 18% would be wrong within a
   month of the first contract renegotiation, and nobody would notice. */
import { mergeRates, bandFor, subsidyFor } from "./finance.js";
/* The POS's own menu. A costed product must be CHOSEN from here, never typed:
   `ts_order_items.name` is this exact string and a hand-typed near-miss would
   produce a cost that reaches zero orders. */
import { fetchProducts as tsFetchProducts } from "./tabsense.js";

const VAT_RATE = 0.15;
const SALES_ONLY = `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;

/* Notes written by the loaders, used to tell measured from hand-priced. */
const NOTE_RECIPE = "من ملف التكاليف بالوصفات";   // loaded from the recipe workbook
const NOTE_WEIGHT = "نموذج الوزن المصحّح";          // written by the weight-model fix
/* Written by POST /api/costing/recalc. A cost row carrying this note came from
   the workbench — a recipe the manager reviewed, priced at dated purchase
   prices, with yield and item-level packaging applied. It is the only note
   that means "this number has a paper trail you can open". */
const NOTE_WORKBENCH = "من ورشة التكاليف";

/* ── The weight model (business rule 4) ──────────────────────────────────────
   Portion costs are MEASURED, from the workbook's own batches:
     salad  = 60 g of B-001 السلطة الحاتي @ 6.0518 SAR/kg
     tahini = 35 g of B-003 الطحينة      @ 9.0379 SAR/kg
     bread  = 1 piece of خبز              @ 0.30 SAR
   Portion COUNTS are Omar's rule. Meat multipliers are Omar's rule. */
const PORTION = { salad: 60 * 0.00605176132278936, tahini: 35 * 0.009037914691943129, bread: 0.30 };
const WEIGHT_MODEL = {
  third: { meat: 1.0, salad: 1, tahini: 1, bread: 2, ar: "ثلث كيلو" },
  half:  { meat: 1.5, salad: 2, tahini: 2, bread: 4, ar: "نصف كيلو" },
  kilo:  { meat: 3.0, salad: 3, tahini: 3, bread: 6, ar: "كيلو" },
};
const accPack = (size) => {
  const m = WEIGHT_MODEL[size];
  return m.salad * PORTION.salad + m.tahini * PORTION.tahini + m.bread * PORTION.bread;
};

/* The seven grill families, with the ثلث-kilo split I preserved from Omar's own
   figures. `acc` is NOT re-derived for families that already carried an
   allowance: rebuilding those from the workbook portions would have cut grill
   COGS by SAR 344 on nothing but an assumption. The three families that had NO
   accompaniment cost at all get the measured workbook pack, flagged `assumed`. */
const GRILL_FAMILIES = [
  { key: "ريش",   meat: 36.63, acc: 3.44,          accSource: "omar", meatNote: "333 g × 110 SAR/kg" },
  { key: "كباب",  meat: 24.50, acc: 5.50,          accSource: "omar", meatNote: "350 g × 70 SAR/kg" },
  { key: "كبدة",  meat: 7.48,  acc: 5.50,          accSource: "omar", meatNote: "340 g × 22 SAR/kg" },
  { key: "مشكل",  meat: 23.60, acc: 5.50,          accSource: "omar", meatNote: "ريش150+كفتة150+كباب50+طرب100" },
  { key: "كفتة",  meat: 9.32,  acc: accPack("third"), accSource: "workbook", meatNote: "من ملف التكلفة (meat only)" },
  { key: "كفته",  meat: 9.32,  acc: accPack("third"), accSource: "workbook", meatNote: "من ملف التكلفة (meat only)" },
  { key: "طرب",   meat: 7.99,  acc: accPack("third"), accSource: "workbook", meatNote: "من ملف التكلفة (meat only)" },
  { key: "شيش",   meat: 9.66,  acc: accPack("third"), accSource: "workbook", meatNote: "من ملف التكلفة (meat only)" },
];

/** Which weight bucket a POS item name is, or null if it is not sold by weight.
 *  Order matters: "نصف كيلو" contains "كيلو", so the half test must run first. */
export function weightSizeOf(name) {
  const n = String(name || "");
  if (n.includes("ثلث")) return "third";
  if (n.includes("نصف كيلو") || n.includes("نص كيلو")) return "half";
  if (n.includes("كيلو")) return "kilo";
  return null;
}
export function grillFamilyOf(name) {
  const n = String(name || "");
  return GRILL_FAMILIES.find((f) => n.includes(f.key)) || null;
}
/** The cost this module says a weight-sold grill line SHOULD carry. */
export function expectedWeightCost(name) {
  const size = weightSizeOf(name); const fam = grillFamilyOf(name);
  if (!size || !fam) return null;
  const m = WEIGHT_MODEL[size];
  const meat = fam.meat * m.meat;
  const acc = fam.acc * (size === "third" ? 1 : size === "half" ? 2 : 3);
  return { size, family: fam.key, meat: round3(meat), acc: round3(acc), total: round3(meat + acc),
           accSource: fam.accSource, meatNote: fam.meatNote };
}

/* ── The modifier trap (business rule 3) ─────────────────────────────────────
   The POS shape is `<parent dish> <qty> <modifier>` where qty is a bare number
   like `1.0`. Matching on that middle number is what distinguishes a modifier
   line from a dish whose name merely contains digits.

   The DECIMAL POINT is load-bearing. Allowing a bare integer here swept up
   `صينية اللمة 100 ريال` — a real SAR 635 platter named after its price — and
   filed it as a free add-on. The POS always writes the modifier quantity with
   a decimal (`1.0`, `2.0`); prices in dish names never carry one. */
const MODIFIER_RE = /^(.+?)\s+\d+\.\d+\s+(.+)$/;
export function isModifierLine(name) {
  return MODIFIER_RE.test(String(name || ""));
}
export function splitModifierLine(name) {
  const m = MODIFIER_RE.exec(String(name || ""));
  return m ? { parent: m[1].trim(), modifier: m[2].trim() } : null;
}

/* ── Portion-size markers (L / M) ────────────────────────────────────────────
   The POS spells a medium pizza six ways — `- وسط`, `- M`, `Pizza - M` — while
   the workbook writes `(M)`. Every one of those has to reduce to the same
   letter, because the loader that filled `item_costs` matched on name and got
   29 medium pizzas costed with the LARGE recipe. `/health` re-checks it. */
export function portionSizeOf(name) {
  const s = String(name || "");
  if (/\(L\)|\bL\b|كبير/.test(s)) return "L";
  if (/\(M\)|\bM\b|وسط/.test(s)) return "M";
  return null;
}

/* ── REMOVED: PROTEIN_RE ──────────────────────────────────────────────────────
   It graded how badly a batch's "output = inputs" claim bit, by protein share,
   and it drove `BATCH_NO_YIELD_LOSS`. Deleted with that rule. The share of a
   batch that is meat says NOTHING about whether the batch loses weight, because
   in this kitchen the meat batches are MARINATIONS: 5 kg in, 5 kg out,
   portioned raw at 300 g and cooked to order. What matters is whether the batch
   is cooked BEFORE it is portioned, which is a fact about the process, not
   about the ingredients — see COOKED_BATCHES inside register().
   Do not reintroduce a protein-share yield heuristic here. ─────────────────── */

const round3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const norm = (s) => String(s ?? "").replace(/[‎‏]/g, "").trim();
const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const dayArg = (v, dflt) => (isDay(v) ? v : dflt);
const idFor = (...parts) =>
  crypto.createHash("sha1").update(parts.join(" ")).digest("hex").slice(0, 24);

/* ── EMBEDDED WORKBOOK SNAPSHOT ──────────────────────────────────────────────
   Positional arrays, generated from the two source workbooks. They are the SEED
   for the tables above and nothing else: once a row exists in Postgres these
   constants are never consulted again, so Omar refining a price in the DB is
   permanent. Column order matches the INSERT statements in seedIfEmpty().

   WB_RAW   [canonical_ar, name_en, purchase_unit, cost_per_unit, cost_per_g,
             cost_per_piece, status]  — cost_per_g and cost_per_piece are
             mutually exclusive; the workbook's own "Lookup Unit Cost" column
             mixes the two units and must never be multiplied by a gram qty.
   WB_ALIAS [alias_ar, canonical_ar]
   WB_BAT   [batch_ar, batch_en, output_g, total_cost, cost_per_g, note]
   WB_BLIN  [batch_ar, ing_type, ing_ar, ing_en, qty, unit, qty_g, line_cost]
   WB_REC   [product_id, ing_type, ing_ar, ing_en, qty, unit, qty_g, line_cost]
   WB_MEN   [product_id, sku, product_ar, product_en, category_ar, category_en,
             total_cost, price_suggested, price_restaurant, price_platform]
             — the last two come from freshcuts_full_food_cost_master.xlsx,
             the ONLY source of the restaurant-vs-platform split.
   WB_MODS  [modifier_ar, modifier_en, ing_ar, qty, unit, cost, price_incl]
   ────────────────────────────────────────────────────────────────────────── */
const WB_RAW = [["ماء","Water","L",0.0,0.0,null,"OK"],["مياه","Water","L",0.0,0.0,null,"OK"],["مياة","Water","L",0.0,0.0,null,"OK"],["لحم وش فخدة","Beef Topside","kg",35.0,0.035,null,"OK"],["لحم مفروم","Minced Beef","kg",35.0,0.035,null,"OK"],["لحم رقبة","Beef Neck","kg",30.0,0.03,null,"OK"],["بوش","Beef Bosh/Fat","kg",7.0,0.007,null,"OK"],["لية","Lamb Fat","kg",25.0,0.025,null,"OK"],["دهن بقري","Beef Fat","kg",30.0,0.03,null,"OK"],["سجق","Sausage","kg",35.0,0.035,null,"OK"],["كبدة","Liver","kg",35.0,0.035,null,"OK"],["لحم بقري بريسكت","Beef Brisket","kg",30.0,0.03,null,"OK"],["دجاجة 1كيلو بالعضم","Whole Chicken 1kg","piece",17.0,0.017,17.0,"OK"],["صدور فيليه ( مخلية )","Chicken Breast Fillet","kg",18.2,0.0182,null,"OK"],["فيليه زنجر","Zinger Fillet","kg",28.0,0.028,4.2,"OK"],["استربس","Chicken Strips","kg",26.5,0.0265,null,"OK"],["هوت دوج","Hot Dog","kg",20.0,0.02,null,"OK"],["لحم بقري","Beef","kg",53.0,0.053,null,"OK"],["رومي مدخن","Smoked Turkey","kg",66.0,0.066,null,"OK"],["بيف بيكون","Beef Bacon","kg",90.0,0.09,null,"OK"],["بوب كوردن","Bob Cordon","kg",25.3,0.0253,0.5819,"OK"],["بطاطس","Potatoes","kg",6.0,0.006,null,"OK"],["بيف بقري فورميد","Beef Formed","kg",28.3,0.0283,null,"OK"],["بيبروني","Pepperoni","kg",48.0,0.048,null,"OK"],["جمبري","Shrimp","kg",38.0,0.038,null,"OK"],["كالماري","Calamari","kg",86.0,0.086,null,"OK"],["كابوريا","Crab","kg",22.0,0.022,null,"OK"],["تونة","Tuna","kg",35.0,0.035,null,"OK"],["كوردن بلو","Cordon Bleu","kg",30.0,0.03,2.4,"OK"],["لحم بقري مدخن","Smoked Beef","kg",53.0,0.053,null,"OK"],["بسطرمة","Pastrami","kg",70.0,0.07,null,"OK"],["دقيق","Flour","kg",2.3,0.0023,null,"OK"],["دقيق فوم","Foam Flour","kg",2.3,0.0023,null,"OK"],["خل","Vinegar","kg",7.0,0.007,null,"OK"],["حليب المراعي","Milk","kg",4.6,0.0046,null,"OK"],["موزاريلا حيواني موندي","Mozzarella","kg",28.25,0.02825,null,"OK"],["مكرونة أقلام قودي","Penne Pasta","kg",12.0,0.012,null,"OK"],["بيض","Egg","piece",0.7,0.014,0.7,"OK"],["ديمي جلاس بودر","Demi Glace Powder","kg",86.7,0.0867,null,"OK"],["مرقة لحم ( بهارات لحم )","Meat Seasoning/Stock","kg",50.0,0.05,null,"OK"],["مرقة دجاج ( بهارات دجاج )","Chicken Seasoning/Stock","kg",42.0,0.042,null,"OK"],["بهارات بطاطس الشرق الاوسط","Potato Seasoning","kg",56.3,0.0563,null,"OK"],["زبادي","Yogurt","kg",7.0,0.007,null,"OK"],["زيت قلي دلال","Frying Oil","L",6.3,0.0063,null,"OK"],["زيت درة","Corn Oil","L",10.0,0.01,null,"OK"],["كريمة طهي","Cooking Cream","L",22.0,0.022,null,"OK"],["زبدة المراعي","Butter","kg",50.0,0.05,null,"OK"],["خميرة","Yeast","kg",30.0,0.03,null,"OK"],["طماطم مقشرة","Peeled Tomatoes","kg",7.2,0.0072,null,"OK"],["زيت زيتون","Olive Oil","L",35.0,0.035,null,"OK"],["فانيليا","Vanilla","piece",0.8,0.16,0.8,"OK"],["مايونيز هيلمانز","Mayonnaise","kg",7.0,0.007,null,"OK"],["جبنة شيدر صوص","Cheddar Sauce","kg",17.0,0.017,null,"OK"],["أرز بسمتي الوليمة","Basmati Rice","kg",8.0,0.008,null,"OK"],["مشروم","Mushroom","kg",40.0,0.04,null,"OK"],["حلقات بصل","Onion Rings","kg",30.0,0.03,0.6,"OK"],["اصابع موزاريلا","Fried Mozzarella Stick","kg",55.0,0.055,1.925,"OK"],["زيتون شرائح","Sliced Olives","kg",17.0,0.017,null,"OK"],["ملح","Salt","kg",6.0,0.006,null,"OK"],["فلفل اسود","Black Pepper","kg",80.0,0.08,null,"OK"],["جوزة الطيب","Nutmeg","kg",300.0,0.3,null,"OK"],["ورق لورى","Bay Leaf","kg",60.0,0.06,0.018,"OK"],["حبهان","Cardamom","kg",180.0,0.18,0.036,"OK"],["كمون","Cumin","kg",25.0,0.025,null,"OK"],["كزبرة","Coriander","kg",28.8,0.0288,null,"OK"],["السبع بهارات","Seven Spices","kg",60.0,0.06,null,"OK"],["بابريكا","Paprika","kg",38.3,0.0383,null,"OK"],["بصل بودرة","Onion Powder","kg",38.3,0.0383,null,"OK"],["ثوم بودر","Garlic Powder","kg",38.3,0.0383,null,"OK"],["خلنجان","Galangal","kg",50.0,0.05,null,"OK"],["جنزبيل","Ginger","kg",38.3,0.0383,null,"OK"],["بهارات ايطالية","Italian Herbs","kg",47.9,0.0479,null,"OK"],["قرفة بودرة","Cinnamon Powder","kg",38.3,0.0383,null,"OK"],["ريحان بودر","Basil Powder","kg",171.4,0.1714,null,"OK"],["سكر","Sugar","kg",5.0,0.005,null,"OK"],["بصل","Onion","kg",3.0,0.003,null,"OK"],["فلفل رومي","Bell Pepper","kg",6.0,0.006,null,"OK"],["ليمون","Lemon","kg",10.0,0.01,1.2,"OK"],["ثوم","Garlic","kg",24.0,0.024,null,"OK"],["فلفل أخضر سبايسي","Spicy Green Pepper","kg",10.0,0.01,null,"OK"],["فلفل احمر رومي","Red Bell Pepper","kg",12.0,0.012,null,"OK"],["بقدونس","Parsley","piece",1.0,0.01,1.0,"OK"],["خيار","Cucumber","kg",5.0,0.005,null,"OK"],["طماطم","Tomato","kg",5.0,0.005,null,"OK"],["شبت","Dill","piece",1.0,0.01,1.0,"OK"],["جزر","Carrot","kg",5.0,0.005,null,"OK"],["نوتيلا","Nutella","kg",50.0,0.05,null,"OK"],["كابوتشا","Iceberg Lettuce","piece",3.0,0.006,3.0,"OK"],["خل تفاح","Apple Cider Vinegar","kg",12.5,0.0125,null,"OK"],["كرنب سلطة","Cabbage","kg",10.0,0.01,null,"OK"],["صلصة بوريه","Peeled Tomatoes","kg",8.8,0.0088,null,"OK"],["زعتر","Thyme","kg",176.1,0.1761,null,"OK"],["مستردة","Mustard","kg",11.0,0.011,null,"OK"],["جبنة كيري","Kiri Cheese","kg",18.0,0.018,null,"OK"],["حليب بودرة","Milk Powder","kg",28.8,0.0288,null,"OK"],["كرفس","Celery","piece",5.0,0.02,5.0,"OK"],["سماق","Sumac","kg",12.5,0.0125,null,"OK"],["برتقال","Orange","kg",10.0,0.01,null,"OK"],["قرنفل","Clove","kg",47.9,0.0479,0.00958,"OK"],["قرفة اعواد","Cinnamon Stick","kg",47.9,0.0479,0.0958,"OK"],["فلفل أبيض","White Pepper","kg",80.0,0.08,null,"OK"],["خبز","Baladi Bread","piece",0.3,null,0.3,"OK"],["سويت شيلي","Sweet Chili Sauce","kg",15.2,0.0152,null,"OK"],["صوص ديناميت","Dynamite Sauce","kg",15.2,0.0152,null,"OK"],["كاتشب ظرف","Ketchup Sachet","piece",0.046,0.0046,0.046,"OK"],["كاتشب جالون","Ketchup","kg",4.0,0.004,null,"OK"],["باربكيو","BBQ Sauce","kg",8.0,0.008,null,"OK"],["صوص تكساس","Texas Sauce","kg",17.0,0.017,null,"OK"],["خبز برجر","Burger Bun","piece",1.3,null,1.3,"OK"],["خبز توست","Toast Bread","piece",0.5,null,0.5,"OK"],["جبنة رومي","Roman Cheese","kg",50.0,0.05,null,"OK"],["جبنة ريكفورد","Roquefort Cheese","kg",70.0,0.07,null,"OK"],["جبنة بارميزان","Parmesan Cheese","kg",65.0,0.065,null,"OK"],["مكرونة شريط","Ribbon Pasta","kg",12.0,0.012,null,"OK"],["مكرونة فوسيلي","Fusilli Pasta","kg",12.0,0.012,null,"OK"],["بقسماط","Breadcrumbs","kg",10.0,0.01,null,"OK"],["نشا","Starch","kg",5.0,0.005,null,"OK"],["ملح صيني","MSG","kg",5.0,0.005,null,"OK"],["ذرة حلو","Sweet Corn","kg",10.0,0.01,null,"OK"],["هوهوز","HoHos","piece",1.0,0.033333,1.0,"OK"],["رانش","Ranch Sauce","kg",10.0,0.01,null,"REVIEW"],["ثاوزند آيلاند","Thousand Island Sauce","kg",15.0,0.015,null,"REVIEW"],["مخلل","Pickles","kg",6.5,0.0065,null,"REVIEW"],["منديل طرب","Caul Fat (Mandeel Tarb)","kg",10.0,0.01,null,"OK"],["طحينة","Tahini Raw","kg",13.0,0.013,null,"OK"],["فلفل هالبينو","Jalapeno","kg",10.0,0.01,null,"OK"],["أوراك مخلية","Chicken Thigh Boneless","kg",30.0,0.03,null,"OK"],["جبنة شيدر شرايح","Cheddar slices","kg",44.0,0.044,1.1,"OK"],["دبس فلفلة","crushed red pepper","kg",13.11,0.01311,null,"OK"]];
const WB_ALIAS = [["موتزريلا","موزاريلا حيواني موندي"],["موزاريلا","موزاريلا حيواني موندي"],["رومي","رومي مدخن"],["رز بسمتي","أرز بسمتي الوليمة"],["أرز بسمتي","أرز بسمتي الوليمة"],["ارزبسمتي","أرز بسمتي الوليمة"],["زيتون اخضر","زيتون شرائح"],["صلصة بيتزا","صوص البيتزا"],["صلصة بوريه","طماطم مقشرة"],["حشو كيري اطراف","جبنة كيري"],["زنجر","استربس"],["زنجر فراشة","فيليه زنجر"],["صدور","الصدور"],["شيش","شيش طاووق"],["كفته","الكفتة"],["طحينه","الطحينة"],["سلطه","السلطة الحاتي"],["كلوسلو","الكلوسلو"],["وايت صوص","الوايت صوص"],["برجر","البرجر"],["حواوشي","الحواوشي"],["كبدة","الكبدة"],["لحمه مفرومه","اللحمة المفرومة"],["شيش طاووك","شيش طاووق"],["سجق ايطالي","سجق"],["روبيان","جمبري"],["ثاوثند ايلند","ثاوزند آيلاند"],["ثلوثند ايلاند","ثاوزند آيلاند"],["سماء","سماق"],["شيش طاووق خام","أوراك مخلية"]];
const WB_BAT = [["السلطة الحاتي","Grill Salad",1391.0,8.418,0.006052,"Approximate output = measurable inputs"],["فراخ فحم","Charcoal Chicken",7124.0,114.4675,0.016068,"Output fixed to 6 whole chickens x 1100g"],["الطحينة","Tahini Sauce",1055.0,9.535,0.009038,""],["الكلوسلو","Coleslaw",2005.0,15.98,0.00797,""],["اللحمة المفرومة","Minced Meat Mix",1694.0,40.896,0.024142,""],["الوايت صوص","White Sauce",6247.0,38.39758,0.006147,""],["الصدور","Marinated Chicken Breast",5351.0,95.436,0.017835,""],["الكبدة","Seasoned Liver",3265.0,111.47,0.034141,""],["صوص البيتزا","Pizza Sauce",5440.0,33.854,0.006223,""],["عجينة الكريب","Crepe Dough",4944.25,18.62,0.003766,""],["عجينة البيتزا","Pizza Dough",3338.0,10.1,0.003026,""],["البرجر","Burger Patty Mix",6280.0,154.367,0.024581,""],["الحواوشي","Hawawshi Mix",10642.0,225.2956,0.02117,""],["الكفتة","Kofta Mix",6994.0,192.4456,0.027516,""],["البيف كازرول","Beef Casserole",4835.0,128.587,0.026595,""],["شيش طاووق","Shish Tawook",5351.0,153.736,0.02873,""],["الأرز المطبوخ","Cooked Basmati Rice",2500.0,8.42,0.003368,"User approved assumption: 1kg raw rice yields 2.5kg cooked"],["خضار فرشة","Fresh Herbs Mix",3400.0,22.5,0.006618,"Assumes 100g per parsley bunch; editable through raw assumptions"],["عجينة الطرب","Tarb",1500.0,32.515814,0.021677,"Missing recipe; update to unlock Tarb products"],["برجر كوردن بلو","Cordon Bleu Burger",2460.0,40.01,0.016264,""]];
const WB_BLIN = [["السلطة الحاتي","Raw","طماطم","Tomato",500.0,"g",500.0,2.5],["السلطة الحاتي","Raw","بابريكا","Paprika",10.0,"g",10.0,0.383],["السلطة الحاتي","Raw","خيار","Cucumber",500.0,"g",500.0,2.5],["السلطة الحاتي","Raw","بصل","Onion",150.0,"g",150.0,0.45],["السلطة الحاتي","Raw","بقدونس","Parsley",30.0,"g",30.0,0.3],["السلطة الحاتي","Raw","ليمون","Lemon",70.0,"g",70.0,0.7],["السلطة الحاتي","Raw","خل","Vinegar",40.0,"g",40.0,0.28],["السلطة الحاتي","Raw","زيت درة","Corn Oil",20.0,"ml",20.0,0.2],["السلطة الحاتي","Raw","ملح","Salt",10.0,"g",10.0,0.06],["السلطة الحاتي","Raw","كمون","Cumin",5.0,"g",5.0,0.125],["السلطة الحاتي","Raw","فلفل اسود","Black Pepper",3.0,"g",3.0,0.24],["السلطة الحاتي","Raw","السبع بهارات","Seven Spices",3.0,"g",3.0,0.18],["السلطة الحاتي","Raw","فلفل أخضر سبايسي","Spicy Green Pepper",50.0,"g",50.0,0.5],["السلطة الحاتي","Raw","ماء","Water",70.0,"ml",70.0,0.0],["فراخ فحم","Raw","دجاجة 1كيلو بالعضم","Whole Chicken 1kg",6.0,"piece",6000.0,102.0],["فراخ فحم","Raw","بصل","Onion",600.0,"g",600.0,1.8],["فراخ فحم","Raw","زيت درة","Corn Oil",30.0,"g",30.0,0.3],["فراخ فحم","Raw","طماطم","Tomato",200.0,"g",200.0,1.0],["فراخ فحم","Raw","ثوم","Garlic",0.0,"g",0.0,0.0],["فراخ فحم","Raw","ملح","Salt",85.0,"g",85.0,0.51],["فراخ فحم","Raw","خل تفاح","Apple Cider Vinegar",15.0,"g",15.0,0.1875],["فراخ فحم","Raw","فلفل اسود","Black Pepper",20.0,"g",20.0,1.6],["فراخ فحم","Raw","زبادي","Yogurt",100.0,"g",100.0,0.7],["فراخ فحم","Raw","كمون","Cumin",20.0,"g",20.0,0.5],["فراخ فحم","Raw","دبس فلفلة","crushed red pepper",100.0,"g",100.0,1.311],["فراخ فحم","Raw","سماق","Sumac",0.0,"g",0.0,0.0],["فراخ فحم","Raw","كزبرة","Coriander",20.0,"g",20.0,0.576],["فراخ فحم","Raw","حبهان","Cardamom",0.0,"g",0.0,0.0],["فراخ فحم","Raw","قرفة اعواد","Cinnamon Stick",0.0,"piece",0.0,0.0],["فراخ فحم","Raw","ورق لورى","Bay Leaf",0.0,"piece",0.0,0.0],["فراخ فحم","Raw","ليمون","Lemon",3.0,"piece",360.0,3.6],["فراخ فحم","Raw","جنزبيل","Ginger",10.0,"g",10.0,0.383],["الطحينة","Raw","طحينة","Tahini Raw",600.0,"g",600.0,7.8],["الطحينة","Raw","ماء","Water",400.0,"ml",400.0,0.0],["الطحينة","Raw","ليمون","Lemon",40.0,"g",40.0,0.4],["الطحينة","Raw","ملح","Salt",15.0,"g",15.0,0.09],["الطحينة","Raw","حليب المراعي","Milk",50.0,"g",50.0,0.23],["الطحينة","Raw","ثوم","Garlic",10.0,"g",10.0,0.24],["الطحينة","Raw","خل","Vinegar",20.0,"g",20.0,0.14],["الطحينة","Raw","كمون","Cumin",5.0,"g",5.0,0.125],["الطحينة","Raw","فلفل اسود","Black Pepper",2.0,"g",2.0,0.16],["الطحينة","Raw","زبادي","Yogurt",50.0,"g",50.0,0.35],["الكلوسلو","Raw","كرنب سلطة","Cabbage",1000.0,"g",1000.0,10.0],["الكلوسلو","Raw","مايونيز هيلمانز","Mayonnaise",700.0,"g",700.0,4.9],["الكلوسلو","Raw","حليب المراعي","Milk",50.0,"g",50.0,0.23],["الكلوسلو","Raw","سكر","Sugar",120.0,"g",120.0,0.6],["الكلوسلو","Raw","جزر","Carrot",50.0,"g",50.0,0.25],["اللحمة المفرومة","Raw","لحم مفروم","Minced Beef",1000.0,"g",1000.0,35.0],["اللحمة المفرومة","Raw","بصل","Onion",500.0,"g",500.0,1.5],["اللحمة المفرومة","Raw","كرفس","Celery",140.0,"g",140.0,2.8],["اللحمة المفرومة","Raw","ثوم","Garlic",15.0,"g",15.0,0.36],["اللحمة المفرومة","Raw","مرقة لحم ( بهارات لحم )","Meat Seasoning/Stock",5.0,"g",5.0,0.25],["اللحمة المفرومة","Raw","حبهان","Cardamom",2.0,"g",2.0,0.36],["اللحمة المفرومة","Raw","ورق لورى","Bay Leaf",2.0,"piece",0.6,0.036],["اللحمة المفرومة","Raw","زيت درة","Corn Oil",10.0,"ml",10.0,0.1],["اللحمة المفرومة","Raw","ملح","Salt",15.0,"g",15.0,0.09],["اللحمة المفرومة","Raw","فلفل اسود","Black Pepper",5.0,"g",5.0,0.4],["الوايت صوص","Raw","حليب المراعي","Milk",3500.0,"g",3500.0,16.1],["الوايت صوص","Raw","ماء","Water",1500.0,"ml",1500.0,0.0],["الوايت صوص","Raw","زبدة المراعي","Butter",200.0,"g",200.0,10.0],["الوايت صوص","Raw","زيت درة","Corn Oil",200.0,"ml",200.0,2.0],["الوايت صوص","Raw","دقيق","Flour",400.0,"g",400.0,0.92],["الوايت صوص","Raw","كريمة طهي","Cooking Cream",250.0,"ml",250.0,5.5],["الوايت صوص","Raw","مرقة دجاج ( بهارات دجاج )","Chicken Seasoning/Stock",50.0,"g",50.0,2.1],["الوايت صوص","Raw","ملح","Salt",70.0,"g",70.0,0.42],["الوايت صوص","Raw","فلفل أبيض","White Pepper",10.0,"g",10.0,0.8],["الوايت صوص","Raw","حبهان","Cardamom",5.0,"piece",1.0,0.18],["الوايت صوص","Raw","ورق لورى","Bay Leaf",1.0,"piece",0.3,0.018],["الوايت صوص","Raw","كرفس","Celery",10.0,"g",10.0,0.2],["الوايت صوص","Raw","بصل","Onion",50.0,"g",50.0,0.15],["الوايت صوص","Raw","قرنفل","Clove",1.0,"piece",0.2,0.00958],["الصدور","Raw","صدور فيليه ( مخلية )","Chicken Breast Fillet",5000.0,"g",5000.0,91.0],["الصدور","Raw","مستردة","Mustard",50.0,"g",50.0,0.55],["الصدور","Raw","زبادي","Yogurt",100.0,"g",100.0,0.7],["الصدور","Raw","ملح","Salt",35.0,"g",35.0,0.21],["الصدور","Raw","فلفل اسود","Black Pepper",6.0,"g",6.0,0.48],["الصدور","Raw","خلنجان","Galangal",2.0,"g",2.0,0.1],["الصدور","Raw","جنزبيل","Ginger",1.0,"g",1.0,0.0383],["الصدور","Raw","السبع بهارات","Seven Spices",5.0,"g",5.0,0.3],["الصدور","Raw","بابريكا","Paprika",5.0,"g",5.0,0.1915],["الصدور","Raw","ثوم بودر","Garlic Powder",7.0,"g",7.0,0.2681],["الصدور","Raw","بصل بودرة","Onion Powder",7.0,"g",7.0,0.2681],["الصدور","Raw","زيت درة","Corn Oil",50.0,"ml",50.0,0.5],["الصدور","Raw","ليمون","Lemon",13.0,"g",13.0,0.13],["الصدور","Raw","برتقال","Orange",70.0,"g",70.0,0.7],["الكبدة","Raw","كبدة","Liver",3000.0,"g",3000.0,105.0],["الكبدة","Raw","ثوم","Garlic",150.0,"g",150.0,3.6],["الكبدة","Raw","ملح","Salt",30.0,"g",30.0,0.18],["الكبدة","Raw","فلفل اسود","Black Pepper",15.0,"g",15.0,1.2],["الكبدة","Raw","كمون","Cumin",15.0,"g",15.0,0.375],["الكبدة","Raw","كزبرة","Coriander",15.0,"g",15.0,0.432],["الكبدة","Raw","ليمون","Lemon",30.0,"g",30.0,0.3],["الكبدة","Raw","قرفة بودرة","Cinnamon Powder",10.0,"g",10.0,0.383],["صوص البيتزا","Raw","طماطم","Tomato",5000.0,"g",5000.0,25.0],["صوص البيتزا","Raw","زيت زيتون","Olive Oil",50.0,"ml",50.0,1.75],["صوص البيتزا","Raw","ثوم","Garlic",50.0,"g",50.0,1.2],["صوص البيتزا","Raw","بصل","Onion",200.0,"g",200.0,0.6],["صوص البيتزا","Raw","سكر","Sugar",50.0,"g",50.0,0.25],["صوص البيتزا","Raw","ملح","Salt",50.0,"g",50.0,0.3],["صوص البيتزا","Raw","فلفل اسود","Black Pepper",10.0,"g",10.0,0.8],["صوص البيتزا","Raw","ريحان بودر","Basil Powder",10.0,"g",10.0,1.714],["صوص البيتزا","Raw","بهارات ايطالية","Italian Herbs",10.0,"g",10.0,0.479],["صوص البيتزا","Raw","زعتر","Thyme",10.0,"g",10.0,1.761],["عجينة الكريب","Raw","دقيق","Flour",2000.0,"g",2000.0,4.6],["عجينة الكريب","Raw","حليب المراعي","Milk",1500.0,"g",1500.0,6.9],["عجينة الكريب","Raw","ماء","Water",1250.0,"ml",1250.0,0.0],["عجينة الكريب","Raw","بيض","Egg",4.0,"piece",200.0,2.8],["عجينة الكريب","Raw","زبدة المراعي","Butter",70.0,"g",70.0,3.5],["عجينة الكريب","Raw","فانيليا","Vanilla",0.25,"piece",1.25,0.2],["عجينة الكريب","Raw","سكر","Sugar",100.0,"g",100.0,0.5],["عجينة الكريب","Raw","ملح","Salt",20.0,"g",20.0,0.12],["عجينة البيتزا","Raw","دقيق فوم","Foam Flour",2000.0,"g",2000.0,4.6],["عجينة البيتزا","Raw","ماء","Water",500.0,"ml",500.0,0.0],["عجينة البيتزا","Raw","حليب المراعي","Milk",650.0,"g",650.0,2.99],["عجينة البيتزا","Raw","زيت درة","Corn Oil",100.0,"ml",100.0,1.0],["عجينة البيتزا","Raw","زيت زيتون","Olive Oil",20.0,"ml",20.0,0.7],["عجينة البيتزا","Raw","خميرة","Yeast",18.0,"g",18.0,0.54],["عجينة البيتزا","Raw","سكر","Sugar",30.0,"g",30.0,0.15],["عجينة البيتزا","Raw","ملح","Salt",20.0,"g",20.0,0.12],["البرجر","Raw","لحم بقري بريسكت","Beef Brisket",5000.0,"g",5000.0,150.0],["البرجر","Raw","لحم وش فخدة","Beef Topside",0.0,"g",0.0,0.0],["البرجر","Raw","بوش","Beef Bosh/Fat",0.0,"g",0.0,0.0],["البرجر","Raw","ملح","Salt",75.0,"g",75.0,0.45],["البرجر","Raw","فلفل اسود","Black Pepper",10.0,"g",10.0,0.8],["البرجر","Raw","كزبرة","Coriander",5.0,"g",5.0,0.144],["البرجر","Raw","مرقة لحم ( بهارات لحم )","Meat Seasoning/Stock",5.0,"g",5.0,0.25],["البرجر","Raw","جنزبيل","Ginger",5.0,"g",5.0,0.1915],["البرجر","Raw","بصل بودرة","Onion Powder",10.0,"g",10.0,0.383],["البرجر","Raw","حليب بودرة","Milk Powder",15.0,"g",15.0,0.432],["البرجر","Raw","بقسماط","Breadcrumbs",150.0,"g",150.0,1.5],["البرجر","Raw","بابريكا","Paprika",5.0,"g",5.0,0.1915],["البرجر","Raw","ملح صيني","MSG",5.0,"g",5.0,0.025],["الحواوشي","Raw","لحم رقبة","Beef Neck",2500.0,"g",2500.0,75.0],["الحواوشي","Raw","لحم وش فخدة","Beef Topside",2500.0,"g",2500.0,87.5],["الحواوشي","Raw","لية","Lamb Fat",1250.0,"g",1250.0,31.25],["الحواوشي","Raw","بوش","Beef Bosh/Fat",1250.0,"g",1250.0,8.75],["الحواوشي","Raw","ملح","Salt",75.0,"g",75.0,0.45],["الحواوشي","Raw","فلفل اسود","Black Pepper",25.0,"g",25.0,2.0],["الحواوشي","Raw","السبع بهارات","Seven Spices",25.0,"g",25.0,1.5],["الحواوشي","Raw","جوزة الطيب","Nutmeg",5.0,"g",5.0,1.5],["الحواوشي","Raw","فلفل أخضر سبايسي","Spicy Green Pepper",500.0,"g",500.0,5.0],["الحواوشي","Raw","كزبرة","Coriander",12.0,"g",12.0,0.3456],["الحواوشي","Raw","بصل","Onion",2000.0,"g",2000.0,6.0],["الحواوشي","Raw","فلفل احمر رومي","Red Bell Pepper",500.0,"g",500.0,6.0],["الكفتة","Raw","لحم رقبة","Beef Neck",2500.0,"g",2500.0,75.0],["الكفتة","Raw","لحم وش فخدة","Beef Topside",2500.0,"g",2500.0,87.5],["الكفتة","Raw","لية","Lamb Fat",800.0,"g",800.0,20.0],["الكفتة","Raw","بوش","Beef Bosh/Fat",700.0,"g",700.0,4.9],["الكفتة","Raw","ملح","Salt",75.0,"g",75.0,0.45],["الكفتة","Raw","فلفل اسود","Black Pepper",25.0,"g",25.0,2.0],["الكفتة","Raw","جوزة الطيب","Nutmeg",5.0,"g",5.0,1.5],["الكفتة","Raw","بصل","Onion",250.0,"g",250.0,0.75],["الكفتة","Raw","كزبرة","Coriander",12.0,"g",12.0,0.3456],["البيف كازرول","Raw","لحم بقري","Beef",2000.0,"g",2000.0,106.0],["البيف كازرول","Raw","بصل","Onion",500.0,"g",500.0,1.5],["البيف كازرول","Raw","زيت درة","Corn Oil",80.0,"ml",80.0,0.8],["البيف كازرول","Raw","زبدة المراعي","Butter",120.0,"g",120.0,6.0],["البيف كازرول","Raw","دقيق","Flour",150.0,"g",150.0,0.345],["البيف كازرول","Raw","ماء","Water",1700.0,"ml",1700.0,0.0],["البيف كازرول","Raw","ديمي جلاس بودر","Demi Glace Powder",60.0,"g",60.0,5.202],["البيف كازرول","Raw","مشروم","Mushroom",200.0,"g",200.0,8.0],["البيف كازرول","Raw","ملح","Salt",15.0,"g",15.0,0.09],["البيف كازرول","Raw","فلفل اسود","Black Pepper",5.0,"g",5.0,0.4],["البيف كازرول","Raw","مرقة لحم ( بهارات لحم )","Meat Seasoning/Stock",5.0,"g",5.0,0.25],["شيش طاووق","Raw","أوراك مخلية","Chicken Thigh Boneless",5000.0,"g",5000.0,150.0],["شيش طاووق","Raw","مستردة","Mustard",50.0,"g",50.0,0.55],["شيش طاووق","Raw","زبادي","Yogurt",100.0,"g",100.0,0.7],["شيش طاووق","Raw","ملح","Salt",35.0,"g",35.0,0.21],["شيش طاووق","Raw","فلفل اسود","Black Pepper",6.0,"g",6.0,0.48],["شيش طاووق","Raw","خلنجان","Galangal",2.0,"g",2.0,0.1],["شيش طاووق","Raw","جنزبيل","Ginger",1.0,"g",1.0,0.0383],["شيش طاووق","Raw","السبع بهارات","Seven Spices",5.0,"g",5.0,0.3],["شيش طاووق","Raw","بابريكا","Paprika",5.0,"g",5.0,0.1915],["شيش طاووق","Raw","ثوم بودر","Garlic Powder",7.0,"g",7.0,0.2681],["شيش طاووق","Raw","بصل بودرة","Onion Powder",7.0,"g",7.0,0.2681],["شيش طاووق","Raw","زيت درة","Corn Oil",50.0,"ml",50.0,0.5],["شيش طاووق","Raw","ليمون","Lemon",13.0,"g",13.0,0.13],["شيش طاووق","Raw","برتقال","Orange",0.0,"g",0.0,0.0],["الأرز المطبوخ","Raw","أرز بسمتي الوليمة","Basmati Rice",1000.0,"g",1000.0,8.0],["الأرز المطبوخ","Raw","زيت درة","Corn Oil",30.0,"ml",30.0,0.3],["الأرز المطبوخ","Raw","ملح","Salt",20.0,"g",20.0,0.12],["الأرز المطبوخ","Raw","ماء","Water",1500.0,"ml",1500.0,0.0],["خضار فرشة","Raw","بصل","Onion",2000.0,"g",2000.0,6.0],["خضار فرشة","Raw","بقدونس","Parsley",4.0,"piece",400.0,4.0],["خضار فرشة","Raw","سماق","Sumac",1000.0,"g",1000.0,12.5],["عجينة الطرب","Batch","الكفتة","Kofta Mix",1000.0,"g",1000.0,27.515814],["عجينة الطرب","Raw","منديل طرب","Caul Fat (Mandeel Tarb)",500.0,"g",500.0,5.0],["برجر كوردن بلو","Raw","صدور فيليه ( مخلية )","Chicken Breast Fillet",1000.0,"g",1000.0,18.2],["برجر كوردن بلو","Raw","جبنة شيدر صوص","Cheddar Sauce",400.0,"g",400.0,6.8],["برجر كوردن بلو","Raw","زيتون شرائح","Sliced Olives",130.0,"g",130.0,2.21],["برجر كوردن بلو","Raw","فلفل هالبينو","Jalapeno",130.0,"g",130.0,1.3],["برجر كوردن بلو","Raw","بقسماط","Breadcrumbs",750.0,"g",750.0,7.5],["برجر كوردن بلو","Raw","فلفل اسود","Black Pepper",50.0,"g",50.0,4.0]];
const WB_REC = [[1,"Batch","عجينة الكريب","Crepe Dough",120.0,"g",120.0,0.451919],[1,"Batch","الكفتة","Kofta Mix",65.0,"g",65.0,1.788528],[1,"Raw","سجق","Sausage",50.0,"g",50.0,1.75],[1,"Raw","هوت دوج","Hot Dog",50.0,"g",50.0,1.0],[1,"Raw","لحم بقري","Beef",0.0,"g",0.0,0.0],[1,"Raw","موزاريلا حيواني موندي","Mozzarella",60.0,"g",60.0,1.695],[1,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[1,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[1,"Raw","صوص تكساس","Texas Sauce",20.0,"g",20.0,0.34],[1,"Raw","كاتشب جالون","Ketchup",25.0,"g",25.0,0.1],[1,"Raw","مايونيز هيلمانز","Mayonnaise",25.0,"g",25.0,0.175],[2,"Batch","عجينة الكريب","Crepe Dough",120.0,"g",120.0,0.451919],[2,"Batch","الصدور","Marinated Chicken Breast",70.0,"g",70.0,1.248462],[2,"Raw","استربس","Chicken Strips",75.0,"g",100.0,2.65],[2,"Raw","رومي مدخن","Smoked Turkey",20.0,"g",20.0,1.32],[2,"Raw","موزاريلا حيواني موندي","Mozzarella",60.0,"g",60.0,1.695],[2,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[2,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[2,"Raw","جبنة شيدر صوص","Cheddar Sauce",20.0,"g",20.0,0.34],[2,"Raw","كاتشب جالون","Ketchup",25.0,"g",25.0,0.1],[2,"Raw","مايونيز هيلمانز","Mayonnaise",25.0,"g",25.0,0.175],[5,"Batch","عجينة الكريب","Crepe Dough",120.0,"g",120.0,0.451919],[5,"Raw","هوت دوج","Hot Dog",180.0,"g",160.0,3.2],[5,"Raw","موزاريلا حيواني موندي","Mozzarella",60.0,"g",60.0,1.695],[5,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[5,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[5,"Raw","كاتشب جالون","Ketchup",25.0,"g",25.0,0.1],[5,"Raw","مايونيز هيلمانز","Mayonnaise",25.0,"g",25.0,0.175],[6,"Batch","عجينة الكريب","Crepe Dough",120.0,"g",120.0,0.451919],[6,"Batch","البرجر","Burger Patty Mix",200.0,"g",200.0,4.916146],[6,"Raw","موزاريلا حيواني موندي","Mozzarella",60.0,"g",60.0,1.695],[6,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[6,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[6,"Raw","كاتشب جالون","Ketchup",25.0,"g",25.0,0.1],[6,"Raw","مايونيز هيلمانز","Mayonnaise",25.0,"g",25.0,0.175],[6,"Raw","صوص تكساس","Texas Sauce",10.0,"g",10.0,0.17],[6,"Raw","جبنة شيدر صوص","Cheddar Sauce",10.0,"g",10.0,0.17],[8,"Batch","عجينة الكريب","Crepe Dough",120.0,"g",120.0,0.451919],[8,"Batch","شيش طاووق","Shish Tawook",170.0,"g",170.0,4.884156],[8,"Raw","موزاريلا حيواني موندي","Mozzarella",60.0,"g",60.0,1.695],[8,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[8,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[8,"Raw","كاتشب جالون","Ketchup",25.0,"g",25.0,0.1],[8,"Raw","مايونيز هيلمانز","Mayonnaise",25.0,"g",25.0,0.175],[9,"Batch","عجينة الكريب","Crepe Dough",120.0,"g",120.0,0.451919],[9,"Batch","الصدور","Marinated Chicken Breast",150.0,"g",150.0,2.675276],[9,"Raw","موزاريلا حيواني موندي","Mozzarella",60.0,"g",60.0,1.695],[9,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[9,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[9,"Raw","كاتشب جالون","Ketchup",25.0,"g",25.0,0.1],[9,"Raw","مايونيز هيلمانز","Mayonnaise",25.0,"g",25.0,0.175],[10,"Batch","عجينة الكريب","Crepe Dough",120.0,"g",120.0,0.451919],[10,"Raw","استربس","Chicken Strips",175.0,"g",175.0,4.6375],[10,"Raw","موزاريلا حيواني موندي","Mozzarella",70.0,"g",70.0,1.9775],[10,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[10,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[10,"Raw","كاتشب جالون","Ketchup",30.0,"g",30.0,0.12],[10,"Raw","مايونيز هيلمانز","Mayonnaise",30.0,"g",30.0,0.21],[10,"Raw","جبنة شيدر صوص","Cheddar Sauce",20.0,"g",20.0,0.34],[11,"Batch","عجينة الكريب","Crepe Dough",120.0,"g",120.0,0.451919],[11,"Raw","استربس","Chicken Strips",175.0,"g",175.0,4.6375],[11,"Raw","رومي مدخن","Smoked Turkey",20.0,"g",20.0,1.32],[11,"Raw","موزاريلا حيواني موندي","Mozzarella",70.0,"g",70.0,1.9775],[11,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[11,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[11,"Raw","كاتشب جالون","Ketchup",30.0,"g",30.0,0.12],[11,"Raw","مايونيز هيلمانز","Mayonnaise",30.0,"g",30.0,0.21],[16,"Batch","عجينة الكريب","Crepe Dough",120.0,"g",120.0,0.451919],[16,"Raw","جبنة رومي","Roman Cheese",30.0,"g",30.0,1.5],[16,"Raw","موزاريلا حيواني موندي","Mozzarella",80.0,"g",80.0,2.26],[16,"Raw","جبنة شيدر صوص","Cheddar Sauce",40.0,"g",40.0,0.68],[16,"Raw","فلفل رومي","Bell Pepper",10.0,"g",10.0,0.06],[16,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[16,"Raw","كاتشب جالون","Ketchup",25.0,"g",25.0,0.1],[16,"Raw","مايونيز هيلمانز","Mayonnaise",25.0,"g",25.0,0.175],[17,"Batch","عجينة الكريب","Crepe Dough",120.0,"g",120.0,0.451919],[17,"Raw","بطاطس","Potatoes",250.0,"g",250.0,1.5],[17,"Raw","موزاريلا حيواني موندي","Mozzarella",60.0,"g",60.0,1.695],[17,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[17,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[17,"Raw","كاتشب جالون","Ketchup",30.0,"g",30.0,0.12],[17,"Raw","مايونيز هيلمانز","Mayonnaise",30.0,"g",30.0,0.21],[20,"Batch","الأرز المطبوخ","Cooked Basmati Rice",350.0,"g",350.0,1.1788],[20,"Batch","شيش طاووق","Shish Tawook",200.0,"g",200.0,5.746066],[20,"raw","بقدونس","Parsley",2.0,"g",2.0,0.02],[20,"Batch","الطحينة","Tahini Sauce",35.0,"g",35.0,0.316327],[20,"Batch","الطحينة","Tahini Sauce",0.0,"g",0.0,0.0],[20,"Batch","السلطة الحاتي","Grill Salad",60.0,"g",60.0,0.363106],[21,"Batch","الأرز المطبوخ","Cooked Basmati Rice",350.0,"g",350.0,1.1788],[21,"Batch","فراخ فحم","Charcoal Chicken",550.0,"g",550.0,8.837328],[21,"raw","بقدونس","Parsley",5.0,"g",5.0,0.05],[21,"Batch","الطحينة","Tahini Sauce",50.0,"g",50.0,0.451896],[21,"Batch","السلطة الحاتي","Grill Salad",50.0,"g",50.0,0.302588],[22,"Batch","الأرز المطبوخ","Cooked Basmati Rice",600.0,"g",600.0,2.0208],[22,"Batch","فراخ فحم","Charcoal Chicken",1100.0,"g",1100.0,17.674656],[22,"Batch","خضار فرشة","Fresh Herbs Mix",30.0,"g",30.0,0.198529],[22,"Batch","الطحينة","Tahini Sauce",100.0,"g",100.0,0.903791],[22,"Batch","السلطة الحاتي","Grill Salad",100.0,"g",100.0,0.605176],[23,"Batch","الأرز المطبوخ","Cooked Basmati Rice",350.0,"g",350.0,1.1788],[23,"Batch","الصدور","Marinated Chicken Breast",200.0,"g",200.0,3.567034],[23,"raw","بقدونس","Parsley",5.0,"g",5.0,0.05],[23,"Batch","الطحينة","Tahini Sauce",35.0,"g",35.0,0.316327],[23,"Batch","السلطة الحاتي","Grill Salad",60.0,"g",60.0,0.363106],[25,"Batch","الأرز المطبوخ","Cooked Basmati Rice",350.0,"g",350.0,1.1788],[25,"Batch","عجينة الطرب","Tarb",225.0,"g",225.0,4.877372],[25,"raw","بقدونس","Parsley",5.0,"g",5.0,0.05],[25,"Batch","الطحينة","Tahini Sauce",35.0,"g",35.0,0.316327],[25,"Batch","السلطة الحاتي","Grill Salad",60.0,"g",60.0,0.363106],[26,"Batch","الأرز المطبوخ","Cooked Basmati Rice",350.0,"g",350.0,1.1788],[26,"Batch","الكفتة","Kofta Mix",150.0,"g",150.0,4.127372],[26,"raw","بقدونس","Parsley",5.0,"g",5.0,0.05],[26,"Batch","الطحينة","Tahini Sauce",35.0,"g",35.0,0.316327],[26,"Batch","السلطة الحاتي","Grill Salad",60.0,"g",60.0,0.363106],[27,"Batch","الأرز المطبوخ","Cooked Basmati Rice",350.0,"g",350.0,1.1788],[27,"Batch","الكفتة","Kofta Mix",100.0,"g",100.0,2.751581],[27,"Batch","عجينة الطرب","Tarb",75.0,"g",75.0,1.625791],[27,"Batch","الصدور","Marinated Chicken Breast",85.0,"g",85.0,1.51599],[27,"Batch","شيش طاووق","Shish Tawook",85.0,"g",85.0,2.442078],[27,"raw","بقدونس","Parsley",5.0,"g",5.0,0.05],[27,"Batch","الطحينة","Tahini Sauce",35.0,"g",35.0,0.316327],[27,"Batch","السلطة الحاتي","Grill Salad",60.0,"g",60.0,0.363106],[31,"Raw","خبز","Baladi Bread",1.0,"piece",0.0,0.3],[31,"Batch","الحواوشي","Hawawshi Mix",180.0,"g",180.0,3.810675],[31,"Raw","مخلل","Pickles",60.0,"g",60.0,0.39],[31,"Batch","الطحينة","Tahini Sauce",35.0,"g",35.0,0.316327],[31,"Raw","موزاريلا حيواني موندي","Mozzarella",30.0,"g",30.0,0.8475],[31,"Raw","بطاطس","Potatoes",100.0,"g",100.0,0.6],[32,"Raw","خبز","Baladi Bread",1.0,"piece",0.0,0.3],[32,"Batch","الحواوشي","Hawawshi Mix",180.0,"g",180.0,3.810675],[32,"Raw","مخلل","Pickles",60.0,"g",60.0,0.39],[32,"Batch","الطحينة","Tahini Sauce",35.0,"g",35.0,0.316327],[32,"Raw","جبنة كيري","Kiri Cheese",20.0,"g",20.0,0.36],[32,"Raw","بسطرمة","Pastrami",20.0,"g",20.0,1.4],[32,"Raw","بطاطس","Potatoes",100.0,"g",100.0,0.6],[33,"Raw","خبز","Baladi Bread",1.0,"piece",0.0,0.3],[33,"Batch","الحواوشي","Hawawshi Mix",180.0,"g",180.0,3.810675],[33,"Raw","مخلل","Pickles",60.0,"g",60.0,0.39],[33,"Batch","الطحينة","Tahini Sauce",35.0,"g",35.0,0.316327],[33,"Raw","بطاطس","Potatoes",100.0,"g",100.0,0.6],[34,"Raw","خبز","Baladi Bread",1.0,"piece",0.0,0.3],[34,"Batch","عجينة الطرب","Tarb",150.0,"g",150.0,3.251581],[34,"Raw","منديل طرب","Caul Fat (Mandeel Tarb)",0.0,"g",0.0,0.0],[34,"Batch","الطحينة","Tahini Sauce",35.0,"g",35.0,0.316327],[34,"Batch","السلطة الحاتي","Grill Salad",60.0,"g",60.0,0.363106],[34,"Batch","خضار فرشة","Fresh Herbs Mix",15.0,"g",15.0,0.099265],[35,"Raw","خبز","Baladi Bread",1.0,"piece",0.0,0.3],[35,"Batch","الكفتة","Kofta Mix",130.0,"g",130.0,3.577056],[35,"Batch","الطحينة","Tahini Sauce",35.0,"g",35.0,0.316327],[35,"Batch","السلطة الحاتي","Grill Salad",60.0,"g",60.0,0.363106],[35,"Batch","خضار فرشة","Fresh Herbs Mix",15.0,"g",15.0,0.099265],[37,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[37,"Raw","موزاريلا حيواني موندي","Mozzarella",200.0,"g",200.0,5.65],[37,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[37,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[37,"Raw","تونة","Tuna",140.0,"g",140.0,4.9],[37,"Raw","ذرة حلو","Sweet Corn",30.0,"g",30.0,0.3],[37,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[37,"Raw","زيتون شرائح","Sliced Olives",15.0,"g",15.0,0.255],[37,"Raw","بصل","Onion",15.0,"g",15.0,0.045],[38,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[38,"Raw","موزاريلا حيواني موندي","Mozzarella",200.0,"g",200.0,5.65],[38,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[38,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[38,"Raw","استربس","Chicken Strips",160.0,"g",160.0,4.24],[38,"Raw","فلفل هالبينو","Jalapeno",20.0,"g",20.0,0.2],[38,"Raw","صوص ديناميت","Dynamite Sauce",50.0,"g",50.0,0.76],[38,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[38,"Raw","زيتون شرائح","Sliced Olives",15.0,"g",15.0,0.255],[39,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[39,"Raw","موزاريلا حيواني موندي","Mozzarella",200.0,"g",200.0,5.65],[39,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[39,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[39,"Raw","استربس","Chicken Strips",160.0,"g",160.0,4.24],[39,"Raw","رومي مدخن","Smoked Turkey",30.0,"g",30.0,1.98],[39,"Raw","جبنة شيدر صوص","Cheddar Sauce",50.0,"g",50.0,0.85],[39,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[39,"Raw","زيتون شرائح","Sliced Olives",15.0,"g",15.0,0.255],[40,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[40,"Raw","موزاريلا حيواني موندي","Mozzarella",200.0,"g",200.0,5.65],[40,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[40,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[40,"Batch","الصدور","Marinated Chicken Breast",140.0,"g",140.0,2.496924],[40,"Raw","رومي مدخن","Smoked Turkey",30.0,"g",30.0,1.98],[40,"Raw","جبنة ريكفورد","Roquefort Cheese",20.0,"g",20.0,1.4],[40,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[40,"Raw","زيتون شرائح","Sliced Olives",15.0,"g",15.0,0.255],[41,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[41,"Raw","موزاريلا حيواني موندي","Mozzarella",220.0,"g",220.0,6.215],[41,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[41,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[41,"Raw","جبنة رومي","Roman Cheese",20.0,"g",20.0,1.0],[41,"Raw","جبنة ريكفورد","Roquefort Cheese",20.0,"g",20.0,1.4],[41,"Raw","جبنة شيدر صوص","Cheddar Sauce",30.0,"g",30.0,0.51],[41,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[41,"Raw","زيتون شرائح","Sliced Olives",15.0,"g",15.0,0.255],[42,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[42,"Raw","موزاريلا حيواني موندي","Mozzarella",200.0,"g",200.0,5.65],[42,"Raw","مشروم","Mushroom",20.0,"g",20.0,0.8],[42,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[42,"Batch","البرجر","Burger Patty Mix",160.0,"g",160.0,3.932917],[42,"Raw","لحم بقري","Beef",0.0,"g",0.0,0.0],[42,"Raw","صوص تكساس","Texas Sauce",50.0,"g",50.0,0.85],[42,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[42,"Raw","زيتون شرائح","Sliced Olives",15.0,"g",15.0,0.255],[43,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[43,"Raw","موزاريلا حيواني موندي","Mozzarella",200.0,"g",200.0,5.65],[43,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[43,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[43,"Raw","جمبري","Shrimp",80.0,"g",80.0,3.04],[43,"Raw","كالماري","Calamari",50.0,"g",50.0,4.3],[43,"Raw","كابوريا","Crab",35.0,"g",35.0,0.77],[43,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[43,"Raw","زيتون شرائح","Sliced Olives",15.0,"g",15.0,0.255],[43,"Raw","رانش","Ranch Sauce",50.0,"g",50.0,0.5],[44,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[44,"Raw","موزاريلا حيواني موندي","Mozzarella",200.0,"g",200.0,5.65],[44,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[44,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[44,"Raw","بيبروني","Pepperoni",80.0,"g",80.0,3.84],[44,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[44,"Raw","زيتون شرائح","Sliced Olives",15.0,"g",15.0,0.255],[45,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[45,"Raw","موزاريلا حيواني موندي","Mozzarella",200.0,"g",200.0,5.65],[45,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[45,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[45,"Raw","بيف بقري فورميد","Beef Formed",50.0,"g",50.0,1.415],[45,"Raw","سجق","Sausage",50.0,"g",50.0,1.75],[45,"Raw","بيبروني","Pepperoni",20.0,"g",20.0,0.96],[45,"Raw","زيتون شرائح","Sliced Olives",15.0,"g",15.0,0.255],[45,"Raw","بصل","Onion",15.0,"g",15.0,0.045],[46,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[46,"Raw","موزاريلا حيواني موندي","Mozzarella",200.0,"g",200.0,5.65],[46,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[46,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[46,"Batch","الصدور","Marinated Chicken Breast",140.0,"g",140.0,2.496924],[46,"Raw","هوت دوج","Hot Dog",40.0,"g",40.0,0.8],[46,"Raw","زيتون شرائح","Sliced Olives",15.0,"g",15.0,0.255],[46,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[46,"Raw","باربكيو","BBQ Sauce",50.0,"g",50.0,0.4],[47,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[47,"Raw","موزاريلا حيواني موندي","Mozzarella",200.0,"g",200.0,5.65],[47,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[47,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[47,"Batch","الصدور","Marinated Chicken Breast",140.0,"g",140.0,2.496924],[47,"Raw","مشروم","Mushroom",20.0,"g",20.0,0.8],[47,"Raw","بصل","Onion",20.0,"g",20.0,0.06],[47,"Raw","فلفل هالبينو","Jalapeno",15.0,"g",15.0,0.15],[47,"Raw","رانش","Ranch Sauce",50.0,"g",50.0,0.5],[48,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[48,"Raw","موزاريلا حيواني موندي","Mozzarella",200.0,"g",200.0,5.65],[48,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[48,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[48,"Raw","مشروم","Mushroom",20.0,"g",20.0,0.8],[48,"Raw","بصل","Onion",20.0,"g",20.0,0.06],[48,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[48,"Raw","زيتون شرائح","Sliced Olives",20.0,"g",20.0,0.34],[97,"Batch","عجينة البيتزا","Pizza Dough",280.0,"g",280.0,0.847214],[97,"Raw","موزاريلا حيواني موندي","Mozzarella",220.0,"g",220.0,6.215],[97,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[97,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[49,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[49,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[49,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[49,"Batch","صوص البيتزا","Pizza Sauce",30.0,"g",30.0,0.186695],[49,"Batch","الصدور","Marinated Chicken Breast",100.0,"g",100.0,1.783517],[49,"Raw","رومي مدخن","Smoked Turkey",30.0,"g",30.0,1.98],[49,"Raw","جبنة ريكفورد","Roquefort Cheese",10.0,"g",10.0,0.7],[49,"Raw","فلفل رومي","Bell Pepper",10.0,"g",10.0,0.06],[49,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[50,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[50,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[50,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[50,"Batch","صوص البيتزا","Pizza Sauce",30.0,"g",30.0,0.186695],[50,"Raw","جبنة رومي","Roman Cheese",15.0,"g",15.0,0.75],[50,"Raw","جبنة ريكفورد","Roquefort Cheese",10.0,"g",10.0,0.7],[50,"Raw","جبنة شيدر صوص","Cheddar Sauce",20.0,"g",20.0,0.34],[50,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[50,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[51,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[51,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[51,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[51,"Batch","صوص البيتزا","Pizza Sauce",30.0,"g",30.0,0.186695],[51,"Batch","البرجر","Burger Patty Mix",80.0,"g",80.0,1.966459],[51,"Raw","مشروم","Mushroom",10.0,"g",10.0,0.4],[51,"Raw","لحم بقري","Beef",0.0,"g",0.0,0.0],[51,"Raw","صوص تكساس","Texas Sauce",40.0,"g",40.0,0.68],[51,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[51,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[52,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[52,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[52,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[52,"Batch","صوص البيتزا","Pizza Sauce",30.0,"g",30.0,0.186695],[52,"Raw","جمبري","Shrimp",50.0,"g",50.0,1.9],[52,"Raw","كالماري","Calamari",50.0,"g",50.0,4.3],[52,"Raw","كابوريا","Crab",25.0,"g",25.0,0.55],[52,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[52,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[52,"Raw","رانش","Ranch Sauce",40.0,"g",40.0,0.4],[53,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[53,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[53,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[53,"Batch","صوص البيتزا","Pizza Sauce",30.0,"g",30.0,0.186695],[53,"Raw","بيبروني","Pepperoni",60.0,"g",60.0,2.88],[53,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[53,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[54,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[54,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[54,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[54,"Batch","صوص البيتزا","Pizza Sauce",30.0,"g",30.0,0.186695],[54,"Raw","بيف بقري فورميد","Beef Formed",40.0,"g",40.0,1.132],[54,"Raw","سجق","Sausage",40.0,"g",40.0,1.4],[54,"Raw","بيبروني","Pepperoni",15.0,"g",15.0,0.72],[54,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[54,"Raw","بصل","Onion",15.0,"g",15.0,0.045],[55,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[55,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[55,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[55,"Batch","صوص البيتزا","Pizza Sauce",30.0,"g",30.0,0.186695],[55,"Batch","الصدور","Marinated Chicken Breast",100.0,"g",100.0,1.783517],[55,"Raw","هوت دوج","Hot Dog",30.0,"g",30.0,0.6],[55,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[55,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[55,"Raw","باربكيو","BBQ Sauce",40.0,"g",40.0,0.32],[56,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[56,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[56,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[56,"Batch","صوص البيتزا","Pizza Sauce",30.0,"g",30.0,0.186695],[56,"Batch","الصدور","Marinated Chicken Breast",100.0,"g",100.0,1.783517],[56,"Raw","مشروم","Mushroom",15.0,"g",15.0,0.6],[56,"Raw","بصل","Onion",15.0,"g",15.0,0.045],[56,"Raw","فلفل هالبينو","Jalapeno",15.0,"g",15.0,0.15],[56,"Raw","رانش","Ranch Sauce",40.0,"g",40.0,0.4],[57,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[57,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[57,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[57,"Batch","صوص البيتزا","Pizza Sauce",30.0,"g",30.0,0.186695],[57,"Raw","مشروم","Mushroom",15.0,"g",15.0,0.6],[57,"Raw","بصل","Onion",15.0,"g",15.0,0.045],[57,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[57,"Raw","زيتون شرائح","Sliced Olives",15.0,"g",15.0,0.255],[58,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[58,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[58,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[58,"Batch","صوص البيتزا","Pizza Sauce",40.0,"g",40.0,0.248926],[59,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[59,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[59,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[59,"Batch","صوص البيتزا","Pizza Sauce",30.0,"g",30.0,0.186695],[59,"Raw","استربس","Chicken Strips",120.0,"g",120.0,3.18],[59,"Raw","فلفل هالبينو","Jalapeno",15.0,"g",15.0,0.15],[59,"Raw","صوص ديناميت","Dynamite Sauce",40.0,"g",40.0,0.608],[59,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[59,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[60,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[60,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[60,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[60,"Batch","صوص البيتزا","Pizza Sauce",30.0,"g",30.0,0.186695],[60,"Raw","استربس","Chicken Strips",120.0,"g",120.0,3.18],[60,"Raw","رومي مدخن","Smoked Turkey",30.0,"g",30.0,1.98],[60,"Raw","جبنة شيدر صوص","Cheddar Sauce",30.0,"g",30.0,0.51],[60,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[60,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[61,"Batch","عجينة البيتزا","Pizza Dough",250.0,"g",250.0,0.756441],[61,"Raw","موزاريلا حيواني موندي","Mozzarella",170.0,"g",170.0,4.8025],[61,"Raw","جبنة كيري","Kiri Cheese",0.0,"g",0.0,0.0],[61,"Batch","صوص البيتزا","Pizza Sauce",30.0,"g",30.0,0.186695],[61,"Raw","تونة","Tuna",80.0,"g",80.0,2.8],[61,"Raw","ذرة حلو","Sweet Corn",30.0,"g",30.0,0.3],[61,"Raw","فلفل رومي","Bell Pepper",15.0,"g",15.0,0.09],[61,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[61,"Raw","بصل","Onion",15.0,"g",15.0,0.045],[62,"Raw","جبنة شيدر صوص","Cheddar Sauce",100.0,"g",100.0,1.7],[62,"Batch","الوايت صوص","White Sauce",300.0,"g",300.0,1.843969],[62,"Raw","استربس","Chicken Strips",125.0,"g",125.0,3.3125],[62,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[62,"Raw","رومي مدخن","Smoked Turkey",20.0,"g",20.0,1.32],[62,"Raw","بصل","Onion",20.0,"g",20.0,0.06],[62,"Raw","موزاريلا حيواني موندي","Mozzarella",50.0,"g",50.0,1.4125],[62,"Raw","خبز توست","Toast Bread",2.0,"piece",0.0,1.0],[62,"Raw","بطاطس","Potatoes",0.0,"g",0.0,0.0],[62,"Raw","باربكيو","BBQ Sauce",40.0,"g",40.0,0.32],[64,"Raw","جبنة شيدر صوص","Cheddar Sauce",100.0,"g",100.0,1.7],[64,"Batch","الوايت صوص","White Sauce",300.0,"g",300.0,1.843969],[64,"Raw","بسطرمة","Pastrami",50.0,"g",50.0,3.5],[64,"Raw","سجق","Sausage",50.0,"g",50.0,1.75],[64,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[64,"Raw","بصل","Onion",20.0,"g",20.0,0.06],[64,"Raw","موزاريلا حيواني موندي","Mozzarella",50.0,"g",50.0,1.4125],[64,"Raw","خبز توست","Toast Bread",2.0,"piece",0.0,1.0],[64,"Raw","بطاطس","Potatoes",0.0,"g",0.0,0.0],[64,"Raw","باربكيو","BBQ Sauce",40.0,"g",40.0,0.32],[66,"Raw","جبنة شيدر صوص","Cheddar Sauce",100.0,"g",100.0,1.7],[66,"Batch","الوايت صوص","White Sauce",300.0,"g",300.0,1.843969],[66,"Raw","هوت دوج","Hot Dog",90.0,"g",90.0,1.8],[66,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[66,"Raw","بصل","Onion",20.0,"g",20.0,0.06],[66,"Raw","موزاريلا حيواني موندي","Mozzarella",50.0,"g",50.0,1.4125],[66,"Raw","خبز توست","Toast Bread",2.0,"piece",0.0,1.0],[66,"Raw","بطاطس","Potatoes",0.0,"g",0.0,0.0],[66,"Raw","باربكيو","BBQ Sauce",40.0,"g",40.0,0.32],[69,"Raw","جبنة شيدر صوص","Cheddar Sauce",100.0,"g",100.0,1.7],[69,"Batch","الوايت صوص","White Sauce",300.0,"g",300.0,1.843969],[69,"Batch","الصدور","Marinated Chicken Breast",140.0,"g",140.0,2.496924],[69,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[69,"Raw","بصل","Onion",20.0,"g",20.0,0.06],[69,"Raw","موزاريلا حيواني موندي","Mozzarella",50.0,"g",50.0,1.4125],[69,"Raw","خبز توست","Toast Bread",2.0,"piece",0.0,1.0],[69,"Raw","بطاطس","Potatoes",0.0,"g",0.0,0.0],[69,"Raw","باربكيو","BBQ Sauce",40.0,"g",40.0,0.32],[72,"Raw","مكرونة شريط","Ribbon Pasta",100.0,"g",100.0,1.2],[72,"Batch","الوايت صوص","White Sauce",250.0,"g",250.0,1.536641],[72,"Raw","ثوم","Garlic",1.0,"g",1.0,0.024],[72,"Raw","مشروم","Mushroom",5.0,"g",5.0,0.2],[72,"Raw","لحم وش فخدة","Beef Topside",100.0,"g",100.0,3.5],[72,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[72,"Raw","جبنة بارميزان","Parmesan Cheese",20.0,"g",20.0,1.3],[73,"Raw","مكرونة شريط","Ribbon Pasta",100.0,"g",100.0,1.2],[73,"Batch","الوايت صوص","White Sauce",250.0,"g",250.0,1.536641],[73,"Raw","ثوم","Garlic",1.0,"g",1.0,0.024],[73,"Raw","مشروم","Mushroom",5.0,"g",5.0,0.2],[73,"Batch","الصدور","Marinated Chicken Breast",85.0,"g",85.0,1.51599],[73,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[73,"Raw","جبنة بارميزان","Parmesan Cheese",20.0,"g",20.0,1.3],[74,"Raw","مكرونة أقلام قودي","Penne Pasta",100.0,"g",100.0,1.2],[74,"Batch","الوايت صوص","White Sauce",250.0,"g",250.0,1.536641],[74,"Raw","جمبري","Shrimp",50.0,"g",50.0,1.9],[74,"Raw","كالماري","Calamari",25.0,"g",25.0,2.15],[74,"Raw","كابوريا","Crab",25.0,"g",25.0,0.55],[74,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[74,"Raw","مشروم","Mushroom",5.0,"g",5.0,0.2],[74,"Raw","جبنة كيري","Kiri Cheese",15.0,"g",15.0,0.27],[74,"Raw","موزاريلا حيواني موندي","Mozzarella",80.0,"g",80.0,2.26],[74,"Raw","ثوم","Garlic",1.0,"g",1.0,0.024],[75,"Raw","مكرونة أقلام قودي","Penne Pasta",100.0,"g",100.0,1.2],[75,"Batch","الوايت صوص","White Sauce",200.0,"g",200.0,1.229313],[75,"Raw","ديمي جلاس بودر","Demi Glace Powder",10.0,"g",10.0,0.867],[75,"Raw","جبنة رومي","Roman Cheese",10.0,"g",10.0,0.5],[75,"Raw","بصل","Onion",10.0,"g",10.0,0.03],[75,"Raw","مشروم","Mushroom",5.0,"g",5.0,0.2],[75,"Raw","موزاريلا حيواني موندي","Mozzarella",80.0,"g",80.0,2.26],[75,"Raw","لحم وش فخدة","Beef Topside",100.0,"g",100.0,3.5],[76,"Raw","مكرونة أقلام قودي","Penne Pasta",100.0,"g",100.0,1.2],[76,"Batch","الوايت صوص","White Sauce",250.0,"g",250.0,1.536641],[76,"Batch","الصدور","Marinated Chicken Breast",85.0,"g",85.0,1.51599],[76,"Raw","لحم بقري","Beef",20.0,"g",20.0,1.06],[76,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[76,"Raw","جبنة كيري","Kiri Cheese",15.0,"g",15.0,0.27],[76,"Raw","مشروم","Mushroom",5.0,"g",5.0,0.2],[76,"Raw","موزاريلا حيواني موندي","Mozzarella",80.0,"g",80.0,2.26],[76,"Raw","ثوم","Garlic",1.0,"g",1.0,0.024],[77,"Raw","مكرونة أقلام قودي","Penne Pasta",100.0,"g",100.0,1.2],[77,"Batch","الوايت صوص","White Sauce",250.0,"g",250.0,1.536641],[77,"Batch","الصدور","Marinated Chicken Breast",85.0,"g",85.0,1.51599],[77,"Raw","بصل","Onion",10.0,"g",10.0,0.03],[77,"Raw","فلفل احمر رومي","Red Bell Pepper",10.0,"g",10.0,0.12],[77,"Raw","مشروم","Mushroom",5.0,"g",5.0,0.2],[77,"Raw","موزاريلا حيواني موندي","Mozzarella",80.0,"g",80.0,2.26],[78,"Raw","مكرونة أقلام قودي","Penne Pasta",100.0,"g",100.0,1.2],[78,"Batch","الوايت صوص","White Sauce",200.0,"g",200.0,1.229313],[78,"Batch","اللحمة المفرومة","Minced Meat Mix",80.0,"g",80.0,1.931334],[78,"Raw","موزاريلا حيواني موندي","Mozzarella",80.0,"g",80.0,2.26],[79,"Raw","مكرونة فوسيلي","Fusilli Pasta",100.0,"g",100.0,1.2],[79,"Batch","الوايت صوص","White Sauce",250.0,"g",250.0,1.536641],[79,"Raw","جبنة شيدر صوص","Cheddar Sauce",70.0,"g",70.0,1.19],[79,"Batch","الصدور","Marinated Chicken Breast",85.0,"g",85.0,1.51599],[79,"Raw","لحم بقري","Beef",20.0,"g",20.0,1.06],[79,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[79,"Raw","موزاريلا حيواني موندي","Mozzarella",80.0,"g",80.0,2.26],[80,"Raw","مكرونة شريط","Ribbon Pasta",100.0,"g",100.0,1.2],[80,"Batch","الوايت صوص","White Sauce",250.0,"g",250.0,1.536641],[80,"Raw","جمبري","Shrimp",25.0,"g",25.0,0.95],[80,"Raw","كالماري","Calamari",20.0,"g",20.0,1.72],[80,"Raw","كابوريا","Crab",25.0,"g",25.0,0.55],[80,"Raw","ثوم","Garlic",1.0,"g",1.0,0.024],[80,"Raw","مشروم","Mushroom",5.0,"g",5.0,0.2],[80,"Raw","زيتون شرائح","Sliced Olives",10.0,"g",10.0,0.17],[80,"Raw","جبنة بارميزان","Parmesan Cheese",20.0,"g",20.0,1.3],[81,"Raw","خبز برجر","Burger Bun",1.0,"piece",0.0,1.3],[81,"Raw","فيليه زنجر","Zinger Fillet",1.0,"piece",150.0,4.2],[81,"Raw","كابوتشا","Iceberg Lettuce",15.0,"g",15.0,0.09],[81,"Raw","اصابع موزاريلا","Fried Mozzarella Stick",2.0,"piece",70.0,3.85],[81,"Raw","رومي مدخن","Smoked Turkey",25.0,"g",25.0,1.65],[81,"Raw","صوص ديناميت","Dynamite Sauce",0.0,"g",0.0,0.0],[81,"Raw","جبنة شيدر صوص","Cheddar Sauce",20.0,"g",20.0,0.34],[81,"Raw","مخلل","Pickles",10.0,"g",10.0,0.065],[81,"Raw","ثاوزند آيلاند","Thousand Island Sauce",20.0,"g",20.0,0.3],[82,"Raw","خبز برجر","Burger Bun",1.0,"piece",0.0,1.3],[82,"Raw","فيليه زنجر","Zinger Fillet",1.0,"piece",150.0,4.2],[82,"Raw","كابوتشا","Iceberg Lettuce",15.0,"g",15.0,0.09],[82,"Raw","حلقات بصل","Onion Rings",2.0,"piece",40.0,1.2],[82,"Raw","باربكيو","BBQ Sauce",15.0,"g",15.0,0.12],[82,"Raw","جبنة شيدر صوص","Cheddar Sauce",20.0,"g",20.0,0.34],[82,"Raw","مخلل","Pickles",10.0,"g",10.0,0.065],[82,"Raw","ثاوزند آيلاند","Thousand Island Sauce",20.0,"g",20.0,0.3],[82,"Raw","مشروم","Mushroom",15.0,"g",15.0,0.6],[83,"Raw","خبز برجر","Burger Bun",1.0,"piece",0.0,1.3],[83,"Batch","الصدور","Marinated Chicken Breast",160.0,"g",160.0,2.853627],[83,"Raw","كابوتشا","Iceberg Lettuce",15.0,"g",15.0,0.09],[83,"Raw","جبنة شيدر صوص","Cheddar Sauce",20.0,"g",20.0,0.34],[83,"Raw","مخلل","Pickles",10.0,"g",10.0,0.065],[83,"Raw","بصل","Onion",10.0,"g",10.0,0.03],[83,"Raw","ثاوزند آيلاند","Thousand Island Sauce",20.0,"g",20.0,0.3],[84,"Raw","خبز برجر","Burger Bun",1.0,"piece",0.0,1.3],[84,"Raw","فيليه زنجر","Zinger Fillet",1.0,"piece",150.0,4.2],[84,"Raw","كابوتشا","Iceberg Lettuce",15.0,"g",15.0,0.09],[84,"Raw","جبنة شيدر صوص","Cheddar Sauce",30.0,"g",30.0,0.51],[84,"Raw","طماطم","Tomato",10.0,"g",10.0,0.05],[84,"Raw","جبنة كيري","Kiri Cheese",20.0,"g",20.0,0.36],[84,"Raw","مشروم","Mushroom",10.0,"g",10.0,0.4],[84,"Raw","رانش","Ranch Sauce",20.0,"g",20.0,0.2],[84,"Raw","مخلل","Pickles",10.0,"g",10.0,0.065],[84,"Raw","ثاوزند آيلاند","Thousand Island Sauce",20.0,"g",20.0,0.3],[85,"Raw","خبز برجر","Burger Bun",1.0,"piece",0.0,1.3],[85,"Batch","البرجر","Burger Patty Mix",160.0,"g",160.0,3.932917],[85,"Raw","كابوتشا","Iceberg Lettuce",15.0,"g",15.0,0.09],[85,"Raw","اصابع موزاريلا","Fried Mozzarella Stick",2.0,"piece",70.0,3.85],[85,"Raw","حلقات بصل","Onion Rings",0.0,"piece",0.0,0.0],[85,"Raw","لحم بقري","Beef",25.0,"g",25.0,1.325],[85,"Raw","جبنة شيدر صوص","Cheddar Sauce",30.0,"g",30.0,0.51],[85,"Raw","طماطم","Tomato",10.0,"g",10.0,0.05],[85,"Raw","مخلل","Pickles",10.0,"g",10.0,0.065],[85,"Raw","ثاوزند آيلاند","Thousand Island Sauce",20.0,"g",20.0,0.3],[86,"Raw","خبز برجر","Burger Bun",1.0,"piece",0.0,1.3],[86,"Batch","البرجر","Burger Patty Mix",160.0,"g",160.0,3.932917],[86,"Raw","كابوتشا","Iceberg Lettuce",15.0,"g",15.0,0.09],[86,"Raw","بصل","Onion",30.0,"g",30.0,0.09],[86,"Raw","مشروم","Mushroom",10.0,"g",10.0,0.4],[86,"Raw","مخلل","Pickles",10.0,"g",10.0,0.065],[86,"Raw","جبنة شيدر صوص","Cheddar Sauce",20.0,"g",20.0,0.34],[86,"Raw","ثاوزند آيلاند","Thousand Island Sauce",20.0,"g",20.0,0.3],[86,"Raw","باربكيو","BBQ Sauce",15.0,"g",15.0,0.12],[87,"Raw","خبز برجر","Burger Bun",1.0,"piece",0.0,1.3],[87,"Batch","البرجر","Burger Patty Mix",160.0,"g",160.0,3.932917],[87,"Raw","كابوتشا","Iceberg Lettuce",15.0,"g",15.0,0.09],[87,"Raw","بيف بيكون","Beef Bacon",30.0,"g",30.0,2.7],[87,"Raw","مشروم","Mushroom",10.0,"g",10.0,0.4],[87,"Raw","بصل","Onion",10.0,"g",10.0,0.03],[87,"Raw","جبنة شيدر صوص","Cheddar Sauce",20.0,"g",20.0,0.34],[87,"Raw","طماطم","Tomato",10.0,"g",10.0,0.05],[87,"Raw","ثاوزند آيلاند","Thousand Island Sauce",20.0,"g",20.0,0.3],[88,"Raw","خبز برجر","Burger Bun",1.0,"piece",0.0,1.3],[88,"Batch","البرجر","Burger Patty Mix",160.0,"g",160.0,3.932917],[88,"Raw","كابوتشا","Iceberg Lettuce",15.0,"g",15.0,0.09],[88,"Raw","مخلل","Pickles",10.0,"g",10.0,0.065],[88,"Raw","طماطم","Tomato",10.0,"g",10.0,0.05],[88,"Raw","بصل","Onion",10.0,"g",10.0,0.03],[88,"Raw","جبنة شيدر صوص","Cheddar Sauce",20.0,"g",20.0,0.34],[88,"Raw","ثاوزند آيلاند","Thousand Island Sauce",20.0,"g",20.0,0.3],[89,"Batch","الكلوسلو","Coleslaw",200.0,"g",200.0,1.594015],[90,"Raw","بوب كوردن","Bob Cordon",4.0,"piece",92.0,2.3276],[90,"Raw","باربكيو","BBQ Sauce",40.0,"g",40.0,0.32],[91,"Raw","اصابع موزاريلا","Fried Mozzarella Stick",2.0,"piece",70.0,3.85],[91,"Raw","ثاوزند آيلاند","Thousand Island Sauce",40.0,"g",40.0,0.6],[92,"Raw","حلقات بصل","Onion Rings",4.0,"piece",80.0,2.4],[92,"Raw","باربكيو","BBQ Sauce",40.0,"g",40.0,0.32],[93,"Raw","بطاطس","Potatoes",250.0,"g",250.0,1.5],[93,"Batch","اللحمة المفرومة","Minced Meat Mix",30.0,"g",30.0,0.72425],[93,"Raw","فلفل هالبينو","Jalapeno",10.0,"g",10.0,0.1],[93,"Raw","سويت شيلي","Sweet Chili Sauce",40.0,"g",40.0,0.608],[93,"Raw","جبنة شيدر صوص","Cheddar Sauce",60.0,"g",60.0,1.02],[94,"Raw","بطاطس","Potatoes",250.0,"g",250.0,1.5],[94,"Raw","استربس","Chicken Strips",50.0,"g",50.0,1.325],[94,"Raw","لحم بقري","Beef",20.0,"g",20.0,1.06],[94,"Raw","جبنة شيدر صوص","Cheddar Sauce",60.0,"g",60.0,1.02],[95,"Raw","بطاطس","Potatoes",250.0,"g",250.0,1.5],[95,"Raw","جبنة شيدر صوص","Cheddar Sauce",60.0,"g",60.0,1.02],[96,"Raw","بطاطس","Potatoes",250.0,"g",250.0,1.5],[68,"Raw","جبنة شيدر صوص","Cheddar Sauce",100.0,"g",100.0,1.7],[68,"Batch","الوايت صوص","White Sauce",300.0,"g",300.0,1.843969],[68,"Batch","البرجر","Burger Patty Mix",160.0,"g",160.0,3.932917],[68,"Raw","فلفل رومي","Bell Pepper",20.0,"g",20.0,0.12],[68,"Raw","بصل","Onion",20.0,"g",20.0,0.06],[68,"Raw","خبز توست","Toast Bread",2.0,"piece",0.0,1.0],[68,"Raw","باربكيو","BBQ Sauce",40.0,"g",40.0,0.32],[98,"Raw","استربس","Chicken Strips",50.0,"g",50.0,1.325]];
const WB_MEN = [[1,"CRE-001","كريب ميكس لحوم","Mixed Meat Crepe","كريبات","Crepes",7.560447,30.0,30.0,43.0],[2,"CRE-002","كريب ميكس فراخ","Mixed Chicken Crepe","كريبات","Crepes",8.240381,29.0,29.0,42.0],[5,"CRE-005","كريب هوت دوج","Hot Dog Crepe","كريبات","Crepes",5.881919,23.0,23.0,34.0],[6,"CRE-006","كريب تشيز برجر","Cheese Burger Crepe","كريبات","Crepes",7.938065,29.0,29.0,null],[8,"CRE-008","كريب شيش طاووك","Shish Tawook Crepe","كريبات","Crepes",7.566075,28.0,28.0,35.0],[9,"CRE-009","كريب فاهيتا دجاج","Chicken Fajita Crepe","كريبات","Crepes",5.357195,24.0,24.0,35.0],[10,"CRE-010","كريب زنجر سوبريم","Zinger Supreme Crepe","كريبات","Crepes",7.996919,28.0,28.0,35.0],[11,"CRE-011","كريب سوبر كرانشي","Super Crunchy Crepe","كريبات","Crepes",8.976919,29.0,29.0,42.0],[16,"CRE-016","كريب ميكس جبن","Mixed Cheese Crepe","كريبات","Crepes",5.396919,21.0,21.0,30.0],[17,"CRE-017","كريب بطاطس","Potato Crepe","كريبات","Crepes",4.236919,15.0,15.0,22.0],[20,"MEA-020","وجبه الشيش طاووك","Shish Tawook Meal","وجبات","Meals",7.624299,27.0,27.0,40.0],[21,"MEA-021","وجبه النص فرخه","Half Charcoal Chicken Meal","وجبات","Meals",10.820612,25.0,25.0,35.0],[22,"MEA-022","وجبه دجاجة فحم","Whole Charcoal Chicken Meal","وجبات","Meals",21.402953,48.0,48.0,65.0],[23,"MEA-023","وجبه الصدور المشويه","Grilled Chicken Breast Meal","وجبات","Meals",5.475267,25.0,25.0,37.0],[25,"MEA-025","وجبه الطرب","Tarb Meal","وجبات","Meals",6.785605,27.0,27.0,38.0],[26,"MEA-026","وجبه الكفته","Kofta Meal","وجبات","Meals",6.035605,24.0,24.0,35.0],[27,"MEA-027","وجبة ميكس جريل","Mix Grill Meal","وجبات","Meals",10.243672,37.0,37.0,50.0],[31,"SND-031","حواوشي موتزريلا","Mozzarella Hawawshi","سندوتشات","Sandwiches",6.264502,23.0,23.0,32.0],[32,"SND-032","حواوشي كيري بسطرمه","Kiri Pastrami Hawawshi","سندوتشات","Sandwiches",7.177002,28.0,28.0,40.0],[33,"SND-033","حواوشي سادة","Plain Hawawshi","سندوتشات","Sandwiches",5.417002,20.0,20.0,28.0],[34,"SND-034","ساندوتش الطرب","Tarb Sandwich","سندوتشات","Sandwiches",4.330279,18.0,18.0,null],[35,"SND-035","ساندوتش الكفته","Kofta Sandwich","سندوتشات","Sandwiches",4.655753,17.0,17.0,null],[37,"PIZ-037","بيتزا تونه (L)","Tuna Pizza (Large)","بيتزا","Pizza",12.36614,41.0,41.0,44.0],[38,"PIZ-038","بيتزا تشيكن ديناميت(L)","Chicken Dynamite Pizza (Large)","بيتزا","Pizza",12.32114,43.0,43.0,44.0],[39,"PIZ-039","بيتزا سوبر كرانشي(L)","Super Crunchy Pizza (Large)","بيتزا","Pizza",14.19114,47.0,47.0,50.0],[40,"PIZ-040","بيتزا تشيكن الباتشينو(L)","Chicken Patcino Pizza (Large)","بيتزا","Pizza",12.998064,44.0,44.0,44.0],[41,"PIZ-041","بيتزا كواترو تشيز(L)","Quattro Cheese Pizza (Large)","بيتزا","Pizza",10.59614,37.0,37.0,36.0],[42,"PIZ-042","بيتزا تشيز برجر(L)","Cheese Burger Pizza (Large)","بيتزا","Pizza",12.704058,45.0,45.0,44.0],[43,"PIZ-043","بيتزا سي فود رانش(L)","Seafood Ranch Pizza (Large)","بيتزا","Pizza",15.73114,52.0,52.0,55.0],[44,"PIZ-044","بيتزا بيبروني(L)","Pepperoni Pizza (Large)","بيتزا","Pizza",10.96114,38.0,38.0,42.0],[45,"PIZ-045","بيتزا سوبر سوبريم (L)","Super Supreme Pizza (Large)","بيتزا","Pizza",11.17114,38.0,38.0,44.0],[46,"PIZ-046","بيتزا تشيكن باربكيو(L)","Chicken BBQ Pizza (Large)","بيتزا","Pizza",10.818064,38.0,38.0,41.0],[47,"PIZ-047","بيتزا تشيكن رانش(L)","Chicken Ranch Pizza (Large)","بيتزا","Pizza",10.753064,38.0,38.0,41.0],[48,"PIZ-048","بيتزا خضروات(L)","Vegetable Pizza (Large)","بيتزا","Pizza",8.06614,31.0,31.0,32.0],[49,"PIZ-049","بيتزا تشيكن الباتشينو(M)","Chicken Patcino Pizza (Medium)","بيتزا","Pizza",10.439153,35.0,35.0,null],[50,"PIZ-050","بيتزا كواترو تشيز(M)","Quattro Cheese Pizza (Medium)","بيتزا","Pizza",7.795636,27.0,27.0,null],[51,"PIZ-051","بيتزا برجر(M)","Burger Pizza (Medium)","بيتزا","Pizza",9.052094,33.0,33.0,null],[52,"PIZ-052","بيتزا سي فود رانش(M)","Seafood Ranch Pizza (Medium)","بيتزا","Pizza",13.155636,44.0,44.0,null],[53,"PIZ-053","بيتزا بيبروني(M)","Pepperoni Pizza (Medium)","بيتزا","Pizza",8.885636,31.0,31.0,null],[54,"PIZ-054","بيتزا سوبر سوبريم (M)","Super Supreme Pizza (Medium)","بيتزا","Pizza",9.212636,34.0,34.0,null],[55,"PIZ-055","بيتزا تشيكن باربكيو(M)","Chicken BBQ Pizza (Medium)","بيتزا","Pizza",8.709153,32.0,32.0,null],[56,"PIZ-056","بيتزا تشيكن رانش(M)","Chicken Ranch Pizza (Medium)","بيتزا","Pizza",8.724153,32.0,32.0,null],[57,"PIZ-057","بيتزا خضروات(M)","Vegetable Pizza (Medium)","بيتزا","Pizza",6.735636,26.0,26.0,null],[58,"PIZ-058","بيتزا مارجريتا (M)","Margherita Pizza (Medium)","بيتزا","Pizza",5.807867,22.0,22.0,null],[59,"PIZ-059","بيتزا تشيكن ديناميت(M)","Chicken Dynamite Pizza (Medium)","بيتزا","Pizza",9.943636,34.0,34.0,null],[60,"PIZ-060","بيتزا سوبر كرانشي(M)","Super Crunchy Pizza (Medium)","بيتزا","Pizza",11.675636,38.0,38.0,null],[61,"PIZ-061","بيتزا تونه (M)","Tuna Pizza (Medium)","بيتزا","Pizza",9.150636,32.0,32.0,null],[97,"PIZ-097","بيتزا مارجريتا (L)","Margherita Pizza (Large)","بيتزا","Pizza",7.31114,28.0,28.0,30.0],[62,"SKL-062","طاسه كرانشي","Crunchy Skillet","طاسات","Skillets",11.088969,38.0,38.0,55.0],[64,"SKL-064","طاسه الاكيله","Akeela Skillet","طاسات","Skillets",11.706469,41.0,41.0,65.0],[66,"SKL-066","طاسه هوت دوج","Hot Dog Skillet","طاسات","Skillets",8.256469,29.0,29.0,47.0],[68,"SKL-068","طاسه برجر","Burger Skillet","طاسات","Skillets",8.976886,32.0,32.0,47.0],[69,"SKL-069","طاسه صدور مشويه","Grilled Chicken Breast Skillet","طاسات","Skillets",8.953393,32.0,32.0,47.0],[72,"PST-072","بيف الفريدو","Beef Alfredo","باستا","Pasta",7.930641,28.0,28.0,40.0],[73,"PST-073","فتتوتشيني الفريدو","Chicken Fettuccine Alfredo","باستا","Pasta",5.94663,25.0,25.0,35.0],[74,"PST-074","سي فود كازرول","Seafood Casserole Pasta","باستا","Pasta",10.260641,37.0,37.0,52.0],[75,"PST-075","بنا بيف كازرول","Penne Beef Casserole","باستا","Pasta",9.786313,35.0,35.0,52.0],[76,"PST-076","بنا تشيكن كازرول","Penne Chicken Casserole","باستا","Pasta",8.23663,28.0,28.0,41.0],[77,"PST-077","نجرسكو","Negresco","باستا","Pasta",6.86263,25.0,25.0,35.0],[78,"PST-078","باستا بشاميل","Pasta Béchamel","باستا","Pasta",6.620647,25.0,25.0,35.0],[79,"PST-079","ماك اند تشيز","Mac and Cheese","باستا","Pasta",8.93263,33.0,33.0,45.0],[80,"PST-080","سي فود الفريدو","Seafood Alfredo","باستا","Pasta",7.650641,30.0,30.0,45.0],[81,"BRG-081","فرايد سموكد تشيكن","Fried Smoked Chicken Burger","برجر","Burgers",11.795,42.0,42.0,null],[82,"BRG-082","فاير بيرد تشيكن","Fire Bird Chicken Burger","برجر","Burgers",8.215,29.0,29.0,null],[83,"BRG-083","جريلد تشيكن ساندوتش","Grilled Chicken Sandwich Burger","برجر","Burgers",4.978627,20.0,20.0,30.0],[84,"BRG-084","كريمي مشروم تشيكن","Creamy Mushroom Chicken Burger","برجر","Burgers",7.475,28.0,28.0,40.0],[85,"BRG-085","ستيكي تشيز برجر","Sticky Cheese Burger","برجر","Burgers",11.422917,40.0,40.0,null],[86,"BRG-086","كرامليز برجر","Caramelized Burger","برجر","Burgers",6.637917,25.0,25.0,null],[87,"BRG-087","مشروم بيكون برجر","Mushroom Bacon Burger","برجر","Burgers",9.142917,34.0,34.0,40.0],[88,"BRG-088","برجر لحم كلاسيك","Classic Beef Burger","برجر","Burgers",6.107917,22.0,22.0,30.0],[89,"APP-089","كلوسلو","Coleslaw","مقبلات","Appetizers",1.594015,6.0,6.0,10.0],[90,"APP-090","بوب كوردن","Bob Cordon","مقبلات","Appetizers",2.6476,10.0,10.0,null],[91,"APP-091","فرايد موتزريلا","Fried Mozzarella","مقبلات","Appetizers",4.45,16.0,16.0,22.0],[92,"APP-092","حلقات بصل","Onion Rings","مقبلات","Appetizers",2.72,10.0,10.0,15.0],[93,"APP-093","تشيلي تشيز فرايز","Chili Cheese Fries","مقبلات","Appetizers",3.95225,15.0,15.0,24.0],[94,"APP-094","كرانشي فرايز تشيز","Crunchy Cheese Fries","مقبلات","Appetizers",4.905,19.0,19.0,30.0],[95,"APP-095","تشيز فرايز","Cheese Fries","مقبلات","Appetizers",2.52,10.0,10.0,14.0],[96,"APP-096","بطاطس محمرة","French Fries","مقبلات","Appetizers",1.5,6.0,6.0,10.0]];
const WB_MODS = [["اضافة صوص باربيكيو","Add BBQ Sauce","باربكيو",40.0,"g",0.32,1.67],["اضافة صوص شيدر","Add Cheddar Sauce","جبنة شيدر صوص",50.0,"g",0.85,4.44],["اضافة صوص تيكساس","Add Texas Sauce","صوص تكساس",40.0,"g",0.68,3.55],["اضافة موزاريلا","Add Mozzarella","موزاريلا حيواني موندي",40.0,"g",1.13,5.91],["اضافة سويت شيلي","Add Sweet Chili","سويت شيلي",40.0,"g",0.608,3.18],["اضافة رانش","Add Ranch","رانش",40.0,"g",0.4,2.09],["اضافة ديناميت صوص","Add Dynamite Sauce","صوص ديناميت",40.0,"g",0.608,3.18],["تحويل لكومبو","Combo Upgrade","",0.0,null,null,null],["حشو اطراف كيري وسط",null,"جبنة كيري",70.0,"g",1.26,6.59],["حشو اطراف موزاريلا وسط",null,"موزاريلا حيواني موندي",80.0,"g",2.26,11.81],["حشو اطراف كيري كبير",null,"جبنة كيري",90.0,"g",1.62,8.47],["حشو اطراف موزاريلا كبير",null,"موزاريلا حيواني موندي",100.0,"g",2.825,14.77],["إضافة فلفل هالبينو",null,"فلفل هالبينو",40.0,"g",0.4,2.09]];

/* ═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx) {
  const { pool, requireAdmin, todayISO, daysAgoISO } = ctx;

  /* The workbench's own login. Mounted from here, not from index.js: the
     workbench and the accounts that may write to it are one feature, and
     wiring them separately would let one ship without the other. */
  const auth = registerCostingAuth(app, ctx);
  const { requireCostingUser, requireCostingOwner, visibilityFor, audit } = auth;
  const isResponse = (x) => typeof Response !== "undefined" && x instanceof Response;

  /* ── Schema. Same shape as finance.js: fired once at registration, a failure
     logs instead of taking the API down. Seeding is idempotent AND
     non-destructive — see business rule 7. ─────────────────────────────────*/
  async function ensureCostingSchema() {
    await pool.query(`
      -- Purchase-level truth. \`cost_per_g\` is SAR per gram/ml, VAT-exclusive;
      -- \`cost_per_piece\` is set instead for items bought by the unit (bread,
      -- eggs, whole chickens). Exactly one of the two is meaningful per row —
      -- never multiply a per-piece cost by a gram quantity.
      CREATE TABLE IF NOT EXISTS cost_raw_materials (
        canonical_ar   TEXT PRIMARY KEY,
        name_en        TEXT NOT NULL DEFAULT '',
        purchase_unit  TEXT NOT NULL DEFAULT '',
        cost_per_unit  NUMERIC,
        cost_per_g     NUMERIC,
        cost_per_piece NUMERIC,
        status         TEXT NOT NULL DEFAULT 'OK',
        note           TEXT NOT NULL DEFAULT '',
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- Arabic spelling variants the kitchen actually writes -> canonical name.
      CREATE TABLE IF NOT EXISTS cost_aliases (
        alias_ar     TEXT PRIMARY KEY,
        canonical_ar TEXT NOT NULL
      );
      -- Production batches (kofta mix, tahini, doughs). \`cost_per_g\` is the
      -- batch total divided by its OUTPUT weight, so cooking yield loss lives
      -- here and nowhere else. output_g >= sum of inputs means no loss was
      -- assumed, which /health flags.
      CREATE TABLE IF NOT EXISTS cost_batches (
        batch_ar   TEXT PRIMARY KEY,
        batch_en   TEXT NOT NULL DEFAULT '',
        output_g   NUMERIC,
        total_cost NUMERIC,
        cost_per_g NUMERIC,
        note       TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cost_batch_lines (
        id        TEXT PRIMARY KEY,
        batch_ar  TEXT NOT NULL,
        ing_type  TEXT NOT NULL DEFAULT 'Raw',
        ing_ar    TEXT NOT NULL,
        ing_en    TEXT NOT NULL DEFAULT '',
        qty       NUMERIC, unit TEXT NOT NULL DEFAULT 'g',
        qty_g     NUMERIC, line_cost NUMERIC
      );
      CREATE INDEX IF NOT EXISTS cost_batch_lines_batch_idx ON cost_batch_lines(batch_ar);
      -- The 78 costed menu items. price_restaurant / price_platform are the
      -- TWO-TIER prices, which only the older workbook carries; the same dish
      -- earns a different margin per channel and that gap is the point.
      CREATE TABLE IF NOT EXISTS cost_menu_items (
        product_id       INT PRIMARY KEY,
        sku              TEXT NOT NULL DEFAULT '',
        product_ar       TEXT NOT NULL DEFAULT '',
        product_en       TEXT NOT NULL DEFAULT '',
        category_ar      TEXT NOT NULL DEFAULT '',
        category_en      TEXT NOT NULL DEFAULT '',
        total_cost       NUMERIC,
        price_suggested  NUMERIC,
        price_restaurant NUMERIC,
        price_platform   NUMERIC,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cost_recipe_lines (
        id         TEXT PRIMARY KEY,
        product_id INT NOT NULL,
        ing_type   TEXT NOT NULL DEFAULT 'Raw',
        ing_ar     TEXT NOT NULL,
        ing_en     TEXT NOT NULL DEFAULT '',
        qty        NUMERIC, unit TEXT NOT NULL DEFAULT 'g',
        qty_g      NUMERIC, line_cost NUMERIC
      );
      CREATE INDEX IF NOT EXISTS cost_recipe_lines_pid_idx ON cost_recipe_lines(product_id);
      -- Priced add-ons. These are costed as THEMSELVES, never as their parent
      -- dish — see business rule 3.
      CREATE TABLE IF NOT EXISTS cost_modifiers (
        modifier_ar TEXT PRIMARY KEY,
        modifier_en TEXT NOT NULL DEFAULT '',
        ing_ar      TEXT NOT NULL DEFAULT '',
        qty         NUMERIC, unit TEXT NOT NULL DEFAULT 'g',
        cost        NUMERIC, price_incl NUMERIC
      );
    `);

    /* ═══ THE WORKBENCH LAYER ════════════════════════════════════════════════
       Everything above is the WORKBOOK as it was imported. Everything below is
       the workbench the manager actually works in, and it is deliberately
       additive: the columns are added to the existing tables rather than
       copied into new ones, so `resolve()`, `/coverage`, `/recipe` and
       `/health` keep working unchanged while gaining a yield model and a
       dated price history underneath them.                                 */
    await pool.query(`
      -- ── 1. Raw materials: supplier + trim/prep loss ──────────────────────
      -- A price is a fact on a date (that is cw_material_prices below). What
      -- lives on the material itself is what does not change per invoice: who
      -- sells it, and how much of a purchased kilo survives prep.
      --
      -- trim_loss_pct is the share of the PURCHASED weight thrown away before
      -- cooking — bone, fat cap, silverskin, outer leaves. NULL means nobody
      -- has measured it, which is not the same as zero and must never be
      -- rendered as 0%.
      --
      -- ── HOW THE KITCHEN ENTERS IT ────────────────────────────────────────
      -- Omar's instruction, verbatim in effect: he will weigh what he BOUGHT
      -- and weigh what CAME OUT after cleaning. He will not compute a
      -- percentage, and asking him to is how the number stops being entered.
      -- So the two weights are the input of record — trim_bought_g and
      -- trim_usable_g — and trim_loss_pct is DERIVED from them
      -- (1 − usable ÷ bought) and stored alongside so that every reader
      -- downstream keeps working unchanged.
      --
      -- trim_source says which of the two it is:
      --   weighed  — the two weights are on the row; the pct is arithmetic
      --   assumed  — somebody typed a percentage with no weights behind it
      --   (empty)  — nobody has said anything, and NULL pct means exactly that
      -- Only 'weighed' is evidence. RIBS_YIELD_ASSUMED and MATERIAL_NO_YIELD
      -- both close when a row turns 'weighed', and neither closes on a typed
      -- percentage — that is deliberate.
      ALTER TABLE cost_raw_materials ADD COLUMN IF NOT EXISTS supplier      TEXT NOT NULL DEFAULT '';
      ALTER TABLE cost_raw_materials ADD COLUMN IF NOT EXISTS trim_loss_pct NUMERIC;
      ALTER TABLE cost_raw_materials ADD COLUMN IF NOT EXISTS trim_bought_g NUMERIC;
      ALTER TABLE cost_raw_materials ADD COLUMN IF NOT EXISTS trim_usable_g NUMERIC;
      ALTER TABLE cost_raw_materials ADD COLUMN IF NOT EXISTS trim_source   TEXT NOT NULL DEFAULT '';
      ALTER TABLE cost_raw_materials ADD COLUMN IF NOT EXISTS trim_measured_at TIMESTAMPTZ;
      ALTER TABLE cost_raw_materials ADD COLUMN IF NOT EXISTS yield_note    TEXT NOT NULL DEFAULT '';
      ALTER TABLE cost_raw_materials ADD COLUMN IF NOT EXISTS updated_by    TEXT NOT NULL DEFAULT '';

      -- Any pct that arrived before the two-weight model existed is, by
      -- definition, a typed number. Label it once so the queue can tell the
      -- difference between "somebody guessed 18%" and "somebody weighed it".
      UPDATE cost_raw_materials SET trim_source = 'assumed'
       WHERE trim_loss_pct IS NOT NULL AND trim_source = '' AND trim_bought_g IS NULL;

      -- Purchase history. Cost lookups resolve BY DATE, exactly like
      -- item_costs.effective_from, so a supplier raising a price next week
      -- cannot silently rewrite last month's reported profit.
      CREATE TABLE IF NOT EXISTS cw_material_prices (
        id             TEXT PRIMARY KEY,
        canonical_ar   TEXT NOT NULL,
        supplier       TEXT NOT NULL DEFAULT '',
        purchase_unit  TEXT NOT NULL DEFAULT '',   -- كجم / علبة / حبة …
        pack_qty       NUMERIC,                    -- how much one purchase unit holds
        pack_unit      TEXT NOT NULL DEFAULT 'g',  -- g | ml | piece
        price          NUMERIC,                    -- SAR per purchase unit, VAT-EXCLUSIVE
        cost_per_g     NUMERIC,
        cost_per_piece NUMERIC,
        effective_from DATE NOT NULL DEFAULT '2000-01-01',
        -- invoice  = a real supplier document exists
        -- quote    = a price we were told but have not bought at
        -- estimate = somebody typed a plausible number  ← this is the enemy
        -- workbook = inherited from the imported spreadsheet, provenance unknown
        source         TEXT NOT NULL DEFAULT 'invoice',
        note           TEXT NOT NULL DEFAULT '',
        created_by     TEXT NOT NULL DEFAULT '',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (canonical_ar, effective_from)
      );
      CREATE INDEX IF NOT EXISTS cw_material_prices_mat_idx
        ON cw_material_prices(canonical_ar, effective_from DESC);

      -- ── 2. Batch-level cooking yield ─────────────────────────────────────
      -- yield_pct = output weight / input weight, 0..1.
      --
      -- ══ READ THIS BEFORE YOU "FIX" A BATCH WHOSE OUTPUT EQUALS ITS INPUT ══
      -- For most batches in THIS kitchen, output = input is CORRECT, not a
      -- missing yield. See COOKED_BATCHES below for the full argument and the
      -- batch-by-batch classification. In one line: الصدور / شيش طاووق /
      -- الكفتة / الحواوشي / البرجر are MARINATION batches — 5 kg of chicken
      -- goes in, 5 kg of marinated chicken comes out, a meal takes 300 g of it
      -- and that 300 g is a PRE-COOKING weight. Raw grams × raw price is the
      -- whole cost and there is no shrinkage to model, because the shrinkage
      -- happens on the grill AFTER the portion has been weighed and costed.
      --
      -- cooked_before_portioning is what separates those from a sauce that
      -- is genuinely reduced on the stove before anyone scoops it. NULL means
      -- the code default in COOKED_BATCHES applies; TRUE/FALSE is a human
      -- overriding it and always wins.
      ALTER TABLE cost_batches ADD COLUMN IF NOT EXISTS yield_pct       NUMERIC;
      ALTER TABLE cost_batches ADD COLUMN IF NOT EXISTS yield_note      TEXT NOT NULL DEFAULT '';
      ALTER TABLE cost_batches ADD COLUMN IF NOT EXISTS output_measured BOOL NOT NULL DEFAULT false;
      ALTER TABLE cost_batches ADD COLUMN IF NOT EXISTS cooked_before_portioning BOOL;
      ALTER TABLE cost_batches ADD COLUMN IF NOT EXISTS updated_by      TEXT NOT NULL DEFAULT '';

      ALTER TABLE cost_recipe_lines ADD COLUMN IF NOT EXISTS note       TEXT NOT NULL DEFAULT '';
      ALTER TABLE cost_batch_lines  ADD COLUMN IF NOT EXISTS note       TEXT NOT NULL DEFAULT '';

      -- Per-item cooking loss, for the case a recipe's grams were written as
      -- SERVED weight rather than raw weight. Omar's recipes are PRE-cooking,
      -- so this defaults to NULL for every item and is only ever set by hand,
      -- on an item somebody has actually checked. Applying a blanket cooking
      -- loss on top of raw weights would double-count the loss.
      CREATE TABLE IF NOT EXISTS cw_item_yield (
        product_id    INT PRIMARY KEY,
        cook_loss_pct NUMERIC,
        note          TEXT NOT NULL DEFAULT '',
        updated_by    TEXT NOT NULL DEFAULT '',
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- ── 3. Packaging ─────────────────────────────────────────────────────
      -- unit_cost is SAR for ONE piece, VAT-exclusive. NULL = not priced yet,
      -- and that is the honest state on first boot: Omar named the items, he
      -- did not quote them. A 0 here would be a lie the P&L would believe.
      CREATE TABLE IF NOT EXISTS cw_packaging (
        id         TEXT PRIMARY KEY,
        name_ar    TEXT NOT NULL,
        name_en    TEXT NOT NULL DEFAULT '',
        unit_cost  NUMERIC,
        pack_size  NUMERIC,      -- pieces in one purchased pack
        pack_price NUMERIC,      -- SAR per pack, VAT-exclusive
        supplier   TEXT NOT NULL DEFAULT '',
        active     BOOL NOT NULL DEFAULT true,
        note       TEXT NOT NULL DEFAULT '',
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Attachment rules, at the THREE levels packaging is really consumed at.
      --   scope='item'    → per unit of a dish. Goes INTO item_costs.
      --   scope='order'   → once per ticket, however many lines it has.
      --   scope='channel' → once per ticket, only for that channel.
      -- The scope is what stops the double count; see the long note on
      -- orderPackagingModel() further down.
      CREATE TABLE IF NOT EXISTS cw_packaging_rules (
        id           TEXT PRIMARY KEY,
        scope        TEXT NOT NULL DEFAULT 'item',   -- item | order | channel
        match_kind   TEXT NOT NULL DEFAULT 'all',    -- all | product | category | name | channel
        match_value  TEXT NOT NULL DEFAULT '',
        packaging_id TEXT NOT NULL,
        qty          NUMERIC NOT NULL DEFAULT 1,
        active       BOOL NOT NULL DEFAULT true,
        reviewed     BOOL NOT NULL DEFAULT false,
        note         TEXT NOT NULL DEFAULT '',
        updated_by   TEXT NOT NULL DEFAULT '',
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cw_packaging_rules_scope_idx ON cw_packaging_rules(scope, active);

      -- ── 4. Review state ──────────────────────────────────────────────────
      -- unreviewed | in_review | confirmed | needs_info.
      -- 'confirmed' is a promise: an import may never overwrite this item's
      -- recipe again without an explicit force. See importGuard().
      CREATE TABLE IF NOT EXISTS cw_item_review (
        product_id      INT PRIMARY KEY,
        status          TEXT NOT NULL DEFAULT 'unreviewed',
        note            TEXT NOT NULL DEFAULT '',
        changed_by      TEXT NOT NULL DEFAULT '',
        changed_by_name TEXT NOT NULL DEFAULT '',
        changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        confirmed_cost  NUMERIC,
        confirmed_at    TIMESTAMPTZ
      );

      -- ── 5. POS name → workbook product ───────────────────────────────────
      -- The POS spells one dish several ways. Deriving the link from the free
      -- text in item_costs.note worked while the loader owned that note, but
      -- the workbench rewrites the note — so the mapping becomes a table, and
      -- an editable one, instead of a string-parsing accident.
      CREATE TABLE IF NOT EXISTS cw_item_pos (
        pos_name   TEXT PRIMARY KEY,
        product_id INT NOT NULL,
        source     TEXT NOT NULL DEFAULT 'note',   -- note | exact | manual
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cw_item_pos_pid_idx ON cw_item_pos(product_id);

      -- ── 6. The queue ─────────────────────────────────────────────────────
      -- Rebuilt from live findings on every read and upserted by fingerprint,
      -- so a task the manager closed does not come back the next morning and a
      -- problem that got worse gets re-ranked without losing its history.
      CREATE TABLE IF NOT EXISTS cw_tasks (
        id            TEXT PRIMARY KEY,
        fingerprint   TEXT NOT NULL UNIQUE,
        kind          TEXT NOT NULL,
        title         TEXT NOT NULL DEFAULT '',
        why           TEXT NOT NULL DEFAULT '',
        action        TEXT NOT NULL DEFAULT '',
        impact_sar    NUMERIC,
        sales_sar     NUMERIC,
        item_ref      TEXT NOT NULL DEFAULT '',
        item_kind     TEXT NOT NULL DEFAULT '',   -- item | batch | material | packaging | pos | rules
        product_id    INT,
        severity      TEXT NOT NULL DEFAULT 'medium',
        status        TEXT NOT NULL DEFAULT 'open',   -- open | done | snoozed | wont_fix
        evidence      JSONB NOT NULL DEFAULT '{}',
        note          TEXT NOT NULL DEFAULT '',
        resolved_by   TEXT NOT NULL DEFAULT '',
        resolved_name TEXT NOT NULL DEFAULT '',
        resolved_at   TIMESTAMPTZ,
        snooze_until  DATE,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cw_tasks_status_idx ON cw_tasks(status, impact_sar DESC);

      -- ── 7. Audit ─────────────────────────────────────────────────────────
      -- Identical DDL to the copy in costing_auth.js on purpose: both modules
      -- boot in parallel and either may win the race. IF NOT EXISTS makes the
      -- loser a no-op.
      CREATE TABLE IF NOT EXISTS cw_audit (
        id         TEXT PRIMARY KEY,
        at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_id   TEXT NOT NULL DEFAULT '',
        actor_name TEXT NOT NULL DEFAULT '',
        entity     TEXT NOT NULL DEFAULT '',
        entity_ref TEXT NOT NULL DEFAULT '',
        field      TEXT NOT NULL DEFAULT '',
        old_value  TEXT,
        new_value  TEXT,
        note       TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS cw_audit_at_idx     ON cw_audit(at DESC);
      CREATE INDEX IF NOT EXISTS cw_audit_entity_idx ON cw_audit(entity, entity_ref);
    `);

    /* ── 8. Creation: the POS menu cache, and deactivation ──────────────────
       A product added to the workbench must be CHOSEN from the POS, never
       typed — `ts_order_items.name` is the join key for every sale and every
       cost, and a hand-typed near-miss produces a cost that reaches zero
       orders. So the TabSense menu is mirrored here: the picker reads this
       table, not the network, and a TabSense outage degrades the create flow
       to "the list is a few hours old" instead of "you cannot add a product".

       `last_seen_at` is what makes the cache honest — a row TabSense stops
       returning is not deleted (it may be an outage), it simply stops being
       refreshed, and the screen can say how old the list is. */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cw_pos_products (
        pos_id       TEXT PRIMARY KEY,          -- TabSense's own product id
        sku          TEXT NOT NULL DEFAULT '',
        name_ar      TEXT NOT NULL,             -- EXACTLY ts_order_items.name
        name_en      TEXT NOT NULL DEFAULT '',
        category_ar  TEXT NOT NULL DEFAULT '',
        category_en  TEXT NOT NULL DEFAULT '',
        price_incl   NUMERIC,                   -- VAT-INCLUSIVE (POS gross_price)
        price_excl   NUMERIC,                   -- VAT-exclusive
        pos_cost     NUMERIC,                   -- the POS's own cost field; ~always 0
        active       BOOL NOT NULL DEFAULT true,
        fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cw_pos_products_name_idx ON cw_pos_products(name_ar);

      -- Deactivation, never deletion. A hard DELETE orphans every cw_audit row
      -- that names the thing, and orphaned audit is worse than no audit: it
      -- reads as if the change never happened. These flags hide a row from the
      -- pickers and the create flows; they deliberately do NOT change what any
      -- existing recipe costs, because retiring a material today must not
      -- silently rewrite last month's reported profit.
      ALTER TABLE cost_raw_materials ADD COLUMN IF NOT EXISTS active BOOL NOT NULL DEFAULT true;
      ALTER TABLE cost_batches       ADD COLUMN IF NOT EXISTS active BOOL NOT NULL DEFAULT true;
      ALTER TABLE cost_menu_items    ADD COLUMN IF NOT EXISTS active BOOL NOT NULL DEFAULT true;
      -- Who added it, and from where. '' for every row the workbook seeded.
      ALTER TABLE cost_menu_items    ADD COLUMN IF NOT EXISTS pos_product_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE cost_menu_items    ADD COLUMN IF NOT EXISTS created_by     TEXT NOT NULL DEFAULT '';
      ALTER TABLE cost_raw_materials ADD COLUMN IF NOT EXISTS created_by     TEXT NOT NULL DEFAULT '';
      ALTER TABLE cost_batches       ADD COLUMN IF NOT EXISTS created_by     TEXT NOT NULL DEFAULT '';
    `);

    await seedIfEmpty();
    await seedWorkbenchIfEmpty();
  }

  /** Seed each reference table only when it is EMPTY. Omar's later edits in the
   *  DB therefore survive every redeploy — the workbook is a starting point. */
  async function seedIfEmpty() {
    const empty = async (t) =>
      num((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n) === 0;
    const many = async (sql, rows) => { for (const r of rows) await pool.query(sql, r); };

    if (await empty("cost_raw_materials")) await many(
      `INSERT INTO cost_raw_materials
         (canonical_ar,name_en,purchase_unit,cost_per_unit,cost_per_g,cost_per_piece,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (canonical_ar) DO NOTHING`, WB_RAW);
    if (await empty("cost_aliases")) await many(
      `INSERT INTO cost_aliases (alias_ar,canonical_ar) VALUES ($1,$2)
       ON CONFLICT (alias_ar) DO NOTHING`, WB_ALIAS);
    if (await empty("cost_batches")) await many(
      `INSERT INTO cost_batches (batch_ar,batch_en,output_g,total_cost,cost_per_g,note)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (batch_ar) DO NOTHING`, WB_BAT);
    if (await empty("cost_batch_lines")) await many(
      `INSERT INTO cost_batch_lines (id,batch_ar,ing_type,ing_ar,ing_en,qty,unit,qty_g,line_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      WB_BLIN.map((r, i) => [idFor("bl", i, r[0], r[2]), ...r]));
    if (await empty("cost_menu_items")) await many(
      `INSERT INTO cost_menu_items
         (product_id,sku,product_ar,product_en,category_ar,category_en,
          total_cost,price_suggested,price_restaurant,price_platform)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (product_id) DO NOTHING`, WB_MEN);
    if (await empty("cost_recipe_lines")) await many(
      `INSERT INTO cost_recipe_lines (id,product_id,ing_type,ing_ar,ing_en,qty,unit,qty_g,line_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      WB_REC.map((r, i) => [idFor("rl", i, r[0], r[2]), ...r]));
    if (await empty("cost_modifiers")) await many(
      `INSERT INTO cost_modifiers (modifier_ar,modifier_en,ing_ar,qty,unit,cost,price_incl)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (modifier_ar) DO NOTHING`, WB_MODS);
  }

  // Sequenced behind the auth module's schema: both declare `cw_audit`, and
  // concurrent CREATE TABLE IF NOT EXISTS on one relation is a real race in
  // PostgreSQL. See the note at the bottom of costing_auth.js.
  Promise.resolve(auth.ready)
    .then(() => ensureCostingSchema())
    .then(() => console.log("[costing] schema ready"))
    .catch((e) => console.error("[costing] ensureCostingSchema failed:", e.message));

  /* ── The model, loaded once and cached briefly. ~1,000 rows total, so this is
     a few hundred KB and every route can afford the whole thing. ──────────── */
  let cache = { at: 0, model: null };
  const CACHE_MS = 60_000;

  async function loadModel() {
    if (cache.model && Date.now() - cache.at < CACHE_MS) return cache.model;
    const [raws, aliases, batches, blines, menu, rlines, mods] = await Promise.all([
      pool.query(`SELECT * FROM cost_raw_materials`),
      pool.query(`SELECT * FROM cost_aliases`),
      pool.query(`SELECT * FROM cost_batches`),
      pool.query(`SELECT * FROM cost_batch_lines`),
      pool.query(`SELECT * FROM cost_menu_items ORDER BY product_id`),
      pool.query(`SELECT * FROM cost_recipe_lines ORDER BY product_id, id`),
      pool.query(`SELECT * FROM cost_modifiers`),
    ]);
    const m = {
      raw: new Map(raws.rows.map((r) => [norm(r.canonical_ar), r])),
      alias: new Map(aliases.rows.map((r) => [norm(r.alias_ar), norm(r.canonical_ar)])),
      batch: new Map(batches.rows.map((r) => [norm(r.batch_ar), r])),
      batchLines: new Map(),
      menu: menu.rows,
      menuById: new Map(menu.rows.map((r) => [r.product_id, r])),
      recipeLines: new Map(),
      modifiers: mods.rows,
    };
    for (const l of blines.rows) {
      const k = norm(l.batch_ar);
      if (!m.batchLines.has(k)) m.batchLines.set(k, []);
      m.batchLines.get(k).push(l);
    }
    for (const l of rlines.rows) {
      if (!m.recipeLines.has(l.product_id)) m.recipeLines.set(l.product_id, []);
      m.recipeLines.get(l.product_id).push(l);
    }
    cache = { at: Date.now(), model: m };
    return m;
  }

  /* ── Ingredient resolution. This is the whole provenance story: given what the
     recipe wrote, say what it costs and WHERE that came from. ─────────────── */
  function resolve(model, type, nameAr) {
    const raw0 = norm(nameAr);
    const isBatch = String(type || "").toLowerCase().startsWith("batch");

    /* ── The self-referential alias ──────────────────────────────────────────
       `Name_Map` maps MENU shorthand onto batches: `كفته → الكفتة`,
       `صدور → الصدور`, `كبدة → الكبدة`. That is right at the menu level and
       catastrophic inside a batch, because the الكبدة batch's own first
       ingredient IS `كبدة` — the raw liver. Follow the alias there and the
       batch is priced from itself.

       Excel got the right answer by accident: it looked the raw up first. So
       the rule here is explicit — a literal name that is already a canonical
       raw material wins over any alias pointing away from it. Only genuine
       shorthand (a name that is NOT itself a raw) is redirected. Without this,
       الكبدة comes out at 108.89 instead of 111.47. */
    const literalIsRaw = model.raw.has(raw0);
    const canonical = (!isBatch && literalIsRaw) ? raw0 : (model.alias.get(raw0) || raw0);
    const viaAlias = canonical !== raw0;

    // A Batch line looks in cost_batches first, a Raw line in cost_raw_materials
    // first, but each falls through to the other — Name_Map legitimately maps
    // some raw aliases onto batches (e.g. a sauce that is produced in-house).
    const order = isBatch ? ["batch", "raw"] : ["raw", "batch"];
    for (const where of order) {
      if (where === "batch" && model.batch.has(canonical)) {
        const b = model.batch.get(canonical);
        return { found: true, canonical, viaAlias, kind: "batch",
                 perG: b.cost_per_g === null ? null : num(b.cost_per_g), perPiece: null,
                 source: viaAlias ? "cost_aliases → cost_batches" : "cost_batches",
                 batch: b };
      }
      if (where === "raw" && model.raw.has(canonical)) {
        const r = model.raw.get(canonical);
        return { found: true, canonical, viaAlias, kind: "raw",
                 perG: r.cost_per_g === null ? null : num(r.cost_per_g),
                 perPiece: r.cost_per_piece === null ? null : num(r.cost_per_piece),
                 source: viaAlias ? "cost_aliases → cost_raw_materials" : "cost_raw_materials",
                 status: r.status, nameEn: r.name_en, purchaseUnit: r.purchase_unit,
                 costPerUnit: r.cost_per_unit === null ? null : num(r.cost_per_unit) };
      }
    }
    return { found: false, canonical, viaAlias, kind: null, perG: null, perPiece: null,
             source: "MISSING" };
  }

  /** Cost one recipe/batch line from first principles. Per-piece materials are
   *  multiplied by `qty`, gram materials by `qty_g` — mixing the two is the
   *  single easiest way to be wrong by a factor of 1,000 here. */
  function lineCost(line, res) {
    if (!res.found) return 0;
    if (res.perG !== null && res.perG !== undefined) return num(line.qty_g) * res.perG;
    if (res.perPiece !== null && res.perPiece !== undefined) return num(line.qty) * res.perPiece;
    return 0;
  }

  /* Confidence of one ingredient, and of a batch (worst of its own lines).
     'measured' → an invoice price behind it. 'guess' → the workbook says REVIEW.
     'plug' → a batch whose recipe was never entered. 'missing' → no cost at all. */
  const RANK = { measured: 0, guess: 1, plug: 2, missing: 3 };
  const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);

  function batchConfidence(model, batchAr, depth = 0) {
    const b = model.batch.get(norm(batchAr));
    if (!b) return "missing";
    if (/missing recipe/i.test(b.note || "")) return "plug";
    if (depth > 4) return "measured";
    let c = "measured";
    for (const l of model.batchLines.get(norm(batchAr)) || []) {
      const r = resolve(model, l.ing_type, l.ing_ar);
      c = worst(c, lineConfidence(model, r, depth + 1));
      if (c === "missing") break;
    }
    return c;
  }
  function lineConfidence(model, res, depth = 0) {
    if (!res.found) return "missing";
    if (res.kind === "batch") return batchConfidence(model, res.canonical, depth);
    if (String(res.status || "").toUpperCase() === "REVIEW") return "guess";
    if (res.perG === null && res.perPiece === null) return "missing";
    return "measured";
  }

  /** Full ingredient breakdown of one menu item, with provenance per line. */
  function explain(model, productId) {
    const item = model.menuById.get(productId);
    const lines = model.recipeLines.get(productId) || [];
    let recomputed = 0, stored = 0, confidence = "measured";
    const out = lines.map((l) => {
      const res = resolve(model, l.ing_type, l.ing_ar);
      const cost = lineCost(l, res);
      const conf = lineConfidence(model, res);
      recomputed += cost;
      stored += num(l.line_cost);
      confidence = worst(confidence, conf);
      const row = {
        type: l.ing_type, ingredientAr: l.ing_ar, ingredientEn: l.ing_en || "",
        canonical: res.canonical, viaAlias: res.viaAlias,
        qty: num(l.qty), unit: l.unit, qtyG: num(l.qty_g),
        unitCost: res.perG !== null && res.perG !== undefined ? round3(res.perG * 1000) : null,
        unitCostBasis: res.perG !== null && res.perG !== undefined ? "SAR/kg"
                     : res.perPiece !== null && res.perPiece !== undefined ? "SAR/piece" : null,
        costPerPiece: res.perPiece ?? null,
        cost: round3(cost), storedCost: round3(num(l.line_cost)),
        drift: round3(cost - num(l.line_cost)),
        source: res.source, confidence: conf,
      };
      if (res.kind === "batch" && res.batch) {
        row.batch = {
          nameEn: res.batch.batch_en, outputG: num(res.batch.output_g),
          totalCost: round3(num(res.batch.total_cost)),
          costPerKg: round3(num(res.batch.cost_per_g) * 1000),
          note: res.batch.note || "",
          components: (model.batchLines.get(res.canonical) || []).map((bl) => {
            const br = resolve(model, bl.ing_type, bl.ing_ar);
            return { ingredientAr: bl.ing_ar, qtyG: num(bl.qty_g),
                     cost: round3(lineCost(bl, br)), source: br.source,
                     confidence: lineConfidence(model, br, 1) };
          }),
        };
      }
      return row;
    });
    return {
      productId, item: item || null,
      lines: out,
      recomputedCost: round3(recomputed),
      storedCost: item ? round3(num(item.total_cost)) : null,
      lineSumCost: round3(stored),
      arithmeticDrift: item ? round3(recomputed - num(item.total_cost)) : null,
      confidence,
      hasSummaryRow: !!item,
    };
  }

  /* ── Sales, keyed by POS item name. Everything money-ranked comes from here.
     `amount` is VAT-INCLUSIVE and pre-discount (finance.js note), so a food-cost
     percentage divides by amount/1.15. Modifier lines carry zero revenue and are
     kept in their own bucket so they cannot skew a value share. ───────────── */
  async function salesByItem(from, to) {
    const rows = (await pool.query(
      `SELECT i.name,
              sum(i.qty)::float    AS qty,
              sum(i.amount)::float AS amount,
              count(DISTINCT i.order_id)::int AS orders
         FROM ts_order_items i
         JOIN ts_orders o ON o.order_id = i.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
        GROUP BY 1`, [from, to])).rows;
    return rows.map((r) => ({
      name: r.name, qty: num(r.qty), amount: num(r.amount), orders: r.orders,
      // Classified on the NAME SHAPE alone. Doing it on `amount === 0` looked
      // safer and was wrong: a handful of add-on lines do carry a few riyals,
      // and treating those as dishes let 17 units of "pizza + crust filling"
      // land on the pizza's own unit economics and drag its average price from
      // 23 SAR down to 0.18. Shape is the only stable signal (rule 3).
      isModifier: isModifierLine(r.name),
      zeroRevenue: num(r.amount) === 0,
    }));
  }

  /** Current cost row per item name, as of `to` (respects effective_from). */
  async function costsAsOf(to) {
    const rows = (await pool.query(
      `SELECT DISTINCT ON (item_name) item_name, cost::float AS cost, note, effective_from
         FROM item_costs WHERE effective_from <= $1::date
        ORDER BY item_name, effective_from DESC`, [to])).rows;
    return new Map(rows.map((r) => [r.item_name, r]));
  }

  /** Which bucket a priced item falls in. Recipe-based beats weight-model beats
   *  hand-priced; the note written by whoever loaded the row is the evidence. */
  function bucketOf(costRow) {
    if (!costRow) return "unpriced";
    const n = String(costRow.note || "");
    if (n.includes(NOTE_RECIPE)) return "recipe";
    if (n.includes(NOTE_WEIGHT)) return "weightModel";
    return "hand";
  }

  /** POS item name -> workbook product, via the note prefix the recipe loader
   *  wrote ("<workbook AR name> — من ملف التكاليف بالوصفات") and, failing that,
   *  an exact match on the workbook's own Arabic name. */
  function posToProduct(model, costs) {
    const byAr = new Map(model.menu.map((m) => [norm(m.product_ar), m]));
    const map = new Map();
    for (const m of model.menu) map.set(norm(m.product_ar), m);
    for (const [name, row] of costs) {
      const n = String(row.note || "");
      if (!n.includes(NOTE_RECIPE)) continue;
      const wbName = norm(n.split("—")[0]);
      const hit = byAr.get(wbName);
      if (hit) map.set(norm(name), hit);
    }
    return map;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     ROUTE 1 — COVERAGE. How much of the money is genuinely measured?
     ═══════════════════════════════════════════════════════════════════════ */
  app.get("/api/costing/coverage", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const from = dayArg(c.req.query("from"), daysAgoISO(89));
      const to = dayArg(c.req.query("to"), todayISO());
      const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 40));

      const [sales, costs] = await Promise.all([salesByItem(from, to), costsAsOf(to)]);
      const buckets = {
        recipe:      { label: "من الوصفات",       items: 0, units: 0, value: 0, cost: 0 },
        weightModel: { label: "نموذج الوزن",      items: 0, units: 0, value: 0, cost: 0 },
        hand:        { label: "تسعير يدوي",       items: 0, units: 0, value: 0, cost: 0 },
        unpriced:    { label: "بدون تكلفة",       items: 0, units: 0, value: 0, cost: 0 },
      };
      // Rule 3: zero-revenue modifier lines are counted apart. They add real
      // cost but no revenue, so folding them into a value share is meaningless.
      const modifiers = { items: 0, units: 0, value: 0, cost: 0, priced: 0, unpriced: 0,
                          zeroRevenueItems: 0 };
      const missing = [];

      for (const s of sales) {
        const row = costs.get(s.name);
        const b = bucketOf(row);
        const cost = row ? num(row.cost) * s.qty : 0;
        if (s.isModifier) {
          modifiers.items++; modifiers.units += s.qty; modifiers.cost += cost;
          modifiers.value += s.amount;
          if (s.zeroRevenue) modifiers.zeroRevenueItems++;
          if (row) modifiers.priced++; else modifiers.unpriced++;
          if (!row) missing.push({ name: s.name, units: s.qty, value: round2(s.amount),
                                   orders: s.orders, isModifier: true });
          continue;
        }
        const k = buckets[b];
        k.items++; k.units += s.qty; k.value += s.amount; k.cost += cost;
        if (b === "unpriced") missing.push({ name: s.name, units: s.qty, value: round2(s.amount),
                                             orders: s.orders, isModifier: false });
      }
      const totalValue = Object.values(buckets).reduce((a, x) => a + x.value, 0);
      const totalUnits = Object.values(buckets).reduce((a, x) => a + x.units, 0);
      const shape = (x) => ({
        label: x.label, items: x.items, units: round2(x.units), value: round2(x.value),
        cost: round2(x.cost),
        valueShare: totalValue ? round3(x.value / totalValue) : 0,
        unitShare: totalUnits ? round3(x.units / totalUnits) : 0,
        foodCostPct: x.value ? round3(x.cost / (x.value / (1 + VAT_RATE))) : null,
      });
      const measuredValue = buckets.recipe.value + buckets.weightModel.value;

      return c.json({
        from, to,
        totals: { items: sales.length, units: round2(totalUnits), value: round2(totalValue) },
        buckets: {
          recipe: shape(buckets.recipe), weightModel: shape(buckets.weightModel),
          hand: shape(buckets.hand), unpriced: shape(buckets.unpriced),
        },
        // The one number to quote: how much of the revenue sits on a cost that
        // was actually built from ingredients rather than typed from memory.
        recipeBackedValueShare: totalValue ? round3(measuredValue / totalValue) : 0,
        pricedValueShare: totalValue ? round3(1 - buckets.unpriced.value / totalValue) : 0,
        modifiers: { ...modifiers, units: round2(modifiers.units), value: round2(modifiers.value),
                     cost: round2(modifiers.cost),
                     note: "أسطر الإضافات: الإيراد غالباً على الصنف الأب — تُحسب تكلفتها كإضافة وليس كالصنف الأب" },
        missing: missing.sort((a, b) => b.value - a.value || b.units - a.units).slice(0, limit),
        missingCount: missing.length,
        basis: {
          costs: "VAT-exclusive, from item_costs as of `to` (effective_from respected)",
          revenue: "ts_order_items.amount — VAT-INCLUSIVE and pre-discount",
          excluded: "void and refund orders",
        },
      });
    } catch (e) {
      console.error("[costing] coverage failed:", e);
      return c.json({ error: "coverage_failed", detail: e.message }, 500);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     ROUTE 2 — RECIPE. One dish, ingredient by ingredient, with provenance.
     Accepts ?productId=, ?item=<POS or workbook Arabic name>, or ?q= (search).
     ═══════════════════════════════════════════════════════════════════════ */
  app.get("/api/costing/recipe", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const model = await loadModel();
      const to = dayArg(c.req.query("to"), todayISO());
      const pidArg = Number(c.req.query("productId"));
      const itemArg = norm(c.req.query("item"));
      const qArg = norm(c.req.query("q"));

      let product = null;
      if (Number.isFinite(pidArg) && pidArg > 0) product = model.menuById.get(pidArg) || null;
      if (!product && itemArg) {
        const costs = await costsAsOf(to);
        const map = posToProduct(model, costs);
        product = map.get(itemArg)
          || model.menu.find((m) => norm(m.product_ar) === itemArg)
          || model.menu.find((m) => norm(m.product_en) === itemArg)
          || null;
        // A modifier line must resolve to the MODIFIER, never to its parent
        // dish — costing it as the parent double-counts the dish (rule 3).
        if (!product && isModifierLine(itemArg)) {
          const { parent, modifier } = splitModifierLine(itemArg);
          const mod = model.modifiers.find((m) => norm(m.modifier_ar) === norm(modifier))
                   || model.modifiers.find((m) => norm(modifier).includes(norm(m.modifier_ar)));
          const row = costs.get(itemArg);
          const parentProduct = map.get(norm(parent))
            || model.menu.find((m) => norm(m.product_ar) === norm(parent)) || null;
          return c.json({
            kind: "modifier", query: itemArg, parentDish: parent, modifier,
            // The Modifiers sheet only covers 13 priced add-ons; the POS emits
            // many more (crust fillings, drink+fries combos, "بدون X"). The
            // item_costs row is the operative cost when the sheet has no match.
            matched: mod ? { nameAr: mod.modifier_ar, nameEn: mod.modifier_en,
                             ingredientAr: mod.ing_ar, qty: num(mod.qty), unit: mod.unit,
                             cost: round3(num(mod.cost)), priceIncl: num(mod.price_incl),
                             source: "cost_modifiers" } : null,
            costRow: row ? { cost: num(row.cost), note: row.note, bucket: bucketOf(row),
                             source: "item_costs" } : null,
            // Named so a caller can look the parent up, and labelled so nobody
            // ever charges the parent's cost to this line (rule 3).
            parentProduct: parentProduct ? menuBrief(parentProduct) : null,
            warning: "سطر إضافة: التكلفة تُحسب للإضافة نفسها وليس للصنف الأب — الإيراد على الصنف الأب",
          });
        }
      }
      if (!product && qArg) {
        const hits = model.menu.filter((m) =>
          norm(m.product_ar).includes(qArg) || String(m.product_en || "").toLowerCase().includes(qArg.toLowerCase()));
        if (hits.length === 1) product = hits[0];
        else return c.json({ kind: "search", query: qArg, matches: hits.map(menuBrief) });
      }
      if (!product) return c.json({ error: "not_found",
        hint: "استخدم productId أو item (اسم الصنف) أو q للبحث — أو GET /api/costing/menu" }, 404);

      const ex = explain(model, product.product_id);
      const sales = await salesByItem(daysAgoISO(89), to);
      const costs = await costsAsOf(to);
      const map = posToProduct(model, costs);
      const posNames = sales.filter((s) => map.get(norm(s.name))?.product_id === product.product_id);

      return c.json({
        kind: "recipe",
        product: menuBrief(product),
        pricing: pricingOf(product, ex.recomputedCost),
        cost: {
          recomputedFromIngredients: ex.recomputedCost,
          storedInWorkbook: ex.storedCost,
          arithmeticDrift: ex.arithmeticDrift,
          confidence: ex.confidence,
          confidenceMeaning: CONFIDENCE_MEANING,
        },
        ingredients: ex.lines,
        posLines: posNames.map((s) => ({
          name: s.name, units: round2(s.qty), value: round2(s.amount),
          costRow: costs.get(s.name)
            ? { cost: num(costs.get(s.name).cost), note: costs.get(s.name).note,
                bucket: bucketOf(costs.get(s.name)) }
            : null,
        })),
        weightModel: expectedWeightCost(product.product_ar),
      });
    } catch (e) {
      console.error("[costing] recipe failed:", e);
      return c.json({ error: "recipe_failed", detail: e.message }, 500);
    }
  });

  /* ── The index the recipe route is picked from. ──────────────────────────── */
  app.get("/api/costing/menu", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const model = await loadModel();
      const items = model.menu.map((m) => {
        const ex = explain(model, m.product_id);
        return { ...menuBrief(m), ...pricingOf(m, ex.recomputedCost),
                 confidence: ex.confidence, ingredientCount: ex.lines.length,
                 arithmeticDrift: ex.arithmeticDrift };
      });
      return c.json({
        count: items.length, items,
        modifiers: model.modifiers.map((m) => ({
          nameAr: m.modifier_ar, nameEn: m.modifier_en, ingredientAr: m.ing_ar,
          qty: num(m.qty), unit: m.unit, cost: round3(num(m.cost)),
          priceIncl: num(m.price_incl) })),
        confidenceMeaning: CONFIDENCE_MEANING,
      });
    } catch (e) {
      console.error("[costing] menu failed:", e);
      return c.json({ error: "menu_failed", detail: e.message }, 500);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     ROUTE 3 — HEALTH. The audit, machine-readable, so the UI can show Omar
     exactly which costs he should not trust yet.

     Every finding carries `salesValue` — the revenue in the window that depends
     on the suspect number — and the list is sorted by it. That ordering is the
     entire point: the workbook's own REVIEW flags point at the three cheapest
     problems it has, while its worst one is marked 'OK'.
     ═══════════════════════════════════════════════════════════════════════ */
  app.get("/api/costing/health", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const from = dayArg(c.req.query("from"), daysAgoISO(89));
      const to = dayArg(c.req.query("to"), todayISO());
      const model = await loadModel();
      const [sales, costs] = await Promise.all([salesByItem(from, to), costsAsOf(to)]);
      const map = posToProduct(model, costs);

      // Sales rolled up onto workbook products, so a finding about a recipe can
      // be priced in real money even though the POS spells the dish six ways.
      const byProduct = new Map();
      for (const s of sales) {
        if (s.isModifier) continue;            // rule 3: an add-on is not the dish
        const p = map.get(norm(s.name));
        if (!p) continue;
        const cur = byProduct.get(p.product_id) || { units: 0, value: 0, names: [] };
        cur.units += s.qty; cur.value += s.amount; cur.names.push(s.name);
        byProduct.set(p.product_id, cur);
      }
      const prodSales = (pid) => byProduct.get(pid) || { units: 0, value: 0, names: [] };
      const F = [];
      // `posNames` is carried on every finding so the summary can union the
      // affected lines before totalling. Without it, four batch findings that
      // all touch وجبة ميكس جريل each claim its SAR 7,532 and the "sales on
      // assumed inputs" figure sails past 100% of revenue.
      const add = (f) => F.push({ salesValue: 0, units: 0, posNames: [], ...f });

      /* ── 1. Arithmetic. Recomputed vs stored, per menu item and per batch.
            Expected to be silent on the shipped workbook — it is here so that
            the moment Omar edits a raw price without recomputing, it shouts. */
      for (const m of model.menu) {
        const ex = explain(model, m.product_id);
        if (Math.abs(ex.arithmeticDrift) > 0.005) {
          const s = prodSales(m.product_id);
          add({ code: "ARITH_MENU", severity: "high", area: "menu",
                item: m.product_ar, itemEn: m.product_en, productId: m.product_id,
                message: `تكلفة الصنف المخزّنة ${round3(num(m.total_cost))} لا تساوي مجموع المكونات ${ex.recomputedCost}`,
                messageEn: `Stored total ${round3(num(m.total_cost))} != sum of ingredients ${ex.recomputedCost}`,
                gapSar: ex.arithmeticDrift, salesValue: round2(s.value), units: round2(s.units),
                posNames: s.names, basis: "measured" });
        }
      }
      for (const [key, b] of model.batch) {
        const lines = model.batchLines.get(key) || [];
        const recomputed = lines.reduce((a, l) => a + lineCost(l, resolve(model, l.ing_type, l.ing_ar)), 0);
        const gap = recomputed - num(b.total_cost);
        if (lines.length && Math.abs(gap) > 0.005)
          add({ code: "ARITH_BATCH", severity: "high", area: "batch", item: b.batch_ar,
                itemEn: b.batch_en,
                message: `تكلفة التشغيلة المخزّنة ${round3(num(b.total_cost))} لا تساوي مجموع مكوناتها ${round3(recomputed)}`,
                messageEn: `Stored batch total ${round3(num(b.total_cost))} != ingredients ${round3(recomputed)}`,
                gapSar: round3(gap), basis: "measured" });

        /* ── 2a. A batch whose recipe was never entered. The workbook marks the
              Tarb batch 'OK' while its note admits the recipe is missing, so the
              Dashboard reports zero flagged items. The note is the truth. */
        if (/missing recipe/i.test(b.note || "")) {
          const dependents = dependentsOfBatch(model, key);
          const value = dependents.reduce((a, pid) => a + prodSales(pid).value, 0);
          const units = dependents.reduce((a, pid) => a + prodSales(pid).units, 0);
          const names = dependents.flatMap((pid) => prodSales(pid).names);
          add({ code: "BATCH_PLUG", severity: "critical", area: "batch",
                item: b.batch_ar, itemEn: b.batch_en,
                message: `وصفة التشغيلة غير مُدخلة — التكلفة ${round3(num(b.cost_per_g) * 1000)} ر.س/كجم رقم مؤقت`,
                messageEn: `Batch recipe was never entered — ${round3(num(b.cost_per_g) * 1000)} SAR/kg is a placeholder`,
                dependents: dependents.map((pid) => ({
                  productId: pid, item: model.menuById.get(pid)?.product_ar,
                  salesValue: round2(prodSales(pid).value) })),
                salesValue: round2(value), units: round2(units), posNames: names,
                basis: "assumed",
                action: "أدخل وصفة الطرب ووزن الإنتاج الفعلي في cost_batch_lines / cost_batches" });
        }
        /* ── 2b. A missing cooking yield — but ONLY on a batch that is cooked
              BEFORE it is portioned.

              This used to fire on every batch whose output equalled its input
              while containing protein, graded by protein share. On this menu
              that was wrong, and loudly: الصدور / شيش طاووق / الكفتة are
              MARINATION batches. 5 kg in, 5 kg out, and the 300 g a meal takes
              out of the tub is weighed RAW before it goes on the grill. Raw
              grams × raw price IS the cost; the grill shrinkage happens after
              the portion has been costed. See COOKED_BATCHES for the full
              argument and the batch-by-batch classification.

              A batch only needs a yield when its recipe grams are grams of the
              FINISHED thing — a reduced sauce, a béchamel, a braise. */
        const inputs = lines.reduce((a, l) => a + num(l.qty_g), 0);
        if (isCookedBatch(key, b) && inputs > 0 && num(b.output_g) >= inputs - 0.5) {
          const info = COOKED_BATCHES.get(norm(key)) || {};
          const dependents = dependentsOfBatch(model, key);
          const value = dependents.reduce((a, pid) => a + prodSales(pid).value, 0);
          add({ code: "BATCH_COOKED_NO_YIELD",
                severity: value > 3000 ? "high" : "medium",
                area: "batch", item: b.batch_ar, itemEn: b.batch_en,
                message: `التشغيلة دي بتتطبخ قبل ما تتقسّم (${info.why || ""}) — `
                  + `يعني الجرام في الوصفة جرام بعد الطهي، لكن التكلفة متقسومة على `
                  + `${round3(inputs)} جم مدخلات كأن مفيش حاجة راحت`,
                messageEn: `This batch is cooked BEFORE it is portioned, so its recipe `
                  + `grams are finished grams — yet the cost is divided by the `
                  + `${round3(inputs)} g of raw input. The SAR/g is understated`,
                salesValue: round2(value), basis: "assumed",
                posNames: dependents.flatMap((pid) => prodSales(pid).names),
                evidence: { outputG: num(b.output_g), inputG: round3(inputs),
                            classification: info.evidence || "manual",
                            reason: info.why || "" } });
        }
        /* Conservation of mass: a RAW batch cannot yield more than it was
           given. effBatch() caps it; here it is reported. */
        if (!isCookedBatch(key, b) && inputs > 0 && num(b.output_g) > inputs + 0.5) {
          const dependents = dependentsOfBatch(model, key);
          const value = dependents.reduce((a, pid) => a + prodSales(pid).value, 0);
          add({ code: "BATCH_OUTPUT_EXCEEDS_INPUT", severity: "critical",
                area: "batch", item: b.batch_ar, itemEn: b.batch_en,
                message: `وزن الإنتاج ${num(b.output_g)} جم أكبر من مجموع المدخلات `
                  + `${round3(inputs)} جم — مستحيل لخلطة نيّة، والفرق بيقلّل تكلفة الكيلو`,
                messageEn: `Output ${num(b.output_g)} g exceeds inputs ${round3(inputs)} g — `
                  + `impossible for a raw mix, and it understates the cost per kilo`,
                salesValue: round2(value), basis: "measured",
                posNames: dependents.flatMap((pid) => prodSales(pid).names),
                evidence: { outputG: num(b.output_g), inputG: round3(inputs),
                            phantomG: round3(num(b.output_g) - inputs) } });
        }
      }

      /* ── 3. Raw materials the workbook itself flagged REVIEW. These are NOT
            missing — someone typed a round number. Every dependent dish is
            computed as if it were fact. */
      for (const [key, r] of model.raw) {
        if (String(r.status || "").toUpperCase() !== "REVIEW") continue;
        const deps = dependentsOfRaw(model, key);
        const value = deps.reduce((a, d) => a + prodSales(d.productId).value, 0);
        const units = deps.reduce((a, d) => a + prodSales(d.productId).units, 0);
        // If the true price is double the guess, this is the extra COGS.
        const doubleRisk = deps.reduce((a, d) => a + d.exposureSar * prodSales(d.productId).units, 0);
        add({ code: "RAW_GUESSED", severity: value > 2000 ? "medium" : "low", area: "raw",
              item: r.canonical_ar, itemEn: r.name_en,
              message: `سعر «${r.canonical_ar}» (${num(r.cost_per_unit)} ر.س/${r.purchase_unit}) رقم تقديري وليس من فاتورة`,
              messageEn: `${r.name_en} at ${num(r.cost_per_unit)} SAR/${r.purchase_unit} is an estimate, not an invoice price`,
              dependents: deps.map((d) => ({ productId: d.productId, item: d.item,
                exposureSar: round3(d.exposureSar), shareOfItemCost: d.share,
                salesValue: round2(prodSales(d.productId).value) })),
              salesValue: round2(value), units: round2(units), basis: "assumed",
              posNames: deps.flatMap((d) => prodSales(d.productId).names),
              costIfDoubled: round2(doubleRisk),
              action: "أدخل سعر الشراء الحالي في cost_raw_materials" });
      }

      /* ── 4. Recipes with no summary row — costed but never published. */
      for (const pid of model.recipeLines.keys())
        if (!model.menuById.has(pid)) {
          const lines = model.recipeLines.get(pid);
          add({ code: "ORPHAN_RECIPE", severity: "low", area: "menu", productId: pid,
                item: lines[0]?.ing_ar ? `product #${pid}` : `product #${pid}`,
                message: `وصفة كاملة (${lines.length} مكوّن) بدون صف في قائمة الأصناف — لا تكلفة ولا سعر`,
                messageEn: `Full recipe (${lines.length} lines) with no menu-item row — no cost, no price`,
                basis: "measured" });
        }

      /* ── 5. Sold with no cost at all. The blended 43% is covering these. */
      for (const s of sales) {
        if (costs.get(s.name)) continue;
        if (num(s.amount) <= 0 && !s.isModifier) continue;
        add({ code: s.isModifier ? "MODIFIER_UNPRICED" : "ITEM_UNPRICED",
              severity: s.amount > 100 ? "medium" : "low", area: "pos", item: s.name,
              message: s.isModifier
                ? `سطر إضافة بدون تكلفة — يُحتسب ضمن نسبة الـ43% العامة`
                : `صنف مُباع بدون تكلفة — يُحتسب ضمن نسبة الـ43% العامة`,
              messageEn: s.isModifier
                ? "Modifier line with no cost — falls back to the blended 43%"
                : "Sold item with no cost — falls back to the blended 43%",
              salesValue: round2(s.amount), units: round2(s.qty), posNames: [s.name],
              basis: "measured" });
      }

      /* ── 6. Weight-model drift. Re-checks every weight-sold item_costs row
            against Omar's rule: meat 1/1.5/3, accompaniments 1/2/3. */
      const salesByName = new Map(sales.map((s) => [s.name, s]));
      for (const [name, row] of costs) {
        const exp = expectedWeightCost(name);
        if (!exp) continue;
        const gap = round3(num(row.cost) - exp.total);
        if (Math.abs(gap) <= 0.005) continue;
        const s = salesByName.get(name) || { qty: 0, amount: 0 };
        add({ code: "WEIGHT_MODEL_DRIFT", severity: "high", area: "weight", item: name,
              message: `تكلفة ${name} = ${num(row.cost)} بينما نموذج الوزن يعطي ${exp.total} (لحم ${exp.meat} + مرفقات ${exp.acc})`,
              messageEn: `item_costs says ${num(row.cost)}, the weight model says ${exp.total} (meat ${exp.meat} + accompaniments ${exp.acc})`,
              gapSar: gap, expected: exp, salesValue: round2(s.amount), units: round2(s.qty),
              posNames: [name],
              basis: exp.accSource === "omar" ? "measured" : "assumed" });
      }

      /* ── 7. Two-tier pricing. The same dish earns a different margin per
            channel; a platform price at or below the restaurant price cannot
            absorb an aggregator commission. */
      for (const m of model.menu) {
        const r = m.price_restaurant === null ? null : num(m.price_restaurant);
        const p = m.price_platform === null ? null : num(m.price_platform);
        const s = prodSales(m.product_id);
        if (r && p && p <= r * 1.03)
          add({ code: "PLATFORM_PRICE_TOO_LOW", severity: "critical", area: "pricing",
                item: m.product_ar, itemEn: m.product_en, productId: m.product_id,
                message: `سعر المنصة ${p} لا يزيد عن سعر المطعم ${r} — لا هامش يستوعب عمولة التطبيق`,
                messageEn: `Platform price ${p} is not above restaurant price ${r} — nothing absorbs the aggregator commission`,
                evidence: { restaurant: r, platform: p, uplift: round3(p / r - 1),
                            platformFoodCostPct: round3(num(m.total_cost) / (p / (1 + VAT_RATE))) },
                salesValue: round2(s.value), units: round2(s.units), basis: "measured" });
        if (r && !p)
          add({ code: "PLATFORM_PRICE_MISSING", severity: "low", area: "pricing",
                item: m.product_ar, itemEn: m.product_en, productId: m.product_id,
                message: "لا يوجد سعر منصة لهذا الصنف — لا يمكن قياس هامش التوصيل",
                messageEn: "No platform price on file — the delivery margin cannot be measured",
                salesValue: round2(s.value), units: round2(s.units), basis: "measured" });
      }

      /* ── 8. Size mismatch. `item_costs` is keyed on the exact POS string, and
            whoever loaded it matched by name — so a medium pizza can end up
            carrying the LARGE recipe. It did, 29 times. This finding compares
            the size marker in the POS name against the one in the workbook
            product named in the cost row's own note. */
      for (const [name, row] of costs) {
        const note = String(row.note || "");
        if (!note.includes(NOTE_RECIPE)) continue;
        const wbName = norm(note.split("—")[0]);
        const a = portionSizeOf(name), b = portionSizeOf(wbName);
        if (!a || !b || a === b) continue;
        const s = salesByNameFor(sales, name);
        // What it should have been: the same dish at the POS line's own size.
        const want = model.menu.find((m) => norm(m.product_ar) ===
          norm(wbName.replace(/\(L\)/, "(M)").replace(/\(M\)/, "(L)")));
        const gap = want ? round3(num(row.cost) - num(want.total_cost)) : null;
        add({ code: "SIZE_COST_MISMATCH", severity: "critical", area: "pos", item: name,
              message: `صنف مقاس ${a} يحمل تكلفة وصفة مقاس ${b} («${wbName}»)`
                     + (gap === null ? "" : ` — فرق ${gap} ر.س للوحدة`),
              messageEn: `A size-${a} item is carrying the size-${b} recipe cost ("${wbName}")`
                     + (gap === null ? "" : ` — ${gap} SAR per unit`),
              gapSar: gap, evidence: { posSize: a, workbookSize: b, workbookItem: wbName,
                costUsed: num(row.cost),
                costExpected: want ? round3(num(want.total_cost)) : null },
              salesValue: round2(s.amount), units: round2(s.qty), basis: "measured",
              action: "صحّح صف التكلفة ليشير إلى وصفة المقاس الصحيح" });
      }

      /* ── 9. Margin alarm. Computed PER POS LINE from that line's own cost row
            and its own revenue — never through the workbook name mapping, which
            is exactly what finding 8 shows cannot be trusted for sizes. */
      const FC_ALARM = 0.45;
      for (const s of sales) {
        if (s.isModifier || s.amount <= 0 || s.qty <= 0) continue;
        const row = costs.get(s.name);
        if (!row) continue;
        const fc = num(row.cost) * s.qty / (s.amount / (1 + VAT_RATE));
        if (fc <= FC_ALARM) continue;
        add({ code: "FOOD_COST_HIGH", severity: fc > 0.6 ? "critical" : "high",
              area: "pricing", item: s.name,
              message: `نسبة تكلفة الطعام الفعلية ${(fc * 100).toFixed(1)}% مقابل هدف 22%`,
              messageEn: `Realised food cost ${(fc * 100).toFixed(1)}% against a 22% target`,
              evidence: { foodCostPct: round3(fc), unitCost: round3(num(row.cost)),
                          avgPriceIncl: round2(s.amount / s.qty),
                          costBucket: bucketOf(row) },
              salesValue: round2(s.amount), units: round2(s.qty), basis: "measured" });
      }

      const SEV = { critical: 0, high: 1, medium: 2, low: 3 };
      F.sort((a, b) => b.salesValue - a.salesValue || SEV[a.severity] - SEV[b.severity]);
      const byCode = {}, bySeverity = {};
      for (const f of F) {
        byCode[f.code] = (byCode[f.code] || 0) + 1;
        bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
      }
      const totalValue = sales.reduce((a, s) => a + s.amount, 0);
      // Union of the POS LINES whose cost depends on at least one assumed
      // input, then price that union once. Summing findings would double-count
      // every dish that has more than one problem.
      const byName = new Map(sales.map((s) => [s.name, s]));
      const atRisk = new Set();
      for (const f of F) if (f.basis === "assumed") for (const n of f.posNames) atRisk.add(n);
      let atRiskValue = 0;
      for (const n of atRisk) atRiskValue += byName.get(n)?.amount || 0;

      return c.json({
        from, to,
        findings: F,
        summary: {
          total: F.length, byCode, bySeverity,
          salesInWindow: round2(totalValue),
          // Revenue whose cost depends on at least one ASSUMED input. Distinct
          // items only, so overlapping findings are not double-counted.
          salesOnAssumedInputs: round2(atRiskValue),
          assumedShare: totalValue ? round3(atRiskValue / totalValue) : 0,
        },
        legend: {
          basis: { measured: "من بيانات فعلية (فواتير، وصفات، مبيعات)",
                   assumed: "رقم تقديري — لا تبنِ عليه قرار تسعير قبل التحقق" },
          severity: ["critical", "high", "medium", "low"],
          note: "مرتبة حسب قيمة المبيعات المعتمدة على الرقم المشكوك فيه، لا حسب صخب التنبيه",
        },
      });
    } catch (e) {
      console.error("[costing] health failed:", e);
      return c.json({ error: "health_failed", detail: e.message }, 500);
    }
  });

  /* ── Small shared helpers used by more than one route. ───────────────────── */
  const CONFIDENCE_MEANING = {
    measured: "كل المكونات لها سعر شراء معروف",
    guess: "أحد المكونات سعره تقديري (Review في ملف التكاليف)",
    plug: "أحد المكونات تشغيلة بدون وصفة — الرقم مؤقت",
    missing: "أحد المكونات بلا تكلفة إطلاقاً — التكلفة ناقصة",
  };

  const salesByNameFor = (sales, name) =>
    sales.find((s) => s.name === name) || { qty: 0, amount: 0, orders: 0 };

  function menuBrief(m) {
    return { productId: m.product_id, sku: m.sku || "", nameAr: m.product_ar,
             nameEn: m.product_en || "", categoryAr: m.category_ar || "",
             categoryEn: m.category_en || "" };
  }

  /** Both price tiers and what each implies, from ONE cost. The restaurant and
   *  platform food-cost percentages are the reason the older workbook still
   *  matters — the newer one only carries a single price. */
  function pricingOf(m, cost) {
    const c = cost === null || cost === undefined ? num(m.total_cost) : cost;
    const pct = (p) => (p ? round3(c / (num(p) / (1 + VAT_RATE))) : null);
    const r = m.price_restaurant === null ? null : num(m.price_restaurant);
    const p = m.price_platform === null ? null : num(m.price_platform);
    return {
      cost: round3(c),
      priceSuggestedIncl: m.price_suggested === null ? null : num(m.price_suggested),
      priceRestaurantIncl: r, pricePlatformIncl: p,
      foodCostPctRestaurant: pct(r), foodCostPctPlatform: pct(p),
      platformUplift: r && p ? round3(p / r - 1) : null,
      // The workbook labels this column "Suggested Price" but it equals Omar's
      // CURRENT restaurant price on all 78 items — the 22% target formula in
      // Config was never applied. Do not read it as a recommendation.
      suggestedIsCurrentPrice: r !== null && m.price_suggested !== null
        && Math.abs(num(m.price_suggested) - r) < 0.005,
    };
  }

  /** Menu products that consume a batch, directly or one level down. */
  function dependentsOfBatch(model, batchKey) {
    const direct = new Set();
    for (const [pid, lines] of model.recipeLines)
      for (const l of lines) {
        const res = resolve(model, l.ing_type, l.ing_ar);
        if (res.kind === "batch" && res.canonical === batchKey) { direct.add(pid); break; }
        if (res.kind === "batch") {
          for (const bl of model.batchLines.get(res.canonical) || []) {
            const br = resolve(model, bl.ing_type, bl.ing_ar);
            if (br.kind === "batch" && br.canonical === batchKey) { direct.add(pid); break; }
          }
        }
      }
    return [...direct];
  }

  /** The portion of an ingredient this kitchen actually uses, taken as the
   *  MEDIAN of every non-zero quantity of it anywhere in the recipe book.
   *  Used only to SIZE a hole where a quantity is missing — never to fill one.
   *  Falls back to 20 g, which is a scoop of most things. */
  function typicalQtyG(model, ingKey) {
    const qs = [];
    for (const lines of [...model.recipeLines.values(), ...model.batchLines.values()])
      for (const l of lines)
        if (norm(l.ing_ar) === ingKey && num(l.qty_g) > 0) qs.push(num(l.qty_g));
    if (!qs.length) return 20;
    qs.sort((a, b) => a - b);
    return qs[Math.floor(qs.length / 2)];
  }

  /** GRAMS of a batch consumed per unit of each dependent dish — direct use
   *  plus the share arriving through a batch that itself consumes it.
   *
   *  This is what turns a batch finding from "SAR 16,050 of sales touch this"
   *  into "SAR 22 of COGS actually moves". A finding whose impact is the SALES
   *  it touches rather than the MONEY it moves ranks a 0.5% error on a big
   *  seller above a 20% error on a small one, which is exactly backwards. */
  function batchGramsPerUnit(model, batchKey) {
    const out = new Map();          // productId -> grams of this batch per unit
    for (const [pid, lines] of model.recipeLines) {
      let g = 0;
      for (const l of lines) {
        const res = resolve(model, l.ing_type, l.ing_ar);
        if (res.kind !== "batch") continue;
        if (res.canonical === batchKey) { g += num(l.qty_g); continue; }
        // One level down: this batch inside that batch, pro-rata by output.
        const sub = model.batch.get(res.canonical);
        const subOut = sub ? num(sub.output_g) : 0;
        if (!subOut) continue;
        for (const bl of model.batchLines.get(res.canonical) || []) {
          const br = resolve(model, bl.ing_type, bl.ing_ar);
          if (br.kind === "batch" && br.canonical === batchKey)
            g += num(l.qty_g) * (num(bl.qty_g) / subOut);
        }
      }
      if (g > 0) out.set(pid, g);
    }
    return out;
  }

  /** Menu products exposed to a raw material, with the SAR of that raw inside
   *  one unit of the dish — direct use plus its share of any batch it feeds. */
  function dependentsOfRaw(model, rawKey) {
    const raw = model.raw.get(rawKey);
    const perG = raw && raw.cost_per_g !== null ? num(raw.cost_per_g) : 0;
    // grams of this raw inside 1 g of each batch
    const inBatch = new Map();
    for (const [bk, lines] of model.batchLines) {
      const b = model.batch.get(bk);
      const out = b ? num(b.output_g) : 0;
      if (!out) continue;
      let g = 0;
      for (const l of lines) {
        const res = resolve(model, l.ing_type, l.ing_ar);
        if (res.kind === "raw" && res.canonical === rawKey) g += num(l.qty_g);
      }
      if (g > 0) inBatch.set(bk, g / out);
    }
    const out = [];
    for (const [pid, lines] of model.recipeLines) {
      const m = model.menuById.get(pid);
      if (!m) continue;
      let grams = 0;
      for (const l of lines) {
        const res = resolve(model, l.ing_type, l.ing_ar);
        if (res.kind === "raw" && res.canonical === rawKey) grams += num(l.qty_g);
        else if (res.kind === "batch" && inBatch.has(res.canonical))
          grams += num(l.qty_g) * inBatch.get(res.canonical);
      }
      if (grams <= 0) continue;
      const exposure = grams * perG;
      out.push({ productId: pid, item: m.product_ar, grams: round3(grams),
                 exposureSar: exposure,
                 share: num(m.total_cost) ? round3(exposure / num(m.total_cost)) : null });
    }
    return out.sort((a, b) => b.exposureSar - a.exposureSar);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     ═══════════════════════ THE COSTING WORKBENCH ═══════════════════════════

     Everything above answers "is this number trustworthy?". Everything below
     is where the manager FIXES it — one item at a time, ranked by money, with
     a record of who changed what.

     ── The four things the imported workbook could not express ───────────────

     1. A PRICE IS A FACT ON A DATE. `cw_material_prices` is append-only by
        (material, effective_from). Every cost lookup takes an `asOf` day and
        resolves the newest price not later than it — the same discipline
        `item_costs.effective_from` already gives finance.js. Re-running last
        month's P&L after a supplier raises a price gives last month's answer.

     2. YIELD IS TWO DIFFERENT THINGS, AT TWO DIFFERENT LEVELS.
        • TRIM loss lives on the material: the share of a purchased kilo you
          throw away before it ever meets heat (bone, fat cap, outer leaves).
              effective SAR/usable-g = purchase SAR/g ÷ (1 − trim_loss)
          This is Omar's ribs case. He buys ribs at 90 SAR/kg and types 110
          into the sheet so the number "comes out right". 110 = 90 ÷ (1 − 0.18).
          Enter 90 as the purchase price and 18% as the trim loss and the model
          produces 110 by itself — and now the 110 is derived, dated and
          arguable instead of a hand-typed constant nobody can audit.
        • COOKING loss lives on the batch: output weight ÷ input weight. The
          imported workbook asserts 1.00 for all 20 batches, which for grilled
          meat is impossible. Set `yield_pct` and the batch's SAR/g rises by
          exactly the water it lost.
        There is a third slot, `cw_item_yield.cook_loss_pct`, and it defaults
        to NULL on every item ON PURPOSE: Omar's recipe weights are PRE-cooking,
        so the raw grams × raw price is already the right cost. Applying a
        blanket cooking loss on top would count the same shrinkage twice. It
        exists only for the individual item somebody later discovers was
        written in served weight.

     3. PACKAGING IS CONSUMED AT THREE LEVELS, AND ONLY ONE OF THEM IS A LINE
        ITEM. See orderPackagingFor() below — this is the part that is easiest
        to get quietly, expensively wrong.

     4. A NUMBER HAS A REVIEW STATE. `cw_item_review` — unreviewed / in_review
        / confirmed / needs_info, with who and when. `confirmed` is a promise
        the import path honours (importGuard).

     Nothing here is seeded with a plausible-looking zero. Packaging arrives
     with `unit_cost = NULL` because Omar named the boxes, he did not price
     them — and a 0.00 box would quietly tell the P&L that packaging is free.
     ═══════════════════════════════════════════════════════════════════════ */

  const isoDayOf = (d) =>
    d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null;

  /** A loss percentage, accepting either 0.18 or 18. NULL for anything that is
   *  not a measurement — an unmeasured loss is not a zero loss. */
  const asPct = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    const p = n > 1 ? n / 100 : n;
    return Math.min(p, 0.95);          // a 100% loss is not a yield, it is a bin
  };
  /** A yield (output ÷ input), accepting 0.82 or 82. NULL when unset. */
  const asYield = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    const p = n > 1 ? n / 100 : n;
    return Math.min(Math.max(p, 0.05), 1);
  };

  /* Which materials plausibly LOSE weight on the PREP BENCH — bone, fat cap,
     silverskin, outer leaves — i.e. which ones are worth a trim test.

     This list is deliberately tight. An earlier, broader pattern run against
     the live 129-material list produced trim-loss tasks for `فلفل رومي` (a bell
     pepper, caught by رومي = turkey) and `مرقة دجاج ( بهارات دجاج )` (a spice
     blend, caught by دجاج). A queue that asks the manager to weigh the trim off
     a bag of seasoning teaches him to ignore the queue. */
  const TRIMMABLE_RE = /لحم|ريش|كبدة|صدور|فيليه|دجاجة|فراخ|أوراك|اوراك|بسطرم|سجق|جمبري|روبيان|تونة|تونه|سمك|ضاني|خروف/;
  const NOT_TRIMMABLE_RE = /بهار|مرقة|مرقه|توابل|فلفل|صوص|مسحوق|بودرة|بودره|مكعب|زيت|ملح/;

  /* ══════════════════════════════════════════════════════════════════════════
     WHY "OUTPUT = INPUT" IS THE RIGHT ANSWER FOR MOST BATCHES HERE
     ─────────────────────────────────────────────────────────────────────────
     This module used to raise `BATCH_NO_YIELD_LOSS` on any batch whose output
     weight equalled its input sum while containing protein, on the reasoning
     that "meat loses weight when you cook it". At the top of the live queue
     that produced three findings worth SAR 3,288 (الصدور), 2,263 (الكفتة) and
     1,929 (شيش طاووق). **All three were wrong**, and the error was the model's,
     not the data's.

     Omar's operation, as he describes it: he makes 5 kg of marinated chicken
     breast and it stays 5 kg. A meal takes 300 g of it. **That 300 g is a
     PRE-COOKING weight** — it is scooped out of the tub, weighed raw, and put
     on the grill. So:

         batch cost per raw gram  ×  raw grams in the portion  =  the cost

     is complete and correct. The shrinkage on the grill is real, but it happens
     AFTER the portion has left the tub, so it changes what lands on the plate,
     not what left the store. Charging a cooking loss against a raw-weighed
     portion would count meat Omar never bought. It is the classic double-count
     and it makes every grill dish look 20% more expensive than it is.

     A yield belongs on a batch only when the batch is COOKED BEFORE IT IS
     PORTIONED — i.e. the recipe's grams are grams of the FINISHED thing, so the
     kilo you are dividing by is smaller than the kilo you bought. On this menu
     four batches are in that state, and they were found by reading the recipes,
     not by pattern-matching the names:

       صوص البيتزا   5 kg of FRESH tomato + oil, garlic, sugar, basil, oregano.
                     Raw blended tomato is water; it slides off a pizza and
                     steams the base. This is a cooked marinara and it is the
                     largest unmodelled reduction in the workbook.
       الوايت صوص    A béchamel: milk + water + flour, simmered, and infused
                     with whole bay/cardamom/clove plus onion and celery that
                     are STRAINED OUT. Both the evaporation and the strainer
                     are weight that never reaches the portion.
       البيف كازرول  A braise — 2 kg beef with 1.7 L of water and demi-glace.
                     Nobody serves a braise at its input weight.
       اللحمة المفرومة  Whole bay leaf and cardamom in a minced-meat mix means a
                     pot, not a bowl; a raw kofta mix (الكفتة) has neither. Fat
                     and water render off. This one is a chef's read of the
                     ingredient list, not a measurement — flagged as such.

     And the batches where output = input is CORRECT and must be left alone:
       الصدور, شيش طاووق, الكفتة, الحواوشي, البرجر, برجر كوردن بلو  — marinated
         or formed raw, portioned raw, cooked to order.
       عجينة البيتزا, خضار فرشة  — nothing is cooked at all.
     Two batches already carry a measured loss (فراخ فحم, الطحينة, عجينة الكريب,
     السلطة الحاتي) and one already models a GAIN (الأرز المطبوخ: 1 kg raw rice
     → 2.5 kg cooked). None of them needs anything.

     DO NOT re-add a blanket protein-share yield rule. If a future batch really
     is cooked before portioning, add it here with the reason, or set
     `cost_batches.cooked_before_portioning` on the row.
     ══════════════════════════════════════════════════════════════════════════ */
  const COOKED_BATCHES = new Map([
    ["صوص البيتزا", { evidence: "measured",
      why: "٥ كجم طماطم طازة بتتطبخ وتتشرب — الناتج أقل من المدخل بفارق كبير" }],
    ["الوايت صوص", { evidence: "measured",
      why: "بشاميل بيتسوّى على النار، والبصل والكرفس وورق اللورى بيتصفّوا منه" }],
    ["البيف كازرول", { evidence: "measured",
      why: "طبخة لحم بـ١٫٧ لتر ماء — الناتج بعد الطبخ أقل من المدخل" }],
    ["اللحمة المفرومة", { evidence: "judgement",
      why: "ورق لورى وحبهان في خلطة مفروم = طبخ في حلة، والدهن والمية بينزلوا" }],
  ]);
  /** TRUE only for a batch that is cooked BEFORE it is portioned. The DB column
   *  is a human override and always wins over the table above. */
  function isCookedBatch(key, b) {
    if (b && b.cooked_before_portioning === true) return true;
    if (b && b.cooked_before_portioning === false) return false;
    return COOKED_BATCHES.has(norm(key));
  }

  const UNIT_G = { g: 1, gm: 1, gram: 1, ml: 1, "جم": 1, "غم": 1, "مل": 1,
                   kg: 1000, l: 1000, lt: 1000, litre: 1000, liter: 1000,
                   "كجم": 1000, "كيلو": 1000, "لتر": 1000, "ليتر": 1000 };
  const PIECE_UNITS = new Set(["piece", "pieces", "pcs", "pc", "unit", "each",
                               "حبة", "قطعة", "عدد", "رغيف"]);
  /** Grams for a qty+unit, or NULL when the unit is a countable piece — a piece
   *  has no gram equivalent and must be costed off `cost_per_piece`. */
  function toGrams(qty, unit) {
    const u = String(unit || "g").trim().toLowerCase();
    if (PIECE_UNITS.has(u)) return null;
    const f = UNIT_G[u];
    return f === undefined ? num(qty) : num(qty) * f;
  }

  /* ── Seeds ────────────────────────────────────────────────────────────────
     Omar named these eleven packaging items out loud. Their COSTS he did not,
     so every one arrives NULL and the queue's first packaging task is "price
     them". The rules below are his words turned into attachments, all flagged
     `reviewed=false` so the workbench asks him to confirm them rather than
     pretending they are settled. */
  const PACKAGING_SEED = [
    ["pkg_box_pizza",   "علبة بيتزا",       "Pizza box"],
    ["pkg_box_doritos", "علبة دوريتوس",     "Doritos box"],
    ["pkg_box_fries",   "علبة فرايز",       "Fries box"],
    ["pkg_box_crepe",   "علبة كريب",        "Crepe box"],
    ["pkg_box_meal",    "علبة وجبة",        "Meal box"],
    ["pkg_fork",        "شوكة",             "Fork"],
    ["pkg_spoon",       "ملعقة",            "Spoon"],
    ["pkg_bag_small",   "كيس ورق صغير",     "Small paper bag"],
    ["pkg_bag_large",   "كيس ورق كبير",     "Large paper bag"],
    ["pkg_sticker",     "ستيكر الطلب",      "Order sticker"],
    ["pkg_wipe",        "منديل مبلل معطر",  "Scented wet wipe"],
  ];
  /* [scope, match_kind, match_value, packaging_id, qty]
     Matched on CATEGORY where the menu has one — the workbook's eight
     categories (بيتزا 26, كريبات 10, باستا 9, مقبلات 8, برجر 8, وجبات 7,
     طاسات 5, سندوتشات 5) are a far better key than a substring, and a
     substring rule on "بيتزا" would also have caught anything merely named
     after it. `فرايز` stays a name match because the fries boxes cut across
     مقبلات rather than being a category.

     Five categories — باستا, برجر, سندوتشات, طاسات, مقبلات, 32 items — get NO
     rule here, because Omar did not say what they are served in. That gap is
     surfaced as a task (PACKAGING_NO_RULE), not filled with a guess. The
     doritos box likewise has no rule: nothing in the costed menu is a doritos
     item, so the box is real but its attachment is unknown. */
  const RULE_SEED = [
    ["item",    "category", "بيتزا",    "pkg_box_pizza",   1],
    ["item",    "category", "كريبات",   "pkg_box_crepe",   1],
    ["item",    "category", "وجبات",    "pkg_box_meal",    1],
    ["item",    "category", "وجبات",    "pkg_fork",        1],
    ["item",    "category", "وجبات",    "pkg_spoon",       1],
    ["item",    "name",     "فرايز",    "pkg_box_fries",   1],
    ["order",   "all",      "",         "pkg_sticker",     1],
    ["order",   "all",      "",         "pkg_wipe",        1],
    ["channel", "channel",  "delivery", "pkg_bag_large",   1],
    ["channel", "channel",  "takeaway", "pkg_bag_small",   1],
    // dine-in deliberately has NO bag rule. Its absence is the model.
  ];

  /* The ribs trim loss Omar's own 90-vs-110 implies, and the marker that says
     it is still an inference. Clearing the marker (or changing the number)
     retires the task. */
  const RIBS_TRIM_ASSUMED = 1 - 90 / 110;          // 0.18181818…
  const RIBS_YIELD_SENTINEL = "نسبة مفترضة من فرق 90/110";

  const CHANNELS = [
    { key: "delivery", ar: "توصيل" },
    { key: "takeaway", ar: "سفري" },
    { key: "dinein",   ar: "صالة" },
  ];

  async function seedWorkbenchIfEmpty() {
    const empty = async (t) =>
      num((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n) === 0;

    // The imported workbook price becomes the row that has been true "since
    // forever", tagged with what it actually is. The materials the workbook
    // itself flagged REVIEW become `estimate` — that is the audit's SAR 163
    // of guessed sauces, now labelled in the data instead of in a comment.
    if (await empty("cw_material_prices")) {
      await pool.query(`
        INSERT INTO cw_material_prices
          (id, canonical_ar, purchase_unit, price, cost_per_g, cost_per_piece,
           effective_from, source, note)
        SELECT 'mp_' || substr(md5(canonical_ar), 1, 20), canonical_ar, purchase_unit,
               cost_per_unit, cost_per_g, cost_per_piece, DATE '2000-01-01',
               CASE WHEN upper(status) = 'REVIEW' THEN 'estimate' ELSE 'workbook' END,
               'من ملف التكاليف عند أول تشغيل — بدون فاتورة'
          FROM cost_raw_materials
        ON CONFLICT (canonical_ar, effective_from) DO NOTHING`);
      console.log("[costing] seeded cw_material_prices from the imported workbook");
    }

    if (await empty("cw_packaging")) {
      for (const [id, ar, en] of PACKAGING_SEED)
        await pool.query(
          `INSERT INTO cw_packaging (id, name_ar, name_en, unit_cost, note)
           VALUES ($1,$2,$3,NULL,$4) ON CONFLICT (id) DO NOTHING`,
          [id, ar, en, "سمّاه عمر — لم يُسعّر بعد"]);
      console.log(`[costing] seeded ${PACKAGING_SEED.length} packaging items, all unpriced`);
    }

    if (await empty("cw_packaging_rules")) {
      for (const [scope, kind, value, pkg, qty] of RULE_SEED)
        await pool.query(
          `INSERT INTO cw_packaging_rules
             (id, scope, match_kind, match_value, packaging_id, qty, reviewed, note)
           VALUES ($1,$2,$3,$4,$5,$6,false,$7) ON CONFLICT (id) DO NOTHING`,
          [idFor("pr", scope, kind, value, pkg), scope, kind, value, pkg, qty,
           "قاعدة مبدئية من كلام عمر — تحتاج مراجعة"]);
      console.log(`[costing] seeded ${RULE_SEED.length} packaging rules, none reviewed`);
    }

    /* ── Omar's ribs, made expressible ──────────────────────────────────────
       `GRILL_FAMILIES` prices ريش at 36.63 SAR for a ثلث portion — 333 g at
       110 SAR/kg. Omar told us the true purchase price is 90; he typed 110 so
       the number would "come out right" after trim and cooking loss. That
       makes 110 a constant nobody can audit and 90 a fact nobody can see.

       There is no `ريش` row in the 129 imported raw materials (checked against
       the live table) — the weight-sold grills never went through the recipe
       engine at all. So we create one, and we create it as the DERIVATION
       rather than the answer:

           90 ÷ (1 − 0.1818) = 110.0 SAR/kg

       The 0.1818 is not a measurement; it is the loss Omar's own two numbers
       imply, and `yield_note` says so. The queue asks him to confirm it, and
       the moment he weighs a real box of ribs the 110 moves by itself. */
    if (!(await pool.query(
      "SELECT 1 FROM cost_raw_materials WHERE canonical_ar = 'ريش'")).rowCount) {
      await pool.query(
        `INSERT INTO cost_raw_materials
           (canonical_ar, name_en, purchase_unit, cost_per_unit, cost_per_g,
            status, note, trim_loss_pct, yield_note)
         VALUES ('ريش','Lamb ribs','kg',90,0.09,'REVIEW',$1,$2,$3)
         ON CONFLICT (canonical_ar) DO NOTHING`,
        ["سعر الشراء الحقيقي حسب عمر — 90 ر.س/كجم",
         RIBS_TRIM_ASSUMED,
         RIBS_YIELD_SENTINEL + " — 110 ÷ 90 يعني فاقد 18.18%. رقم مستنتج من كلام عمر، "
         + "مش من ميزان. زِن صندوق ريش قبل وبعد التنظيف والشوي وصحّح النسبة."]);
      await pool.query(
        `INSERT INTO cw_material_prices
           (id, canonical_ar, purchase_unit, price, cost_per_g, effective_from, source, note)
         VALUES ($1,'ريش','kg',90,0.09,DATE '2000-01-01','estimate',$2)
         ON CONFLICT (canonical_ar, effective_from) DO NOTHING`,
        [idFor("mp", "ريش", "2000-01-01"), "سعر عمر — يحتاج فاتورة"]);
      console.log("[costing] seeded ريش at 90 SAR/kg + 18.18% assumed trim loss (derives the 110)");
    }

    // Depends on `item_costs` and `ts_order_items`, which other modules create.
    // If we lost that race the map is simply rebuilt on the next boot, or on
    // demand via POST /api/costing/remap — it must not abort the whole schema.
    if (await empty("cw_item_pos"))
      await rebuildPosMap().catch((e) =>
        console.warn("[costing] cw_item_pos seed deferred:", e.message));
  }

  /** Hono has already percent-decoded a path param, but an Arabic name that
   *  genuinely contains '%' would make a second decode throw. Try, then keep
   *  what we were given. */
  const safeDecode = (s) => {
    try { return decodeURIComponent(String(s || "")); } catch { return String(s || ""); }
  };

  /* ── POS name → workbook product ─────────────────────────────────────────
     The old route derived this by parsing `item_costs.note`. That worked only
     while the recipe loader owned the note; the workbench rewrites it, so the
     mapping is promoted to a table. Rebuilt non-destructively: a row a human
     added by hand (`source='manual'`) is never overwritten. */
  async function rebuildPosMap() {
    const model = await loadModel();
    const byAr = new Map(model.menu.map((m) => [norm(m.product_ar), m]));
    const found = new Map();          // pos_name -> [product_id, source]

    const costRows = (await pool.query(
      `SELECT DISTINCT ON (item_name) item_name, note
         FROM item_costs ORDER BY item_name, effective_from DESC`)).rows;
    for (const r of costRows) {
      const n = String(r.note || "");
      if (!n.includes(NOTE_RECIPE) && !n.includes(NOTE_WORKBENCH)) continue;
      const hit = byAr.get(norm(n.split("—")[0]));
      if (hit) found.set(r.item_name, [hit.product_id, "note"]);
    }
    // Plus every POS line whose name IS a workbook name, cost row or not.
    const sold = (await pool.query(
      `SELECT DISTINCT name FROM ts_order_items WHERE name IS NOT NULL`)).rows;
    for (const s of sold) {
      if (found.has(s.name)) continue;
      const hit = byAr.get(norm(s.name));
      if (hit) found.set(s.name, [hit.product_id, "exact"]);
    }

    let n = 0;
    for (const [name, [pid, src]] of found) {
      const r = await pool.query(
        `INSERT INTO cw_item_pos (pos_name, product_id, source) VALUES ($1,$2,$3)
         ON CONFLICT (pos_name) DO NOTHING`, [name, pid, src]);
      n += r.rowCount;
    }
    if (n) console.log(`[costing] cw_item_pos: linked ${n} POS name(s) to workbook products`);
    return n;
  }

  /* ── The dated, yield-aware model ────────────────────────────────────────── */

  async function loadWorkbench(asOf) {
    const day = isDay(asOf) ? asOf : todayISO();
    const [prices, pkg, rules, iy, review, posmap] = await Promise.all([
      pool.query(
        `SELECT DISTINCT ON (canonical_ar) * FROM cw_material_prices
          WHERE effective_from <= $1::date
          ORDER BY canonical_ar, effective_from DESC`, [day]),
      pool.query("SELECT * FROM cw_packaging ORDER BY name_ar"),
      pool.query("SELECT * FROM cw_packaging_rules ORDER BY scope, match_kind, match_value"),
      pool.query("SELECT * FROM cw_item_yield"),
      pool.query("SELECT * FROM cw_item_review"),
      pool.query("SELECT * FROM cw_item_pos"),
    ]);
    const wb = {
      asOf: day,
      prices: new Map(prices.rows.map((r) => [norm(r.canonical_ar), r])),
      packaging: pkg.rows,
      packagingById: new Map(pkg.rows.map((r) => [r.id, r])),
      rules: rules.rows,
      itemYield: new Map(iy.rows.map((r) => [r.product_id, r])),
      review: new Map(review.rows.map((r) => [r.product_id, r])),
      posByName: new Map(posmap.rows.map((r) => [norm(r.pos_name), r.product_id])),
      posByProduct: new Map(),
      batchCache: new Map(),
    };
    for (const r of posmap.rows) {
      if (!wb.posByProduct.has(r.product_id)) wb.posByProduct.set(r.product_id, []);
      wb.posByProduct.get(r.product_id).push(r.pos_name);
    }
    return wb;
  }

  /* ── THE TRIM TEST ────────────────────────────────────────────────────────
     The one genuine yield loss in this operation that the workbook never
     captured. Omar buys a kilo of ribs, cleans it, and ~820 g survives. Bone,
     fat cap, silverskin and the outer leaves of a cabbage are weight he paid
     for and can never sell.

     It is entered as TWO WEIGHTS, never as a percentage:

         bought 1000 g  →  usable 820 g
         loss  = 1 − 820/1000 = 18%
         cost  = purchase SAR/kg ÷ (1 − 0.18) = purchase × 1.2195

     Both weights come off the same scale on the same afternoon, which is a
     thing a kitchen can actually do. A percentage is a thing a kitchen quietly
     never does, and an unentered number is worth nothing however elegant the
     column is. `trimFrom()` reads the weights first and only falls back to a
     typed percentage for rows that predate the two-weight model.

     Note carefully what this is NOT: it is not a cooking loss. It happens on
     the prep bench, BEFORE the raw material reaches a batch or a recipe, so it
     scales the price per gram and every consumer — recipe line, batch line,
     nested batch — inherits it automatically through `effRaw`. There is no
     second place to apply it and no risk of applying it twice. */
  function trimFrom(base) {
    const bought = base?.trim_bought_g === null || base?.trim_bought_g === undefined
      ? null : num(base.trim_bought_g);
    const usable = base?.trim_usable_g === null || base?.trim_usable_g === undefined
      ? null : num(base.trim_usable_g);
    // Two weights that make physical sense beat anything typed.
    if (bought !== null && usable !== null && bought > 0 && usable > 0 && usable <= bought) {
      const pct = asPct(1 - usable / bought);
      return { pct, boughtG: bought, usableG: usable, source: "weighed" };
    }
    const typed = asPct(base?.trim_loss_pct);
    return { pct: typed, boughtG: bought, usableG: usable,
             source: typed === null ? "" : String(base?.trim_source || "assumed") };
  }

  /** A raw material's cost per USABLE gram on `wb.asOf`, and the paper trail.
   *  This is the whole of point 2 above in six lines. */
  function effRaw(model, wb, canonical) {
    const base = model.raw.get(canonical) || null;
    const p = wb.prices.get(canonical) || null;
    const pick = (a, b) => (a !== null && a !== undefined ? num(a)
                          : b !== null && b !== undefined ? num(b) : null);
    const purchasePerG = pick(p?.cost_per_g, base?.cost_per_g);
    const purchasePerPiece = pick(p?.cost_per_piece, base?.cost_per_piece);
    const trim = trimFrom(base);
    const loss = trim.pct;
    const f = loss === null ? 1 : 1 / (1 - loss);
    const status = String(base?.status || "").toUpperCase();
    const source = p ? String(p.source || "workbook") : (base ? "workbook" : null);
    return {
      found: !!(base || p),
      purchasePerG, purchasePerPiece,
      perG: purchasePerG === null ? null : purchasePerG * f,
      perPiece: purchasePerPiece === null ? null : purchasePerPiece * f,
      trimLossPct: loss, yieldFactor: f,
      // The two weights, so the screen can show the measurement rather than
      // the arithmetic derived from it.
      trimBoughtG: trim.boughtG, trimUsableG: trim.usableG,
      trimSource: trim.source,          // weighed | assumed | ''
      trimWeighed: trim.source === "weighed",
      priceSource: source,
      verified: source === "invoice",
      supplier: String(p?.supplier || base?.supplier || ""),
      purchaseUnit: String(p?.purchase_unit || base?.purchase_unit || ""),
      pricePerUnit: pick(p?.price, base?.cost_per_unit),
      effectiveFrom: p ? isoDayOf(p.effective_from) : null,
      flaggedReview: status === "REVIEW",
      note: String(p?.note || base?.note || ""),
      yieldNote: String(base?.yield_note || ""),
    };
  }

  /** The trim arithmetic spelled out for the screen, or NULL when untested. */
  function trimMathOf(e) {
    if (e.trimLossPct === null || e.purchasePerG === null) return null;
    const pctTxt = `${round2(e.trimLossPct * 100)}%`;
    return {
      boughtG: e.trimBoughtG, usableG: e.trimUsableG,
      trimLossPct: e.trimLossPct, source: e.trimSource,
      purchaseSarPerKg: round3(e.purchasePerG * 1000),
      effectiveSarPerKg: round3(e.perG * 1000),
      formula: e.trimWeighed
        ? `اشتريت ${round2(e.trimBoughtG)} جم ← طلع ${round2(e.trimUsableG)} جم `
          + `(فاقد ${pctTxt}) — ${round3(e.purchasePerG * 1000)} ÷ (1 − ${round3(e.trimLossPct)}) `
          + `= ${round3(e.perG * 1000)} ر.س/كجم`
        : `نسبة مكتوبة ${pctTxt} بدون وزنتين — ${round3(e.purchasePerG * 1000)} ÷ `
          + `(1 − ${round3(e.trimLossPct)}) = ${round3(e.perG * 1000)} ر.س/كجم`,
    };
  }

  /** A batch's cost per gram OF OUTPUT on `wb.asOf`, with the cooking loss
   *  applied. Memoised per workbench load; recursive (a batch may consume a
   *  batch) with a cycle guard, and a result that touched a cycle is never
   *  cached because it is not the true answer, only a safe one. */
  function effBatch(model, wb, key, stack = []) {
    const hit = wb.batchCache.get(key);
    if (hit) return hit;
    if (stack.includes(key))
      return { perG: null, cycle: true, hadCycle: true, confidence: "missing",
               lines: [], inputG: null, outputG: null, totalCost: null, batch: null };

    const b = model.batch.get(key);
    if (!b)
      return { perG: null, missing: true, hadCycle: false, confidence: "missing",
               lines: [], inputG: null, outputG: null, totalCost: null, batch: null };

    const lines = model.batchLines.get(key) || [];
    const next = [...stack, key];
    let cost = 0, inputG = 0, conf = "measured", hadCycle = false;
    const rows = [];
    for (const l of lines) {
      const res = resolve(model, l.ing_type, l.ing_ar);
      const e = effLine(model, wb, res, l, next);
      cost += e.cost; inputG += num(l.qty_g);
      conf = worst(conf, e.confidence);
      hadCycle = hadCycle || e.hadCycle;
      rows.push(e.row);
    }

    const yieldPct = asYield(b.yield_pct);
    const storedOut = b.output_g === null || b.output_g === undefined ? null : num(b.output_g);
    const cooked = isCookedBatch(key, b);

    /* ── The conservation-of-mass cap ─────────────────────────────────────────
       A batch that is NOT cooked before portioning cannot produce more than
       went into it. Three live batches claim it does, because the workbook set
       the output cell by hand and then somebody zeroed an ingredient without
       revisiting it:

         البرجر    5,285 g in  →  6,280 g out  (لحم وش فخدة and بوش are 0 g)
         الكلوسلو  1,920 g in  →  2,005 g out
         الكفتة    6,867 g in  →  6,994 g out
         شيش طاووق 5,281 g in  →  5,351 g out

       Dividing the real cost by a phantom output UNDERSTATES the cost per
       gram — البرجر by 18.8%, and البرجر feeds a burger, a pizza, a crepe and
       a طاسة. So a raw batch's output is capped at its input. The cap is
       one-directional on purpose: a stored output BELOW the input is somebody
       recording a real loss (bowl residue in عجينة الكريب, water excluded from
       السلطة الحاتي) and is left exactly as entered. Correcting upward would
       be inventing a saving. */
    const outputCapped = !cooked && yieldPct === null
      && storedOut !== null && inputG > 0 && storedOut > inputG + 0.5;

    // Priority: an explicit yield beats a stored output weight, because the
    // stored weight in the imported workbook is the input sum wearing a hat.
    const outputG = yieldPct !== null && inputG > 0 ? inputG * yieldPct
                  : outputCapped ? inputG
                  : storedOut && storedOut > 0 ? storedOut
                  : inputG > 0 ? inputG : null;

    let perG = null, plug = false;
    if (!lines.length) {
      // No recipe was ever entered. Whatever SAR/g the workbook carries is a
      // plug, and saying so is the single most valuable thing this file does.
      perG = b.cost_per_g === null || b.cost_per_g === undefined ? null : num(b.cost_per_g);
      plug = true; conf = "plug";
    } else if (outputG && outputG > 0) {
      perG = cost / outputG;
      /* The Tarb trap. عجينة الطرب HAS two lines — 1000 g of kofta mix and
         500 g of caul fat — so it recomputes cleanly and would otherwise be
         graded 'measured'. But its own note says the recipe is missing, and it
         is: tarb is not kofta. An arithmetic that reconciles is not evidence
         that the inputs are the right inputs. The note is the truth, and it
         downgrades the whole dependent tree — including وجبة ميكس جريل, the
         best-selling item in the business. */
      if (/missing recipe/i.test(b.note || "")) { plug = true; conf = "plug"; }
    }

    const r = {
      key, perG, plug, hadCycle, lines: rows,
      inputG: inputG || null, outputG: outputG || null,
      storedOutputG: storedOut, outputMeasured: b.output_measured === true,
      yieldPct, yieldAssumed: yieldPct === null,
      /* `cookedBeforePortioning` is the flag that decides whether a missing
         yield is a finding or a fact. FALSE means the recipe's grams are raw
         grams and output = input is correct — do not "fix" it. */
      cookedBeforePortioning: cooked,
      cookedReason: cooked
        ? (b.cooked_before_portioning === true ? "محدّدة يدويًا"
           : COOKED_BATCHES.get(norm(key))?.why || "")
        : "",
      cookedEvidence: cooked
        ? (b.cooked_before_portioning === true ? "manual"
           : COOKED_BATCHES.get(norm(key))?.evidence || "")
        : null,
      outputCapped, capGainG: outputCapped ? round3(storedOut - inputG) : 0,
      // The number Omar can argue with: what the batch costs per kilo now, and
      // what it costed before the yield was applied.
      sarPerKg: perG === null ? null : round3(perG * 1000),
      sarPerKgBeforeYield: lines.length && inputG > 0 ? round3((cost / inputG) * 1000) : null,
      storedSarPerKg: b.cost_per_g === null || b.cost_per_g === undefined
        ? null : round3(num(b.cost_per_g) * 1000),
      totalCost: round3(cost), confidence: conf,
      nameAr: b.batch_ar, nameEn: b.batch_en || "", note: b.note || "",
      yieldNote: b.yield_note || "", batch: b,
    };
    if (!hadCycle) wb.batchCache.set(key, r);
    return r;
  }

  /** Cost one recipe/batch line at workbench prices, and say where the number
   *  came from. `costSource` is the provenance the manager reads:
   *    purchase — a dated purchase price, invoice-backed or not
   *    batch    — a sub-recipe with its own breakdown one click away
   *    guess    — a price somebody typed (REVIEW flag, or source='estimate')
   *    missing  — no cost at all; the line contributes nothing and says so */
  function effLine(model, wb, res, line, stack) {
    const qtyG = num(line.qty_g);
    const qty = num(line.qty);
    const base = {
      lineId: line.id || null,
      type: line.ing_type, ingredientAr: line.ing_ar, ingredientEn: line.ing_en || "",
      canonical: res.canonical, viaAlias: res.viaAlias,
      qty, unit: line.unit || "g", qtyG,
      note: line.note || "",
    };

    if (!res.found)
      return { cost: 0, confidence: "missing", hadCycle: false,
               row: { ...base, cost: null, unitCost: null, unitCostBasis: null,
                      costSource: "missing", costSourceAr: "بدون تكلفة",
                      source: "MISSING", verified: false, trimLossPct: null } };

    if (res.kind === "batch") {
      const eb = effBatch(model, wb, res.canonical, stack);
      const cost = eb.perG === null ? 0 : qtyG * eb.perG;
      return {
        cost, confidence: eb.confidence, hadCycle: eb.hadCycle === true,
        row: { ...base,
          cost: eb.perG === null ? null : round3(cost),
          unitCost: eb.sarPerKg, unitCostBasis: "SAR/kg",
          costSource: eb.plug ? "guess" : "batch",
          costSourceAr: eb.plug ? "تشغيلة بدون وصفة — رقم مؤقت" : "تشغيلة داخلية",
          source: res.source, verified: false,
          trimLossPct: null,
          batchRef: { key: res.canonical, nameAr: eb.nameAr, nameEn: eb.nameEn,
                      sarPerKg: eb.sarPerKg, sarPerKgBeforeYield: eb.sarPerKgBeforeYield,
                      yieldPct: eb.yieldPct, yieldAssumed: eb.yieldAssumed,
                      hasRecipe: !eb.plug, confidence: eb.confidence } },
      };
    }

    const er = effRaw(model, wb, res.canonical);
    let cost = 0, unitCost = null, basis = null;
    if (er.perG !== null) { cost = qtyG * er.perG; unitCost = round3(er.perG * 1000); basis = "SAR/kg"; }
    else if (er.perPiece !== null) { cost = qty * er.perPiece; unitCost = round3(er.perPiece); basis = "SAR/piece"; }

    const conf = er.perG === null && er.perPiece === null ? "missing"
               : er.flaggedReview || er.priceSource === "estimate" ? "guess"
               : "measured";
    return {
      cost, confidence: conf, hadCycle: false,
      row: { ...base,
        cost: conf === "missing" ? null : round3(cost),
        unitCost, unitCostBasis: basis,
        // The two halves of the ribs story, side by side.
        purchaseSarPerKg: er.purchasePerG === null ? null : round3(er.purchasePerG * 1000),
        trimLossPct: er.trimLossPct,
        effectiveSarPerKg: er.perG === null ? null : round3(er.perG * 1000),
        costSource: conf === "missing" ? "missing" : conf === "guess" ? "guess" : "purchase",
        costSourceAr: conf === "missing" ? "بدون تكلفة"
                    : conf === "guess" ? "سعر تقديري — بدون فاتورة"
                    : er.verified ? "سعر شراء بفاتورة" : "سعر من ملف التكاليف",
        source: res.source, verified: er.verified, priceSource: er.priceSource,
        supplier: er.supplier, effectiveFrom: er.effectiveFrom },
    };
  }

  /* ── Packaging ────────────────────────────────────────────────────────────
     ═══ HOW PER-ORDER PACKAGING AVOIDS BEING COUNTED FIVE TIMES ═══

     `item_costs` is keyed by ITEM NAME and multiplied by LINE QUANTITY. Any
     cost written there is, by construction, a per-unit cost. A bag costs the
     same whether the ticket has one dish or six — so putting the bag into
     `item_costs` charges it once per line, and a six-line delivery order pays
     for six bags. On this menu that is not a rounding error: the bag is
     plausibly the third-largest packaging line there is.

     So the three scopes are separated at the schema level and only ONE of them
     can ever reach `item_costs`:

       scope='item'    the box a dish is physically served in. Genuinely
                       per-unit. Added to the item's cost by computeItem() and
                       written to item_costs by /recalc. Two pizzas = two boxes.

       scope='order'   the sticker, the wet wipe — once per ticket, whatever is
                       on it. NEVER written to item_costs. There is no honest
                       per-unit value for these, and inventing one by dividing
                       by "average lines per order" would make every item's
                       cost depend on how big other people's orders were.

       scope='channel' the bag — once per ticket, and only for the channels
                       that use one. Delivery packs a large bag, takeaway a
                       small one, dine-in none. Also never per-unit.

     Order- and channel-scoped packaging is therefore reported as what it
     actually is: a PERIOD COST, priced as (orders in the window × per-order
     packaging for that channel) and surfaced by GET /rules. That figure
     belongs in the P&L as an operating expense line, next to gas and gloves —
     not smeared across item costs. The alternative, "just divide by the number
     of orders", would double-count the moment anyone also counted the boxes.

     If a rule is ever mis-scoped, the damage is visible rather than silent:
     `GET /rules` returns `orderPackaging` and `itemPackagingItems` as two
     separate blocks, and the same packaging id appearing in both is a fact you
     can see. ──────────────────────────────────────────────────────────────── */

  function ruleMatchesItem(rule, item) {
    if (rule.scope !== "item" || rule.active === false) return false;
    const k = String(rule.match_kind || "all");
    const v = norm(rule.match_value);
    if (k === "all") return true;
    if (!item) return false;
    if (k === "product") return String(item.product_id) === String(rule.match_value).trim();
    if (k === "category") return norm(item.category_ar) === v || norm(item.category_en) === v;
    if (k === "name")
      return v !== "" && (norm(item.product_ar).includes(v)
        || norm(item.product_en).toLowerCase().includes(v.toLowerCase()));
    return false;
  }

  function packLine(wb, r) {
    const p = wb.packagingById.get(r.packaging_id);
    if (!p || p.active === false) return null;
    const unit = p.unit_cost === null || p.unit_cost === undefined ? null : num(p.unit_cost);
    const q = num(r.qty) || 1;
    return {
      ruleId: r.id, packagingId: p.id, nameAr: p.name_ar, nameEn: p.name_en || "",
      qty: q, unitCost: unit, cost: unit === null ? null : round3(unit * q),
      scope: r.scope, matchKind: r.match_kind, matchValue: r.match_value,
      reviewed: r.reviewed === true, note: r.note || "",
    };
  }

  /** Item-scoped packaging for one menu item. `cost` is the sum of what is
   *  PRICED; anything unpriced is named in `unpriced` rather than counted as
   *  zero, so a total can never quietly claim a free box. */
  function itemPackagingFor(model, wb, item) {
    const lines = []; const unpriced = []; let cost = 0;
    for (const r of wb.rules) {
      if (!ruleMatchesItem(r, item)) continue;
      const l = packLine(wb, r);
      if (!l) continue;
      if (l.cost === null) unpriced.push(l.nameAr); else cost += l.cost;
      lines.push(l);
    }
    /* Four genuinely different states, and they must not collapse into a 0:
         no_rule       nothing says what this dish is served in
         unpriced      we know the boxes, none of them has a price
         partly_priced some priced, some not — the sum is a floor, not a total
         priced        the only state where `cost` is the whole story          */
    const status = !lines.length ? "no_rule"
      : unpriced.length === lines.length ? "unpriced"
      : unpriced.length ? "partly_priced" : "priced";
    return {
      lines, cost, unpriced, status,
      complete: status === "priced",
      // `cost` is what is KNOWN; `total` is the honest answer, which is null
      // whenever anything attached has no price.
      total: status === "priced" ? cost : null,
    };
  }

  /** Order- and channel-scoped packaging for ONE ticket on a given channel.
   *  Never per-unit, never written to item_costs. */
  function orderPackagingFor(wb, channel) {
    const lines = []; const unpriced = []; let cost = 0;
    for (const r of wb.rules) {
      if (r.active === false) continue;
      const applies = r.scope === "order"
        || (r.scope === "channel" && norm(r.match_value) === norm(channel));
      if (!applies) continue;
      const l = packLine(wb, r);
      if (!l) continue;
      if (l.cost === null) unpriced.push(l.nameAr); else cost += l.cost;
      lines.push(l);
    }
    return { channel, lines, perOrder: round3(cost),
             complete: unpriced.length === 0, unpriced };
  }

  async function deliveryAppList() {
    try {
      const s = await ctx.getSettingsData?.();
      const list = Array.isArray(s?.deliveryAppMethods) && s.deliveryAppMethods.length
        ? s.deliveryAppMethods : (ctx.DEFAULT_DELIVERY_APPS || []);
      return list.map((x) => String(x).toLowerCase());
    } catch {
      return (ctx.DEFAULT_DELIVERY_APPS || []).map((x) => String(x).toLowerCase());
    }
  }

  /* Ticket counts per packaging channel. `order_option` lies for aggregator
     orders (the POS logs them as Dine-in — see staff.js), so the aggregator
     test runs FIRST and wins. */
  async function ordersByChannel(from, to) {
    const apps = await deliveryAppList();
    const rows = (await pool.query(
      `SELECT CASE
                WHEN COALESCE(o.order_type,'') ILIKE '%external%'
                  OR EXISTS (SELECT 1 FROM jsonb_object_keys(o.payments) k
                              WHERE lower(k) = ANY($3::text[]))         THEN 'delivery'
                -- The POS's own delivery option, checked AFTER the aggregator
                -- test because order_option lies for aggregator tickets (it
                -- logs them as Dine-in — see staff.js). Live data: 'توصيل
                -- Delivery' on 41 orders the aggregator test does not catch.
                -- Without this line those 41 were being packed as dine-in,
                -- i.e. with no bag at all.
                WHEN COALESCE(o.order_option,'') ILIKE '%deliver%'
                  OR COALESCE(o.order_option,'') LIKE '%توصيل%'          THEN 'delivery'
                WHEN COALESCE(o.order_option,'') ILIKE '%take%'
                  OR COALESCE(o.order_option,'') ILIKE '%away%'
                  OR COALESCE(o.order_option,'') LIKE '%سفري%'
                  OR COALESCE(o.order_option,'') LIKE '%خارج%'          THEN 'takeaway'
                ELSE 'dinein' END AS channel,
              count(*)::int AS orders,
              COALESCE(sum(o.total),0)::float AS revenue
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
        GROUP BY 1`, [from, to, apps])).rows;
    const out = new Map(CHANNELS.map((ch) => [ch.key, { channel: ch.key, ar: ch.ar, orders: 0, revenue: 0 }]));
    for (const r of rows) {
      const e = out.get(r.channel) || { channel: r.channel, ar: r.channel, orders: 0, revenue: 0 };
      e.orders += r.orders; e.revenue += num(r.revenue);
      out.set(r.channel, e);
    }
    return [...out.values()];
  }

  /* ── One item, fully costed ─────────────────────────────────────────────── */

  const REVIEW_STATUSES = ["unreviewed", "in_review", "confirmed", "needs_info"];
  const REVIEW_AR = {
    unreviewed: "لم تُراجع", in_review: "قيد المراجعة",
    confirmed: "مؤكدة", needs_info: "ناقصة معلومات",
  };
  const PACKAGING_STATUS_AR = {
    no_rule: "لا توجد قاعدة تغليف لهذا الصنف",
    unpriced: "التغليف معروف لكن بدون أسعار",
    partly_priced: "بعض أصناف التغليف بدون سعر",
    priced: "التغليف مُسعّر بالكامل",
  };
  const COST_SOURCE_AR = {
    recipe: "محسوبة من الوصفة", estimate: "الوصفة فيها سعر تقديري",
    plug: "الوصفة فيها تشغيلة بدون وصفة", missing: "مكوّن بلا تكلفة",
    none: "لا توجد وصفة",
  };

  function computeItem(model, wb, productId) {
    const item = model.menuById.get(productId) || null;
    const lines = model.recipeLines.get(productId) || [];
    let food = 0, conf = "measured";
    const rows = [];
    for (const l of lines) {
      const res = resolve(model, l.ing_type, l.ing_ar);
      const e = effLine(model, wb, res, l, []);
      food += e.cost; conf = worst(conf, e.confidence);
      rows.push(e.row);
    }
    const cy = wb.itemYield.get(productId) || null;
    const cookLoss = asPct(cy?.cook_loss_pct);
    const foodAfter = cookLoss === null ? food : food / (1 - cookLoss);
    const pk = itemPackagingFor(model, wb, item);
    const rv = wb.review.get(productId) || null;

    const costSource = !lines.length ? "none"
      : conf === "missing" ? "missing" : conf === "plug" ? "plug"
      : conf === "guess" ? "estimate" : "recipe";

    return {
      productId, item,
      lines: rows,
      hasRecipe: lines.length > 0,
      foodCost: lines.length ? round3(food) : null,
      cookLossPct: cookLoss,
      foodCostAfterYield: lines.length ? round3(foodAfter) : null,
      packaging: pk.lines,
      // NULL unless every attached box has a price. A 0 here would tell the
      // P&L that a meal box is free, which is the exact class of lie this
      // module exists to remove.
      packagingCost: pk.total === null ? null : round3(pk.total),
      packagingCostKnown: round3(pk.cost),
      packagingStatus: pk.status,
      packagingStatusAr: PACKAGING_STATUS_AR[pk.status],
      packagingComplete: pk.complete,
      packagingUnpriced: pk.unpriced,
      // A cost with no recipe behind it is not zero — it is unknown. With a
      // recipe but unpriced packaging it is a FLOOR, and `costComplete` says so.
      cost: lines.length ? round3(foodAfter + pk.cost) : null,
      costComplete: lines.length > 0 && conf !== "missing" && pk.status === "priced",
      confidence: lines.length ? conf : "missing",
      costSource, costSourceAr: COST_SOURCE_AR[costSource],
      reviewStatus: rv ? rv.status : "unreviewed",
      reviewStatusAr: REVIEW_AR[rv ? rv.status : "unreviewed"] || "",
      reviewNote: rv?.note || "",
      reviewedBy: rv?.changed_by_name || "",
      reviewedAt: rv?.changed_at || null,
      posNames: wb.posByProduct.get(productId) || [],
    };
  }

  /** Sales rolled onto workbook products through cw_item_pos. */
  async function salesByProduct(wb, from, to) {
    const sales = await salesByItem(from, to);
    const byProduct = new Map();
    for (const s of sales) {
      if (s.isModifier) continue;                    // rule 3: an add-on is not the dish
      const pid = wb.posByName.get(norm(s.name));
      if (pid === undefined) continue;
      const cur = byProduct.get(pid) || { units: 0, value: 0, names: [] };
      cur.units += s.qty; cur.value += s.amount; cur.names.push(s.name);
      byProduct.set(pid, cur);
    }
    return { sales, byProduct };
  }

  /* ── Guards ───────────────────────────────────────────────────────────────
     A hidden section is a courtesy to the manager's attention, not a
     permission — so every route re-checks rather than trusting the UI. */
  async function gate(c, u, section) {
    if (u.role === "owner" || u.isAdmin) return null;
    const v = await visibilityFor(u);
    if (v[section] === false)
      return c.json({ ok: false, error: "hidden",
                      message: "هذا القسم غير متاح لحسابك — كلّم المالك" }, 403);
    return null;
  }

  /** A `confirmed` item is a promise: no importer may rewrite its recipe
   *  without saying so out loud. Exported behaviour, not decoration — any
   *  future workbook re-import must call this. */
  async function importGuard(productId) {
    const r = await pool.query(
      "SELECT status FROM cw_item_review WHERE product_id = $1", [productId]);
    return r.rowCount && r.rows[0].status === "confirmed";
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     WORKBENCH ROUTE 1 — /items and /items/:id
     ═══════════════════════════════════════════════════════════════════════ */

  app.get("/api/costing/items", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "items"); if (denied) return denied;
    try {
      const from = dayArg(c.req.query("from"), daysAgoISO(89));
      const to = dayArg(c.req.query("to"), todayISO());
      const search = norm(c.req.query("search") || "");
      const status = String(c.req.query("status") || "").trim();
      const vis = await visibilityFor(u);

      const model = await loadModel();
      const wb = await loadWorkbench(to);
      const { byProduct } = await salesByProduct(wb, from, to);

      let items = model.menu.map((m) => {
        const cm = computeItem(model, wb, m.product_id);
        const s = byProduct.get(m.product_id) || { units: 0, value: 0, names: [] };
        const revEx = s.value > 0 ? s.value / (1 + VAT_RATE) : null;
        // Realised food cost when we have sales; the menu price when we do not;
        // null when we have neither — never a 0 that reads as "brilliant margin".
        const foodCostPct =
          cm.cost !== null && revEx && s.units > 0 ? round3((cm.cost * s.units) / revEx)
          : cm.cost !== null && m.price_restaurant
            ? round3(cm.cost / (num(m.price_restaurant) / (1 + VAT_RATE)))
            : null;
        return {
          id: m.product_id,
          nameAr: m.product_ar, nameEn: m.product_en || "",
          category: m.category_ar || m.category_en || "",
          categoryEn: m.category_en || "",
          sku: m.sku || "",
          cost: cm.cost,
          costComplete: cm.costComplete,
          foodCost: cm.foodCost,
          packagingCost: cm.packagingCost,
          packagingStatus: cm.packagingStatus, packagingStatusAr: cm.packagingStatusAr,
          costSource: cm.costSource, costSourceAr: cm.costSourceAr,
          confidence: cm.confidence,
          foodCostPct,
          foodCostPctBasis: revEx && s.units > 0 ? "realised" : m.price_restaurant ? "menuPrice" : null,
          reviewStatus: cm.reviewStatus, reviewStatusAr: cm.reviewStatusAr,
          ingredientCount: cm.lines.length,
          packagingComplete: cm.packagingComplete,
          // A manager whose visibility blob hides sales sees nulls, not zeros.
          salesUnits: vis.sales ? (s.units || null) : null,
          salesValue: vis.sales ? (s.value ? round2(s.value) : null) : null,
          priceRestaurantIncl: vis.prices && m.price_restaurant !== null ? num(m.price_restaurant) : null,
          pricePlatformIncl: vis.prices && m.price_platform !== null ? num(m.price_platform) : null,
          posNames: cm.posNames,
        };
      });

      if (search)
        items = items.filter((i) =>
          norm(i.nameAr).includes(search) || norm(i.category).includes(search)
          || String(i.nameEn).toLowerCase().includes(search.toLowerCase())
          || String(i.id) === search);
      if (status && REVIEW_STATUSES.includes(status))
        items = items.filter((i) => i.reviewStatus === status);

      // Money first: the item the manager should open next is the one the most
      // revenue depends on, not the one that sorts first alphabetically.
      items.sort((a, b) => (b.salesValue || 0) - (a.salesValue || 0)
                        || String(a.nameAr).localeCompare(String(b.nameAr), "ar"));

      const counts = {};
      for (const s of REVIEW_STATUSES) counts[s] = 0;
      for (const i of items) counts[i.reviewStatus] = (counts[i.reviewStatus] || 0) + 1;

      return c.json({ ok: true, from, to, count: items.length, items,
                      statusCounts: counts, statusLabels: REVIEW_AR });
    } catch (e) {
      console.error("[costing] items failed:", e);
      return c.json({ ok: false, error: "items_failed", detail: e.message }, 500);
    }
  });

  app.get("/api/costing/items/:id", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "items"); if (denied) return denied;
    try {
      const pid = Number(c.req.param("id"));
      if (!Number.isFinite(pid)) return c.json({ ok: false, error: "bad_id" }, 400);
      const from = dayArg(c.req.query("from"), daysAgoISO(89));
      const to = dayArg(c.req.query("to"), todayISO());

      const model = await loadModel();
      const wb = await loadWorkbench(to);
      const m = model.menuById.get(pid);
      if (!m) return c.json({ ok: false, error: "not_found", message: "الصنف غير موجود" }, 404);

      const cm = computeItem(model, wb, pid);
      const { byProduct } = await salesByProduct(wb, from, to);
      const s = byProduct.get(pid) || { units: 0, value: 0, names: [] };
      const revEx = s.value > 0 ? s.value / (1 + VAT_RATE) : null;

      // History: what changed on this item, and every dated cost row its POS
      // names carry — that second half is the audit trail finance.js reads.
      const changes = (await pool.query(
        `SELECT * FROM cw_audit
          WHERE (entity = 'item' AND entity_ref = $1)
             OR (entity = 'recipe' AND entity_ref = $1)
          ORDER BY at DESC LIMIT 100`, [String(pid)])).rows;
      const names = cm.posNames;
      const costRows = names.length
        ? (await pool.query(
            `SELECT item_name, cost::float AS cost, effective_from, note, updated_at
               FROM item_costs WHERE item_name = ANY($1::text[])
              ORDER BY effective_from DESC, item_name`, [names])).rows
        : [];

      const cy = wb.itemYield.get(pid) || null;
      return c.json({
        ok: true,
        item: {
          id: pid, nameAr: m.product_ar, nameEn: m.product_en || "",
          category: m.category_ar || "", categoryEn: m.category_en || "", sku: m.sku || "",
          cost: cm.cost, costComplete: cm.costComplete,
          foodCost: cm.foodCost, foodCostAfterYield: cm.foodCostAfterYield,
          packagingCost: cm.packagingCost, packagingCostKnown: cm.packagingCostKnown,
          packagingStatus: cm.packagingStatus, packagingStatusAr: cm.packagingStatusAr,
          packagingComplete: cm.packagingComplete, packagingUnpriced: cm.packagingUnpriced,
          confidence: cm.confidence, costSource: cm.costSource, costSourceAr: cm.costSourceAr,
          reviewStatus: cm.reviewStatus, reviewStatusAr: cm.reviewStatusAr,
          reviewNote: cm.reviewNote, reviewedBy: cm.reviewedBy, reviewedAt: cm.reviewedAt,
          storedWorkbookCost: m.total_cost === null ? null : round3(num(m.total_cost)),
          // What the workbench now says minus what the imported sheet said.
          driftFromWorkbook: cm.cost === null || m.total_cost === null
            ? null : round3(cm.cost - num(m.total_cost)),
          priceRestaurantIncl: m.price_restaurant === null ? null : num(m.price_restaurant),
          pricePlatformIncl: m.price_platform === null ? null : num(m.price_platform),
          foodCostPct: cm.cost !== null && revEx && s.units > 0
            ? round3((cm.cost * s.units) / revEx) : null,
          salesUnits: s.units || null, salesValue: s.value ? round2(s.value) : null,
          posNames: names,
        },
        recipe: cm.lines,
        packaging: cm.packaging,
        yield: {
          cookLossPct: cy ? asPct(cy.cook_loss_pct) : null,
          note: cy?.note || "",
          updatedBy: cy?.updated_by || "", updatedAt: cy?.updated_at || null,
          // Said out loud so nobody "fixes" a null by typing 20%.
          explain: "أوزان الوصفة قبل الطهي، فالتكلفة صحيحة بدونها. لا تُدخل نسبة هنا "
                 + "إلا لو تأكدت أن أوزان هذه الوصفة مكتوبة بعد الطهي.",
        },
        history: [
          ...changes.map((r) => ({
            kind: "change", at: r.at, by: r.actor_name || r.actor_id,
            field: r.field, from: r.old_value, to: r.new_value, note: r.note || "",
          })),
          ...costRows.map((r) => ({
            kind: "cost", at: r.updated_at, by: "", field: "item_costs",
            from: null, to: `${r.cost} ر.س`, effectiveFrom: isoDayOf(r.effective_from),
            posName: r.item_name, note: r.note || "",
          })),
        ],
      });
    } catch (e) {
      console.error("[costing] item detail failed:", e);
      return c.json({ ok: false, error: "item_failed", detail: e.message }, 500);
    }
  });

  /* ── PUT /api/costing/items/:id ───────────────────────────────────────────
     { recipe?, packaging?, yield?, reviewStatus?, note? } → { ok, cost, breakdown }

     Each block is optional and independent, so "mark this confirmed" does not
     have to resend the recipe. Every change is audited with its old value —
     a change log without the old value cannot answer "what did it used to
     say?", which is the only question anyone ever asks it. */
  app.put("/api/costing/items/:id", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "items"); if (denied) return denied;
    try {
      const pid = Number(c.req.param("id"));
      if (!Number.isFinite(pid)) return c.json({ ok: false, error: "bad_id" }, 400);
      const b = await c.req.json().catch(() => ({}));
      const note = String(b.note || "");

      const model0 = await loadModel();
      if (!model0.menuById.has(pid))
        return c.json({ ok: false, error: "not_found", message: "الصنف غير موجود" }, 404);
      const before = computeItem(model0, await loadWorkbench(todayISO()), pid);

      /* Recipe — replace the item's lines wholesale. Partial merges on a list
         the user reordered produce ghosts; a full replace is what the screen
         actually means when it says "save". */
      if (Array.isArray(b.recipe)) {
        const old = model0.recipeLines.get(pid) || [];
        await pool.query("DELETE FROM cost_recipe_lines WHERE product_id = $1", [pid]);
        let i = 0;
        for (const l of b.recipe) {
          const ingAr = norm(l?.ingredientAr ?? l?.ing_ar ?? l?.name);
          if (!ingAr) continue;
          const unit = String(l?.unit || "g");
          const qty = num(l?.qty);
          const qtyG = l?.qtyG !== undefined && l?.qtyG !== null ? num(l.qtyG) : toGrams(qty, unit);
          const type = String(l?.type || l?.ing_type || "Raw");
          await pool.query(
            `INSERT INTO cost_recipe_lines (id, product_id, ing_type, ing_ar, ing_en, qty, unit, qty_g, line_cost, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)`,
            [idFor("rl", String(pid), String(i), ingAr), pid, type, ingAr,
             String(l?.ingredientEn || l?.ing_en || ""), qty, unit,
             qtyG === null ? 0 : qtyG, String(l?.note || "")]);
          i += 1;
        }
        await audit(u, "recipe", String(pid), "lines",
          old.map((x) => `${x.ing_ar}:${num(x.qty_g)}g`).join(", "),
          b.recipe.map((x) => `${norm(x?.ingredientAr ?? x?.ing_ar)}:${num(x?.qtyG ?? x?.qty)}`).join(", "),
          note);
        cache = { at: 0, model: null };   // the recipe changed; drop the 60 s cache
      }

      /* Packaging — the item's OWN attachments, i.e. rules scoped to this
         product id. Rules that reach it by category or name are shared with
         other dishes and are edited in /rules, not here. */
      if (Array.isArray(b.packaging)) {
        const oldRows = (await pool.query(
          `SELECT * FROM cw_packaging_rules
            WHERE scope='item' AND match_kind='product' AND match_value=$1`, [String(pid)])).rows;
        await pool.query(
          `DELETE FROM cw_packaging_rules
            WHERE scope='item' AND match_kind='product' AND match_value=$1`, [String(pid)]);
        for (const p of b.packaging) {
          const pkgId = String(p?.packagingId || p?.id || "").trim();
          if (!pkgId) continue;
          await pool.query(
            `INSERT INTO cw_packaging_rules
               (id, scope, match_kind, match_value, packaging_id, qty, reviewed, note, updated_by, updated_at)
             VALUES ($1,'item','product',$2,$3,$4,true,$5,$6,NOW())
             ON CONFLICT (id) DO UPDATE SET qty=EXCLUDED.qty, reviewed=true,
               note=EXCLUDED.note, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
            [idFor("pr", "item", "product", String(pid), pkgId), String(pid), pkgId,
             num(p?.qty) || 1, String(p?.note || ""), String(u.id || "")]);
        }
        await audit(u, "item", String(pid), "packaging",
          oldRows.map((r) => `${r.packaging_id}×${num(r.qty)}`).join(", "),
          b.packaging.map((p) => `${p?.packagingId || p?.id}×${num(p?.qty) || 1}`).join(", "), note);
      }

      /* Yield — see the long warning on the GET route. */
      if (b.yield && typeof b.yield === "object") {
        const oldY = (await pool.query(
          "SELECT * FROM cw_item_yield WHERE product_id = $1", [pid])).rows[0] || null;
        const raw = b.yield.cookLossPct ?? b.yield.cook_loss_pct;
        const pct = raw === null || raw === "" ? null : asPct(raw);
        await pool.query(
          `INSERT INTO cw_item_yield (product_id, cook_loss_pct, note, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (product_id) DO UPDATE SET
             cook_loss_pct=EXCLUDED.cook_loss_pct, note=EXCLUDED.note,
             updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
          [pid, pct, String(b.yield.note || ""), String(u.id || "")]);
        await audit(u, "item", String(pid), "cookLossPct",
          oldY ? asPct(oldY.cook_loss_pct) : null, pct, note);
      }

      /* Review state. */
      if (b.reviewStatus !== undefined) {
        const st = String(b.reviewStatus);
        if (!REVIEW_STATUSES.includes(st))
          return c.json({ ok: false, error: "bad_status",
                          message: `الحالة لازم تكون: ${REVIEW_STATUSES.join(" / ")}` }, 400);
        const oldR = (await pool.query(
          "SELECT status FROM cw_item_review WHERE product_id = $1", [pid])).rows[0];
        const wbNow = await loadWorkbench(todayISO());
        const nowCost = computeItem(await loadModel(), wbNow, pid).cost;
        await pool.query(
          `INSERT INTO cw_item_review
             (product_id, status, note, changed_by, changed_by_name, changed_at, confirmed_cost, confirmed_at)
           VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7)
           ON CONFLICT (product_id) DO UPDATE SET
             status=EXCLUDED.status, note=EXCLUDED.note,
             changed_by=EXCLUDED.changed_by, changed_by_name=EXCLUDED.changed_by_name,
             changed_at=NOW(),
             confirmed_cost=EXCLUDED.confirmed_cost, confirmed_at=EXCLUDED.confirmed_at`,
          [pid, st, note, String(u.id || ""), String(u.display_name || u.username || ""),
           st === "confirmed" ? nowCost : null,
           st === "confirmed" ? new Date() : null]);
        await audit(u, "item", String(pid), "reviewStatus", oldR?.status || "unreviewed", st, note);
      }

      cache = { at: 0, model: null };
      const model = await loadModel();
      const wb = await loadWorkbench(todayISO());
      const after = computeItem(model, wb, pid);

      return c.json({
        ok: true,
        cost: after.cost,
        breakdown: {
          foodCost: after.foodCost,
          cookLossPct: after.cookLossPct,
          foodCostAfterYield: after.foodCostAfterYield,
          packagingCost: after.packagingCost,
          packagingCostKnown: after.packagingCostKnown,
          packagingStatus: after.packagingStatus,
          packagingStatusAr: after.packagingStatusAr,
          packagingComplete: after.packagingComplete,
          packagingUnpriced: after.packagingUnpriced,
          total: after.cost, totalComplete: after.costComplete,
          confidence: after.confidence,
          costSource: after.costSource, costSourceAr: after.costSourceAr,
          reviewStatus: after.reviewStatus,
          recipe: after.lines, packaging: after.packaging,
          // What this edit did to the number, so the screen can say it.
          previousCost: before.cost,
          delta: after.cost === null || before.cost === null
            ? null : round3(after.cost - before.cost),
        },
        // Saving an item does NOT publish it to the P&L. /recalc does that,
        // deliberately, so a half-finished edit cannot move last week's profit.
        writtenToItemCosts: false,
        hint: "التغيير محفوظ في الورشة. اضغط «إعادة الاحتساب» لنقله إلى تقارير الأرباح.",
      });
    } catch (e) {
      console.error("[costing] item save failed:", e);
      return c.json({ ok: false, error: "save_failed", detail: e.message }, 500);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     WORKBENCH ROUTE 2 — /materials
     ═══════════════════════════════════════════════════════════════════════ */

  app.get("/api/costing/materials", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "materials"); if (denied) return denied;
    try {
      const asOf = dayArg(c.req.query("asOf"), todayISO());
      const search = norm(c.req.query("search") || "");
      const model = await loadModel();
      const wb = await loadWorkbench(asOf);

      const counts = (await pool.query(
        `SELECT canonical_ar, count(*)::int AS n FROM cw_material_prices GROUP BY 1`)).rows;
      const nPrices = new Map(counts.map((r) => [norm(r.canonical_ar), r.n]));

      let out = [...model.raw.values()].map((r) => {
        const key = norm(r.canonical_ar);
        const e = effRaw(model, wb, key);
        return {
          id: r.canonical_ar,
          nameAr: r.canonical_ar, nameEn: r.name_en || "",
          supplier: e.supplier,
          purchaseUnit: e.purchaseUnit,
          pricePerUnit: e.pricePerUnit,
          purchaseSarPerKg: e.purchasePerG === null ? null : round3(e.purchasePerG * 1000),
          purchaseSarPerPiece: e.purchasePerPiece === null ? null : round3(e.purchasePerPiece),
          trimLossPct: e.trimLossPct,
          /* The trim test, as the two weights the kitchen actually takes.
             `trimSource` is the difference between evidence and a hunch:
               weighed — bought/usable are on the row, the pct is arithmetic
               assumed — a typed percentage, nothing weighed
               ''      — nobody has looked (and NULL pct means exactly that) */
          trimBoughtG: e.trimBoughtG, trimUsableG: e.trimUsableG,
          trimSource: e.trimSource, trimWeighed: e.trimWeighed,
          trimNeeded: TRIMMABLE_RE.test(key) && !NOT_TRIMMABLE_RE.test(key),
          trimMath: trimMathOf(e),
          // The ribs line: 90 in, 18% loss, 110 out — visible, not typed.
          effectiveSarPerKg: e.perG === null ? null : round3(e.perG * 1000),
          effectiveSarPerPiece: e.perPiece === null ? null : round3(e.perPiece),
          yieldNote: e.yieldNote,
          priceSource: e.priceSource, verified: e.verified,
          effectiveFrom: e.effectiveFrom,
          flaggedReview: e.flaggedReview,
          priceRows: nPrices.get(key) || 0,
          note: r.note || "",
        };
      });
      if (search)
        out = out.filter((m) => norm(m.nameAr).includes(search)
          || String(m.nameEn).toLowerCase().includes(search.toLowerCase())
          || norm(m.supplier).includes(search));

      out.sort((a, b) => Number(!!b.flaggedReview) - Number(!!a.flaggedReview)
                      || String(a.nameAr).localeCompare(String(b.nameAr), "ar"));
      return c.json({
        ok: true, asOf, count: out.length, materials: out,
        priceSources: {
          invoice: "فاتورة مورّد", quote: "عرض سعر", estimate: "تقدير — بدون مستند",
          workbook: "من ملف التكاليف المستورد",
        },
      });
    } catch (e) {
      console.error("[costing] materials failed:", e);
      return c.json({ ok: false, error: "materials_failed", detail: e.message }, 500);
    }
  });

  /* PUT /api/costing/materials/:id — :id is the canonical Arabic name.
     A price change INSERTS a dated row; it never edits the old one. That is
     the whole reason last month's P&L is stable. */
  app.put("/api/costing/materials/:id", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "materials"); if (denied) return denied;
    try {
      const id = norm(safeDecode(c.req.param("id")));
      const b = await c.req.json().catch(() => ({}));
      const model = await loadModel();
      if (!model.raw.has(id))
        return c.json({ ok: false, error: "not_found", message: "المادة غير موجودة" }, 404);
      const cur = model.raw.get(id);
      const note = String(b.note || "");

      // ── the material's own attributes ──
      const supplier = b.supplier === undefined ? cur.supplier || "" : String(b.supplier);
      const yieldNote = b.yieldNote === undefined ? cur.yield_note || "" : String(b.yieldNote);

      /* ── THE TRIM TEST, ENTERED AS TWO WEIGHTS ────────────────────────────
         The preferred body is `{ trimBoughtG: 1000, trimUsableG: 820 }` — what
         the scale said before cleaning and after. The percentage is derived
         here, once, and stored so every existing reader keeps working.

         `trimLossPct` is still accepted, because the ribs row already carries
         one and a UI may still send it, but a percentage arriving on its own is
         recorded as `trim_source='assumed'` and does NOT close the task asking
         for the weights. Sending the two weights clears any old typed pct;
         sending `trimBoughtG: null` clears the test entirely. */
      const numOrNull = (v) => (v === undefined ? undefined
        : v === null || v === "" ? null
        : Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
      const boughtIn = numOrNull(b.trimBoughtG ?? b.boughtG ?? b.trim_bought_g);
      const usableIn = numOrNull(b.trimUsableG ?? b.usableG ?? b.trim_usable_g);
      const weightsTouched = boughtIn !== undefined || usableIn !== undefined;

      const curBought = cur.trim_bought_g === null || cur.trim_bought_g === undefined
        ? null : num(cur.trim_bought_g);
      const curUsable = cur.trim_usable_g === null || cur.trim_usable_g === undefined
        ? null : num(cur.trim_usable_g);
      const bought = boughtIn === undefined ? curBought : boughtIn;
      const usable = usableIn === undefined ? curUsable : usableIn;

      if (bought !== null && usable !== null && usable > bought)
        return c.json({ ok: false, error: "trim_impossible",
          message: "الوزن بعد التنظيف أكبر من وزن الشراء — راجع الرقمين" }, 400);

      const trimRaw = b.trimLossPct ?? b.yieldLossPct ?? b.trim_loss_pct;
      let trim, trimSource;
      if (bought !== null && usable !== null && bought > 0) {
        trim = asPct(1 - usable / bought);
        trimSource = "weighed";
      } else if (weightsTouched && (bought === null || usable === null)) {
        // The weights were explicitly cleared or only half-entered: the test no
        // longer stands, so neither does a percentage derived from it.
        trim = trimRaw === undefined || trimRaw === null || trimRaw === "" ? null : asPct(trimRaw);
        trimSource = trim === null ? "" : "assumed";
      } else if (trimRaw !== undefined) {
        trim = trimRaw === null || trimRaw === "" ? null : asPct(trimRaw);
        trimSource = trim === null ? "" : "assumed";
      } else {
        trim = asPct(cur.trim_loss_pct);
        trimSource = String(cur.trim_source || (trim === null ? "" : "assumed"));
      }

      if (String(cur.supplier || "") !== supplier)
        await audit(u, "material", id, "supplier", cur.supplier || "", supplier, note);
      if (asPct(cur.trim_loss_pct) !== trim || curBought !== bought || curUsable !== usable)
        await audit(u, "material", id, "trimLoss",
          curBought !== null && curUsable !== null ? `${curBought}→${curUsable} جم`
            : asPct(cur.trim_loss_pct),
          bought !== null && usable !== null ? `${bought}→${usable} جم` : trim,
          `${trimSource || "بدون"}${note ? " · " + note : ""}`);

      await pool.query(
        `UPDATE cost_raw_materials
            SET supplier=$2, trim_loss_pct=$3, yield_note=$4, updated_by=$5,
                trim_bought_g=$6, trim_usable_g=$7, trim_source=$8,
                trim_measured_at = CASE WHEN $8 = 'weighed' THEN NOW() ELSE trim_measured_at END,
                updated_at=NOW()
          WHERE canonical_ar=$1`,
        [cur.canonical_ar, supplier, trim, yieldNote, String(u.id || ""),
         bought, usable, trimSource]);

      // ── a new dated purchase price, if one was supplied ──
      let priceRow = null;
      const hasPrice = b.pricePerUnit !== undefined || b.costPerG !== undefined
                    || b.costPerPiece !== undefined || b.sarPerKg !== undefined;
      if (hasPrice) {
        const effectiveFrom = dayArg(b.effectiveFrom, todayISO());
        const purchaseUnit = String(b.purchaseUnit ?? cur.purchase_unit ?? "");
        const perG = b.costPerG !== undefined && b.costPerG !== null ? num(b.costPerG)
                   : b.sarPerKg !== undefined && b.sarPerKg !== null ? num(b.sarPerKg) / 1000
                   : null;
        const perPiece = b.costPerPiece !== undefined && b.costPerPiece !== null
                   ? num(b.costPerPiece) : null;
        if (perG === null && perPiece === null)
          return c.json({ ok: false, error: "no_unit_cost",
            message: "لازم تدخل سعر للكيلو أو سعر للحبة" }, 400);
        const src = ["invoice", "quote", "estimate", "workbook"].includes(String(b.priceSource))
          ? String(b.priceSource) : "invoice";
        /* A screen that offers "SAR per kilo" should not leave `price` NULL and
           make the history read as if nobody recorded what was paid. When the
           purchase unit IS the kilo (or the litre), the per-kg figure and the
           per-unit price are the same number — derive it rather than lose it. */
        const perUnitGiven = b.pricePerUnit === undefined || b.pricePerUnit === null
          ? null : num(b.pricePerUnit);
        const unitIsKilo = /^(kg|كجم|كيلو|l|lt|لتر|ليتر)$/i.test(purchaseUnit.trim());
        const pricePerUnit = perUnitGiven !== null ? perUnitGiven
          : (unitIsKilo && perG !== null ? round3(perG * 1000)
          : (/^(piece|حبة|قطعة|عدد)$/i.test(purchaseUnit.trim()) && perPiece !== null
             ? round3(perPiece) : null));

        priceRow = (await pool.query(
          `INSERT INTO cw_material_prices
             (id, canonical_ar, supplier, purchase_unit, pack_qty, pack_unit, price,
              cost_per_g, cost_per_piece, effective_from, source, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12,$13)
           ON CONFLICT (canonical_ar, effective_from) DO UPDATE SET
             supplier=EXCLUDED.supplier, purchase_unit=EXCLUDED.purchase_unit,
             pack_qty=EXCLUDED.pack_qty, pack_unit=EXCLUDED.pack_unit, price=EXCLUDED.price,
             cost_per_g=EXCLUDED.cost_per_g, cost_per_piece=EXCLUDED.cost_per_piece,
             source=EXCLUDED.source, note=EXCLUDED.note, created_by=EXCLUDED.created_by
           RETURNING *`,
          [idFor("mp", id, effectiveFrom), cur.canonical_ar, supplier, purchaseUnit,
           b.packQty === undefined ? null : num(b.packQty), String(b.packUnit || "g"),
           pricePerUnit,
           perG, perPiece, effectiveFrom, src, String(b.priceNote || note), String(u.id || "")]
        )).rows[0];

        // The base table keeps the CURRENT price so /coverage, /recipe and
        // /health — which do not take an asOf — keep working unchanged.
        if (effectiveFrom <= todayISO())
          await pool.query(
            `UPDATE cost_raw_materials
                SET cost_per_unit=COALESCE($2, cost_per_unit),
                    cost_per_g=$3, cost_per_piece=$4,
                    purchase_unit=COALESCE(NULLIF($5,''), purchase_unit),
                    status = CASE WHEN $6 = 'invoice' THEN 'OK' ELSE status END,
                    updated_at=NOW()
              WHERE canonical_ar=$1`,
            [cur.canonical_ar,
             pricePerUnit,
             perG, perPiece, purchaseUnit, src]);

        await audit(u, "material", id, "price",
          cur.cost_per_g === null ? null : round3(num(cur.cost_per_g) * 1000),
          perG === null ? round3(perPiece) : round3(perG * 1000),
          `${effectiveFrom} · ${src}${note ? " · " + note : ""}`);
      }

      cache = { at: 0, model: null };
      const m2 = await loadModel();
      const wb = await loadWorkbench(todayISO());
      const e = effRaw(m2, wb, id);
      return c.json({
        ok: true,
        material: {
          id: cur.canonical_ar, nameAr: cur.canonical_ar, nameEn: cur.name_en || "",
          supplier: e.supplier, purchaseUnit: e.purchaseUnit, pricePerUnit: e.pricePerUnit,
          purchaseSarPerKg: e.purchasePerG === null ? null : round3(e.purchasePerG * 1000),
          trimLossPct: e.trimLossPct,
          trimBoughtG: e.trimBoughtG, trimUsableG: e.trimUsableG,
          trimSource: e.trimSource, trimWeighed: e.trimWeighed,
          effectiveSarPerKg: e.perG === null ? null : round3(e.perG * 1000),
          priceSource: e.priceSource, verified: e.verified, effectiveFrom: e.effectiveFrom,
        },
        priceRowAdded: !!priceRow,
        // Spelled out so the ribs case is legible on screen:
        //   bought 1000 g → usable 820 g → 90 ÷ (1 − 0.18) = 110 SAR/kg
        yieldMath: trimMathOf(e),
      });
    } catch (e) {
      console.error("[costing] material save failed:", e);
      return c.json({ ok: false, error: "save_failed", detail: e.message }, 500);
    }
  });

  /* Price history for one material — the evidence behind `effectiveFrom`. */
  app.get("/api/costing/materials/:id/prices", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "materials"); if (denied) return denied;
    const id = norm(safeDecode(c.req.param("id")));
    const rows = (await pool.query(
      `SELECT * FROM cw_material_prices WHERE canonical_ar = $1
        ORDER BY effective_from DESC`, [id])).rows;
    return c.json({
      ok: true, material: id,
      prices: rows.map((r) => ({
        id: r.id, effectiveFrom: isoDayOf(r.effective_from), supplier: r.supplier || "",
        purchaseUnit: r.purchase_unit || "", pricePerUnit: r.price === null ? null : num(r.price),
        sarPerKg: r.cost_per_g === null ? null : round3(num(r.cost_per_g) * 1000),
        sarPerPiece: r.cost_per_piece === null ? null : round3(num(r.cost_per_piece)),
        source: r.source, note: r.note || "", createdAt: r.created_at,
      })),
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     WORKBENCH ROUTE 3 — /batches
     ═══════════════════════════════════════════════════════════════════════ */

  app.get("/api/costing/batches", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "batches"); if (denied) return denied;
    try {
      const from = dayArg(c.req.query("from"), daysAgoISO(89));
      const to = dayArg(c.req.query("to"), todayISO());
      const model = await loadModel();
      const wb = await loadWorkbench(to);
      const { byProduct } = await salesByProduct(wb, from, to);

      const out = [...model.batch.keys()].map((k) => {
        const eb = effBatch(model, wb, k);
        const deps = dependentsOfBatch(model, k);
        const salesValue = deps.reduce((a, pid) => a + (byProduct.get(pid)?.value || 0), 0);
        return {
          id: eb.nameAr, nameAr: eb.nameAr, nameEn: eb.nameEn,
          hasRecipe: !eb.plug, lineCount: eb.lines.length,
          inputG: eb.inputG, outputG: eb.outputG, storedOutputG: eb.storedOutputG,
          outputMeasured: eb.outputMeasured,
          yieldPct: eb.yieldPct, yieldAssumed: eb.yieldAssumed,
          /* The flag the UI must show next to "output = input", so nobody reads
             an equal weight as a missing number. FALSE = raw prep batch,
             portioned raw, and the equality is the correct answer. */
          cookedBeforePortioning: eb.cookedBeforePortioning,
          cookedReason: eb.cookedReason, cookedEvidence: eb.cookedEvidence,
          outputCapped: eb.outputCapped, capGainG: eb.capGainG,
          sarPerKg: eb.sarPerKg, sarPerKgBeforeYield: eb.sarPerKgBeforeYield,
          storedSarPerKg: eb.storedSarPerKg,
          totalCost: eb.totalCost, confidence: eb.confidence,
          note: eb.note, yieldNote: eb.yieldNote,
          dependents: deps.length,
          salesValue: salesValue ? round2(salesValue) : null,
        };
      });
      out.sort((a, b) => (b.salesValue || 0) - (a.salesValue || 0));
      return c.json({ ok: true, from, to, count: out.length, batches: out });
    } catch (e) {
      console.error("[costing] batches failed:", e);
      return c.json({ ok: false, error: "batches_failed", detail: e.message }, 500);
    }
  });

  app.get("/api/costing/batches/:id", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "batches"); if (denied) return denied;
    try {
      const key = norm(safeDecode(c.req.param("id")));
      const from = dayArg(c.req.query("from"), daysAgoISO(89));
      const to = dayArg(c.req.query("to"), todayISO());
      const model = await loadModel();
      if (!model.batch.has(key))
        return c.json({ ok: false, error: "not_found", message: "التشغيلة غير موجودة" }, 404);
      const wb = await loadWorkbench(to);
      const eb = effBatch(model, wb, key);
      const deps = dependentsOfBatch(model, key);
      const { byProduct } = await salesByProduct(wb, from, to);
      const history = (await pool.query(
        `SELECT * FROM cw_audit WHERE entity = 'batch' AND entity_ref = $1
          ORDER BY at DESC LIMIT 100`, [key])).rows;

      return c.json({
        ok: true,
        batch: {
          id: eb.nameAr, nameAr: eb.nameAr, nameEn: eb.nameEn,
          hasRecipe: !eb.plug, inputG: eb.inputG, outputG: eb.outputG,
          storedOutputG: eb.storedOutputG, outputMeasured: eb.outputMeasured,
          yieldPct: eb.yieldPct, yieldAssumed: eb.yieldAssumed,
          cookedBeforePortioning: eb.cookedBeforePortioning,
          cookedReason: eb.cookedReason, cookedEvidence: eb.cookedEvidence,
          outputCapped: eb.outputCapped, capGainG: eb.capGainG,
          sarPerKg: eb.sarPerKg, sarPerKgBeforeYield: eb.sarPerKgBeforeYield,
          storedSarPerKg: eb.storedSarPerKg, totalCost: eb.totalCost,
          confidence: eb.confidence, note: eb.note, yieldNote: eb.yieldNote,
          yieldMath: eb.yieldPct === null || !eb.inputG ? null : {
            inputG: round3(eb.inputG), yieldPct: eb.yieldPct,
            outputG: round3(eb.outputG),
            formula: `${round3(eb.inputG)} جم × ${eb.yieldPct} = ${round3(eb.outputG)} جم`,
          },
          /* Why a batch whose output equals its input is fine. The UI should
             render this instead of an alarm — see COOKED_BATCHES. */
          yieldExplain: eb.cookedBeforePortioning
            ? (eb.yieldPct === null
                ? `التشغيلة دي بتتطبخ قبل ما تتقسّم (${eb.cookedReason}) — محتاجة نسبة ناتج مقيسة`
                : "")
            : "التشغيلة دي بتتحضّر نيّة وبتتقسّم نيّة — الوزن الخارج = الوزن الداخل، "
              + "والجرام في الوصفة جرام قبل الطهي. مفيش فاقد طهي ينفع يتحسب هنا.",
        },
        recipe: eb.lines,
        dependents: deps.map((pid) => ({
          productId: pid, nameAr: model.menuById.get(pid)?.product_ar || `#${pid}`,
          salesValue: byProduct.get(pid)?.value ? round2(byProduct.get(pid).value) : null,
        })).sort((a, b) => (b.salesValue || 0) - (a.salesValue || 0)),
        history: history.map((r) => ({ at: r.at, by: r.actor_name || r.actor_id,
          field: r.field, from: r.old_value, to: r.new_value, note: r.note || "" })),
      });
    } catch (e) {
      console.error("[costing] batch detail failed:", e);
      return c.json({ ok: false, error: "batch_failed", detail: e.message }, 500);
    }
  });

  /* PUT /api/costing/batches/:id — { lines?, outputG?, yieldPct?, note?, yieldNote? }
     This is the route that fixes the Tarb plug: post the real recipe lines and
     a real grill yield, and the 21.68 SAR/kg placeholder is replaced by a
     number with a derivation. */
  app.put("/api/costing/batches/:id", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "batches"); if (denied) return denied;
    try {
      const key = norm(safeDecode(c.req.param("id")));
      const b = await c.req.json().catch(() => ({}));
      const model0 = await loadModel();
      if (!model0.batch.has(key))
        return c.json({ ok: false, error: "not_found", message: "التشغيلة غير موجودة" }, 404);
      const cur = model0.batch.get(key);
      const before = effBatch(model0, await loadWorkbench(todayISO()), key);
      const note = String(b.note || "");

      if (Array.isArray(b.lines)) {
        const old = model0.batchLines.get(key) || [];
        await pool.query("DELETE FROM cost_batch_lines WHERE batch_ar = $1", [cur.batch_ar]);
        let i = 0;
        for (const l of b.lines) {
          const ingAr = norm(l?.ingredientAr ?? l?.ing_ar ?? l?.name);
          if (!ingAr) continue;
          const unit = String(l?.unit || "g");
          const qty = num(l?.qty);
          const qtyG = l?.qtyG !== undefined && l?.qtyG !== null ? num(l.qtyG) : toGrams(qty, unit);
          await pool.query(
            `INSERT INTO cost_batch_lines (id, batch_ar, ing_type, ing_ar, ing_en, qty, unit, qty_g, line_cost, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)`,
            [idFor("bl", cur.batch_ar, String(i), ingAr), cur.batch_ar,
             String(l?.type || l?.ing_type || "Raw"), ingAr,
             String(l?.ingredientEn || l?.ing_en || ""), qty, unit,
             qtyG === null ? 0 : qtyG, String(l?.note || "")]);
          i += 1;
        }
        await audit(u, "batch", key, "lines",
          old.map((x) => `${x.ing_ar}:${num(x.qty_g)}g`).join(", "),
          b.lines.map((x) => `${norm(x?.ingredientAr ?? x?.ing_ar)}:${num(x?.qtyG ?? x?.qty)}`).join(", "),
          note);

        /* Entering the recipe IS the resolution of "recipe is missing". The
           marker in `note` is what effBatch() reads to grade the batch a plug
           — and it is what /health has always read — so leaving it behind
           would mean the manager does the work and the system keeps calling
           his number a placeholder forever. Clear it, and say so in the audit
           rather than deleting evidence quietly. */
        if (b.lines.length && /missing recipe/i.test(cur.note || "")) {
          const cleaned = String(cur.note).replace(/missing recipe[^.;]*[.;]?/i, "").trim();
          await pool.query("UPDATE cost_batches SET note=$2 WHERE batch_ar=$1",
            [cur.batch_ar, cleaned]);
          await audit(u, "batch", key, "note", cur.note, cleaned,
            "أُدخلت الوصفة — رُفعت علامة «الوصفة غير مُدخلة»");
        }
      }

      const yieldPct = b.yieldPct === undefined ? asYield(cur.yield_pct)
                     : b.yieldPct === null || b.yieldPct === "" ? null : asYield(b.yieldPct);
      const outputG = b.outputG === undefined ? (cur.output_g === null ? null : num(cur.output_g))
                    : b.outputG === null || b.outputG === "" ? null : num(b.outputG);
      const outputMeasured = b.outputMeasured === undefined
        ? cur.output_measured === true : !!b.outputMeasured;

      /* Whether this batch is cooked BEFORE it is portioned. Only ever set by a
         human — the code default (COOKED_BATCHES) fills the NULL. Setting it
         FALSE is the way to say "output = input is correct here, stop asking",
         and setting it TRUE is the way to make the queue ask for a real yield. */
      const cookedRaw = b.cookedBeforePortioning ?? b.cooked_before_portioning;
      const cooked = cookedRaw === undefined ? (cur.cooked_before_portioning ?? null)
                   : cookedRaw === null || cookedRaw === "" ? null : !!cookedRaw;

      if (asYield(cur.yield_pct) !== yieldPct)
        await audit(u, "batch", key, "yieldPct", asYield(cur.yield_pct), yieldPct, note);
      if ((cur.output_g === null ? null : num(cur.output_g)) !== outputG)
        await audit(u, "batch", key, "outputG",
          cur.output_g === null ? null : num(cur.output_g), outputG, note);
      if ((cur.cooked_before_portioning ?? null) !== cooked)
        await audit(u, "batch", key, "cookedBeforePortioning",
          cur.cooked_before_portioning ?? null, cooked, note);

      await pool.query(
        `UPDATE cost_batches
            SET yield_pct=$2, output_g=$3, output_measured=$4,
                yield_note=$5, note=COALESCE(NULLIF($6,''), note),
                cooked_before_portioning=$8,
                updated_by=$7, updated_at=NOW()
          WHERE batch_ar=$1`,
        [cur.batch_ar, yieldPct, outputG, outputMeasured,
         b.yieldNote === undefined ? cur.yield_note || "" : String(b.yieldNote),
         String(b.batchNote || ""), String(u.id || ""), cooked]);

      cache = { at: 0, model: null };
      const model = await loadModel();
      const wb = await loadWorkbench(todayISO());
      const eb = effBatch(model, wb, key);

      // Keep the denormalised columns the older routes read in step with the
      // recomputed truth, so /health and /recipe never disagree with /batches.
      await pool.query(
        `UPDATE cost_batches SET total_cost=$2, cost_per_g=$3, updated_at=NOW() WHERE batch_ar=$1`,
        [cur.batch_ar, eb.plug ? cur.total_cost : eb.totalCost,
         eb.perG === null ? cur.cost_per_g : eb.perG]);
      cache = { at: 0, model: null };

      return c.json({
        ok: true,
        batch: {
          id: eb.nameAr, sarPerKg: eb.sarPerKg, sarPerKgBeforeYield: eb.sarPerKgBeforeYield,
          inputG: eb.inputG, outputG: eb.outputG, yieldPct: eb.yieldPct,
          cookedBeforePortioning: eb.cookedBeforePortioning,
          outputCapped: eb.outputCapped, capGainG: eb.capGainG,
          totalCost: eb.totalCost, confidence: eb.confidence, hasRecipe: !eb.plug,
        },
        previousSarPerKg: before.sarPerKg,
        delta: eb.sarPerKg === null || before.sarPerKg === null
          ? null : round3(eb.sarPerKg - before.sarPerKg),
        recipe: eb.lines,
        hint: "اضغط «إعادة الاحتساب» لنقل الأثر إلى تكاليف الأصناف وتقارير الأرباح.",
      });
    } catch (e) {
      console.error("[costing] batch save failed:", e);
      return c.json({ ok: false, error: "save_failed", detail: e.message }, 500);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     WORKBENCH ROUTE 4 — /packaging and /rules
     ═══════════════════════════════════════════════════════════════════════ */

  app.get("/api/costing/packaging", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "packaging"); if (denied) return denied;
    const rows = (await pool.query("SELECT * FROM cw_packaging ORDER BY active DESC, name_ar")).rows;
    const used = (await pool.query(
      `SELECT packaging_id, count(*)::int AS n FROM cw_packaging_rules
        WHERE active = true GROUP BY 1`)).rows;
    const uses = new Map(used.map((r) => [r.packaging_id, r.n]));
    return c.json({
      ok: true,
      packaging: rows.map((r) => ({
        id: r.id, nameAr: r.name_ar, nameEn: r.name_en || "",
        // NULL, not 0. An unpriced box is unknown, not free.
        unitCost: r.unit_cost === null || r.unit_cost === undefined ? null : num(r.unit_cost),
        packSize: r.pack_size === null ? null : num(r.pack_size),
        packPrice: r.pack_price === null ? null : num(r.pack_price),
        supplier: r.supplier || "", active: r.active !== false,
        note: r.note || "", ruleCount: uses.get(r.id) || 0,
        updatedAt: r.updated_at,
      })),
      unpricedCount: rows.filter((r) => r.unit_cost === null || r.unit_cost === undefined).length,
    });
  });

  async function upsertPackaging(c, u, id) {
    const b = await c.req.json().catch(() => ({}));
    const nameAr = norm(b.nameAr ?? b.name_ar ?? b.name);
    const pkgId = String(id || b.id || "").trim()
      || `pkg_${idFor("pkg", nameAr).slice(0, 10)}`;
    const cur = (await pool.query("SELECT * FROM cw_packaging WHERE id = $1", [pkgId])).rows[0] || null;
    if (!cur && !nameAr)
      return c.json({ ok: false, error: "name_required", message: "اسم صنف التغليف مطلوب" }, 400);

    // pack price ÷ pack size is the honest way to price a box: you buy 500 for
    // 180 SAR, not one for 0.36. Either form is accepted, the per-unit wins.
    const packSize = b.packSize === undefined ? (cur ? cur.pack_size : null)
                   : b.packSize === null || b.packSize === "" ? null : num(b.packSize);
    const packPrice = b.packPrice === undefined ? (cur ? cur.pack_price : null)
                    : b.packPrice === null || b.packPrice === "" ? null : num(b.packPrice);
    let unitCost = b.unitCost === undefined ? (cur ? cur.unit_cost : null)
                 : b.unitCost === null || b.unitCost === "" ? null : num(b.unitCost);
    if ((b.unitCost === undefined || b.unitCost === null || b.unitCost === "")
        && packSize && packPrice) unitCost = packPrice / packSize;

    const row = (await pool.query(
      `INSERT INTO cw_packaging (id, name_ar, name_en, unit_cost, pack_size, pack_price,
                                 supplier, active, note, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name_ar=EXCLUDED.name_ar, name_en=EXCLUDED.name_en, unit_cost=EXCLUDED.unit_cost,
         pack_size=EXCLUDED.pack_size, pack_price=EXCLUDED.pack_price,
         supplier=EXCLUDED.supplier, active=EXCLUDED.active, note=EXCLUDED.note,
         updated_by=EXCLUDED.updated_by, updated_at=NOW()
       RETURNING *`,
      [pkgId, nameAr || cur?.name_ar || pkgId, String(b.nameEn ?? cur?.name_en ?? ""),
       unitCost === null || unitCost === undefined ? null : round3(unitCost),
       packSize, packPrice, String(b.supplier ?? cur?.supplier ?? ""),
       b.active === undefined ? (cur ? cur.active : true) : !!b.active,
       // The seed note says "not priced yet". Once it IS priced that note is a
       // lie sitting on the screen next to the price, so pricing clears it.
       b.note !== undefined ? String(b.note)
         : (unitCost !== null && unitCost !== undefined
            && String(cur?.note || "").includes("لم يُسعّر بعد") ? "" : String(cur?.note ?? "")),
       String(u.id || "")]
    )).rows[0];

    const oldUnit = cur && cur.unit_cost !== null ? num(cur.unit_cost) : null;
    const newUnit = row.unit_cost === null ? null : num(row.unit_cost);
    if (oldUnit !== newUnit)
      await audit(u, "packaging", pkgId, "unitCost", oldUnit, newUnit, String(b.note || ""));
    if (!cur) await audit(u, "packaging", pkgId, "create", null, row.name_ar, "");

    return c.json({
      ok: true,
      packaging: {
        id: row.id, nameAr: row.name_ar, nameEn: row.name_en || "",
        unitCost: newUnit, packSize: row.pack_size === null ? null : num(row.pack_size),
        packPrice: row.pack_price === null ? null : num(row.pack_price),
        supplier: row.supplier || "", active: row.active !== false, note: row.note || "",
      },
    });
  }
  app.post("/api/costing/packaging", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "packaging"); if (denied) return denied;
    return upsertPackaging(c, u, null);
  });
  app.put("/api/costing/packaging/:id", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "packaging"); if (denied) return denied;
    return upsertPackaging(c, u, c.req.param("id"));
  });

  /* GET /api/costing/rules — the attachment rules, PLUS the per-order figure
     they imply. The two blocks are returned separately on purpose: seeing
     `itemPackaging` and `orderPackaging` side by side is what makes a
     mis-scoped rule visible instead of silently doubling a cost. */
  app.get("/api/costing/rules", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "rules"); if (denied) return denied;
    try {
      const from = dayArg(c.req.query("from"), daysAgoISO(29));
      const to = dayArg(c.req.query("to"), todayISO());
      const wb = await loadWorkbench(to);
      const model = await loadModel();

      const shape = (r) => {
        const p = wb.packagingById.get(r.packaging_id);
        return {
          id: r.id, scope: r.scope, matchKind: r.match_kind, matchValue: r.match_value,
          packagingId: r.packaging_id, packagingNameAr: p ? p.name_ar : "(محذوف)",
          unitCost: p && p.unit_cost !== null && p.unit_cost !== undefined ? num(p.unit_cost) : null,
          qty: num(r.qty) || 1, active: r.active !== false, reviewed: r.reviewed === true,
          note: r.note || "",
        };
      };

      const channels = await ordersByChannel(from, to);
      const perChannel = channels.map((ch) => {
        const op = orderPackagingFor(wb, ch.channel);
        return {
          channel: ch.channel, channelAr: ch.ar, orders: ch.orders,
          perOrder: op.complete ? op.perOrder : null,
          perOrderKnown: op.perOrder,
          complete: op.complete, unpriced: op.unpriced,
          lines: op.lines,
          periodCost: op.complete && ch.orders ? round2(op.perOrder * ch.orders) : null,
        };
      });
      const known = perChannel.every((x) => x.complete);
      const periodTotal = perChannel.reduce((a, x) => a + (x.periodCost || 0), 0);

      // How many item-scoped boxes the menu actually attracts, so the manager
      // can see the other half of the packaging bill.
      let itemPackagingTotal = 0, itemPackagingComplete = true;
      const { byProduct } = await salesByProduct(wb, from, to);
      for (const m of model.menu) {
        const pk = itemPackagingFor(model, wb, m);
        if (!pk.lines.length) continue;
        if (!pk.complete) itemPackagingComplete = false;
        itemPackagingTotal += pk.cost * (byProduct.get(m.product_id)?.units || 0);
      }

      return c.json({
        ok: true, from, to,
        rules: wb.rules.map(shape),
        packaging: wb.packaging.map((p) => ({
          id: p.id, nameAr: p.name_ar,
          unitCost: p.unit_cost === null || p.unit_cost === undefined ? null : num(p.unit_cost),
        })),
        scopes: [
          { key: "item", ar: "لكل صنف", explain: "يدخل في تكلفة الصنف ويُضرب في الكمية — علبة البيتزا" },
          { key: "order", ar: "لكل طلب", explain: "مرة واحدة لكل فاتورة مهما كان عدد الأصناف — الستيكر والمنديل" },
          { key: "channel", ar: "حسب القناة", explain: "مرة واحدة لكل فاتورة، وللقناة دي بس — الكيس للتوصيل" },
        ],
        matchKinds: [
          { key: "all", ar: "كل الأصناف" }, { key: "product", ar: "صنف محدد" },
          { key: "category", ar: "تصنيف" }, { key: "name", ar: "الاسم يحتوي" },
          { key: "channel", ar: "قناة البيع" },
        ],
        channels: CHANNELS,
        orderPackaging: {
          byChannel: perChannel,
          complete: known,
          periodCost: known ? round2(periodTotal) : null,
          // The sentence that keeps this out of item_costs.
          explain: "تغليف الطلب (كيس، ستيكر، منديل) يُحسب مرة واحدة لكل فاتورة، "
                 + "ولا يدخل في تكلفة الصنف — لأنه لو دخل، الطلب اللي فيه ٦ أصناف "
                 + "هيدفع ٦ أكياس. رقمه هنا مصروف تشغيلي شهري، مش تكلفة وحدة.",
        },
        itemPackaging: {
          periodCost: itemPackagingComplete ? round2(itemPackagingTotal) : null,
          complete: itemPackagingComplete,
          explain: "تغليف الصنف (علبة البيتزا، علبة الوجبة) يدخل في تكلفة الوحدة ويُكتب في item_costs.",
        },
        unreviewedRules: wb.rules.filter((r) => r.reviewed !== true).length,
      });
    } catch (e) {
      console.error("[costing] rules failed:", e);
      return c.json({ ok: false, error: "rules_failed", detail: e.message }, 500);
    }
  });

  /* PUT /api/costing/rules — { rules:[…] } replaces the whole set.
     A rule set is a single coherent statement about how orders are packed;
     merging half of one is how you end up with two bags. */
  app.put("/api/costing/rules", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "rules"); if (denied) return denied;
    try {
      const b = await c.req.json().catch(() => ({}));
      const rules = Array.isArray(b.rules) ? b.rules : null;
      if (!rules) return c.json({ ok: false, error: "rules_required" }, 400);

      const oldRows = (await pool.query("SELECT * FROM cw_packaging_rules")).rows;
      const known = new Set((await pool.query("SELECT id FROM cw_packaging")).rows.map((r) => r.id));
      const errors = [];
      const keep = [];
      for (const r of rules) {
        const scope = ["item", "order", "channel"].includes(String(r?.scope)) ? String(r.scope) : null;
        const pkg = String(r?.packagingId || r?.packaging_id || "").trim();
        if (!scope) { errors.push(`نطاق غير صحيح: ${r?.scope}`); continue; }
        if (!known.has(pkg)) { errors.push(`صنف تغليف غير معروف: ${pkg}`); continue; }
        let kind = String(r?.matchKind || (scope === "channel" ? "channel" : "all"));
        let value = String(r?.matchValue ?? "");
        if (scope === "order") { kind = "all"; value = ""; }
        if (scope === "channel") {
          kind = "channel";
          if (!CHANNELS.some((ch) => ch.key === value)) { errors.push(`قناة غير معروفة: ${value}`); continue; }
        }
        if (scope === "item" && !["all", "product", "category", "name"].includes(kind)) {
          errors.push(`نوع مطابقة غير صحيح: ${kind}`); continue;
        }
        keep.push({ id: r?.id || idFor("pr", scope, kind, value, pkg),
                    scope, kind, value, pkg, qty: num(r?.qty) || 1,
                    active: r?.active === undefined ? true : !!r.active,
                    reviewed: r?.reviewed === undefined ? true : !!r.reviewed,
                    note: String(r?.note || "") });
      }
      if (!keep.length && rules.length)
        return c.json({ ok: false, error: "all_rules_invalid", errors }, 400);

      await pool.query("DELETE FROM cw_packaging_rules");
      for (const k of keep)
        await pool.query(
          `INSERT INTO cw_packaging_rules
             (id, scope, match_kind, match_value, packaging_id, qty, active, reviewed, note, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
           ON CONFLICT (id) DO UPDATE SET qty=EXCLUDED.qty, active=EXCLUDED.active,
             reviewed=EXCLUDED.reviewed, note=EXCLUDED.note, updated_by=EXCLUDED.updated_by,
             updated_at=NOW()`,
          [k.id, k.scope, k.kind, k.value, k.pkg, k.qty, k.active, k.reviewed, k.note,
           String(u.id || "")]);

      const desc = (r) => `${r.scope}/${r.match_kind ?? r.kind}:${r.match_value ?? r.value}→${r.packaging_id ?? r.pkg}×${num(r.qty)}`;
      await audit(u, "rules", "packaging", "ruleset",
        oldRows.map(desc).join(" | "), keep.map(desc).join(" | "), String(b.note || ""));

      return c.json({ ok: true, saved: keep.length, errors });
    } catch (e) {
      console.error("[costing] rules save failed:", e);
      return c.json({ ok: false, error: "save_failed", detail: e.message }, 500);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     WORKBENCH ROUTE 5 — /recalc. The only route that writes to `item_costs`,
     which is the only table finance.js reads. Everything else in the workbench
     is a draft until this runs.
     ═══════════════════════════════════════════════════════════════════════ */

  app.post("/api/costing/recalc", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "recalc"); if (denied) return denied;
    try {
      const b = await c.req.json().catch(() => ({}));
      const dryRun = b.dryRun === true;
      // Default effective date is TODAY, never '2000-01-01'. Backdating a new
      // cost to the beginning of time rewrites every month already reported.
      const effectiveFrom = dayArg(b.effectiveFrom, todayISO());
      const onlyIds = Array.isArray(b.productIds) ? new Set(b.productIds.map(Number)) : null;

      cache = { at: 0, model: null };
      const model = await loadModel();
      const wb = await loadWorkbench(effectiveFrom);
      const current = await costsAsOf(effectiveFrom);

      const changed = [], unchanged = [], skipped = [];
      for (const m of model.menu) {
        const pid = m.product_id;
        if (onlyIds && !onlyIds.has(pid)) continue;
        const names = wb.posByProduct.get(pid) || [];
        const cm = computeItem(model, wb, pid);
        const rv = wb.review.get(pid);

        const reject = (reason, reasonAr) => skipped.push({
          productId: pid, nameAr: m.product_ar, reason, reasonAr,
          cost: cm.cost, confidence: cm.confidence });

        if (!names.length) { reject("no_pos_name", "لا يوجد اسم مطابق على الكاشير"); continue; }
        if (cm.cost === null) { reject("no_recipe", "لا توجد وصفة"); continue; }
        // We refuse to publish a number we do not believe. A missing ingredient
        // makes the total an understatement, and an understated COGS is worse
        // than the blended 43% fallback finance.js already applies.
        if (cm.confidence === "missing") { reject("missing_ingredient", "أحد المكونات بلا تكلفة"); continue; }
        if (rv?.status === "needs_info") { reject("needs_info", "الصنف معلّم «ناقص معلومات»"); continue; }

        for (const name of names) {
          const cur = current.get(name);
          const same = cur && Math.abs(num(cur.cost) - cm.cost) < 0.005;
          if (same) { unchanged.push({ posName: name, productId: pid, cost: cm.cost }); continue; }
          const entry = {
            posName: name, productId: pid, nameAr: m.product_ar,
            from: cur ? round3(num(cur.cost)) : null, to: cm.cost,
            delta: cur ? round3(cm.cost - num(cur.cost)) : null,
            confidence: cm.confidence, reviewStatus: cm.reviewStatus,
            foodCost: cm.foodCost, packagingCost: cm.packagingCost,
          };
          if (!dryRun) {
            await pool.query(
              `INSERT INTO item_costs (id, item_name, item_id, cost, effective_from, note)
               VALUES ($1,$2,$3,$4,$5::date,$6)
               ON CONFLICT (item_name, effective_from) DO UPDATE SET
                 cost=EXCLUDED.cost, item_id=EXCLUDED.item_id, note=EXCLUDED.note, updated_at=NOW()`,
              [crypto.randomUUID(), name, String(pid), cm.cost, effectiveFrom,
               `${m.product_ar} — ${NOTE_WORKBENCH}`]);
            await audit(u, "item_costs", name, "cost", entry.from, entry.to,
              `${effectiveFrom} · ${m.product_ar}`);
          }
          changed.push(entry);
        }
      }

      if (!dryRun)
        await audit(u, "recalc", effectiveFrom, "run", null,
          `${changed.length} تغيير`, String(b.note || ""));

      changed.sort((a, b2) => Math.abs(b2.delta ?? b2.to ?? 0) - Math.abs(a.delta ?? a.to ?? 0));

      // Order-scoped packaging is deliberately absent from everything above.
      // Reported here so the number is not lost, only kept out of unit costs.
      const chans = await ordersByChannel(daysAgoISO(29), todayISO());
      const orderPack = chans.map((ch) => {
        const op = orderPackagingFor(wb, ch.channel);
        return { channel: ch.channel, channelAr: ch.ar, orders: ch.orders,
                 perOrder: op.complete ? op.perOrder : null,
                 periodCost: op.complete ? round2(op.perOrder * ch.orders) : null };
      });

      return c.json({
        ok: true, dryRun, effectiveFrom,
        changed: changed.length, unchanged: unchanged.length, skipped: skipped.length,
        changes: changed, skippedItems: skipped,
        totalDelta: round3(changed.reduce((a, x) => a + (x.delta || 0), 0)),
        orderPackagingLast30d: {
          byChannel: orderPack,
          note: "لم تُكتب في تكاليف الأصناف — تُحسب مرة واحدة لكل فاتورة كمصروف تشغيلي.",
        },
        wrote: dryRun ? "لا شيء (تجربة فقط)" : "item_costs",
      });
    } catch (e) {
      console.error("[costing] recalc failed:", e);
      return c.json({ ok: false, error: "recalc_failed", detail: e.message }, 500);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     WORKBENCH ROUTE 6 — /tasks. The queue.

     Ranked by MONEY MOVED, which is deliberately not the same as severity:

         impact ≈ sales value riding on the number × how wrong it could be

     A 5%-uncertain cost on the best-selling dish outranks a 100%-uncertain
     cost on a dish nobody orders. That is the ordering that makes the Tarb
     plug — flagged 'OK' by the source workbook — the first thing the manager
     sees, and the three loud sauce flags the last.
     ═══════════════════════════════════════════════════════════════════════ */

  /* How wrong each kind of gap could plausibly be, as a share of the cost it
     touches. These are judgement calls, and they are written down here rather
     than buried in an expression so they can be argued with. */
  const UNCERTAINTY = {
    BATCH_PLUG: 0.35,           // tarb modelled as kofta — a third out is easy
    /* Reductions, not grill losses. A tomato sauce loses a LOT of water; a
       béchamel and a braise lose less. 25% is the conservative end of what a
       reduced sauce does, and it is applied only to the four batches that are
       genuinely cooked before they are portioned — see COOKED_BATCHES.
       It is NOT applied to marinated meat, whose portions are weighed raw. */
    BATCH_COOKED_NO_YIELD: 0.25,
    RAW_GUESSED: 1.00,          // a typed round number could be double
    ITEM_UNREVIEWED: 0.10,      // nobody has looked; assume a tenth
    PACKAGING_UNPRICED: 1.00,   // unknown is unknown
    RULES_UNREVIEWED: 0.50,
    /* Deep-fried items absorb oil and the fryer is dumped on a cycle. A working
       trade figure is 3–5% of the fried item's own food cost; 4% is used and
       stated as an estimate everywhere it appears. */
    FRY_OIL: 0.04,
  };

  /* Which menu items are deep-fried, for the frying-oil finding. Matched on the
     INGREDIENT, not the dish name, because "كرانشي" is marketing and بطاطس is
     a fryer basket. Every one of these arrives at the restaurant frozen and
     leaves it through 180 °C oil. */
  const FRIED_INGREDIENT_RE = /بطاطس|اصابع موزاريلا|أصابع موزاريلا|حلقات بصل|فيليه زنجر|استربس|بوب كوردن|كوردن بلو|كالماري|جمبري/;
  const FRY_OIL_RE = /زيت قلي|زيت القلي|frying oil/i;

  async function buildTasks(model, wb, from, to) {
    const { sales, byProduct } = await salesByProduct(wb, from, to);
    const costs = await costsAsOf(to);
    const salesByName = new Map(sales.map((s) => [s.name, s]));
    const prodValue = (pid) => byProduct.get(pid)?.value || 0;
    const T = [];
    const push = (t) => T.push({ impactSar: 0, salesSar: 0, evidence: {}, ...t });

    /* Grams of one batch that physically left the store over the window, and
       what those grams cost. Batch findings are ranked on THIS, not on the
       sales value of every dish that happens to touch the batch — a 0.5% error
       on a 16,000-SAR seller is not a bigger problem than a 20% error on a
       3,000-SAR one, and ranking by sales says it is. */
    const batchGramsInWindow = (m, key) => {
      let g = 0;
      for (const [pid, perUnit] of batchGramsPerUnit(m, key))
        g += perUnit * (byProduct.get(pid)?.units || 0);
      return g;
    };
    const batchCogsInWindow = (m, key, eb) =>
      eb.perG === null ? 0 : batchGramsInWindow(m, key) * eb.perG;

    /* ── 1. Batches with no recipe. The headline: Tarb. ── */
    for (const [key, b] of model.batch) {
      const eb = effBatch(model, wb, key);
      const deps = dependentsOfBatch(model, key);
      const value = deps.reduce((a, pid) => a + prodValue(pid), 0);
      const noRecipe = eb.plug || /missing recipe/i.test(b.note || "");
      if (noRecipe) {
        push({
          kind: "BATCH_PLUG", severity: "critical", itemKind: "batch", itemRef: b.batch_ar,
          title: `وصفة «${b.batch_ar}» غير مُدخلة`,
          why: `التكلفة الحالية ${eb.storedSarPerKg ?? "?"} ر.س/كجم رقم مؤقت بلا وصفة خلفه، `
             + `و${round2(value)} ر.س من المبيعات محسوبة عليه`
             + (deps.length ? ` عبر ${deps.length} صنف` : ""),
          action: "أدخل مكونات التشغيلة ووزن الإنتاج الفعلي بعد الطهي",
          salesSar: round2(value), impactSar: round2(value * UNCERTAINTY.BATCH_PLUG),
          evidence: { storedSarPerKg: eb.storedSarPerKg, dependents: deps.length,
                      dependentItems: deps.map((pid) => model.menuById.get(pid)?.product_ar).filter(Boolean) },
        });
        continue;   // a batch with no recipe cannot also have a yield finding
      }
      /* ── 2. A yield finding, but ONLY where a yield can exist. ─────────────
         ═══ DELETED ON PURPOSE: the old BATCH_NO_YIELD_LOSS rule ═══
         It fired on any batch whose output equalled its input while containing
         protein, and it was WRONG on this menu. It put SAR 3,288 (الصدور),
         2,263 (الكفتة) and 1,929 (شيش طاووق) at the very top of the manager's
         queue asking him to fix numbers that were already right.

         Those are MARINATION batches. 5 kg of chicken goes into the tub and
         5 kg comes out; a meal takes 300 g and that 300 g is weighed RAW,
         before it ever sees the grill. Raw grams × raw price is the complete
         and correct cost. The grill shrinkage happens after the portion has
         been costed, so charging it here would bill Omar for meat he never
         bought — and it would do it on his best-selling dishes.

         "Output = input" is only a problem when the recipe's grams are grams
         of the FINISHED thing, i.e. the batch is cooked before it is
         portioned. That is `isCookedBatch()`, and on this menu it is four
         sauces and a braise, not the meat. Do not generalise this back to a
         protein-share heuristic. */
      if (eb.cookedBeforePortioning && eb.yieldAssumed
          && eb.inputG && eb.outputG >= eb.inputG - 0.5) {
        const info = COOKED_BATCHES.get(norm(key)) || {};
        const judged = eb.cookedEvidence === "judgement";
        push({
          kind: "BATCH_COOKED_NO_YIELD",
          severity: value > 3000 ? "high" : "medium",
          itemKind: "batch", itemRef: b.batch_ar,
          title: `«${b.batch_ar}» بتتطبخ قبل ما تتقسّم وبدون نسبة ناتج`,
          why: `${eb.cookedReason || info.why || "التشغيلة دي بتتطبخ"} — يعني الجرام في `
             + `الوصفة جرام بعد الطهي، لكن التكلفة متقسومة على وزن المدخلات `
             + `(${round3(eb.inputG)} جم) كأن مفيش حاجة راحت. التكلفة الحقيقية للجرام أعلى، `
             + `و${round2(value)} ر.س مبيعات بتعتمد عليها`
             + (judged ? ". ملاحظة: التصنيف ده قراءة مهنية لقائمة المكونات، مش قياس" : ""),
          action: `اطبخ تشغيلة وزن ${round3(eb.inputG)} جم مدخلات، وزن الناتج بعد ما يبرد، وأدخل الرقمين`,
          salesSar: round2(value),
          /* Real money, not a share of sales: the grams of THIS batch that
             actually left the store over the window, priced at the difference
             between the current SAR/g and what it would be at a 25% loss. */
          impactSar: round2(batchCogsInWindow(model, key, eb)
            * (1 / (1 - UNCERTAINTY.BATCH_COOKED_NO_YIELD) - 1)),
          evidence: { inputG: round3(eb.inputG), outputG: round3(eb.outputG),
                      sarPerKg: eb.sarPerKg, cookedReason: eb.cookedReason,
                      classification: eb.cookedEvidence,
                      batchCogsInWindow: round2(batchCogsInWindow(model, key, eb)),
                      note: "الأثر تقدير: لو الفاقد الحقيقي 25%، ده الفرق في تكلفة "
                          + "الكمية اللي اتباعت فعلاً في الفترة" },
        });
      }

      /* ── 2b. More out than in. Conservation of mass, and provable. ─────────
         A raw batch cannot yield more than it was given. Four do on paper,
         because the output cell was typed by hand and an ingredient was later
         zeroed without revisiting it. effBatch() now caps the output at the
         input, so the cost is already corrected — this finding exists to tell
         the manager the number MOVED and why, and to get the recipe fixed at
         source rather than left leaning on a cap. */
      if (eb.outputCapped) {
        const before = eb.storedOutputG ? round3(eb.totalCost / eb.storedOutputG * 1000) : null;
        const zeros = (model.batchLines.get(key) || [])
          .filter((l) => num(l.qty_g) === 0 && num(l.qty) === 0).map((l) => l.ing_ar);
        push({
          kind: "BATCH_OUTPUT_EXCEEDS_INPUT", severity: "critical",
          itemKind: "batch", itemRef: b.batch_ar,
          title: `«${b.batch_ar}» ناتجها أكبر من مكوّناتها`,
          why: `المكتوب ${round3(eb.storedOutputG)} جم ناتج من ${round3(eb.inputG)} جم مكوّنات — `
             + `${round3(eb.capGainG)} جم بيظهروا من العدم، وده بيخلي سعر الكيلو ${before} `
             + `بدل ${eb.sarPerKg}. التكلفة اتصححت تلقائيًا لكن الوصفة نفسها لسه ناقصة`
             + (zeros.length ? `؛ في ${zeros.length} مكوّن مكتوب بكمية صفر (${zeros.join("، ")})` : ""),
          action: "افتح التشغيلة وأدخل كميات المكوّنات اللي مكتوبة صفر، أو صحّح وزن الناتج",
          salesSar: round2(value),
          /* Exact: the grams sold over the window × the SAR/g the cap moved.
             No estimate in this one — the correction is arithmetic. */
          impactSar: before === null ? round2(value * 0.05)
            : round2(batchGramsInWindow(model, key) * (eb.perG - before / 1000)),
          evidence: { storedOutputG: round3(eb.storedOutputG), inputG: round3(eb.inputG),
                      phantomG: round3(eb.capGainG), sarPerKgWas: before,
                      sarPerKgNow: eb.sarPerKg, zeroQtyLines: zeros },
        });
      }
    }

    /* ── 3. Materials priced by guess. ── */
    for (const [key, r] of model.raw) {
      const e = effRaw(model, wb, key);
      if (!e.flaggedReview && e.priceSource !== "estimate") continue;
      const deps = dependentsOfRaw(model, key);
      const value = deps.reduce((a, d) => a + prodValue(d.productId), 0);
      // If the true price is double, this is the extra COGS over the window —
      // a direct money figure, not a share, so it is used as the impact as-is.
      const doubleRisk = deps.reduce(
        (a, d) => a + d.exposureSar * (byProduct.get(d.productId)?.units || 0), 0);
      push({
        kind: "RAW_GUESSED", severity: doubleRisk > 500 ? "high" : "low",
        itemKind: "material", itemRef: r.canonical_ar,
        title: `سعر «${r.canonical_ar}» تقديري`,
        why: `${e.pricePerUnit ?? "?"} ر.س/${e.purchaseUnit || "وحدة"} رقم مكتوب بلا فاتورة. `
           + `لو السعر الحقيقي الضعف، الفرق ${round2(doubleRisk)} ر.س في الفترة دي`,
        action: "أدخل سعر الشراء من آخر فاتورة، مع اسم المورّد",
        salesSar: round2(value), impactSar: round2(doubleRisk),
        evidence: { pricePerUnit: e.pricePerUnit, purchaseUnit: e.purchaseUnit,
                    dependents: deps.length, costIfDoubled: round2(doubleRisk) },
      });
    }

    /* ── 4. THE TRIM TEST — the real yield loss in this operation. ─────────────
          This is where the money the deleted BATCH_NO_YIELD_LOSS rule was
          chasing actually is. Not on the grill, where the portion has already
          been weighed and paid for, but on the prep bench BEFORE anything is
          weighed: buy 1 kg of ribs, clean it, get 820 g. The 180 g of bone and
          fat cap is bought, paid for, and unsellable, so every usable gram cost
          more than the invoice says.

          The task asks for the two weights and nothing else. A typed percentage
          does not close it (`trimWeighed`), because the point of the whole
          exercise is to replace inference with a scale. */
    for (const [key, r] of model.raw) {
      if (!TRIMMABLE_RE.test(key) || NOT_TRIMMABLE_RE.test(key)) continue;
      const e = effRaw(model, wb, key);
      if (e.trimWeighed) continue;          // measured — done
      if (e.purchasePerG === null) continue;
      const deps = dependentsOfRaw(model, key);
      const value = deps.reduce((a, d) => a + prodValue(d.productId), 0);
      if (value < 100) continue;    // not worth the manager's morning
      const assumed = e.trimLossPct !== null;   // a number exists, unweighed
      const buyKg = round3(e.purchasePerG * 1000);
      push({
        kind: "MATERIAL_NO_YIELD", severity: value > 3000 ? "high" : "medium",
        itemKind: "material", itemRef: r.canonical_ar,
        title: assumed
          ? `فاقد تنظيف «${r.canonical_ar}» رقم مفترض مش موزون`
          : `«${r.canonical_ar}» — مقستش الفاقد بعد التنظيف`,
        why: assumed
          ? `الموديل شغّال على فاقد ${round2(e.trimLossPct * 100)}% وده رقم استُنتج، `
            + `مش خارج من ميزان. سعر الشراء ${buyKg} ر.س/كجم بيطلع ${round3(e.perG * 1000)} `
            + `بعد الفاقد، و${round2(value)} ر.س مبيعات ماشية على الرقم ده`
          : `سعر الشراء ${buyKg} ر.س/كجم، لكن العضم والدهن اللي بيتشال قبل الطهي `
            + `اتدفع تمنه ومش بيتباع. من غير الوزنتين الموديل بيحسب الجرام بسعر الشراء، `
            + `يعني أرخص من الحقيقة. ${round2(value)} ر.س مبيعات تعتمد عليها`,
        // One instruction, two numbers, one scale. No percentage anywhere.
        action: "زِن الكمية وهي زي ما اشتريتها، نضّفها، زِنها تاني — "
              + "وأدخل الرقمين (اشتريت / طلع). النسبة والسعر الصافي بيتحسبوا لوحدهم",
        salesSar: round2(value), impactSar: round2(value * (assumed ? 0.05 : 0.08)),
        evidence: { purchaseSarPerKg: buyKg, dependents: deps.length,
                    trimSource: e.trimSource || "none",
                    assumedTrimLossPct: e.trimLossPct,
                    example: `اشتريت 1000 جم ← طلع 820 جم يعني فاقد 18% → `
                           + `${round3(buyKg / 0.82)} ر.س/كجم بدل ${buyKg}`,
                    note: "الأثر تقدير — الفاقد الحقيقي مش متقاس لسه" },
      });
    }

    /* ── 4b. The ribs number. The one material where a trim loss is ALREADY in
          the cost, derived by algebra from the gap between what Omar pays (90)
          and what he was pricing off (110). It is the right shape and the wrong
          provenance, and it stays flagged until the two weights replace it. ── */
    {
      const ribs = model.raw.get(norm("ريش"));
      const eR = effRaw(model, wb, norm("ريش"));
      if (ribs && !eR.trimWeighed
          && String(ribs.yield_note || "").includes(RIBS_YIELD_SENTINEL)) {
        const ribSales = sales.filter((s) => !s.isModifier && norm(s.name).includes("ريش"))
                              .reduce((a, s) => a + s.amount, 0);
        push({
          kind: "RIBS_YIELD_ASSUMED", severity: ribSales > 2000 ? "high" : "medium",
          itemKind: "material", itemRef: "ريش",
          title: "فاقد الريش متحسوب بالعكس من السعر، مش من ميزان",
          why: `الموديل عارف إن الشراء 90 ر.س/كجم والتسعير 110، فاستنتج إن الفاقد `
             + `${Math.round(RIBS_TRIM_ASSUMED * 100)}%. ده رقم اتحسب من الفرق نفسه — `
             + `لو الفاقد الحقيقي 25% السعر الصافي 120 مش 110، ولو 12% يبقى 102. `
             + `${round2(ribSales)} ر.س مبيعات ريش قاعدة على التخمين ده`,
          action: "زِن صندوق ريش قبل التنظيف وبعده وأدخل الرقمين — الوزنتين بس",
          salesSar: round2(ribSales),
          impactSar: round2(ribSales * 0.12),
          evidence: {
            purchaseSarPerKg: eR.purchasePerG === null ? null : round3(eR.purchasePerG * 1000),
            assumedTrimLossPct: round3(RIBS_TRIM_ASSUMED),
            derivedSarPerKg: eR.perG === null ? null : round3(eR.perG * 1000),
            hardcodedSarPerKg: 110,
            trimSource: eR.trimSource || "none",
            formula: "90 ÷ (1 − 0.1818) = 110.0 ر.س/كجم",
            note: "الأثر تقدير: ±6 نقاط حوالين الـ18% المفترضة",
          },
        });
      }
    }

    /* ── 5. Packaging Omar named but never priced. ── */
    const unpriced = wb.packaging.filter((p) => p.active !== false
      && (p.unit_cost === null || p.unit_cost === undefined));
    if (unpriced.length) {
      const orders = (await ordersByChannel(from, to)).reduce((a, ch) => a + ch.orders, 0);
      push({
        kind: "PACKAGING_UNPRICED", severity: "high", itemKind: "packaging",
        itemRef: "packaging", title: `${unpriced.length} صنف تغليف بدون سعر`,
        why: `${unpriced.map((p) => p.name_ar).join("، ")} — كلها بلا تكلفة، `
           + `يعني ${orders} طلب في الفترة دي محسوبة كأن التغليف مجاني`,
        action: "أدخل سعر العبوة وعدد القطع فيها لكل صنف تغليف",
        salesSar: null,
        // 0.75 SAR of packaging per order is a placeholder for the SIZE of the
        // hole, not a cost estimate — it is never written anywhere.
        impactSar: round2(orders * 0.75),
        evidence: { unpriced: unpriced.map((p) => p.name_ar), ordersInWindow: orders },
      });
    }

    /* ── 5b. Categories no packaging rule reaches. Omar named boxes for pizza,
          doritos, fries and crepe and said every meal goes out in a box — he
          said nothing about burgers, pasta, sandwiches, طاسات or مقبلات. That
          is 32 of the 78 costed items being served in something nobody has
          named. The gap is reported; it is not filled with a plausible box. ── */
    {
      const uncovered = new Map();
      for (const m of model.menu) {
        if (itemPackagingFor(model, wb, m).lines.length) continue;
        const cat = m.category_ar || "(بدون تصنيف)";
        const e = uncovered.get(cat) || { items: 0, value: 0 };
        e.items += 1; e.value += prodValue(m.product_id);
        uncovered.set(cat, e);
      }
      for (const [cat, e] of uncovered) {
        if (e.value < 200) continue;
        push({
          kind: "PACKAGING_NO_RULE", severity: "medium", itemKind: "rules",
          itemRef: `category:${cat}`,
          title: `«${cat}» — ${e.items} صنف بدون تغليف محدد`,
          why: `${round2(e.value)} ر.س مبيعات، وما فيش قاعدة تقول الأصناف دي بتتقدم في إيه. `
             + `تكلفتها دلوقتي محسوبة كأنها بتتقدم بدون علبة`,
          action: `افتح «قواعد التغليف» وأضف علبة لتصنيف ${cat}`,
          salesSar: round2(e.value), impactSar: round2(e.value * 0.02),
          evidence: { category: cat, items: e.items },
        });
      }
    }

    /* ── 6. Packaging rules nobody has confirmed. ── */
    const unrev = wb.rules.filter((r) => r.reviewed !== true).length;
    if (unrev) {
      const orders = (await ordersByChannel(from, to)).reduce((a, ch) => a + ch.orders, 0);
      push({
        kind: "RULES_UNREVIEWED", severity: "medium", itemKind: "rules", itemRef: "rules",
        title: `${unrev} قاعدة تغليف لم تُراجع`,
        why: "القواعد الحالية مكتوبة من كلام عمر ولم يؤكدها أحد: أي صنف بياخد علبة، "
           + "وأي قناة بتاخد كيس",
        action: "افتح «قواعد التغليف» وأكّد أو صحّح كل قاعدة",
        salesSar: null, impactSar: round2(orders * 0.25),
        evidence: { unreviewedRules: unrev },
      });
    }

    /* ── 7. Sold every day, never reviewed. ── */
    for (const m of model.menu) {
      const rv = wb.review.get(m.product_id);
      if (rv && rv.status !== "unreviewed") continue;
      const value = prodValue(m.product_id);
      if (value < 500) continue;
      const cm = computeItem(model, wb, m.product_id);
      push({
        kind: "ITEM_UNREVIEWED", severity: value > 5000 ? "high" : "medium",
        itemKind: "item", itemRef: m.product_ar, productId: m.product_id,
        title: `«${m.product_ar}» لم تُراجع تكلفتها`,
        why: `${round2(value)} ر.س مبيعات، والتكلفة ${cm.cost ?? "غير معروفة"} ر.س `
           + `جاية من ملف التكاليف بدون ما حد يفتحها ويتأكد`,
        action: "افتح الصنف، راجع كل مكوّن، ثم علّمه «مؤكدة»",
        salesSar: round2(value), impactSar: round2(value * UNCERTAINTY.ITEM_UNREVIEWED),
        evidence: { cost: cm.cost, confidence: cm.confidence, ingredients: cm.lines.length },
      });
    }

    /* ── 8. A size-M dish carrying the size-L recipe. Direct, provable money. ── */
    for (const [name, row] of costs) {
      const note = String(row.note || "");
      if (!note.includes(NOTE_RECIPE) && !note.includes(NOTE_WORKBENCH)) continue;
      const wbName = norm(note.split("—")[0]);
      const a = portionSizeOf(name), z = portionSizeOf(wbName);
      if (!a || !z || a === z) continue;
      const s = salesByName.get(name) || { qty: 0, amount: 0 };
      const want = model.menu.find((m) => norm(m.product_ar) ===
        norm(wbName.replace(/\(L\)/, "(M)").replace(/\(M\)/, "(L)")));
      const gap = want ? round3(num(row.cost) - num(want.total_cost)) : null;
      /* A gap of exactly zero means the COST is already the size-correct one
         and only the free-text note still names the other size. Live data: all
         nine medium pizzas are in this state — the number was fixed, the note
         was not. Raising nine 'critical' tasks worth SAR 0 would teach the
         manager that critical means nothing. The mapping no longer depends on
         that note anyway (cw_item_pos does), so there is nothing to fix. */
      if (gap !== null && Math.abs(gap) < 0.005) continue;
      push({
        kind: "SIZE_COST_MISMATCH", severity: "critical", itemKind: "pos", itemRef: name,
        title: `«${name}» بتحمل تكلفة مقاس تاني`,
        why: `الصنف مقاس ${a} لكن التكلفة مأخوذة من وصفة مقاس ${z} («${wbName}»)`
           + (gap === null ? "" : ` — فرق ${gap} ر.س للوحدة × ${round2(s.qty)} وحدة`),
        action: "اربط الصنف بالوصفة الصحيحة في جدول الربط ثم أعد الاحتساب",
        salesSar: round2(s.amount),
        impactSar: gap === null ? round2(s.amount * 0.1) : round2(Math.abs(gap) * s.qty),
        evidence: { posSize: a, workbookSize: z, workbookItem: wbName,
                    costUsed: num(row.cost), gapPerUnit: gap, units: round2(s.qty) },
      });
    }

    /* ── 9. Items whose realised food cost is above the alarm line. ── */
    for (const s of sales) {
      if (s.isModifier || s.amount <= 0 || s.qty <= 0) continue;
      const row = costs.get(s.name);
      if (!row) continue;
      const revEx = s.amount / (1 + VAT_RATE);
      const fc = (num(row.cost) * s.qty) / revEx;
      if (fc <= 0.45) continue;
      push({
        kind: "FOOD_COST_HIGH", severity: fc > 0.6 ? "critical" : "high",
        itemKind: "pos", itemRef: s.name,
        title: `«${s.name}» تكلفتها ${(fc * 100).toFixed(0)}% من سعرها`,
        why: `التكلفة ${round3(num(row.cost))} ر.س والسعر ${round2(s.amount / s.qty)} ر.س شامل الضريبة. `
           + `الهدف 22% — الفرق ${round2((fc - 0.22) * revEx)} ر.س في الفترة دي`,
        action: "راجع الوصفة أولاً؛ لو التكلفة صحيحة فالمشكلة في السعر",
        salesSar: round2(s.amount),
        // Direct money: what a 45% ceiling would have saved. Not a guess.
        impactSar: round2((fc - 0.45) * revEx),
        evidence: { foodCostPct: round3(fc), unitCost: round3(num(row.cost)),
                    avgPriceIncl: round2(s.amount / s.qty), units: round2(s.qty) },
      });
    }

    /* ── 10. Sold with no cost row at all. ── */
    for (const s of sales) {
      if (costs.get(s.name)) continue;
      if (s.isModifier || s.amount <= 200) continue;
      push({
        kind: "ITEM_UNPRICED", severity: s.amount > 2000 ? "high" : "medium",
        itemKind: "pos", itemRef: s.name,
        title: `«${s.name}» تُباع بدون تكلفة معروفة`,
        why: `${round2(s.amount)} ر.س مبيعات بتتحسب بنسبة 43% العامة بدل تكلفة حقيقية`,
        action: "اربط الصنف بوصفة في القائمة، أو أدخل له وصفة جديدة",
        salesSar: round2(s.amount), impactSar: round2(s.amount * 0.15),
        evidence: { units: round2(s.qty), value: round2(s.amount) },
      });
    }

    /* ══════════════════════════════════════════════════════════════════════════
       11. THE CHEF'S READ OF THE RECIPES
       Everything above audits the arithmetic. The four findings below come from
       reading the recipes the way a kitchen reads them — what would you actually
       have to buy to send this dish out of the pass — and every one of them is a
       cost that is genuinely being incurred and genuinely is not in the model.
       ══════════════════════════════════════════════════════════════════════════ */

    /* ── 11a. An ingredient written into a recipe at ZERO grams. ───────────────
       Somebody listed it, then never measured it. Either the kitchen does not
       use it (delete the line) or it does (the dish is undercosted every time).
       On the live data this is 36 lines: جبنة كيري on 25 pizzas — a cheese
       nobody has weighed onto a product family worth SAR 2,100 — and بطاطس on
       four طاسات, which matters more than it looks: a طاسة is SERVED on a bed
       of fries. A skillet with 0 g of potato is not a costing rounding error,
       it is a recipe that cannot produce the dish on the menu photo. */
    {
      const byIng = new Map();
      for (const [pid, lines] of model.recipeLines) {
        const m = model.menuById.get(pid);
        if (!m) continue;
        for (const l of lines) {
          if (num(l.qty) !== 0 || num(l.qty_g) !== 0) continue;
          const k = norm(l.ing_ar);
          const e = byIng.get(k) || { ing: l.ing_ar, items: [], value: 0, units: 0 };
          e.items.push(m.product_ar);
          e.value += prodValue(pid);
          e.units += byProduct.get(pid)?.units || 0;
          byIng.set(k, e);
        }
      }
      for (const [k, e] of byIng) {
        const er = effRaw(model, wb, k);
        /* Size the hole with the portion this kitchen ACTUALLY uses of the
           same ingredient elsewhere, not a flat guess. بطاطس is 250 g in the
           fries and 100 g in a حواوشي, so the four طاسات missing their potato
           base are a far bigger hole than جبنة كيري at 15 g. The number is
           never written to any cost — the whole point of the finding is that
           nobody has said what the quantity is. */
        const typicalG = typicalQtyG(model, k);
        const perPortion = er.perG === null ? null : round3(er.perG * typicalG);
        push({
          kind: "RECIPE_ZERO_QTY",
          severity: e.value > 2000 ? "high" : e.value > 300 ? "medium" : "low",
          itemKind: "material", itemRef: e.ing,
          title: `«${e.ing}» مكتوبة في ${e.items.length} وصفة بكمية صفر`,
          why: `مكوّن اتكتب في الوصفة وماتحطلوش كمية، يعني إما المطبخ مش بيستخدمه `
             + `والسطر لازم يتشال، أو بيستخدمه والتكلفة ناقصة على `
             + `${round2(e.value)} ر.س مبيعات`
             + (perPortion === null ? ""
                : ` — في وصفات تانية بيتحط منه ${round2(typicalG)} جم بـ${perPortion} ر.س`),
          action: `افتح أي صنف من دول وقول: بيتحط منه كام جرام فعلاً؟ لو مش بيتحط، امسح السطر`,
          salesSar: round2(e.value),
          impactSar: perPortion === null ? round2(e.value * 0.01)
                                         : round2(perPortion * e.units),
          evidence: { ingredient: e.ing, itemCount: e.items.length,
                      items: e.items.slice(0, 12),
                      typicalQtyG: round2(typicalG), sarPerTypicalPortion: perPortion,
                      unitsSold: round2(e.units),
                      note: "الأثر تقدير: الحصة مأخوذة من متوسط استخدام نفس المكوّن في "
                          + "وصفات تانية — الكمية الحقيقية هنا مش مكتوبة" },
        });
      }
    }

    /* ── 11b. The fryer. ──────────────────────────────────────────────────────
       `زيت قلي دلال` is in the raw-material list at 6.30 SAR/L and it appears in
       exactly zero recipes. So is `بهارات بطاطس`. Meanwhile بطاطس محمرة is
       costed as 250 g of potato at 1.50 SAR and NOTHING ELSE — no oil, no
       seasoning. Every fried item on this menu is in the same state: mozzarella
       sticks, onion rings, zinger fillets, strips, بوب كوردن, calamari.

       Frying oil is not a rounding error in a fried-food business. The basket
       absorbs it and the fryer gets dumped on a cycle whether or not it was
       busy, and both of those are bought oil that left the building as food
       cost. 4% of the fried item's own cost is the conservative trade figure
       and it is stated as an estimate. */
    {
      // The exact canonical name, so the task links to the real material row.
      const oilKey = [...model.raw.keys()].find((k) => FRY_OIL_RE.test(String(k))) || null;
      const oilExists = oilKey !== null;
      const oilUsed = [...model.recipeLines.values()].flat()
        .some((l) => FRY_OIL_RE.test(norm(l.ing_ar)) && num(l.qty_g) > 0)
        || [...model.batchLines.values()].flat()
        .some((l) => FRY_OIL_RE.test(norm(l.ing_ar)) && num(l.qty_g) > 0);
      if (!oilUsed) {
        const fried = [];
        for (const [pid, lines] of model.recipeLines) {
          const m = model.menuById.get(pid);
          if (!m) continue;
          if (!lines.some((l) => FRIED_INGREDIENT_RE.test(norm(l.ing_ar)))) continue;
          fried.push({ pid, nameAr: m.product_ar, value: prodValue(pid) });
        }
        const friedValue = fried.reduce((a, f) => a + f.value, 0);
        const friedCogs = fried.reduce((a, f) => {
          const cm = computeItem(model, wb, f.pid);
          return a + (cm.cost || 0) * (byProduct.get(f.pid)?.units || 0);
        }, 0);
        if (fried.length) {
          fried.sort((a, b) => b.value - a.value);
          push({
            kind: "FRY_OIL_UNCOSTED", severity: friedValue > 3000 ? "high" : "medium",
            itemKind: "material", itemRef: oilKey || "زيت قلي",
            title: "زيت القلي مش داخل في تكلفة أي صنف مقلي",
            why: (oilExists
                   ? `«${model.raw.get(oilKey)?.canonical_ar || oilKey}» موجود في قايمة الخامات `
                     + `بـ${round3(num(model.raw.get(oilKey)?.cost_per_unit))} `
                     + `ر.س/${model.raw.get(oilKey)?.purchase_unit || "لتر"} ومستخدم في صفر وصفة. `
                   : "مفيش مادة خام اسمها زيت قلي أصلاً. ")
               + `${fried.length} صنف بيتقلي (${fried.slice(0, 4).map((f) => f.nameAr).join("، ")}…) `
               + `بـ${round2(friedValue)} ر.س مبيعات محسوبة كأن القلي مجاني. البطاطس المحمرة `
               + `مثلاً تكلفتها 1.50 ر.س = بطاطس وبس، لا زيت ولا بهارات`,
            action: "قول القلاية بتاخد كام لتر، وبتتغير كل كام يوم — الموديل هيوزّع "
                  + "التكلفة على الأصناف المقلية",
            salesSar: round2(friedValue),
            impactSar: round2(friedCogs * UNCERTAINTY.FRY_OIL),
            evidence: { friedItems: fried.length, friedCogsInWindow: round2(friedCogs),
                        oilMaterialExists: oilExists, assumedShareOfFriedCost: UNCERTAINTY.FRY_OIL,
                        topItems: fried.slice(0, 8).map((f) => f.nameAr),
                        note: "الأثر تقدير: 4% من تكلفة الأصناف المقلية، رقم مهني مش قياس" },
          });
        }
      }
    }

    /* ── 11c. qty and qty_g disagreeing on a gram line. ────────────────────────
       Two live rows, both of them a straight data-entry slip that changes the
       cost: كريب ميكس فراخ charges 100 g of strips for a line that says 75 g
       (over by 0.66 SAR), and كريب هوت دوج charges 160 g for a line that says
       180 g (under by 0.40 SAR). Small money, but it is the kind of thing that
       makes a manager stop trusting the recipe screen. */
    {
      const bad = [];
      for (const [pid, lines] of model.recipeLines) {
        const m = model.menuById.get(pid);
        if (!m) continue;
        for (const l of lines) {
          const u = String(l.unit || "g").trim().toLowerCase();
          if (!["g", "ml", "جم", "مل"].includes(u)) continue;
          const q = num(l.qty), g = num(l.qty_g);
          if (!q || !g || Math.abs(q - g) < 0.001) continue;
          bad.push({ pid, nameAr: m.product_ar, ing: l.ing_ar, qty: q, qtyG: g,
                     value: prodValue(pid) });
        }
      }
      if (bad.length) {
        const value = [...new Set(bad.map((x) => x.pid))]
          .reduce((a, pid) => a + prodValue(pid), 0);
        const gap = bad.reduce((a, x) => {
          const er = effRaw(model, wb, norm(x.ing));
          const units = byProduct.get(x.pid)?.units || 0;
          return a + (er.perG === null ? 0 : Math.abs(x.qtyG - x.qty) * er.perG * units);
        }, 0);
        push({
          kind: "RECIPE_QTY_UNIT_MISMATCH", severity: "high",
          itemKind: "recipe", itemRef: "qty_mismatch",
          title: `${bad.length} سطر في الوصفات الكمية فيه غير الجرامات`,
          why: bad.map((x) => `«${x.nameAr}» — ${x.ing} مكتوبة ${x.qty} جم ومحسوبة ${x.qtyG} جم`)
                  .join("؛ ") + `. الفرق ${round2(gap)} ر.س في الفترة دي`,
          action: "افتح السطرين دول وخلّي الكمية والجرامات نفس الرقم",
          salesSar: round2(value), impactSar: round2(gap),
          evidence: { lines: bad.map((x) => ({ item: x.nameAr, ingredient: x.ing,
                        qty: x.qty, qtyG: x.qtyG })) },
        });
      }
    }

    /* ── 11d. The same dish, two prices, one of them a loss. ───────────────────
       The delivery apps take 18–21%. A platform price at or below the in-house
       price therefore cannot cover the commission, let alone the extra
       packaging — the dish earns LESS on the app than on the counter and the
       app is the channel that costs more to serve. `/health` has reported this
       for a while; it belongs in the queue, because it is the one pricing error
       here that can be fixed in a minute by editing a number in an app portal. */
    {
      const COMMISSION = 0.195;    // midpoint of the 18–21% band
      for (const m of model.menu) {
        const r = m.price_restaurant === null ? null : num(m.price_restaurant);
        const p = m.price_platform === null ? null : num(m.price_platform);
        if (!r || !p) continue;
        if (p > r * (1 + COMMISSION)) continue;      // uplift covers the cut
        const cm = computeItem(model, wb, m.product_id);
        const cost = cm.cost;
        if (cost === null || cost === undefined) continue;
        const gpHouse = r / (1 + VAT_RATE) - cost;
        const gpApp = (p * (1 - COMMISSION)) / (1 + VAT_RATE) - cost;
        const value = prodValue(m.product_id);
        const units = byProduct.get(m.product_id)?.units || 0;
        push({
          kind: "PLATFORM_PRICE_TOO_LOW",
          /* A platform price at or BELOW the counter price is not an
             optimisation, it is a mistake — four pizzas are in that state and
             they must not be filtered out by the noise floor just because they
             sold two units. Critical means "this is wrong", not "this is big". */
          severity: p <= r || gpApp <= 0 ? "critical" : "high",
          itemKind: "item", itemRef: m.product_ar, productId: m.product_id,
          title: gpApp <= 0
            ? `«${m.product_ar}» بتخسر على التطبيق`
            : `«${m.product_ar}» سعرها على التطبيق مش مغطّي العمولة`,
          why: `سعر المطعم ${r} وسعر التطبيق ${p} — فرق ${round2((p / r - 1) * 100)}% بس، `
             + `والتطبيقات بتاخد 18–21%. بعد العمولة الطبق بيجيب `
             + `${round2(gpApp)} ر.س مقابل ${round2(gpHouse)} داخل المطعم`
             + (gpApp <= 0 ? " — يعني كل وحدة بتتباع خسارة" : ""),
          action: `ارفع سعر «${m.product_ar}» على التطبيقات لـ${round2(r * 1.35)} ر.س على الأقل`,
          salesSar: round2(value),
          impactSar: round2(Math.max(0, gpHouse - gpApp) * Math.max(units, 1)),
          evidence: { priceRestaurant: r, pricePlatform: p, cost: round3(cost),
                      gpHouse: round2(gpHouse), gpPlatform: round2(gpApp),
                      commissionAssumed: COMMISSION, units,
                      note: "العمولة 19.5% متوسط نطاق 18–21% — تقدير، والنسبة الحقيقية في تبويب المالية" },
        });
      }
    }

    /* ── 12. Open questions, asked in the queue instead of over WhatsApp ──────
       Omar's instruction: put the questions to the manager directly. These are
       costs every restaurant carries and this menu certainly carries — charcoal
       under the grill, the sauce nobody ordered, the daily bin — none of which
       exists anywhere in the workbook. Each one is a finding tied to a piece of
       missing DATA, so it closes itself the moment the answer is entered rather
       than needing someone to remember to tick it off.

       Impact is deliberately conservative and stated as a share of the sales it
       touches, because the honest answer to "how much is this costing you" is
       currently "nobody has measured it". */
    const materialExists = (re) => [...model.raw.keys()].some((k) => re.test(String(k)));
    const totalSales = sales.reduce((a, s) => a + (s.amount || 0), 0);
    const grillSales = sales
      .filter((s) => /مشوي|ريش|كباب|كفت|طرب|شيش|فحم|مشكل/.test(s.name))
      .reduce((a, s) => a + (s.amount || 0), 0);

    const QUESTIONS = [
      { id: "charcoal", need: /فحم|charcoal|غاز|gas/i, sales: grillSales, share: 0.02,
        title: "الفحم والغاز مش محسوبين في تكلفة أي طبق",
        why: `المشاوي بتاكل فحم وغاز وده مصروف حقيقي لكل طبق، ومفيش مادة خام بالاسم ده أصلاً. `
           + `${round2(grillSales)} ر.س مبيعات مشاوي محسوبة من غيره`,
        action: "قول كيس الفحم بكام وبيكفي كام طبق تقريبًا، وأضفه كمادة خام" },
      { id: "free_sauce", need: /صوص مجاني|إضافات مجانية/i, sales: totalSales, share: 0.01,
        title: "الصوصات والمخلل اللي بتتحط من غير طلب",
        why: "الحاجات اللي بتنزل مع الطبق من غير ما العميل يطلبها مش في أي وصفة، "
           + "وبتاكل من الهامش على كل طلب",
        action: "قول إيه اللي بينزل مجاني مع كل صنف وبكمية تقريبية قد إيه" },
      { id: "waste", need: /هدر يومي|تالف/i, sales: totalSales, share: 0.015,
        title: "الأكل التالف آخر اليوم مش محسوب",
        why: "اللي بيترمي في آخر اليوم تكلفته بتتوزع على اللي اتباع فعلاً. "
           + "من غير الرقم ده تكلفة الطعام أقل من الحقيقة",
        action: "قول تقريبًا بيترمي بكام في اليوم، أو ابدأ تكتبه يوم بيوم" },
      { id: "staff_meal", need: /وجبة موظفين|أكل العاملين/i, sales: totalSales, share: 0.01,
        title: "أكل الموظفين مش متسجل كتكلفة",
        why: "ده غير خصم الـ٥٠٪ — الوجبة اللي بياكلها العامل بتطلع من نفس المخزون",
        action: "قول كام وجبة موظفين في اليوم وإيه اللي بياكلوه غالبًا" },
      { id: "drink_serve", need: /كوب|شاليموه|تلج|ice|cup/i, sales: totalSales, share: 0.005,
        title: "الكوباية والتلج والشاليموه",
        why: "لو في مشروب بيتقدّم مفتوح، الكوباية والتلج تكلفة مالهاش سطر",
        action: "قول المشروب بيتقدّم إزاي، وسعر الكوباية والشاليموه" },
      /* Skewers. شيش طاووق, كفتة and طرب all go on a skewer and the skewer is
         either a wooden one that leaves with the food or a steel one that has
         to be washed. Neither is in any recipe or in the packaging list. Small
         per unit, constant across the whole grill section. */
      { id: "skewers", need: /سيخ|أسياخ|اسياخ|skewer/i, sales: grillSales, share: 0.004,
        title: "الأسياخ مش محسوبة في الشيش والكفتة والطرب",
        why: `الشيش طاووق والكفتة والطرب كلها بتتشوى على أسياخ، ومفيش سيخ في أي وصفة `
           + `ولا في قايمة التغليف. ${round2(grillSales)} ر.س مبيعات مشاوي محسوبة من غير سيخ`,
        action: "قول الأسياخ خشب ولا حديد، والخشب بكام الكيس وفيه كام سيخ" },
      /* Crepe/hawawshi wrapping. A crepe leaves the pass in paper before it
         reaches a box, and every سندوتش is wrapped. Nothing in PACKAGING_SEED
         covers paper — only boxes and bags. */
      { id: "wrap_paper", need: /ورق تغليف|ورق كريب|ورق ساندوتش|wrapping/i,
        sales: sales.filter((s) => /كريب|حواوشي|ساندوتش|برجر/.test(s.name))
                    .reduce((a, s) => a + (s.amount || 0), 0),
        share: 0.006,
        title: "ورق تغليف الكريب والساندوتشات",
        why: "الكريب والحواوشي والبرجر بيتلفّوا في ورق قبل ما يدخلوا العلبة، "
           + "وقايمة التغليف فيها علب وأكياس بس — مفيش ورق",
        action: "قول رول ورق التغليف بكام وبيلف كام قطعة تقريبًا" },
    ];
    for (const q of QUESTIONS) {
      if (materialExists(q.need)) continue;   // answered — the material now exists
      if (!(q.sales > 0)) continue;
      push({
        kind: "OPEN_QUESTION", severity: "medium", itemKind: "question", itemRef: q.id,
        title: q.title, why: q.why, action: q.action,
        salesSar: round2(q.sales), impactSar: round2(q.sales * q.share),
        evidence: { note: "الأثر تقدير محافظ — الرقم الحقيقي مش متقاس لسه", share: q.share },
      });
    }
    // Delivery packaging is a different question: it is about a RULE, not a
    // material, so it closes when a channel rule for delivery is reviewed.
    const reviewedChannelRule = (await pool.query(
      `SELECT 1 FROM cw_packaging_rules
        WHERE scope = 'channel' AND active AND reviewed LIMIT 1`)).rowCount > 0;
    if (!reviewedChannelRule) {
      push({
        kind: "OPEN_QUESTION", severity: "medium", itemKind: "question", itemRef: "delivery_box",
        title: "علبة التوصيل نفس علبة الصالة؟",
        why: "طلبات التوصيل غالبًا بتتغلّف أتقل عشان تستحمل الطريق، "
           + "وقواعد التغليف الحالية اتكتبت من كلام مش من مراجعة",
        action: "راجع قواعد التغليف وقول لو التوصيل بياخد علبة أغلى",
        salesSar: 0, impactSar: 20,
        evidence: { note: "بند تشغيلي، مش مربوط بصنف" },
      });
    }

    /* ── The noise floor ─────────────────────────────────────────────────────
       Before this line the live build produced 140 open tasks, 30 of them
       food-cost alarms worth under SAR 15 each over three months. A queue the
       manager cannot finish is a queue he stops opening, and the cost of
       hiding a SAR 12 finding is smaller than the cost of burying the SAR
       3,288 one under it. Anything CRITICAL survives regardless of size —
       those are correctness bugs, not optimisations.

       So do STRUCTURAL findings: statements about how the model itself is
       built, of which there can only ever be a handful. صوص البيتزا carries a
       few tens of riyals because pizza sauce is 30 g of cooked tomato, but
       "this batch needs a yield and those twelve do not" is the sentence that
       keeps the whole yield model honest. Burying it would let the next reader
       conclude nothing here ever needs a yield. */
    const STRUCTURAL = new Set(["BATCH_COOKED_NO_YIELD", "BATCH_OUTPUT_EXCEEDS_INPUT",
                                "RECIPE_QTY_UNIT_MISMATCH", "FRY_OIL_UNCOSTED"]);
    const FLOOR_SAR = 15;
    const kept = T.filter((t) => t.severity === "critical" || STRUCTURAL.has(t.kind)
      || (t.impactSar || 0) >= FLOOR_SAR);
    kept.sort((a, b) => (b.impactSar || 0) - (a.impactSar || 0));
    kept.belowFloor = T.length - kept.length;
    return kept;
  }

  /** Persist the candidate list, preserving whatever the manager already did
   *  with each one, and auto-close the ones that no longer occur. */
  async function syncTasks(candidates) {
    const stamp = new Date();
    for (const t of candidates) {
      const fp = `${t.kind}|${t.itemRef}`;
      await pool.query(
        `INSERT INTO cw_tasks
           (id, fingerprint, kind, title, why, action, impact_sar, sales_sar,
            item_ref, item_kind, product_id, severity, evidence, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
         ON CONFLICT (fingerprint) DO UPDATE SET
           title=EXCLUDED.title, why=EXCLUDED.why, action=EXCLUDED.action,
           impact_sar=EXCLUDED.impact_sar, sales_sar=EXCLUDED.sales_sar,
           severity=EXCLUDED.severity, evidence=EXCLUDED.evidence,
           last_seen_at=EXCLUDED.last_seen_at,
           -- A snooze that has run out becomes open again by itself.
           status = CASE WHEN cw_tasks.status = 'snoozed'
                          AND cw_tasks.snooze_until IS NOT NULL
                          AND cw_tasks.snooze_until <= CURRENT_DATE
                         THEN 'open' ELSE cw_tasks.status END`,
        [`tk_${idFor("tk", fp).slice(0, 16)}`, fp, t.kind, t.title, t.why, t.action || "",
         t.impactSar, t.salesSar, String(t.itemRef), t.itemKind || "",
         t.productId ?? null, t.severity || "medium", JSON.stringify(t.evidence || {}), stamp]);
    }
    // Anything still open that this build did not produce is fixed. Closing it
    // as 'done' by 'system' is honest — and it stays in the table, so the
    // manager can see that it was once a problem.
    const gone = await pool.query(
      `UPDATE cw_tasks SET status='done', resolved_by='system',
              resolved_name='تلقائي', resolved_at=NOW(),
              note = CASE WHEN note = '' THEN 'لم تعد المشكلة موجودة' ELSE note END
        WHERE status = 'open' AND last_seen_at < $1
        RETURNING id`, [stamp]);
    return gone.rowCount;
  }

  app.get("/api/costing/tasks", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "tasks"); if (denied) return denied;
    try {
      const from = dayArg(c.req.query("from"), daysAgoISO(89));
      const to = dayArg(c.req.query("to"), todayISO());
      const status = String(c.req.query("status") || "open").trim();
      const model = await loadModel();
      const wb = await loadWorkbench(to);

      const candidates = await buildTasks(model, wb, from, to);
      const autoClosed = await syncTasks(candidates);

      const where = status === "all" ? "" : "WHERE status = $1";
      const rows = (await pool.query(
        `SELECT * FROM cw_tasks ${where}
          ORDER BY (status='open') DESC, impact_sar DESC NULLS LAST, last_seen_at DESC
          LIMIT 400`, status === "all" ? [] : [status])).rows;

      const tasks = rows.map((r, i) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        why: r.why,
        action: r.action || "",
        impactSar: r.impact_sar === null ? null : round2(num(r.impact_sar)),
        salesSar: r.sales_sar === null ? null : round2(num(r.sales_sar)),
        itemRef: r.item_ref,
        itemKind: r.item_kind,
        productId: r.product_id,
        severity: r.severity,
        status: r.status,
        priority: i + 1,
        evidence: r.evidence || {},
        note: r.note || "",
        resolvedBy: r.resolved_name || "",
        resolvedAt: r.resolved_at,
        snoozeUntil: isoDayOf(r.snooze_until),
        firstSeenAt: r.first_seen_at,
      }));

      const counts = (await pool.query(
        "SELECT status, count(*)::int AS n FROM cw_tasks GROUP BY 1")).rows;
      return c.json({
        ok: true, from, to, status,
        tasks,
        autoClosed,
        // Findings real but too small to be worth a morning. Reported as a
        // number so "the queue is short" never means "we hid things".
        belowFloor: candidates.belowFloor || 0,
        counts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
        totalImpactOpen: round2(rows.filter((r) => r.status === "open")
          .reduce((a, r) => a + num(r.impact_sar), 0)),
        ranking: "مرتبة حسب المبلغ اللي بيتحرك لو صُلّحت: قيمة المبيعات المعتمدة على الرقم "
               + "× مقدار الشك فيه. المشكلة الغالية أولاً، مش الأعلى صوتاً.",
      });
    } catch (e) {
      console.error("[costing] tasks failed:", e);
      return c.json({ ok: false, error: "tasks_failed", detail: e.message }, 500);
    }
  });

  /* POST /api/costing/tasks/:id/resolve — { action, note } → { ok }
     action: done | snooze | wont_fix | reopen. A task the manager closes stays
     closed even when the underlying finding is still detectable, because
     "I have decided this is fine" is information the system does not have. */
  app.post("/api/costing/tasks/:id/resolve", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "tasks"); if (denied) return denied;
    try {
      const id = String(c.req.param("id") || "").trim();
      const b = await c.req.json().catch(() => ({}));
      const action = String(b.action || "done");
      const note = String(b.note || "");
      const MAP = { done: "done", snooze: "snoozed", wont_fix: "wont_fix",
                    wontfix: "wont_fix", reopen: "open", open: "open" };
      const status = MAP[action];
      if (!status)
        return c.json({ ok: false, error: "bad_action",
                        message: "الإجراء: done / snooze / wont_fix / reopen" }, 400);
      if (status === "wont_fix" && !note.trim())
        return c.json({ ok: false, error: "note_required",
                        message: "اكتب سبب تجاهل المهمة — ده اللي هيفسّرها بعدين" }, 400);

      const cur = (await pool.query("SELECT * FROM cw_tasks WHERE id = $1", [id])).rows[0];
      if (!cur) return c.json({ ok: false, error: "not_found" }, 404);

      const days = Math.min(90, Math.max(1, Number(b.days) || 7));
      await pool.query(
        `UPDATE cw_tasks
            SET status=$2, note=$3,
                resolved_by = CASE WHEN $2 = 'open' THEN '' ELSE $4 END,
                resolved_name = CASE WHEN $2 = 'open' THEN '' ELSE $5 END,
                resolved_at = CASE WHEN $2 = 'open' THEN NULL ELSE NOW() END,
                snooze_until = CASE WHEN $2 = 'snoozed'
                                    THEN CURRENT_DATE + ($6 || ' days')::interval
                                    ELSE NULL END
          WHERE id=$1`,
        [id, status, note, String(u.id || ""),
         String(u.display_name || u.username || ""), String(days)]);
      await audit(u, "task", cur.fingerprint, "status", cur.status, status, note);
      return c.json({ ok: true, status, snoozeDays: status === "snoozed" ? days : null });
    } catch (e) {
      console.error("[costing] task resolve failed:", e);
      return c.json({ ok: false, error: "resolve_failed", detail: e.message }, 500);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     WORKBENCH ROUTE 7 — /audit
     ═══════════════════════════════════════════════════════════════════════ */

  app.get("/api/costing/audit", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "audit"); if (denied) return denied;
    const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit")) || 200));
    const entity = String(c.req.query("entity") || "").trim();
    const ref = String(c.req.query("ref") || "").trim();
    const params = [limit];
    let where = "";
    if (entity) { params.push(entity); where += ` AND entity = $${params.length}`; }
    if (ref) { params.push(ref); where += ` AND entity_ref = $${params.length}`; }
    const rows = (await pool.query(
      `SELECT * FROM cw_audit WHERE true ${where} ORDER BY at DESC LIMIT $1`, params)).rows;
    return c.json({
      ok: true, count: rows.length,
      entries: rows.map((r) => ({
        id: r.id, at: r.at, by: r.actor_name || r.actor_id || "—", byId: r.actor_id,
        entity: r.entity, entityAr: AUDIT_ENTITY_AR[r.entity] || r.entity,
        ref: r.entity_ref, field: r.field,
        from: r.old_value, to: r.new_value, note: r.note || "",
      })),
    });
  });

  const AUDIT_ENTITY_AR = {
    item: "صنف", recipe: "وصفة", batch: "تشغيلة", material: "مادة خام",
    packaging: "تغليف", rules: "قواعد التغليف", task: "مهمة", user: "مستخدم",
    auth: "دخول", recalc: "إعادة احتساب", item_costs: "تكلفة صنف",
    visibility: "صلاحيات العرض",
  };

  /* ── Admin utility: rebuild the POS↔product mapping on demand. Exposed
     because a new dish on the POS is otherwise invisible to /recalc until the
     next empty-table boot, which never comes. ─────────────────────────────── */
  app.post("/api/costing/remap", async (c) => {
    const u = await requireCostingOwner(c); if (isResponse(u)) return u;
    const n = await rebuildPosMap();
    await audit(u, "recalc", "posmap", "rebuild", null, String(n), "");
    return c.json({ ok: true, linked: n });
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     WORKBENCH ROUTE 8 — CREATION

     Everything above edits what already exists. This section adds: a raw
     material, a production batch, a menu product, and — the reason the whole
     section is worth building — a calculator that costs a dish BEFORE it
     exists, so the answer to "should this go on the menu?" is a number rather
     than a feeling.

     ── THE ONE RULE THAT IS NOT NEGOTIABLE ──────────────────────────────────
     A product is CHOSEN from TabSense, never typed. `finance.js` joins
     `ts_order_items.name` to `item_costs.item_name` on string equality; the
     POS is the only place that string is authored. A manager who types
     "كريب شيش طاووق" when the POS says "كريب شيش طاووك" creates a cost that is
     perfectly correct and reaches exactly zero orders — and nothing in the
     system would ever say so. So the create-product flow presents the POS
     menu and writes the chosen name verbatim into `cw_item_pos`.
     ═══════════════════════════════════════════════════════════════════════ */

  const TS_READY = !!(process.env.TABSENSE_EMAIL && process.env.TABSENSE_PASSWORD);
  const POS_CACHE_MS = 6 * 60 * 60 * 1000;   // 6 h — a menu does not move hourly
  let posFetchInFlight = null;

  /** Mirror the POS menu into `cw_pos_products`. Never destructive: a product
   *  TabSense stops returning is left in place (an outage looks identical to a
   *  deletion) and simply stops being refreshed, which `ageMinutes` reveals. */
  async function refreshPosProducts() {
    if (!TS_READY) throw new Error("tabsense_not_configured");
    if (posFetchInFlight) return posFetchInFlight;
    posFetchInFlight = (async () => {
      const rows = await tsFetchProducts({});
      for (const p of rows) {
        await pool.query(
          `INSERT INTO cw_pos_products
             (pos_id, sku, name_ar, name_en, category_ar, category_en,
              price_incl, price_excl, pos_cost, active, fetched_at, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
           ON CONFLICT (pos_id) DO UPDATE SET
             sku=EXCLUDED.sku, name_ar=EXCLUDED.name_ar, name_en=EXCLUDED.name_en,
             category_ar=EXCLUDED.category_ar, category_en=EXCLUDED.category_en,
             price_incl=EXCLUDED.price_incl, price_excl=EXCLUDED.price_excl,
             pos_cost=EXCLUDED.pos_cost, active=EXCLUDED.active,
             fetched_at=NOW(), last_seen_at=NOW()`,
          [p.id, p.sku, p.nameAr, p.nameEn, p.categoryAr, p.categoryEn,
           p.priceIncl, p.priceExcl, p.posCost, p.active !== false]);
      }
      return rows.length;
    })().finally(() => { posFetchInFlight = null; });
    return posFetchInFlight;
  }

  /** The POS menu as the picker sees it, each product flagged with whether the
   *  workbench already costs it.
   *
   *  `source` is part of the answer, not decoration:
   *    pos       — the live TabSense menu (cached)
   *    pos_stale — the cache, because TabSense would not answer just now
   *    sold      — the FALLBACK: distinct `ts_order_items.name`. Real POS
   *                strings, but sales history rather than a menu, so it
   *                contains retired dishes and misses anything never sold. */
  async function posCatalog({ search = "", refresh = false } = {}) {
    let fetchError = null;
    const have = num((await pool.query("SELECT count(*)::int AS n FROM cw_pos_products")).rows[0].n);
    const oldest = have
      ? (await pool.query("SELECT min(fetched_at) AS t FROM cw_pos_products")).rows[0].t
      : null;
    const stale = !have || !oldest || (Date.now() - new Date(oldest).getTime() > POS_CACHE_MS);
    if (TS_READY && (refresh || stale)) {
      try { await refreshPosProducts(); }
      catch (e) { fetchError = e.message; }
    } else if (!TS_READY) {
      fetchError = "tabsense_not_configured";
    }

    const rows = (await pool.query(
      "SELECT * FROM cw_pos_products ORDER BY category_ar, name_ar")).rows;

    // What the workbench already knows: the POS→product map is the real link
    // (it is what /recalc writes item_costs against), SKU and exact name are
    // the two ways a workbook row can already BE this product.
    const model = await loadModel();
    const linked = (await pool.query("SELECT pos_name, product_id FROM cw_item_pos")).rows;
    const byPosName = new Map(linked.map((r) => [norm(r.pos_name), r.product_id]));
    const bySku = new Map(model.menu.filter((m) => m.sku)
      .map((m) => [String(m.sku).trim().toUpperCase(), m]));
    const byAr = new Map(model.menu.map((m) => [norm(m.product_ar), m]));
    const soldNames = new Set((await pool.query(
      "SELECT DISTINCT name FROM ts_order_items WHERE name IS NOT NULL")).rows.map((r) => norm(r.name)));

    const decorate = (p) => {
      const pidLinked = byPosName.get(norm(p.name_ar));
      const skuHit = p.sku ? bySku.get(String(p.sku).trim().toUpperCase()) : null;
      const arHit = byAr.get(norm(p.name_ar));
      const match = pidLinked !== undefined ? model.menuById.get(pidLinked) : (skuHit || arHit || null);
      const productId = pidLinked !== undefined ? pidLinked : (match ? match.product_id : null);
      const computed = productId !== null && model.menuById.has(productId)
        ? { hasRecipe: (model.recipeLines.get(productId) || []).length > 0 } : null;
      return {
        posId: p.pos_id, sku: p.sku || "",
        nameAr: p.name_ar, nameEn: p.name_en || "",
        categoryAr: p.category_ar || "", categoryEn: p.category_en || "",
        priceIncl: p.price_incl === null ? null : num(p.price_incl),
        priceExcl: p.price_excl === null ? null : num(p.price_excl),
        activeOnPos: p.active !== false,
        /* Three different states the screen must not merge:
             costed        — linked AND has a recipe behind it
             linkedNoRecipe— a workbook row exists but is empty
             new           — nothing in the workbench knows this dish        */
        costed: !!(productId !== null && computed?.hasRecipe),
        linkedProductId: productId,
        linkedNameAr: match ? match.product_ar : null,
        linkMatchedBy: pidLinked !== undefined ? "pos_map"
          : skuHit ? "sku" : arHit ? "name" : null,
        // Whether the POS has ever actually sold this string. A product that
        // has never sold is not a mistake — it may be brand new — but a cost
        // written against it will sit idle until it does.
        everSold: soldNames.has(norm(p.name_ar)),
      };
    };

    let list = rows.map(decorate);
    let source = fetchError && stale ? "pos_stale" : "pos";

    /* FALLBACK. Only when the menu endpoint gave us nothing at all — then the
       distinct names on real order lines are the best remaining source of
       genuine POS strings, and the response says so out loud rather than
       pretending it is the menu. */
    if (!list.length) {
      const sold = (await pool.query(
        `SELECT name, count(*)::int AS n, max(o.calendar_day) AS last_day
           FROM ts_order_items i JOIN ts_orders o ON o.order_id = i.order_id
          WHERE i.name IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)).rows;
      list = sold.filter((r) => !isModifierLine(r.name)).map((r) => {
        const pid = byPosName.get(norm(r.name));
        const arHit = byAr.get(norm(r.name));
        const productId = pid !== undefined ? pid : (arHit ? arHit.product_id : null);
        return {
          posId: "", sku: "", nameAr: r.name, nameEn: "",
          categoryAr: "", categoryEn: "", priceIncl: null, priceExcl: null,
          activeOnPos: true,
          costed: !!(productId !== null && (model.recipeLines.get(productId) || []).length),
          linkedProductId: productId,
          linkedNameAr: productId !== null ? model.menuById.get(productId)?.product_ar ?? null : null,
          linkMatchedBy: pid !== undefined ? "pos_map" : arHit ? "name" : null,
          everSold: true, soldLines: r.n, lastSoldDay: isoDayOf(r.last_day),
        };
      });
      source = "sold";
    }

    const s = norm(search);
    if (s) {
      const low = s.toLowerCase();
      list = list.filter((p) => norm(p.nameAr).includes(s)
        || String(p.nameEn).toLowerCase().includes(low)
        || String(p.sku).toLowerCase().includes(low)
        || norm(p.categoryAr).includes(s));
    }
    return {
      list, source, fetchError,
      fetchedAt: oldest || null,
      ageMinutes: oldest ? Math.round((Date.now() - new Date(oldest).getTime()) / 60000) : null,
    };
  }

  /* GET /api/costing/catalog/products — the picker behind "add a product". */
  app.get("/api/costing/catalog/products", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "items"); if (denied) return denied;
    try {
      const r = await posCatalog({
        search: c.req.query("search") || "",
        refresh: c.req.query("refresh") === "1",
      });
      const SOURCE_AR = {
        pos: "قائمة نقاط البيع مباشرة",
        pos_stale: "نسخة محفوظة من قائمة نقاط البيع — تعذّر تحديثها الآن",
        sold: "أسماء اتباعت فعلاً على الكاشير (مش قائمة المنيو)",
      };
      return c.json({
        ok: true,
        count: r.list.length,
        products: r.list,
        source: r.source,
        sourceAr: SOURCE_AR[r.source] || r.source,
        fetchedAt: r.fetchedAt, ageMinutes: r.ageMinutes,
        fetchError: r.fetchError,
        newCount: r.list.filter((p) => !p.costed).length,
        costedCount: r.list.filter((p) => p.costed).length,
        hint: r.source === "sold"
          ? "دي أسماء من الطلبات الحقيقية مش من المنيو — فيها أصناف قديمة، وناقصها أي صنف لسه ما اتباعش."
          : "الاسم بيتاخد من نقاط البيع بالحرف — ده اللي بيخلّي التكلفة توصل للطلبات.",
      });
    } catch (e) {
      console.error("[costing] catalog/products failed:", e);
      return c.json({ ok: false, error: "catalog_failed", detail: e.message }, 500);
    }
  });

  /* GET /api/costing/catalog/ingredients — everything a recipe line may point
     at, in one light payload: raw materials and batches with the price the
     calculator will actually use. Deliberately NOT /materials + /batches: the
     latter runs a 90-day sales sweep per call and the picker needs neither. */
  app.get("/api/costing/catalog/ingredients", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    try {
      const asOf = dayArg(c.req.query("asOf"), todayISO());
      const model = await loadModel();
      const wb = await loadWorkbench(asOf);
      const s = norm(c.req.query("search") || "");
      const keep = (ar, en) => !s || norm(ar).includes(s)
        || String(en || "").toLowerCase().includes(s.toLowerCase());

      const materials = [...model.raw.values()]
        .filter((r) => r.active !== false && keep(r.canonical_ar, r.name_en))
        .map((r) => {
          const e = effRaw(model, wb, norm(r.canonical_ar));
          return {
            kind: "Raw", id: r.canonical_ar, nameAr: r.canonical_ar, nameEn: r.name_en || "",
            sarPerKg: e.perG === null ? null : round3(e.perG * 1000),
            sarPerPiece: e.perPiece === null ? null : round3(e.perPiece),
            // A piece-priced material must be entered in pieces, not grams —
            // multiplying a per-piece price by 200 g is the classic 1000× error.
            unitBasis: e.perG !== null ? "g" : e.perPiece !== null ? "piece" : null,
            priced: e.perG !== null || e.perPiece !== null,
            priceSource: e.priceSource, verified: e.verified,
            purchaseUnit: e.purchaseUnit, supplier: e.supplier,
          };
        });

      const batches = [...model.batch.values()]
        .filter((b) => b.active !== false && keep(b.batch_ar, b.batch_en))
        .map((b) => {
          const eb = effBatch(model, wb, norm(b.batch_ar));
          return {
            kind: "Batch", id: b.batch_ar, nameAr: b.batch_ar, nameEn: b.batch_en || "",
            sarPerKg: eb.sarPerKg, sarPerPiece: null, unitBasis: "g",
            priced: eb.perG !== null, hasRecipe: !eb.plug,
            priceSource: eb.plug ? "plug" : "batch", verified: false,
            confidence: eb.confidence,
          };
        });

      const cmp = (a, b) => String(a.nameAr).localeCompare(String(b.nameAr), "ar");
      return c.json({
        ok: true, asOf,
        materials: materials.sort(cmp),
        batches: batches.sort(cmp),
        packaging: wb.packaging.filter((p) => p.active !== false).map((p) => ({
          id: p.id, nameAr: p.name_ar, nameEn: p.name_en || "",
          unitCost: p.unit_cost === null || p.unit_cost === undefined ? null : num(p.unit_cost),
        })),
        unpricedMaterials: materials.filter((m) => !m.priced).length,
      });
    } catch (e) {
      console.error("[costing] catalog/ingredients failed:", e);
      return c.json({ ok: false, error: "catalog_failed", detail: e.message }, 500);
    }
  });

  /* ── THE CALCULATOR ───────────────────────────────────────────────────────
     Cost a recipe that does not exist yet, at today's real purchase prices,
     and write nothing.

     It reuses `effLine` — the very function that costs the live menu — so a
     dish estimated here and the same dish saved and recalculated cannot
     disagree. Reimplementing the arithmetic "just for the preview" is how a
     preview starts lying.

     The honesty rule from `computeItem` carries over intact: an ingredient
     with no price contributes NOTHING and is named, so `total` is a FLOOR and
     `complete` is false. It is never quietly treated as free. */
  function estimateRecipe(model, wb, body) {
    const lines = Array.isArray(body.recipe) ? body.recipe : [];
    const rows = []; const unpriced = [];
    let food = 0, conf = lines.length ? "measured" : "missing";

    lines.forEach((l, i) => {
      const ingAr = norm(l?.ingredientAr ?? l?.ing_ar ?? l?.name ?? l?.id);
      if (!ingAr) return;
      const unit = String(l?.unit || "g");
      const qty = num(l?.qty);
      const qtyG = l?.qtyG !== undefined && l?.qtyG !== null ? num(l.qtyG) : toGrams(qty, unit);
      const type = String(l?.type || l?.ing_type || "Raw");
      const line = {
        id: `est_${i}`, ing_type: type, ing_ar: ingAr,
        ing_en: String(l?.ingredientEn || l?.ing_en || ""),
        qty, unit, qty_g: qtyG === null ? 0 : qtyG, note: String(l?.note || ""),
      };
      const res = resolve(model, type, ingAr);
      const e = effLine(model, wb, res, line, []);
      food += e.cost;
      conf = worst(conf, e.confidence);
      if (e.row.costSource === "missing") unpriced.push(ingAr);
      rows.push(e.row);
    });

    // Cooking loss, only if the manager says the grams are SERVED weight.
    // Defaults to NULL exactly like cw_item_yield — Omar's recipes are written
    // pre-cooking, and applying a blanket loss on top would double-count it.
    const cookLoss = body.cookLossPct === undefined || body.cookLossPct === null
      || body.cookLossPct === "" ? null : asPct(body.cookLossPct);
    const foodAfter = cookLoss === null ? food : food / (1 - cookLoss);

    // Packaging: [{ packagingId, qty }]. Same four states as itemPackagingFor.
    const pkgIn = Array.isArray(body.packaging) ? body.packaging : [];
    const pkgRows = []; const pkgUnpriced = []; let pkgCost = 0;
    for (const p of pkgIn) {
      const id = String(p?.packagingId || p?.id || "").trim();
      const row = wb.packagingById.get(id);
      if (!row) continue;
      const q = num(p?.qty) || 1;
      const unitCost = row.unit_cost === null || row.unit_cost === undefined ? null : num(row.unit_cost);
      if (unitCost === null) pkgUnpriced.push(row.name_ar); else pkgCost += unitCost * q;
      pkgRows.push({ packagingId: row.id, nameAr: row.name_ar, nameEn: row.name_en || "",
                     qty: q, unitCost, cost: unitCost === null ? null : round3(unitCost * q) });
    }
    const pkgStatus = !pkgRows.length ? "no_rule"
      : pkgUnpriced.length === pkgRows.length ? "unpriced"
      : pkgUnpriced.length ? "partly_priced" : "priced";

    const complete = lines.length > 0 && !unpriced.length
      && (pkgStatus === "priced" || pkgStatus === "no_rule");

    return {
      lines: rows,
      ingredientCost: lines.length ? round3(food) : null,
      cookLossPct: cookLoss,
      ingredientCostAfterYield: lines.length ? round3(foodAfter) : null,
      packaging: pkgRows,
      packagingCost: pkgStatus === "priced" ? round3(pkgCost) : null,
      packagingCostKnown: round3(pkgCost),
      packagingStatus: pkgStatus, packagingStatusAr: PACKAGING_STATUS_AR[pkgStatus],
      packagingUnpriced: pkgUnpriced,
      // The number on the screen. `totalIsFloor` is the whole honesty of it:
      // true means "at least this much", not "this much".
      total: lines.length ? round3(foodAfter + pkgCost) : null,
      totalComplete: complete,
      totalIsFloor: lines.length > 0 && !complete,
      confidence: lines.length ? conf : "missing",
      unpricedIngredients: unpriced,
      warning: !lines.length ? "مافيش مكوّنات — ضيف سطر عشان يبقى في رقم"
        : unpriced.length ? `في ${unpriced.length} مكوّن بدون سعر — الرقم ده أقل من الحقيقة، مش التكلفة النهائية`
        : pkgUnpriced.length ? "في تغليف بدون سعر — التكلفة أعلى من الرقم ده"
        : null,
    };
  }

  /** What ONE unit of this dish leaves behind, in-house and on each delivery
   *  app, at a proposed VAT-INCLUSIVE menu price.
   *
   *  Mirrors `orderEconomics` in finance.js line for line — same commission
   *  base per app, same payment fee, same subsidy tiers, same band-by-day — on
   *  a hypothetical single-line order. The rates themselves are imported, not
   *  restated, so a contract change in the finance settings moves this screen
   *  on the same deploy. */
  function channelMath(priceIncl, cost, rates, day) {
    const p = num(priceIncl);
    if (!(p > 0)) return null;
    const netEx = p / (1 + VAT_RATE);
    const out = [];
    for (const key of ["restaurant", "keeta", "hungerstation", "ninja"]) {
      const cfg = rates[key];
      if (!cfg) continue;
      const band = bandFor(cfg, day);
      const rate = num(band.delivery);
      /* Keeta charges on the VAT-INCLUSIVE value; the other two on the
         VAT-exclusive net. Getting this backwards is a 15% error on the single
         biggest cost line there is — see rule 3 in finance.js. */
      const base = cfg.commissionBase === "total_after_promo" ? p : netEx;
      const commission = base * rate;
      const minFee = num(cfg.minServiceFeeSar);
      const minFeeTopUp = commission < minFee ? minFee - commission : 0;
      const paymentFee = base * num(cfg.paymentFeePct);
      const sub = subsidyFor(cfg, base);
      const platformCost = commission + minFeeTopUp + paymentFee + sub.amount;
      const contribution = cost === null ? null : netEx - cost - platformCost;
      out.push({
        channel: key,
        label: cfg.label || key,
        commissionRate: round3(rate),
        commissionBase: round2(base),
        commissionBaseAr: cfg.commissionBase === "total_after_promo"
          ? "العمولة على السعر شامل الضريبة" : "العمولة على السعر بدون ضريبة",
        commission: round2(commission),
        minFeeTopUp: round2(minFeeTopUp),
        paymentFee: round2(paymentFee),
        deliverySubsidy: round2(sub.amount),
        subsidyTier: sub.tier,
        subsidyConfirmed: cfg.subsidyConfirmed !== false,
        platformCost: round2(platformCost),
        revenueEx: round2(netEx),
        // What the plate leaves behind before rent, salaries and ads. Those are
        // period costs and charging them per dish would be inventing a number.
        contribution: contribution === null ? null : round2(contribution),
        contributionPct: contribution === null || netEx <= 0 ? null : round3(contribution / netEx),
        foodCostPct: cost === null || netEx <= 0 ? null : round3(cost / netEx),
        losesMoney: contribution !== null && contribution < 0,
        outOfContract: !!band.outOfContract,
        bandWhy: band.why,
        note: band.note || "",
        caveats: Array.isArray(cfg.caveats) ? cfg.caveats : [],
      });
    }
    return out;
  }

  /* POST /api/costing/estimate — creates NOTHING. The scratchpad behind
     "should this dish exist?", and the same call powers the live preview while
     a real product is being built. */
  app.post("/api/costing/estimate", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "items"); if (denied) return denied;
    try {
      const b = await c.req.json().catch(() => ({}));
      const asOf = dayArg(b.asOf, todayISO());
      const model = await loadModel();
      const wb = await loadWorkbench(asOf);
      const est = estimateRecipe(model, wb, b);

      const priceIncl = b.priceIncl === undefined || b.priceIncl === null || b.priceIncl === ""
        ? null : num(b.priceIncl);
      let rates = null;
      try { rates = mergeRates((await ctx.getSettingsData?.())?.financeRates); }
      catch { rates = mergeRates(null); }
      const channels = priceIncl === null ? null
        : channelMath(priceIncl, est.total, rates, asOf);

      const netEx = priceIncl === null ? null : priceIncl / (1 + VAT_RATE);
      /* The price the dish would need to hit a target food-cost percentage.
         Offered because the manager's real question is usually the inverse of
         the one he asked: not "what is the margin at 30 riyals" but "what do I
         have to charge". Defaults to 30% — a number to argue with, and the
         response says it is a target, not a recommendation from the data. */
      const targetPct = b.targetFoodCostPct === undefined || b.targetFoodCostPct === null
        || b.targetFoodCostPct === "" ? 0.30 : asPct(b.targetFoodCostPct);
      const suggestedIncl = est.total === null || !targetPct || targetPct <= 0
        ? null : round2((est.total / targetPct) * (1 + VAT_RATE));

      return c.json({
        ok: true,
        asOf,
        cost: {
          ingredientCost: est.ingredientCost,
          cookLossPct: est.cookLossPct,
          ingredientCostAfterYield: est.ingredientCostAfterYield,
          packagingCost: est.packagingCost,
          packagingCostKnown: est.packagingCostKnown,
          packagingStatus: est.packagingStatus,
          packagingStatusAr: est.packagingStatusAr,
          packagingUnpriced: est.packagingUnpriced,
          total: est.total,
          totalComplete: est.totalComplete,
          totalIsFloor: est.totalIsFloor,
          confidence: est.confidence,
          unpricedIngredients: est.unpricedIngredients,
          warning: est.warning,
        },
        lines: est.lines,
        packaging: est.packaging,
        pricing: priceIncl === null ? null : {
          priceIncl: round2(priceIncl),
          priceExVat: round2(netEx),
          vat: round2(priceIncl - netEx),
          foodCostPct: est.total === null ? null : round3(est.total / netEx),
          contributionInHouse: est.total === null ? null : round2(netEx - est.total),
          // A floor cost makes an OPTIMISTIC margin. Say so next to it.
          marginIsOptimistic: est.totalIsFloor,
        },
        target: { foodCostPct: targetPct, suggestedPriceIncl: suggestedIncl },
        channels,
        vatRate: VAT_RATE,
        writtenToItemCosts: false,
        hint: "ده حساب على الورق — مافيش حاجة اتحفظت.",
      });
    } catch (e) {
      console.error("[costing] estimate failed:", e);
      return c.json({ ok: false, error: "estimate_failed", detail: e.message }, 500);
    }
  });

  /* ── POST /api/costing/materials — a new raw material ─────────────────────
     The canonical Arabic name IS the primary key and IS what every recipe line
     resolves against, so a duplicate is not a harmless extra row: it splits one
     ingredient's price history in two and quietly halves the evidence behind
     every dish that uses it. A name that already exists — directly, or through
     an alias the kitchen already writes — is REFUSED with the existing row
     named, so the manager edits that one instead. */
  app.post("/api/costing/materials", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "materials"); if (denied) return denied;
    try {
      const b = await c.req.json().catch(() => ({}));
      const nameAr = norm(b.nameAr ?? b.name_ar ?? b.name);
      if (!nameAr)
        return c.json({ ok: false, error: "name_required",
                        message: "اكتب اسم المادة بالعربي — الاسم ده هو اللي الوصفات بتنده بيه" }, 400);

      const model0 = await loadModel();
      if (model0.raw.has(nameAr))
        return c.json({ ok: false, error: "duplicate",
          message: `«${nameAr}» موجودة عندك خلاص — عدّل عليها بدل ما تعمل تانية`,
          existingId: nameAr }, 409);
      const viaAlias = model0.alias.get(nameAr);
      if (viaAlias && model0.raw.has(viaAlias))
        return c.json({ ok: false, error: "duplicate_alias",
          message: `«${nameAr}» اسم تاني لـ «${viaAlias}» الموجودة عندك — عدّل عليها`,
          existingId: viaAlias }, 409);
      if (model0.batch.has(nameAr))
        return c.json({ ok: false, error: "duplicate_batch",
          message: `«${nameAr}» اسم تشغيلة موجودة — اختار اسم تاني للمادة الخام`,
          existingId: nameAr }, 409);

      const purchaseUnit = String(b.purchaseUnit ?? b.purchase_unit ?? "").trim();
      /* Two weights, never a percentage — the same input of record as
         PUT /materials/:id. See THE TRIM TEST above. */
      const numOrNull = (v) => (v === null || v === undefined || v === ""
        ? null : Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
      const bought = numOrNull(b.trimBoughtG ?? b.boughtG);
      const usable = numOrNull(b.trimUsableG ?? b.usableG);
      if (bought !== null && usable !== null && usable > bought)
        return c.json({ ok: false, error: "trim_impossible",
          message: "الوزن بعد التنظيف أكبر من وزن الشراء — راجع الرقمين" }, 400);
      const trim = bought !== null && usable !== null && bought > 0
        ? asPct(1 - usable / bought) : null;
      const trimSource = trim === null ? "" : "weighed";

      /* Price. NULL is a legitimate answer — "I know we buy this, I do not know
         today's price" is a real state and far better than a typed guess. The
         material is created either way and the queue will ask for the price. */
      const perG = b.costPerG !== undefined && b.costPerG !== null && b.costPerG !== ""
          ? num(b.costPerG)
        : b.sarPerKg !== undefined && b.sarPerKg !== null && b.sarPerKg !== ""
          ? num(b.sarPerKg) / 1000 : null;
      const perPiece = b.costPerPiece !== undefined && b.costPerPiece !== null && b.costPerPiece !== ""
        ? num(b.costPerPiece) : null;
      if (perG !== null && perPiece !== null)
        return c.json({ ok: false, error: "two_bases",
          message: "إمّا سعر بالكيلو أو سعر بالحبة — مش الاتنين. المادة بتتحسب بواحد بس" }, 400);
      const unitIsKilo = /^(kg|كجم|كيلو|l|lt|لتر|ليتر)$/i.test(purchaseUnit);
      const perUnitGiven = b.pricePerUnit === undefined || b.pricePerUnit === null
        || b.pricePerUnit === "" ? null : num(b.pricePerUnit);
      const pricePerUnit = perUnitGiven !== null ? perUnitGiven
        : unitIsKilo && perG !== null ? round3(perG * 1000)
        : perPiece !== null ? round3(perPiece) : null;
      const src = ["invoice", "quote", "estimate", "workbook"].includes(String(b.priceSource))
        ? String(b.priceSource) : "invoice";
      const note = String(b.note || "");

      await pool.query(
        `INSERT INTO cost_raw_materials
           (canonical_ar, name_en, purchase_unit, cost_per_unit, cost_per_g, cost_per_piece,
            status, note, supplier, trim_loss_pct, trim_bought_g, trim_usable_g,
            trim_source, trim_measured_at, yield_note, created_by, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 CASE WHEN $13 = 'weighed' THEN NOW() ELSE NULL END,$14,$15,$15,NOW())`,
        [nameAr, String(b.nameEn ?? b.name_en ?? ""), purchaseUnit,
         pricePerUnit, perG, perPiece,
         // A material with no price is not 'OK'. Saying REVIEW is what puts it
         // in front of somebody instead of letting it read as costed.
         perG === null && perPiece === null ? "REVIEW" : "OK",
         note, String(b.supplier || ""), trim, bought, usable, trimSource,
         String(b.yieldNote || ""), String(u.id || "")]);

      if (perG !== null || perPiece !== null) {
        const effectiveFrom = dayArg(b.effectiveFrom, todayISO());
        await pool.query(
          `INSERT INTO cw_material_prices
             (id, canonical_ar, supplier, purchase_unit, pack_qty, pack_unit, price,
              cost_per_g, cost_per_piece, effective_from, source, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12,$13)
           ON CONFLICT (canonical_ar, effective_from) DO NOTHING`,
          [idFor("mp", nameAr, effectiveFrom), nameAr, String(b.supplier || ""),
           purchaseUnit, b.packQty === undefined || b.packQty === "" ? null : num(b.packQty),
           String(b.packUnit || "g"), pricePerUnit, perG, perPiece,
           effectiveFrom, src, String(b.priceNote || note), String(u.id || "")]);
      }

      await audit(u, "material", nameAr, "create", null, nameAr,
        `${purchaseUnit || "بدون وحدة"}${perG !== null ? ` · ${round3(perG * 1000)} ر.س/كجم`
          : perPiece !== null ? ` · ${round3(perPiece)} ر.س/حبة` : " · بدون سعر"}`
        + `${trimSource === "weighed" ? ` · تنضيف ${bought}→${usable} جم` : ""}`
        + `${note ? " · " + note : ""}`);

      cache = { at: 0, model: null };
      const model = await loadModel();
      const wb = await loadWorkbench(todayISO());
      const e = effRaw(model, wb, nameAr);
      return c.json({
        ok: true, created: true,
        material: {
          id: nameAr, nameAr, nameEn: String(b.nameEn ?? ""),
          supplier: e.supplier, purchaseUnit: e.purchaseUnit, pricePerUnit: e.pricePerUnit,
          purchaseSarPerKg: e.purchasePerG === null ? null : round3(e.purchasePerG * 1000),
          effectiveSarPerKg: e.perG === null ? null : round3(e.perG * 1000),
          effectiveSarPerPiece: e.perPiece === null ? null : round3(e.perPiece),
          trimLossPct: e.trimLossPct, trimBoughtG: e.trimBoughtG, trimUsableG: e.trimUsableG,
          trimSource: e.trimSource, trimWeighed: e.trimWeighed,
          priceSource: e.priceSource, verified: e.verified,
        },
        yieldMath: trimMathOf(e),
        priced: e.perG !== null || e.perPiece !== null,
        hint: e.perG === null && e.perPiece === null
          ? "اتضافت من غير سعر — هتفضل في قايمة المهام لحد ما تدخّل سعر شراء."
          : "اتضافت. أي وصفة تستعملها دلوقتي هتحسب بالسعر ده.",
      });
    } catch (e) {
      console.error("[costing] material create failed:", e);
      return c.json({ ok: false, error: "create_failed", detail: e.message }, 500);
    }
  });

  /* ── POST /api/costing/batches — a new production batch ───────────────────
     `cooked` is the field that decides whether a missing yield is a finding or
     a fact, and it is asked HERE rather than left to the code default, because
     the person entering the batch is the only one who knows. FALSE (the
     kitchen's normal case — a marinade portioned raw) makes output = input the
     correct answer and stops the queue from nagging about a yield that does
     not exist. See the long note on `effBatch`. */
  app.post("/api/costing/batches", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "batches"); if (denied) return denied;
    try {
      const b = await c.req.json().catch(() => ({}));
      const nameAr = norm(b.nameAr ?? b.batchAr ?? b.name);
      if (!nameAr)
        return c.json({ ok: false, error: "name_required",
                        message: "اكتب اسم التشغيلة بالعربي" }, 400);

      const model0 = await loadModel();
      if (model0.batch.has(nameAr))
        return c.json({ ok: false, error: "duplicate",
          message: `«${nameAr}» تشغيلة موجودة خلاص — عدّل عليها`, existingId: nameAr }, 409);
      if (model0.raw.has(nameAr))
        return c.json({ ok: false, error: "duplicate_material",
          message: `«${nameAr}» اسم مادة خام موجودة — لو دي تشغيلة سمّيها باسم مختلف، `
            + `وإلا الوصفات هتلخبط بين الاتنين`, existingId: nameAr }, 409);

      const lines = Array.isArray(b.lines) ? b.lines : [];
      if (!lines.length)
        return c.json({ ok: false, error: "no_lines",
          message: "التشغيلة من غير مكوّنات تكلفتها رقم مؤقت مش أكتر — دخّل المكوّنات" }, 400);

      const cookedRaw = b.cookedBeforePortioning ?? b.cooked;
      const cooked = cookedRaw === undefined || cookedRaw === null || cookedRaw === ""
        ? null : !!cookedRaw;
      const outputG = b.outputG === undefined || b.outputG === null || b.outputG === ""
        ? null : num(b.outputG);
      const yieldPct = b.yieldPct === undefined || b.yieldPct === null || b.yieldPct === ""
        ? null : asYield(b.yieldPct);

      await pool.query(
        `INSERT INTO cost_batches
           (batch_ar, batch_en, output_g, total_cost, cost_per_g, note,
            yield_pct, yield_note, output_measured, cooked_before_portioning,
            created_by, updated_by, updated_at)
         VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6,$7,$8,$9,$9,NOW())`,
        [nameAr, String(b.nameEn ?? b.batchEn ?? ""), outputG, String(b.batchNote || ""),
         yieldPct, String(b.yieldNote || ""), b.outputMeasured === true, cooked,
         String(u.id || "")]);

      let i = 0;
      for (const l of lines) {
        const ingAr = norm(l?.ingredientAr ?? l?.ing_ar ?? l?.name ?? l?.id);
        if (!ingAr) continue;
        const unit = String(l?.unit || "g");
        const qty = num(l?.qty);
        const qtyG = l?.qtyG !== undefined && l?.qtyG !== null ? num(l.qtyG) : toGrams(qty, unit);
        await pool.query(
          `INSERT INTO cost_batch_lines (id, batch_ar, ing_type, ing_ar, ing_en, qty, unit, qty_g, line_cost, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)`,
          [idFor("bl", nameAr, String(i), ingAr), nameAr,
           String(l?.type || l?.ing_type || "Raw"), ingAr,
           String(l?.ingredientEn || l?.ing_en || ""), qty, unit,
           qtyG === null ? 0 : qtyG, String(l?.note || "")]);
        i += 1;
      }

      await audit(u, "batch", nameAr, "create", null, nameAr,
        `${i} مكوّن${outputG !== null ? ` · ناتج ${outputG} جم` : ""}`
        + `${cooked === null ? "" : cooked ? " · بتتطبخ قبل التقسيم" : " · بتتقسّم نيّة"}`
        + `${b.note ? " · " + String(b.note) : ""}`);

      cache = { at: 0, model: null };
      const model = await loadModel();
      const wb = await loadWorkbench(todayISO());
      const eb = effBatch(model, wb, nameAr);
      // Keep the denormalised columns in step, exactly as PUT /batches/:id does.
      await pool.query(
        `UPDATE cost_batches SET total_cost=$2, cost_per_g=$3, updated_at=NOW() WHERE batch_ar=$1`,
        [nameAr, eb.plug ? null : eb.totalCost, eb.perG]);
      cache = { at: 0, model: null };

      return c.json({
        ok: true, created: true,
        batch: {
          id: nameAr, nameAr, nameEn: String(b.nameEn ?? ""),
          lineCount: i, inputG: eb.inputG, outputG: eb.outputG,
          yieldPct: eb.yieldPct, cookedBeforePortioning: eb.cookedBeforePortioning,
          outputCapped: eb.outputCapped, capGainG: eb.capGainG,
          sarPerKg: eb.sarPerKg, sarPerKgBeforeYield: eb.sarPerKgBeforeYield,
          totalCost: eb.totalCost, confidence: eb.confidence, hasRecipe: !eb.plug,
        },
        recipe: eb.lines,
        hint: "اتضافت. تقدر تستعملها كمكوّن في أي صنف دلوقتي — واضغط «إعادة الاحتساب» عشان الأثر يوصل للأرباح.",
      });
    } catch (e) {
      console.error("[costing] batch create failed:", e);
      return c.json({ ok: false, error: "create_failed", detail: e.message }, 500);
    }
  });

  /* ── POST /api/costing/items — a new costed product ───────────────────────
     Body: { posId | posNameAr, recipe:[…], packaging:[…], priceIncl?, … }

     The product MUST come from the POS catalogue. `posNameAr` is accepted as
     well as `posId` only because the sold-names fallback has no ids; either
     way the name is looked up in `cw_pos_products` (or, failing that, in the
     real order lines) and REJECTED if it is not a string the POS has authored.
     Free text is refused on purpose — see the header of this section.

     Two ids are in play and must not be confused:
       pos_product_id  TabSense's own id for the dish
       product_id      the workbench's key, ours, allocated here.
     They overlap numerically and mean different dishes (TabSense 6 and
     workbook 8 are both SKU CRE-008), so new rows are allocated from 9001 up:
     high enough that a future re-import of the original workbook — whose ids
     stop at 97 — can never land on one. */
  app.post("/api/costing/items", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "items"); if (denied) return denied;
    try {
      const b = await c.req.json().catch(() => ({}));
      const posId = String(b.posId ?? b.pos_id ?? "").trim();
      const askedName = norm(b.posNameAr ?? b.nameAr ?? b.name);

      // ── the product must exist on the POS ──
      let pos = null;
      if (posId) {
        pos = (await pool.query("SELECT * FROM cw_pos_products WHERE pos_id = $1", [posId])).rows[0] || null;
      }
      if (!pos && askedName) {
        pos = (await pool.query(
          "SELECT * FROM cw_pos_products WHERE name_ar = $1 LIMIT 1", [askedName])).rows[0] || null;
      }
      if (!pos && askedName) {
        // Fallback path: the catalogue came from sold order lines, so the only
        // proof the POS authored this string is that it appears on a real
        // order. That is proof enough — and it is still not free text.
        const sold = (await pool.query(
          "SELECT name FROM ts_order_items WHERE name = $1 LIMIT 1", [askedName])).rows[0];
        if (sold) pos = { pos_id: "", sku: "", name_ar: sold.name, name_en: "",
                          category_ar: "", category_en: "", price_incl: null };
      }
      if (!pos)
        return c.json({ ok: false, error: "not_on_pos",
          message: "الصنف ده مش موجود في نقاط البيع. اختاره من القايمة — الاسم لازم يطابق "
            + "اللي الكاشير بيطبعه بالحرف، وإلا التكلفة مش هتلحق أي طلب.",
          hint: "لو الصنف جديد فعلاً، أضفه في نقاط البيع الأول وبعدين حدّث القايمة هنا." }, 400);

      const nameAr = norm(pos.name_ar);

      // ── already costed? ──
      const model0 = await loadModel();
      const existingPid = (await pool.query(
        "SELECT product_id FROM cw_item_pos WHERE pos_name = $1", [nameAr])).rows[0]?.product_id;
      if (existingPid !== undefined && model0.menuById.has(existingPid))
        return c.json({ ok: false, error: "already_costed",
          message: `«${nameAr}» متربط خلاص بصنف في الورشة — عدّل عليه بدل ما تعمل نسخة تانية`,
          productId: existingPid }, 409);
      const skuHit = pos.sku
        ? model0.menu.find((m) => String(m.sku).trim().toUpperCase() === String(pos.sku).trim().toUpperCase())
        : null;
      const arHit = model0.menu.find((m) => norm(m.product_ar) === nameAr);
      const twin = skuHit || arHit || null;
      if (twin && b.linkToExisting !== true)
        return c.json({ ok: false, error: "existing_workbook_item",
          message: `في صنف في الورشة اسمه «${twin.product_ar}»`
            + `${skuHit ? ` بنفس الكود ${twin.sku}` : ""} — على الأغلب ده نفس الطبق. `
            + `اربطه بيه بدل ما تعمل واحد جديد.`,
          productId: twin.product_id, matchedBy: skuHit ? "sku" : "name",
          // The escape hatch: saying "no, these are different dishes" is a
          // decision a human is allowed to make — it just may not be silent.
          resolveWith: { linkToExisting: true } }, 409);

      /* linkToExisting: adopt the workbook row rather than duplicating it. The
         POS name is mapped onto it and the recipe (if one was sent) replaces
         whatever was there — which is exactly what PUT /items/:id does. */
      let pid;
      let adopted = false;
      if (twin && b.linkToExisting === true) {
        pid = twin.product_id;
        adopted = true;
      } else {
        pid = num((await pool.query(
          `SELECT GREATEST(COALESCE(max(product_id),0) + 1, 9001)::int AS id FROM cost_menu_items`
        )).rows[0].id);
        const priceIncl = b.priceIncl === undefined || b.priceIncl === null || b.priceIncl === ""
          ? (pos.price_incl === null || pos.price_incl === undefined ? null : num(pos.price_incl))
          : num(b.priceIncl);
        await pool.query(
          `INSERT INTO cost_menu_items
             (product_id, sku, product_ar, product_en, category_ar, category_en,
              total_cost, price_suggested, price_restaurant, price_platform,
              pos_product_id, created_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,$7,$8,$9,$10,NOW())`,
          [pid, String(pos.sku || ""), nameAr, String(pos.name_en || ""),
           String(pos.category_ar || ""), String(pos.category_en || ""),
           priceIncl,
           // The platform (delivery-app) price is a separate commercial
           // decision. NULL until somebody makes it — a copy of the restaurant
           // price would read as "we checked, they are the same".
           b.pricePlatformIncl === undefined || b.pricePlatformIncl === null || b.pricePlatformIncl === ""
             ? null : num(b.pricePlatformIncl),
           String(pos.pos_id || ""), String(u.id || "")]);
      }

      /* The link that makes the whole thing worth doing: `pos_name` is the
         exact `ts_order_items.name`, and /recalc writes `item_costs` against
         it. Without this row the cost exists and reaches nothing.
         source='manual' so rebuildPosMap() never overwrites it. */
      await pool.query(
        `INSERT INTO cw_item_pos (pos_name, product_id, source) VALUES ($1,$2,'manual')
         ON CONFLICT (pos_name) DO UPDATE SET product_id = EXCLUDED.product_id, source = 'manual'`,
        [pos.name_ar, pid]);

      // ── recipe ──
      const recipe = Array.isArray(b.recipe) ? b.recipe : [];
      if (recipe.length) {
        await pool.query("DELETE FROM cost_recipe_lines WHERE product_id = $1", [pid]);
        let i = 0;
        for (const l of recipe) {
          const ingAr = norm(l?.ingredientAr ?? l?.ing_ar ?? l?.name ?? l?.id);
          if (!ingAr) continue;
          const unit = String(l?.unit || "g");
          const qty = num(l?.qty);
          const qtyG = l?.qtyG !== undefined && l?.qtyG !== null ? num(l.qtyG) : toGrams(qty, unit);
          await pool.query(
            `INSERT INTO cost_recipe_lines (id, product_id, ing_type, ing_ar, ing_en, qty, unit, qty_g, line_cost, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)`,
            [idFor("rl", String(pid), String(i), ingAr), pid,
             String(l?.type || l?.ing_type || "Raw"), ingAr,
             String(l?.ingredientEn || l?.ing_en || ""), qty, unit,
             qtyG === null ? 0 : qtyG, String(l?.note || "")]);
          i += 1;
        }
      }

      // ── packaging: rules scoped to THIS product, same shape as PUT /items ──
      const pkg = Array.isArray(b.packaging) ? b.packaging : [];
      if (pkg.length) {
        await pool.query(
          `DELETE FROM cw_packaging_rules
            WHERE scope='item' AND match_kind='product' AND match_value=$1`, [String(pid)]);
        for (const p of pkg) {
          const pkgId = String(p?.packagingId || p?.id || "").trim();
          if (!pkgId) continue;
          await pool.query(
            `INSERT INTO cw_packaging_rules
               (id, scope, match_kind, match_value, packaging_id, qty, reviewed, note, updated_by, updated_at)
             VALUES ($1,'item','product',$2,$3,$4,true,$5,$6,NOW())
             ON CONFLICT (id) DO UPDATE SET qty=EXCLUDED.qty, reviewed=true,
               note=EXCLUDED.note, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
            [idFor("pr", "item", "product", String(pid), pkgId), String(pid), pkgId,
             num(p?.qty) || 1, String(p?.note || ""), String(u.id || "")]);
        }
      }

      /* A brand-new item starts `unreviewed`, never `confirmed`. Confirmed is
         a promise that a human checked it, and creating it is not checking it. */
      await pool.query(
        `INSERT INTO cw_item_review (product_id, status, note, changed_by, changed_by_name, changed_at)
         VALUES ($1,'unreviewed',$2,$3,$4,NOW())
         ON CONFLICT (product_id) DO NOTHING`,
        [pid, String(b.note || ""), String(u.id || ""),
         String(u.display_name || u.username || "")]);

      await audit(u, "item", String(pid), adopted ? "link" : "create",
        null, nameAr,
        `${adopted ? "ربط" : "إنشاء"} من نقاط البيع${pos.pos_id ? ` (POS #${pos.pos_id})` : ""}`
        + `${pos.sku ? ` · ${pos.sku}` : ""} · ${recipe.length} مكوّن`
        + `${b.note ? " · " + String(b.note) : ""}`);
      await audit(u, "item", String(pid), "posName", null, pos.name_ar, "ربط اسم الكاشير بالصنف");

      cache = { at: 0, model: null };
      const model = await loadModel();
      const wb = await loadWorkbench(todayISO());
      const after = computeItem(model, wb, pid);
      const m = model.menuById.get(pid);
      let rates = null;
      try { rates = mergeRates((await ctx.getSettingsData?.())?.financeRates); }
      catch { rates = mergeRates(null); }
      const priceIncl = m && m.price_restaurant !== null ? num(m.price_restaurant) : null;

      return c.json({
        ok: true, created: !adopted, linked: adopted,
        productId: pid,
        item: {
          productId: pid, sku: m?.sku || "", nameAr: m?.product_ar || nameAr,
          nameEn: m?.product_en || "", categoryAr: m?.category_ar || "",
          posNames: after.posNames, posProductId: String(pos.pos_id || ""),
          priceRestaurantIncl: priceIncl,
        },
        breakdown: {
          foodCost: after.foodCost,
          packagingCost: after.packagingCost,
          packagingStatus: after.packagingStatus,
          packagingStatusAr: after.packagingStatusAr,
          packagingUnpriced: after.packagingUnpriced,
          total: after.cost, totalComplete: after.costComplete,
          confidence: after.confidence,
          costSource: after.costSource, costSourceAr: after.costSourceAr,
          reviewStatus: after.reviewStatus,
          recipe: after.lines, packaging: after.packaging,
        },
        channels: priceIncl === null ? null : channelMath(priceIncl, after.cost, rates, todayISO()),
        writtenToItemCosts: false,
        hint: recipe.length
          ? "الصنف اتعمل واتربط باسم الكاشير. اضغط «إعادة الاحتساب» عشان التكلفة تدخل تقارير الأرباح."
          : "الصنف اتعمل من غير وصفة — تكلفته لسه مش معروفة. افتحه وضيف المكوّنات.",
      });
    } catch (e) {
      console.error("[costing] item create failed:", e);
      return c.json({ ok: false, error: "create_failed", detail: e.message }, 500);
    }
  });

  /* ── Deactivation ─────────────────────────────────────────────────────────
     There is no hard delete anywhere in the workbench and there must not be.
     `cw_audit` names things by their key — a canonical Arabic name, a batch
     name, a product id — so deleting the row leaves the history pointing at
     nothing, which reads as if the change never happened. Deactivating hides
     the thing from the pickers and the create flows and leaves every past
     number, and every explanation of it, exactly where it was.

     A thing still used by a live recipe is refused, with the users named. */
  async function deactivate(c, u, kind, rawId) {
    const b = await c.req.json().catch(() => ({}));
    const id = norm(safeDecode(rawId));
    const activate = b.active === true;
    const note = String(b.note || "");
    const model = await loadModel();

    if (kind === "material") {
      const cur = model.raw.get(id);
      if (!cur) return c.json({ ok: false, error: "not_found", message: "المادة غير موجودة" }, 404);
      if (!activate) {
        // Products that consume it (directly or through a batch), plus the
        // batches whose own lines name it — the two together are every place
        // a removal would change a number.
        const inItems = dependentsOfRaw(model, id);
        const inBatches = [];
        for (const [bk, lines] of model.batchLines)
          if (lines.some((l) => resolve(model, l.ing_type, l.ing_ar).canonical === id
                                && resolve(model, l.ing_type, l.ing_ar).kind === "raw"))
            inBatches.push(bk);
        if (inItems.length || inBatches.length)
          return c.json({ ok: false, error: "in_use",
            message: `«${id}» لسه مستعملة في ${inItems.length} صنف و${inBatches.length} تشغيلة`
              + " — شيلها من الوصفات الأول",
            usedByItems: inItems.map((d) => ({ productId: d.productId, nameAr: d.item })),
            usedByBatches: inBatches }, 409);
      }
      await pool.query(
        "UPDATE cost_raw_materials SET active=$2, updated_by=$3, updated_at=NOW() WHERE canonical_ar=$1",
        [cur.canonical_ar, activate, String(u.id || "")]);
      await audit(u, "material", id, "active", cur.active !== false, activate, note);
    } else if (kind === "batch") {
      const cur = model.batch.get(id);
      if (!cur) return c.json({ ok: false, error: "not_found", message: "التشغيلة غير موجودة" }, 404);
      if (!activate) {
        const deps = dependentsOfBatch(model, id);
        if (deps.length)
          return c.json({ ok: false, error: "in_use",
            message: `«${id}» داخلة في ${deps.length} صنف — شيلها منهم الأول`,
            usedByProductIds: deps }, 409);
      }
      await pool.query(
        "UPDATE cost_batches SET active=$2, updated_by=$3, updated_at=NOW() WHERE batch_ar=$1",
        [cur.batch_ar, activate, String(u.id || "")]);
      await audit(u, "batch", id, "active", cur.active !== false, activate, note);
    } else {
      const pid = Number(rawId);
      const cur = model.menuById.get(pid);
      if (!Number.isFinite(pid) || !cur)
        return c.json({ ok: false, error: "not_found", message: "الصنف غير موجود" }, 404);
      await pool.query(
        "UPDATE cost_menu_items SET active=$2, updated_at=NOW() WHERE product_id=$1",
        [pid, activate]);
      await audit(u, "item", String(pid), "active", cur.active !== false, activate, note);
    }
    cache = { at: 0, model: null };
    return c.json({
      ok: true, active: activate, kind, id: kind === "item" ? Number(rawId) : id,
      // Say plainly what did NOT happen, so nobody reads this as a delete.
      hint: activate
        ? "رجّعناها للقايمة."
        : "اتشالت من القوايم بس ما اتمسحتش — كل الأرقام والسجل القديم زي ما هما، "
          + "وأي وصفة شغّالة عليها لسه بتحسب بيها.",
    });
  }

  app.delete("/api/costing/materials/:id", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "materials"); if (denied) return denied;
    try { return await deactivate(c, u, "material", c.req.param("id")); }
    catch (e) { return c.json({ ok: false, error: "deactivate_failed", detail: e.message }, 500); }
  });
  app.delete("/api/costing/batches/:id", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "batches"); if (denied) return denied;
    try { return await deactivate(c, u, "batch", c.req.param("id")); }
    catch (e) { return c.json({ ok: false, error: "deactivate_failed", detail: e.message }, 500); }
  });
  app.delete("/api/costing/items/:id", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    const denied = await gate(c, u, "items"); if (denied) return denied;
    try { return await deactivate(c, u, "item", c.req.param("id")); }
    catch (e) { return c.json({ ok: false, error: "deactivate_failed", detail: e.message }, 500); }
  });

  /* Referenced by any future workbook re-importer; see cw_item_review. */
  ctx.costingImportGuard = importGuard;
}
