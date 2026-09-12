/* ═══════════════════════════════════════════════════════════════════════════
   BUNDLES — «باقة بخيارات»: باقة بسعر واحد بتتبني عندنا، وبتنزل نقطة البيع
   كـ**منتجات حقيقية** بأسعار احنا بنحددها.

   قرار عمر (2026-09-12) بالنص:
     «عايز دا يكون داخلي عندنا في المتجر ويتبعت للكاشير في الطلب بالسعر
      والطريقة اللي احنا نحددها بدل ما نعمل منتج جديد عشان ميضايقناش في
      حساب الريسبي»
     «نحتاج نفعّل الأوبشن ده عشان لو استخدمناه تاني في المستقبل بشكل كامل»

   يعني: **مفيش منتج جديد في نقطة البيع للباقة**. الباقة متعرّفة عندنا،
   ولما تتطلب بنوسّعها لمكوّناتها الحقيقية بأسعار موزّعة تجمع على سعر الباقة.
   كل مكوّن بيستهلك الريسبي بتاعه، فحساب التكلفة يفضل مظبوط.

   ── الباقة = اسم + سعر + «خانات» (slots) ───────────────────────────────────
   الخانة إما:
     • fixed  — منتج محدد (مع وزن اختياري)، مثال: طبق أرز بسمتي
     • choice — مجموعة منتجات العميل يختار منها واحد، مثال: نوع المشوي
   كل خانة ليها كمية، وممكن يكون لكل اختيار `variant_option_id` (زي «كيلو»).

   ── قاعدة توزيع السعر ──────────────────────────────────────────────────────
   السعر بيتوزّع **بالتناسب مع سعر القايمة** (ex-VAT) لكل مكوّن — الافتراضي
   العاقل: المكوّن الغالي بياخد نصيب أكبر، فالخصم المتضمّن في الباقة بيتوزّع
   بالعدل، والريسبي/التكلفة بتفضل منطقية لكل صنف.

   التوزيع **مضبوط بالظبط** (مفيش فروقة ولا هللة):
     ١. T = round(سعر الباقة شامل الضريبة × MULTIPLY ÷ (1 + ضريبة))
        = إجمالي الباقة **قبل** الضريبة بوحدة النظام الصحيحة (نانو-ريال).
     ٢. وزن كل مكوّن w = سعر القايمة قبل الضريبة × الكمية.
     ٣. نصيب الوحدة الخام = T × سعر_القايمة ÷ Σw  →  بناخد الجزء الصحيح (floor).
     ٤. الباقي R = T − Σ(نصيب × كمية) بيتوزّع **وحدة وحدة** بطريقة «أكبر كسر
        متبقي» (largest remainder / Hamilton) — كل وحدة بتاخد +١ نانو.
     ٥. الوحدات اللي ليها نفس السعر بترجع تتجمّع في سطر واحد لنقطة البيع.

   النتيجة مضمونة رياضياً: Σ(unit_amount × quantity) === T بالظبط. مفيش أي
   انحراف ممكن يخلي الإجمالي يختلف عن سعر الباقة.

   ملاحظة على الضريبة: ١٥٪ مش قابلة للعكس بالظبط في العشري — ٩٦ شامل =
   83.478260869565… قبل الضريبة، وده كسر دوري. بنشتغل على دقة النانو (1e9)
   زي ما تاب سينس نفسها بتخزّن أسعارها (مثال: «طرب كيلو» = 121.73913043 قبل
   الضريبة = 140.00 شامل)، فالفرق بيطلع أقل من واحد على المليار من الريال —
   بيختفي تماماً عند أي تقريب لهللتين.

   الملف ده **صافي** (مفيش داتابيز ولا شبكة) عشان كل قاعدة فيه تتجرّب أوفلاين
   — الفلوس هنا فلوس عملاء حقيقيين.
═══════════════════════════════════════════════════════════════════════════ */

export const MULTIPLY = 1000000000; // نفس وحدة tsstore — نانو ريال
export const VAT_RATE = 0.15;

/* سعر شامل الضريبة → قبل الضريبة، بوحدة النظام الصحيحة */
export function exVatUnits(priceInclVat, { multiply = MULTIPLY, vatRate = VAT_RATE } = {}) {
  return Math.round((Number(priceInclVat) || 0) * multiply / (1 + vatRate));
}

/* ═══════════════════════════════════════════════════════════════════════════
   توزيع سعر الباقة على المكوّنات — الدالة الأساسية، صافية ومضبوطة.

   lines: [{ key, menuPriceEx, quantity }]
     • menuPriceEx = سعر المنتج/الوزن في القايمة **قبل** الضريبة (زي ما تاب
       سينس بتخزّنه في `price`). هو الوزن النسبي بس، مش السعر النهائي.
     • quantity   = عدد الوحدات في الباقة (عدد صحيح ≥ ١).

   بترجّع: [{ key, quantity, unitAmount }] — وممكن يطلع أكتر من سطر لنفس
   المكوّن لو كميته > ١ والباقي ما اتقسمش عليها بالتساوي (فرق نانو واحد).

   ضمان: Σ(unitAmount × quantity) === totalEx بالظبط.
═══════════════════════════════════════════════════════════════════════════ */
export function distribute(totalEx, lines) {
  const T = Math.round(Number(totalEx) || 0);
  const src = (lines || []).map((l, i) => ({
    key: l.key, i,
    q: Math.max(1, Math.round(Number(l.quantity) || 1)),
    p: Math.max(0, Number(l.menuPriceEx) || 0),
  }));
  if (!src.length) return [];

  // كل الأوزان أصفار (منتجات بسعر صفر) ⇒ بالتساوي على الوحدات
  let sumW = src.reduce((a, l) => a + l.p * l.q, 0);
  if (!(sumW > 0)) {
    for (const l of src) l.p = 1;
    sumW = src.reduce((a, l) => a + l.p * l.q, 0);
  }

  // نصيب الوحدة الخام مستقل عن الكمية: T × p ÷ Σw
  const units = []; // وحدة وحدة عشان التوزيع يبقى مضبوط مهما كانت الكميات
  for (const l of src) {
    const raw = T * l.p / sumW;
    const base = Math.floor(raw);
    for (let k = 0; k < l.q; k++) units.push({ line: l, base, frac: raw - base, amount: base });
  }
  const placed = units.reduce((a, u) => a + u.amount, 0);
  let R = T - placed; // ٠ ≤ R < عدد الوحدات (لأن كل وحدة اتقرّبت لتحت)

  // أكبر كسر متبقي الأول؛ التعادل بيتكسر بالسعر الأكبر ثم بترتيب الخانة،
  // عشان نفس المدخلات تدّي نفس النتيجة دايماً (مهم للاختبارات وللمراجعة).
  const order = units.map((u, idx) => ({ u, idx })).sort((a, b) =>
    (b.u.frac - a.u.frac) || (b.u.line.p - a.u.line.p) ||
    (a.u.line.i - b.u.line.i) || (a.idx - b.idx));
  for (let k = 0; R > 0 && k < order.length; k++, R--) order[k].u.amount += 1;
  // حماية: لو فضل باقي (مستحيل رياضياً) بنحطه على أول وحدة بدل ما يضيع
  if (R > 0) order[0].u.amount += R;

  // تجميع الوحدات المتساوية في سطر واحد، بترتيب الخانات الأصلي
  const out = [];
  for (const l of src) {
    const mine = units.filter((u) => u.line === l);
    const byAmount = new Map();
    for (const u of mine) byAmount.set(u.amount, (byAmount.get(u.amount) || 0) + 1);
    // الأكبر الأول: لو السطر اتقسم، السطر «الأغلى» هو الأساسي
    for (const [amount, q] of [...byAmount.entries()].sort((a, b) => b[0] - a[0])) {
      out.push({ key: l.key, quantity: q, unitAmount: amount });
    }
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   شكل الباقة (التحقق) — بيتخزّن كـJSONB في cms_bundles.slots

   slot = {
     key: "grill",              // ثابت جوّه الباقة — ده اللي التقارير بتعدّ بيه
     label: "اختر المشوي",
     type: "fixed" | "choice",
     quantity: 1,
     product_id, variant_option_id      // لـfixed
     choices: [{ product_id, variant_option_id, label }]   // لـchoice
   }
═══════════════════════════════════════════════════════════════════════════ */
const clip = (v, n) => (v == null ? "" : String(v).trim().slice(0, n));
const pid = (v) => {
  const s = clip(v, 24);
  return /^\d+$/.test(s) ? s : null;
};
const vopt = (v) => {
  if (v == null || v === "" || v === false) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function normalizeSlots(raw) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(raw) ? raw.slice(0, 12) : []) {
    if (!s || typeof s !== "object") continue;
    const type = s.type === "choice" ? "choice" : "fixed";
    let key = clip(s.key, 32).replace(/[^\w-]/g, "") || `${type}${out.length + 1}`;
    while (seen.has(key)) key += "x";
    seen.add(key);
    const quantity = Math.min(20, Math.max(1, Math.round(Number(s.quantity) || 1)));
    const slot = { key, label: clip(s.label, 80), type, quantity };
    if (type === "choice") {
      const choices = [];
      const cseen = new Set();
      for (const ch of Array.isArray(s.choices) ? s.choices.slice(0, 60) : []) {
        const p = pid(ch && ch.product_id);
        if (!p) continue;
        const vo = vopt(ch.variant_option_id);
        const ck = `${p}:${vo || ""}`;
        if (cseen.has(ck)) continue;
        cseen.add(ck);
        choices.push({ product_id: p, variant_option_id: vo, label: clip(ch.label, 60) });
      }
      if (!choices.length) continue; // خانة اختيار من غير اختيارات = مالهاش معنى
      slot.choices = choices;
    } else {
      const p = pid(s.product_id);
      if (!p) continue;
      slot.product_id = p;
      slot.variant_option_id = vopt(s.variant_option_id);
    }
    out.push(slot);
  }
  return out;
}

/* هل الباقة متاحة لنوع الطلب ده؟ فاضي = متاحة للكل. */
export const ORDER_KINDS = ["delivery", "pickup", "dine_in"];
export function normalizeKinds(raw) {
  const k = (Array.isArray(raw) ? raw : []).map(String).filter((x) => ORDER_KINDS.includes(x));
  return k.length ? [...new Set(k)] : [...ORDER_KINDS];
}

/* ═══════════════════════════════════════════════════════════════════════════
   توسيع الباقة لسطور حقيقية.

   bundle  : { slug, name, price, slots, vat_rate? }
   choices : { [slotKey]: "<product_id>" | {product_id, variant_option_id} }
   quantity: عدد الباقات في السطر
   resolve : (product_id, variant_option_id) => { name, priceEx, taxId } | null
             (المصدر الوحيد للأسعار: قايمة تاب سينس — مابنثقش في العميل أبداً)

   بترجّع { ok, lines, error?, missing? } — lines جاهزة كـpurchases:
     { product_id, quantity, tax_id, unit_amount, variant_option_id,
       bundle, bundle_name, bundle_slot, bundle_line, variant_name, name }
═══════════════════════════════════════════════════════════════════════════ */
export function expandBundle(bundle, choices, quantity, resolve, opts = {}) {
  const qty = Math.min(20, Math.max(1, Math.round(Number(quantity) || 1)));
  const slots = Array.isArray(bundle && bundle.slots) ? bundle.slots : [];
  if (!slots.length) return { ok: false, error: "bundle_has_no_slots" };
  const vatRate = Number(bundle.vat_rate ?? opts.vatRate ?? VAT_RATE);
  const multiply = Number(opts.multiply || MULTIPLY);
  const ch = choices && typeof choices === "object" ? choices : {};

  // ١) اختيار كل خانة → منتج حقيقي + سعر قايمة
  const picked = [];
  const missing = [];
  for (const slot of slots) {
    let productId = null, variantId = null;
    if (slot.type === "choice") {
      const given = ch[slot.key];
      const gp = pid(given && typeof given === "object" ? given.product_id : given);
      const gv = given && typeof given === "object" ? vopt(given.variant_option_id) : null;
      if (!gp) { missing.push(slot.key); continue; }
      // لازم يكون من ضمن الاختيارات المسموحة — مش أي منتج في المطعم
      const allowed = (slot.choices || []).find((x) =>
        x.product_id === gp && (gv == null || x.variant_option_id === gv));
      if (!allowed) return { ok: false, error: "choice_not_allowed", slot: slot.key, product_id: gp };
      productId = allowed.product_id;
      variantId = allowed.variant_option_id;
    } else {
      productId = slot.product_id;
      variantId = slot.variant_option_id;
    }
    const info = resolve(productId, variantId);
    if (!info) return { ok: false, error: "product_unavailable", slot: slot.key, product_id: productId };
    picked.push({ slot, productId, variantId, info });
  }
  if (missing.length) return { ok: false, error: "choice_required", missing };

  // ٢) توزيع سعر باقة واحدة على مكوّناتها (بالظبط)
  const totalEx = exVatUnits(bundle.price, { multiply, vatRate });
  const shares = distribute(totalEx, picked.map((p, i) => ({
    key: i, menuPriceEx: p.info.priceEx, quantity: p.slot.quantity,
  })));

  // ٣) سطور الشراء. الكمية بتتضرب في عدد الباقات — السعر للوحدة مابيتغيّرش،
  //    فإجمالي N باقة = N × سعر الباقة بالظبط من غير أي تقريب جديد.
  const lineUid = opts.lineUid || `${bundle.slug}-${Date.now().toString(36)}`;
  const lines = shares.map((sh) => {
    const p = picked[sh.key];
    return {
      product_id: Number(p.productId),
      quantity: sh.quantity * qty,
      tax_id: p.info.taxId ?? 1,
      unit_amount: sh.unitAmount,
      ...(p.variantId ? { variant_option_id: p.variantId } : {}),
      // وسم الباقة — بيتخزّن في shop_orders.items وبيغذّي التقارير والكاشير
      bundle: bundle.slug,
      bundle_name: bundle.name,
      bundle_slot: p.slot.key,
      bundle_line: lineUid,
      name: p.info.name || "",
      ...(p.info.variantName ? { variant_name: p.info.variantName } : {}),
    };
  });

  const sum = lines.reduce((a, l) => a + l.unit_amount * l.quantity, 0);
  // حزام أمان: لو التوزيع اختلف عن الهدف لأي سبب، بنفشل بصوت عالي بدل ما
  // ننزّل طلب بفلوس غلط. (الاختبارات بتغطي ده، بس ده فلوس حقيقية.)
  if (sum !== totalEx * qty) {
    return { ok: false, error: "distribution_mismatch", expected: totalEx * qty, got: sum };
  }
  return {
    ok: true, lines, lineUid,
    totalEx: totalEx * qty,
    priceIncl: Math.round(Number(bundle.price) * 100) / 100 * qty,
    quantity: qty,
    picks: picked.map((p) => ({
      slot: p.slot.key, label: p.slot.label, product_id: p.productId,
      variant_option_id: p.variantId, name: p.info.name, variant_name: p.info.variantName || null,
    })),
  };
}
