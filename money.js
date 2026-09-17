/* ═══════════════════════════════════════════════════════════════════════════
   MONEY — وحدة الفلوس الوحيدة اللي بنكلّم بيها تاب سينس.

   ليه الملف ده موجود (باج ١٧ سبتمبر ٢٠٢٦، العميل مش قادر يطلب):
     تاب سينس بترفض أي سطر `unit_amount ≥ 100000000000` (1e11) بخطأ ٤٢٢:
       «The purchases.0.unit_amount must be less than 100000000000.»
     والمتجر بيقول في /api/info إن معامل الضرب = 1e9 (نانو-ريال). يعني أي
     صنف سعره الصافي ≥ ١٠٠ ر.س بيتخطّى الحد ويترفض — كل المشاوي بالكيلو:
       ريش ١٦٠٫٨٧ · مشكل ١٣٤٫٧٨ · كباب ١٢١٫٧٤ · سجق ١٠٤٫٣٥
     والنتيجة إن حساب السلة كان بيفشل، والشريط يفضل «جاري تحديث الإجمالي…»
     للأبد، والعميل مايقدرش يكمّل الطلب.

   الحل: مابنثقش في معامل المتجر — بنشتغل على **ميكرو-ريال (1e6)**:
     • أعلى سعر صنف ممكن يتمثّل = ١٠٠٬٠٠٠ ر.س (أكتر من كفاية)
     • الخطأ في تقريب الضريبة أقل من واحد على المليون من الريال
     • مجسّ على الإنتاج (١٧ سبتمبر) أثبت إن 1e6 بيعدّي لكل الأوزان والأصناف

   الوحدة القديمة (نانو-ريال 1e9) لسه موجودة جوّه الطلبات المتخزّنة في
   shop_orders.items، فأي قارئ للتخزين لازم يستعمل scaleOf(item) — السطور
   الجديدة بتتوسم بـ`mf`، والقديمة (من غير وسم) بتترجع للنانو تلقائياً.

   الملف ده **صافي**: مفيش شبكة ولا داتابيز — عشان كل قاعدة فيه تتجرّب أوفلاين.
═══════════════════════════════════════════════════════════════════════════ */

/** وحدة الفلوس الحالية: ميكرو-ريال. */
export const MULTIPLY = 1000000;

/** وحدة الفلوس القديمة (نانو-ريال) — الطلبات اللي اتخزّنت قبل ١٧ سبتمبر ٢٠٢٦. */
export const LEGACY_MULTIPLY = 1000000000;

/** حد تاب سينس الصلب: أي unit_amount ≥ الرقم ده بيترفض ٤٢٢. */
export const TS_UNIT_LIMIT = 100000000000;

/** سلّم التنازل لما تاب سينس ترفض الحد — بننزل خطوة واحدة كل مرة.
    (mf = 1 مرفوض من تاب سينس نفسها: «Invalid multiply factor».) */
export const MF_LADDER = [1000000000, 1000000, 1000, 100];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

/** معامل ضرب آمن: اللي المتجر قاله، مسقّف عند MULTIPLY. */
export function safeMultiply(storeFactor, cap = MULTIPLY) {
  const n = num(storeFactor);
  return n > 0 ? Math.min(n, cap) : cap;
}

/** وحدة سطر متخزّن: الوسم `mf` لو موجود، وإلا النانو القديم. */
export function scaleOf(item) {
  const n = num(item && item.mf);
  return n > 0 ? n : LEGACY_MULTIPLY;
}

/** ريال صافي (قبل الضريبة) من سطر متخزّن، مهما كانت وحدته. */
export function netSarOf(item) {
  return (num(item && item.unit_amount) || 0) / scaleOf(item);
}

/** بيوسم السطور بوحدتها الحالية عشان أي قارئ بعدين يقراها صح. */
export function stampMf(items, mf = MULTIPLY) {
  return (Array.isArray(items) ? items : []).map((it) =>
    (it && typeof it === "object") ? { ...it, mf } : it);
}

/** بيحوّل سطور جايّة بوحدة تانية (متصفح قديم في الكاش) لوحدتنا الحالية.
    mfIn غير معروف ⇒ النانو القديم، عشان النسخ المكاشّة تفضل شغّالة. */
export function rescaleItems(items, mfIn, mfOut = MULTIPLY) {
  const from = num(mfIn) > 0 ? num(mfIn) : LEGACY_MULTIPLY;
  if (from === mfOut) return Array.isArray(items) ? items : [];
  const ratio = mfOut / from;
  return (Array.isArray(items) ? items : []).map((it) => {
    if (!it || typeof it !== "object" || it.unit_amount == null) return it;
    return { ...it, unit_amount: Math.round((num(it.unit_amount) || 0) * ratio) };
  });
}

/** أكبر unit_amount في السطور — عشان نعرف احنا قريبين من الحد قد إيه. */
export function maxUnitAmount(items) {
  let max = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const v = Math.abs(num(it && it.unit_amount) || 0);
    if (v > max) max = v;
  }
  return max;
}

/** السطور دي هتترفض من تاب سينس؟ */
export function exceedsTsLimit(items, limit = TS_UNIT_LIMIT) {
  return maxUnitAmount(items) >= limit;
}

/** رسالة خطأ تاب سينس اللي معناها «الرقم كبير» — عشان نعرف ننزّل المعامل. */
export function isUnitLimitError(message) {
  return /must be less than\s*\d/i.test(String(message || ""));
}

/** الخطوة اللي بعدها في سلّم التنازل، أو null لو خلصنا. */
export function nextFactorDown(mf) {
  const cur = num(mf);
  for (const step of MF_LADDER) if (step < cur) return step;
  return null;
}
