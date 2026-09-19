/* ═══════════════════════════════════════════════════════════════════════════
   IDENTITY — عميل واحد = رقم جوال واحد، عبر كل القنوات (Customer 360)

   سؤال عمر (١٩/٩): «العملاء اللي بيتسجلوا في الموقع هما نفسهم العملاء اللي
   موجودين ولا بيتحسبوا تاني من الأول؟». الإجابة الصح لازم تبقى في مكان واحد،
   وكل تقرير يقرا منه. القواعد:

   ١. الهوية = الجوال السعودي بعد التطبيع (normPhone): 9 أرقام تبدأ بـ5.
      +966 / 00966 / 966 / 05… / أرقام عربية — كلها نفس الشخص.
   ٢. المصادر اللي بتربط طلب بجوال:
        • نقطة البيع: order_sources.phone_norm (الكاشير/FeedUs — كيتا بتدّي
          الجوال)، وts_customers عن طريق ts_orders.customer_id.
        • سجل العميل في تاب سينس: ts_customers.first_order_at (تاريخ أقدم من
          الكاش بتاعنا) — **first_order_at بس**. registered_at مش طلب: عميل
          اتسجّل (من الموقع وقت الـOTP أو من الكاشير) ومطلبش لسه مش «قديم».
        • متجرنا: shop_orders (مدفوع، مش is_test).
      التسجيل في الموقع (acct_customers)، والـOTP، والسلة، والرسايل، والرحلة
      **مش طلبات** — بتربط الهوية بس، عمرها ما بتخلّي حد «جديد» أو «قديم».
   ٣. «عميل جديد» في فترة = **أول طلب ليه على الإطلاق، من أي قناة**، وقع جوّه
      الفترة. واحد طالب من الصالة أو كيتا قبل كده وطلب من الموقع النهارده =
      عميل قديم (أول مرة على الموقع بس)، مش جديد.
   ٤. اليوم = يوم العمل بتاع تاب سينس (calendar_day، بيقلب ٤ الفجر بتوقيت
      الرياض)؛ طلبات الموقع بتتحوّل لنفس اليوم بنفس القاعدة.
   ٥. الملغي/المسترجع (Void/Refund) والطلبات اللي مادفعتش مش أول طلب.
   ٦. طلب من غير جوال (هنقرستيشن/نينجا بيخبّوه) مابيتحسبش جديد ولا قديم —
      بيتعدّ «غير معروف» لوحده.

   الـAPI (للتقارير — reports-core وغيرها):
     FIRST_ORDER_CTE           → `firsts(pn, first_day)` جاهز يتحط بعد WITH.
         جديد في [from,to]:  f.first_day BETWEEN from AND to
         قديم على طلب:       f.first_day < <يوم الطلب>
     isNewCustomer(firstDay, from, to?)     → true/false (دالة صافية)
     firstOrderDays(pool, phones)           → Map(pn → 'YYYY-MM-DD')
     isNewCustomerOn(pool, phone, from, to?)→ true/false
     normPhone / maskPhone / SHOP_PAID_SQL / bizDaySql
═══════════════════════════════════════════════════════════════════════════ */

export const TZ = "Asia/Riyadh";
export const BIZ_DAY_START_HOUR = 4; // نفس analytics.js — تاب سينس بيقلب اليوم ٤ الفجر

const AR = "٠١٢٣٤٥٦٧٨٩", FA = "۰۱۲۳۴۵۶۷۸۹";

/* جوال سعودي → «5XXXXXXXX» أو "" لو مش جوال سعودي صالح. */
export function normPhone(raw) {
  let d = String(raw == null ? "" : raw)
    .replace(/[٠-٩]/g, (x) => String(AR.indexOf(x)))
    .replace(/[۰-۹]/g, (x) => String(FA.indexOf(x)))
    .replace(/\D/g, "");
  if (d.startsWith("00966")) d = d.slice(5);
  else if (d.startsWith("966")) d = d.slice(3);
  if (d.length === 10 && d.startsWith("05")) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? d : "";
}

/* نفس شكل البورتال: ٠٥•••••٨٢ — آخر رقمين بس. */
export const maskPhone = (pn) => (pn ? `05${"•".repeat(5)}${String(pn).slice(-2)}` : "");

/* طلب موقع «حقيقي»: اتدفع ومش تجربة. pending/expired = ماحصلش دفع؛
   rejected_refunded/refund_failed = الفلوس رجعت (مش طلب). */
export const SHOP_NOT_ORDER_STATUSES = ["pending_payment", "expired", "rejected_refunded", "refund_failed", "payment_failed", "cancelled"];
export const shopPaidSql = (a = "so") =>
  `(NOT COALESCE(${a}.is_test, false) AND ${a}.status NOT IN (${SHOP_NOT_ORDER_STATUSES.map((s) => `'${s}'`).join(",")}))`;
export const SHOP_PAID_SQL = shopPaidSql("so");

/* timestamptz → يوم العمل (نفس calendar_day بتاع تاب سينس) */
export const bizDaySql = (ts) => `(((${ts}) AT TIME ZONE '${TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date`;

const NOT_VOID = (a) => `(${a}.order_type IS NULL OR (${a}.order_type NOT ILIKE '%void%' AND ${a}.order_type NOT ILIKE '%refund%'))`;

/* THE first-order day per phone. Aliases (fs/fo/fc/so) مقصودة عشان الجزء
   ده يتلزق في أي استعلام من غير ما يمسك o / s / tc اللي بره. */
export const FIRST_ORDER_CTE = `
  firsts AS (
    SELECT pn, min(first_day) AS first_day FROM (
      -- (a) الجوال اللي الكاشير/FeedUs كتبه على طلب نقطة البيع
      SELECT fs.phone_norm AS pn, min(fo.calendar_day) AS first_day
        FROM order_sources fs
        JOIN ts_orders fo ON fo.order_id = fs.order_id
       WHERE fs.phone_norm <> '' AND ${NOT_VOID("fo")}
       GROUP BY 1
      UNION ALL
      -- (b) سجل العميل اللي نقطة البيع ربطته بالطلب
      SELECT fc.phone_norm AS pn, min(fo.calendar_day) AS first_day
        FROM ts_orders fo
        JOIN ts_customers fc ON fc.customer_id = fo.customer_id
       WHERE COALESCE(fc.phone_norm, '') <> '' AND ${NOT_VOID("fo")}
       GROUP BY 1
      UNION ALL
      -- (c) تاريخ أقدم من الكاش — أول طلب في سجل العميل (مش تاريخ التسجيل)
      SELECT fc.phone_norm AS pn, min(${bizDaySql("fc.first_order_at")}) AS first_day
        FROM ts_customers fc
       WHERE COALESCE(fc.phone_norm, '') <> '' AND fc.first_order_at IS NOT NULL
       GROUP BY 1
      UNION ALL
      -- (d) متجرنا — طلبات مدفوعة (حتى لو ماوصلتش نقطة البيع بجوال)
      SELECT so.phone_norm AS pn, min(${bizDaySql("so.created_at")}) AS first_day
        FROM shop_orders so
       WHERE COALESCE(so.phone_norm, '') <> '' AND ${SHOP_PAID_SQL}
       GROUP BY 1
    ) u GROUP BY 1
  )`;

const isoDay = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    // pg بيرجّع DATE كـDate منتصف الليل محلي — ناخد المكوّنات المحلية
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, "0"), d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
};

/* جديد في [from,to] = أول طلب على الإطلاق وقع جوّه الفترة. null = مالوش طلب معروف → مش جديد. */
export function isNewCustomer(firstDay, from, to = from) {
  const f = isoDay(firstDay);
  if (!f || !from) return false;
  return f >= String(from).slice(0, 10) && f <= String(to || from).slice(0, 10);
}

export async function firstOrderDays(pool, phones) {
  const list = [...new Set((phones || []).map(normPhone).filter(Boolean))];
  const out = new Map();
  if (!list.length) return out;
  const r = await pool.query(
    `WITH ${FIRST_ORDER_CTE} SELECT pn, first_day::text AS first_day FROM firsts WHERE pn = ANY($1::text[])`, [list]);
  for (const row of r.rows) out.set(row.pn, row.first_day);
  return out;
}

export async function isNewCustomerOn(pool, phone, from, to = from) {
  const pn = normPhone(phone);
  if (!pn) return false;
  return isNewCustomer((await firstOrderDays(pool, [pn])).get(pn), from, to);
}

export const IDENTITY_RULES_AR = [
  "العميل = رقم الجوال بعد التطبيع (٠٥…/+٩٦٦/٩٦٦ نفس الشخص).",
  "«جديد» = أول طلب ليه على الإطلاق من أي قناة (صالة، كيتا، تطبيقات، الموقع) وقع في الفترة.",
  "التسجيل في الموقع أو الـOTP أو السلة مش طلب — مابيخلّيش حد جديد ولا قديم.",
  "طالب قبل كده من الصالة/التطبيقات وأول مرة على الموقع = عميل قديم (أول طلب موقع بس).",
  "الملغي/المسترجع والطلبات اللي مادفعتش مش أول طلب. طلب من غير جوال = غير معروف.",
];
