/* ═══════════════════════════════════════════════════════════════════════════
   TABLE ORDER — «اطلب وادفع من طاولتك» (QR الطاولات، أكتوبر ٢٠٢٦).

   الفكرة: طلب الطاولة = طلب «استلام» عادي في كل دورة متجرنا (مفيش عنوان ولا
   مندوب ولا رسوم توصيل)، + رقم طاولة. الفرق كله في ٣ أماكن بس:
     ١. نقطة البيع: خيار الطلب «Dine in» بدل «Take away»، والملاحظات أولها
        «🍽 طاولة N» — API الشركاء مافيهوش طاولات (tables = 404، order_type 1
        مرفوض)، فالرقم بيوصل للكاشير والمطبخ في الملاحظة. اتأكدنا إن الطلب
        بيوصل كـExternal/Dine in (نفس شكل طلبات كيتا الصالة).
     ٢. شاشة المطبخ: سطر «🍽 طاولة N» (الواجهة بتعرض o.table أصلاً).
     ٣. البوابة: شارة طاولة على الكارت.

   الرقم بييجي من المتجر (static/table.js بيقراه من ?t= أو من
   utm_content=table-N بتاع روابط /l/table-N). السيرفر هو الحَكَم: رقم صحيح
   ١..maxNo، والطلب استلام مش مسبق. أي حاجة تانية = طلب عادي من غير طاولة —
   عمره ما يوقّع الطلب.

   الإعدادات (settings.tables، كلها اختيارية): { enabled: true, count: 12,
   maxNo: 99 }. count للوحة والتصاميم بس؛ التحقق بـmaxNo عشان ستاند مطبوع
   برقم أكبر من العدد مايرفضش طلب مدفوع.
═══════════════════════════════════════════════════════════════════════════ */

export const TABLE_DEFAULTS = Object.freeze({ enabled: true, count: 12, maxNo: 99 });

export function tableCfg(settings) {
  const t = (settings && typeof settings === "object" && settings.tables) || {};
  const int = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
  };
  return {
    enabled: t.enabled !== false,
    count: int(t.count, TABLE_DEFAULTS.count, 1, 999),
    maxNo: int(t.maxNo, TABLE_DEFAULTS.maxNo, 1, 999),
  };
}

/* "7" · 7 · "table-7" · "t7" · "طاولة ٧" → 7. غير كده null. */
export function parseTable(raw, cfg = TABLE_DEFAULTS) {
  if (!cfg || cfg.enabled === false) return null;
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  let s = String(raw).trim().slice(0, 20)
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const m = s.match(/^(?:table-|t|طاولة\s*)?(\d{1,3})$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const max = Number(cfg.maxNo) || TABLE_DEFAULTS.maxNo;
  return n >= 1 && n <= max ? n : null;
}

/* طلب طاولة = استلام عادي وقت ما يتطلب (الطلب المسبق مالوش معنى على طاولة). */
export function tableForCheckout(body, option, { scheduled = false, settings = null } = {}) {
  if (option !== "pickup" || scheduled) return null;
  return parseTable(body && body.table, tableCfg(settings));
}

export const tableLabel = (n) => (n ? `طاولة ${n}` : null);

/* أول الملاحظات في نقطة البيع — الكاشير والعدّاء يشوفوه قبل أي حاجة. */
export const tableNote = (n) => `🍽 ${tableLabel(n)} — يتقدّم على الطاولة`;

export function posOptionOf(row) {
  return row && Number(row.table_no) > 0 ? "dine_in" : row && row.option;
}

