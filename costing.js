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

const VAT_RATE = 0.15;
const SALES_ONLY = `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;

/* Notes written by the loaders, used to tell measured from hand-priced. */
const NOTE_RECIPE = "من ملف التكاليف بالوصفات";   // loaded from the recipe workbook
const NOTE_WEIGHT = "نموذج الوزن المصحّح";          // written by the weight-model fix

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
   line from a dish whose name merely contains digits. */
const MODIFIER_RE = /^(.+?)\s+\d+(?:\.\d+)?\s+(.+)$/;
export function isModifierLine(name) {
  return MODIFIER_RE.test(String(name || ""));
}
export function splitModifierLine(name) {
  const m = MODIFIER_RE.exec(String(name || ""));
  return m ? { parent: m[1].trim(), modifier: m[2].trim() } : null;
}

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
    await seedIfEmpty();
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

  ensureCostingSchema()
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
    const canonical = model.alias.get(raw0) || raw0;
    const viaAlias = canonical !== raw0;
    const isBatch = String(type || "").toLowerCase().startsWith("batch");

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
      isModifier: isModifierLine(r.name) && num(r.amount) === 0,
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
      const modifiers = { items: 0, units: 0, cost: 0, priced: 0, unpriced: 0 };
      const missing = [];

      for (const s of sales) {
        const row = costs.get(s.name);
        const b = bucketOf(row);
        const cost = row ? num(row.cost) * s.qty : 0;
        if (s.isModifier) {
          modifiers.items++; modifiers.units += s.qty; modifiers.cost += cost;
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
        modifiers: { ...modifiers, units: round2(modifiers.units), cost: round2(modifiers.cost),
                     note: "أسطر الإضافات لا تحمل إيراداً (المبلغ على الصنف الأب) — تُحسب تكلفتها فقط" },
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
          return c.json({
            kind: "modifier", query: itemArg, parentDish: parent, modifier,
            matched: mod ? { nameAr: mod.modifier_ar, nameEn: mod.modifier_en,
                             ingredientAr: mod.ing_ar, qty: num(mod.qty), unit: mod.unit,
                             cost: round3(num(mod.cost)), priceIncl: num(mod.price_incl) } : null,
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
        const p = map.get(norm(s.name));
        if (!p) continue;
        const cur = byProduct.get(p.product_id) || { units: 0, value: 0, names: [] };
        cur.units += s.qty; cur.value += s.amount; cur.names.push(s.name);
        byProduct.set(p.product_id, cur);
      }
      const prodSales = (pid) => byProduct.get(pid) || { units: 0, value: 0, names: [] };
      const F = [];
      const add = (f) => F.push({ salesValue: 0, units: 0, ...f });

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
                basis: "measured" });
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
          add({ code: "BATCH_PLUG", severity: "critical", area: "batch",
                item: b.batch_ar, itemEn: b.batch_en,
                message: `وصفة التشغيلة غير مُدخلة — التكلفة ${round3(num(b.cost_per_g) * 1000)} ر.س/كجم رقم مؤقت`,
                messageEn: `Batch recipe was never entered — ${round3(num(b.cost_per_g) * 1000)} SAR/kg is a placeholder`,
                dependents: dependents.map((pid) => ({
                  productId: pid, item: model.menuById.get(pid)?.product_ar,
                  salesValue: round2(prodSales(pid).value) })),
                salesValue: round2(value), units: round2(units), basis: "assumed",
                action: "أدخل وصفة الطرب ووزن الإنتاج الفعلي في cost_batch_lines / cost_batches" });
        }
        /* ── 2b. Zero cooking loss. output >= inputs means the batch assumes the
              meat weighs the same after grilling, which it never does. Every
              such batch is understated. */
        const inputs = lines.reduce((a, l) => a + num(l.qty_g), 0);
        if (inputs > 0 && num(b.output_g) >= inputs - 0.5) {
          const dependents = dependentsOfBatch(model, key);
          const value = dependents.reduce((a, pid) => a + prodSales(pid).value, 0);
          add({ code: "BATCH_NO_YIELD_LOSS", severity: "medium", area: "batch",
                item: b.batch_ar, itemEn: b.batch_en,
                message: `وزن الإنتاج ${num(b.output_g)} جم يساوي أو يزيد عن مجموع المدخلات ${round3(inputs)} جم — لا يوجد فقد طهي`,
                messageEn: `Output ${num(b.output_g)} g >= inputs ${round3(inputs)} g — zero cooking loss assumed, so the cost is understated`,
                salesValue: round2(value), basis: "assumed",
                evidence: { outputG: num(b.output_g), inputG: round3(inputs),
                            impliedYield: round3(num(b.output_g) / inputs) } });
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
              salesValue: round2(s.amount), units: round2(s.qty), basis: "measured" });
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

      /* ── 8. Margin alarm, measured against what the dish actually sold for. */
      const FC_ALARM = 0.45;
      for (const m of model.menu) {
        const s = prodSales(m.product_id);
        if (s.value <= 0) continue;
        const fc = num(m.total_cost) * s.units / (s.value / (1 + VAT_RATE));
        if (fc > FC_ALARM)
          add({ code: "FOOD_COST_HIGH", severity: fc > 0.6 ? "critical" : "high",
                area: "pricing", item: m.product_ar, itemEn: m.product_en,
                productId: m.product_id,
                message: `نسبة تكلفة الطعام الفعلية ${(fc * 100).toFixed(1)}% مقابل هدف 22%`,
                messageEn: `Realised food cost ${(fc * 100).toFixed(1)}% against a 22% target`,
                evidence: { foodCostPct: round3(fc), unitCost: round3(num(m.total_cost)),
                            avgPriceIncl: round2(s.value / (s.units || 1)) },
                salesValue: round2(s.value), units: round2(s.units), basis: "measured" });
      }

      const SEV = { critical: 0, high: 1, medium: 2, low: 3 };
      F.sort((a, b) => b.salesValue - a.salesValue || SEV[a.severity] - SEV[b.severity]);
      const byCode = {}, bySeverity = {};
      for (const f of F) {
        byCode[f.code] = (byCode[f.code] || 0) + 1;
        bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
      }
      const totalValue = sales.reduce((a, s) => a + s.amount, 0);
      const atRisk = new Set();
      let atRiskValue = 0;
      for (const f of F) {
        if (f.basis !== "assumed") continue;
        const k = f.item || f.code;
        if (atRisk.has(k)) continue;
        atRisk.add(k); atRiskValue += f.salesValue;
      }

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
}
