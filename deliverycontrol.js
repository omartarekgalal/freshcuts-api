/* ═══════════════════════════════════════════════════════════════════════════
   🛵 لوحة التوصيل والمندوبين — مفتاح واحد لكل إعداد توصيل

   عمر (٢٤ سبتمبر ٢٠٢٦): «عايز أتحكم في كل إعدادات التوصيل والشركات بالكامل».

   قبل الملف ده كانت مفاتيح التوصيل موزّعة على أربع شاشات (المتجر أونلاين،
   مخالفات لاجلك، مطابقة الفاتورة، التوصيل بالحي) — وتلاتة منها مكانوش
   بيتحققوا من الأرقام قبل الحفظ، وواحد مهم (`dispatchMode`، اللي بيقرّر هل
   أي طلب مندوب بيخرج أصلاً) مكانش له خانة خالص.

   الملف ده مش مخزن تاني: كل حقل هنا بيكتب في **نفس** مفتاح الإعدادات اللي
   الكود بيقراه (settings.delivery.* / settings.shop.*). اللي بيضيفه:

     ١) **مواصفة لكل حقل** (نوع، أقل، أكتر، خيارات) — الحفظ كله أو ولا حاجة.
        رقم بره المدى بيرجع ٤٠٠ بأسماء الحقول الغلط، ومابيتحفظش نص واحد.
     ٢) **القيمة الفعّالة** جنب كل حقل: إيه المخزون، وإيه اللي الكود بيستعمله
        فعلاً (بعد الافتراضيات ومتغيّرات البيئة)، ومنين جاي.
     ٣) **تأكيد صريح** للمفاتيح الخطيرة (تبديل الشركة، إيقاف الإرسال الآلي،
        فتح التوصيل بالحي، فتح التوجيه بالمسافة) + سطر في سجل النشاط بيقول
        إيه اللي اتغيّر من إيه لإيه.

   الكتابة بـjsonb_set على `{delivery}` و`{shop}` بس — عشان حفظ من شاشة تانية
   في نفس اللحظة مايتدوسش عليه (نفس أسلوب districts.js).
═══════════════════════════════════════════════════════════════════════════ */
import { DEFAULT_COURIER_SLA, courierSlaCfg } from "./courierops.js";
import { DEFAULT_LJ_CONTRACT, ljContract } from "./leajlakrecon.js";
import { DEFAULT_COURIER_ROUTING, courierRoutingCfg, API_PROVIDER_IDS } from "./couriers.js";
import { DEFAULT_DISPATCH_DELAY_MIN, dispatchDelayOf, dispatchMode, DISPATCH_MODES, DEFAULT_POLICY } from "./delivery.js";
import { districtCfg } from "./districts.js";

/* ── عنوان الحقل جوّه الإعدادات ──────────────────────────────────────────── */
export function getAt(obj, path) {
  let cur = obj;
  for (const k of String(path).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}
export function setAt(obj, path, value) {
  const keys = String(path).split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== "object" || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
  return obj;
}

/* ── الأرقام السعودية: ٠٥xxxxxxxx. أي سطر مش رقم بيرفض الحفظ كله بدل ما
   يتشال بالسكات — رقم إنذار ضايع معناه إننا ما نعرفش إن فيه طلب واقف. ── */
export function normSaudiMobile(raw) {
  const d = String(raw == null ? "" : raw).replace(/[^\d]/g, "");
  let n = d;
  if (n.startsWith("00966")) n = n.slice(5);
  else if (n.startsWith("966")) n = n.slice(3);
  if (n.startsWith("5") && n.length === 9) n = "0" + n;
  return /^05\d{8}$/.test(n) ? n : null;
}

const ENUM = (...vals) => vals.map((v) => (typeof v === "string" ? { v, label: v } : v));

/* ═══ مواصفة الحقول ═══════════════════════════════════════════════════════
   المجموعات نفسها اللي الشاشة بتعرضها:
     provider  = المزوّد الحالي
     dispatch  = توقيت طلب المندوب
     zone      = النطاق والرسوم (القابل للتعديل هنا؛ سلّم الرسوم في dl_policies)
     contract  = عقد لاجلك والتكاليف
     alerts    = تنبيهات ومسؤولين
     district  = التوصيل بالحي (مقفول)

   danger: "any" = أي تغيير محتاج تأكيد · "on"/"off" = التحويل للقيمة دي بس. */
export const FIELDS = [
  /* ── المزوّد ── */
  { path: "delivery.provider", group: "provider", type: "enum", danger: "any",
    label: "شركة التوصيل الفعّالة",
    options: ENUM({ v: "leajlak", label: "لأجلك (4U)" }, { v: "cervo", label: "Cervo" }, { v: "flyingarrow", label: "Flying Arrow" }),
    hint: "التبديل بيأثر على الطلبات الجديدة بس — الشحنات الجارية بتفضل مع شركتها." },
  { path: "delivery.ljShopId", group: "provider", type: "text", max: 40,
    label: "معرّف المحل عند لاجلك (shop_id)", hint: "الاستلام عندهم من محل مسجّل، مش إحداثيات مع كل طلب." },
  { path: "delivery.ljShopName", group: "provider", type: "text", max: 120,
    label: "اسم المحل عندهم (للمراجعة بس)" },
  { path: "delivery.faCityId", group: "provider", type: "int", min: 1, max: 9999,
    label: "Flying Arrow — رقم المدينة" },
  { path: "delivery.faVehicleId", group: "provider", type: "int", min: 1, max: 9999,
    label: "Flying Arrow — نوع المركبة" },
  { path: "delivery.faPaymentMethod", group: "provider", type: "enum",
    label: "Flying Arrow — طريقة الدفع للمندوب",
    options: ENUM({ v: "wallet", label: "محفظة — يُخصم من رصيدنا (المُوصى به)" }, { v: "cash", label: "نقدي — الفرع يدفع للكابتن" }) },
  { path: "delivery.courierRouting.enabled", group: "provider", type: "bool", danger: "on",
    label: "التوجيه بالمسافة (شريحة لكل شركة)",
    hint: "وهو مقفول كل الطلبات بتروح للشركة الفعّالة. الشرايح نفسها بتتعدّل من «التوجيه بالمسافة + Cervo» تحت." },
  /* شكل العنوان اللي بيوصل لتطبيق الكابتن — غلطة هنا = كابتن تايه. */
  { path: "delivery.ljAddressFormat", group: "provider", type: "enum",
    label: "لاجلك — شكل حقل العنوان",
    options: ENUM({ v: "coords", label: "النقطة بس lat,lng (الموصى به)" }, { v: "link", label: "رابط جوجل ماب" }),
    hint: "تطبيق الكابتن بيفتح جوجل ماب بنص الحقل — أي كلام قبل الإحداثيات بيخليه يدوّر بدل ما يفتح النقطة." },
  { path: "delivery.cervoAddressFormat", group: "provider", type: "enum",
    label: "Cervo — شكل حقل العنوان",
    options: ENUM({ v: "full", label: "العنوان المقروء + النقطة" }, { v: "coords", label: "النقطة بس" }),
    hint: "عندهم حقول إحداثيات منفصلة، فالنص إضافة مش بديل." },
  { path: "delivery.cervoAsciiLine", group: "provider", type: "bool",
    label: "Cervo — سطر إنجليزي مختصر قبل العربي",
    hint: "ردودهم مابترجّعش الملاحظات، فمفيش طريقة نتأكد إن العربي وصل سليم." },
  { path: "delivery.manualProviderLabel", group: "provider", type: "text", max: 80,
    label: "اسم الشركة في الإرسال اليدوي", hint: "الاسم اللي الكاشير بيشوفه لما الإرسال يكون يدوي." },
  { path: "delivery.manualDashboardUrl", group: "provider", type: "url",
    label: "رابط لوحة الشركة (للإرسال اليدوي)" },

  /* ── توقيت طلب المندوب ── */
  { path: "delivery.dispatchMode", group: "dispatch", type: "enum", danger: "any",
    label: "بوابة الإرسال",
    options: ENUM({ v: "auto", label: "آلي — السيرفر بيطلب الكابتن بنفسه" }, { v: "manual", label: "يدوي — مفيش أي طلب بيخرج للشركة" }),
    hint: "أقوى مفتاح في الصفحة. «يدوي» = مفيش طلب مندوب بيخرج من السيرفر خالص، والكاشير بيطلب من لوحة الشركة." },
  { path: "shop.autoDispatch", group: "dispatch", type: "bool", danger: "off",
    label: "طلب مندوب تلقائي للطلبات الأونلاين",
    hint: "لو مقفول، الطلب بيوصل المطبخ عادي بس المندوب بيتطلب بزرار من البورتال." },
  { path: "delivery.dispatchDelayMin", group: "dispatch", type: "int", min: 0, max: 90,
    label: "مهلة التحضير قبل طلب المندوب (دقيقة)",
    hint: "الكابتن بيتطلب أول لحظة من اتنين: «جاهز» على نقطة البيع، أو المهلة دي بعد القبول. ٠ = مع القبول فوراً." },
  { path: "delivery.autoRefundOnNoAccept", group: "dispatch", type: "bool",
    label: "استرجاع تلقائي لو الطلب ماتقبلش خالص" },

  /* ── النطاق والحارس ── */
  { path: "delivery.courierSla.farGuard.fromKm", group: "zone", type: "num", min: 1, max: 50, step: 0.5,
    label: "المشوار البعيد من (كم)" },
  { path: "delivery.courierSla.farGuard.mode", group: "zone", type: "enum",
    label: "الطلب البعيد قبل طلب المندوب",
    options: ENUM({ v: "suggest", label: "يتبعت عادي + تنبيه (الافتراضي)" }, { v: "confirm", label: "يستنى تأكيد المدير" }, { v: "off", label: "مقفول" }) },

  /* ── عقد لاجلك ── */
  { path: "delivery.leajlakContract.flatExVat", group: "contract", type: "num", min: 0, max: 500, step: 0.01,
    label: "الأجرة الثابتة قبل الضريبة (ر.س)" },
  { path: "delivery.leajlakContract.includedKm", group: "contract", type: "num", min: 0, max: 100, step: 0.5,
    label: "كم داخل الأجرة الثابتة" },
  { path: "delivery.leajlakContract.perKmExVat", group: "contract", type: "num", min: 0, max: 100, step: 0.01,
    label: "كل كم إضافي قبل الضريبة (ر.س)" },
  { path: "delivery.leajlakContract.vatPct", group: "contract", type: "num", min: 0, max: 100, step: 1,
    label: "الضريبة ٪" },
  { path: "delivery.leajlakContract.kmRounding", group: "contract", type: "enum",
    label: "حساب كسر الكيلو",
    options: ENUM({ v: "exact", label: "بالكسور (زي لوحتهم: ٠٫٤ كم = ٠٫٨٠)" }, { v: "ceil", label: "كل جزء من كيلو = كيلو" }) },
  { path: "delivery.leajlakContract.kmTolerance", group: "contract", type: "num", min: 0, max: 5, step: 0.05,
    label: "سماح فرق مسافتهم عن مسافتنا (كم)" },
  { path: "delivery.leajlakContract.cancelFeeExVat", group: "contract", type: "num", min: 0, max: 500, step: 0.01,
    label: "رسوم إلغاء قبل الاستلام (قبل الضريبة)" },

  /* ── تنبيهات ومسؤولين ── */
  { path: "delivery.alertPhones", group: "alerts", type: "phones",
    label: "🚨 أرقام الإنذارات الحرجة",
    hint: "طلب مدفوع ماوصلش نقطة البيع · تأخير كبير · ربط تاب سينس واقع — رقم في كل سطر." },
  { path: "delivery.newOrderPhones", group: "alerts", type: "phones",
    label: "🧾 أرقام رسالة كل طلب أونلاين جديد" },
  { path: "delivery.newOrderSms", group: "alerts", type: "bool", label: "رسالة مع كل طلب جديد" },
  { path: "delivery.staffSmsLanguage", group: "alerts", type: "enum", label: "لغة رسايل الإدارة",
    options: ENUM({ v: "en", label: "English" }, { v: "ar", label: "عربي" }) },
  { path: "delivery.pickupAddress", group: "alerts", type: "text", max: 200, label: "عنوان الاستلام" },
  { path: "delivery.pickupContactName", group: "alerts", type: "text", max: 80, label: "اسم جهة الاستلام" },
  { path: "delivery.pickupContactPhone", group: "alerts", type: "phone", label: "تليفون المحل" },

  /* ── التوصيل بالحي ── */
  { path: "delivery.districtCouriers.enabled", group: "district", type: "bool", danger: "on",
    label: "تشغيل التوصيل بالحي",
    hint: "قرار عمر: يفضل **مقفول** لحد ما الأسعار تتأكد ويتحدد المزوّد. الجدول نفسه بيتعدّل من «التوصيل بالحي» تحت." },
];

/* مهل تنبيه الطلب (settings.delivery.sla) — دي **مش** مهل المندوب
   (settings.delivery.courierSla). اسمين متشابهين لمفهومين مختلفين، فبنكتب
   العنوان كامل في كل خانة عشان محدش يظن إنه بيعدّل التاني. */
export const ORDER_SLA_FIELDS = [
  ["posFailMinutes", "مدفوع ومش واصل نقطة البيع", 5],
  ["acceptMinutes", "مستني قبول الكاشير — تنبيه", 8],
  ["acceptBreachMinutes", "مستني قبول الكاشير — إنذار SMS", 15],
  ["autoRefundNoAcceptMinutes", "ماتقبلش خالص ⇒ استرجاع", 25],
  ["handoffMinutes", "اتقبل ومفيش مندوب — تنبيه", 10],
  ["handoffBreachMinutes", "اتقبل ومفيش مندوب — إنذار SMS", 20],
  ["pickupMinutes", "مستني المندوب يستلم — تنبيه", 25],
  ["pickupBreachMinutes", "مستني المندوب يستلم — إنذار SMS", 45],
  ["deliverMinutes", "في الطريق للعميل — تنبيه", 45],
  ["deliverBreachMinutes", "في الطريق للعميل — إنذار SMS", 75],
];

/* مهل المندوب (settings.courierSla) — الأرقام اللي المخالفات بتتحسب بيها. */
export const COURIER_SLA_FIELDS = [
  ["assignMin", "تعيين الكابتن خلال (د) — من طلبنا", 1],
  ["arriveWarnMin", "الوصول بعد التعيين: أصفر من (د)", 1],
  ["arriveTargetMin", "الوصول بعد التعيين: الهدف (د)", 1],
  ["arriveMin", "حد العقد للوصول (د) — من الطلب", 1],
  ["deliverGraceMin", "سماح التوصيل بعد مدة المشوار (د)", 1],
  ["handoverMaxMin", "علينا: التسليم خلال (د) — العقد ١٠", 1],
  ["baseMin", "مدة المشوار لو مفيش جوجل: أساس (د)", 1],
  ["minPerKm", "مدة المشوار: د لكل كم", 0.1],
  ["prepMin", "تقدير التحضير لحساب الوقت المتوقع (د)", 1],
  ["arriveTypMin", "المعتاد: الكابتن في المطعم بعد (د)", 1],
  ["handoverMin", "تسليم الشنطة (د)", 1],
  ["claimMinOverMin", "أقل تأخير يتحسب للمطالبة (د)", 1],
  ["alertOverMin", "أقل تأخير يطلّع SMS (د)", 1],
  ["nearKm", "«قريب» لحد (كم خط مستقيم)", 0.05],
];

/* الحقول المولّدة: مهل الطلب + مهل المندوب. بنبنيها بدل ما نكتب ٢٤ سطر
   بالإيد — الأسماء والافتراضيات مصدرها الموديول اللي بيقراها. */
function generatedFields() {
  const out = [];
  for (const [k, label, def] of ORDER_SLA_FIELDS) {
    out.push({ path: `delivery.sla.${k}`, group: "alerts", type: "int", min: 1, max: 240,
      label: `مهلة الطلب — ${label}`, fallback: def });
  }
  for (const [k, label, step] of COURIER_SLA_FIELDS) {
    out.push({ path: `delivery.courierSla.${k}`, group: "zone", type: "num", min: 0, max: 240, step,
      label: `مهلة المندوب — ${label}` });
  }
  for (const [k, label] of [["alertStaff", "SMS للإدارة عند كل مخالفة/رفض"], ["customerSms", "رسالة للعميل لما طريقة التوصيل تتغير"]]) {
    out.push({ path: `delivery.courierSla.${k}`, group: "zone", type: "bool", label: `مهلة المندوب — ${label}` });
  }
  return out;
}

export const ALL_FIELDS = Object.freeze([...FIELDS, ...generatedFields()]);
export const FIELD_BY_PATH = Object.freeze(Object.fromEntries(ALL_FIELDS.map((f) => [f.path, f])));

export const GROUPS = Object.freeze([
  { id: "provider", label: "المزوّد الحالي", icon: "🔌" },
  { id: "dispatch", label: "توقيت طلب المندوب", icon: "⏱" },
  { id: "zone", label: "النطاق والرسوم", icon: "📏" },
  { id: "contract", label: "عقد لاجلك والتكاليف", icon: "📜" },
  { id: "alerts", label: "تنبيهات ومسؤولين", icon: "📟" },
  { id: "district", label: "التوصيل بالحي (مقفول)", icon: "🏘️" },
]);

/* ═══ التحقق ═══════════════════════════════════════════════════════════════
   بترجّع {ok, value} أو {ok:false, error}. مفيش «تصحيح صامت»: رقم بره المدى
   بيرجع خطأ بدل ما يتقصّ على الحد — عمر لازم يشوف إن اللي كتبه مش مقبول. */
export function coerceField(spec, raw) {
  if (!spec) return { ok: false, error: "حقل مش معروف" };
  const t = spec.type;

  if (t === "bool") {
    if (raw === true || raw === false) return { ok: true, value: raw };
    if (raw === "true") return { ok: true, value: true };
    if (raw === "false") return { ok: true, value: false };
    return { ok: false, error: "لازم صح أو غلط" };
  }

  if (t === "enum") {
    const v = String(raw == null ? "" : raw).trim();
    const vals = (spec.options || []).map((o) => o.v);
    if (!vals.includes(v)) return { ok: false, error: `الخيارات المسموحة: ${vals.join(" / ")}` };
    return { ok: true, value: v };
  }

  if (t === "int" || t === "num") {
    if (raw === "" || raw === null || raw === undefined) return { ok: false, error: "الخانة مش ممكن تبقى فاضية" };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: "لازم رقم" };
    const v = t === "int" ? Math.round(n) : Math.round(n * 1e6) / 1e6;
    if (spec.min != null && v < spec.min) return { ok: false, error: `أقل قيمة ${spec.min}` };
    if (spec.max != null && v > spec.max) return { ok: false, error: `أكبر قيمة ${spec.max}` };
    return { ok: true, value: v };
  }

  if (t === "text") {
    const v = String(raw == null ? "" : raw).trim();
    if (spec.max != null && v.length > spec.max) return { ok: false, error: `أطول من ${spec.max} حرف` };
    return { ok: true, value: v };
  }

  if (t === "url") {
    const v = String(raw == null ? "" : raw).trim();
    if (!v) return { ok: true, value: "" };
    if (!/^https?:\/\/[^\s]+$/i.test(v) || v.length > 300) return { ok: false, error: "لازم رابط بيبدأ بـhttp:// أو https://" };
    return { ok: true, value: v };
  }

  if (t === "phone") {
    const v = String(raw == null ? "" : raw).trim();
    if (!v) return { ok: true, value: "" };
    const n = normSaudiMobile(v);
    return n ? { ok: true, value: n } : { ok: false, error: "رقم سعودي غلط (٠٥xxxxxxxx)" };
  }

  if (t === "phones") {
    const list = Array.isArray(raw)
      ? raw
      : String(raw == null ? "" : raw).split(/[\s,،;]+/);
    const out = [];
    const bad = [];
    for (const item of list) {
      const s = String(item == null ? "" : item).trim();
      if (!s) continue;
      const n = normSaudiMobile(s);
      if (!n) { bad.push(s); continue; }
      if (!out.includes(n)) out.push(n);
    }
    if (bad.length) return { ok: false, error: `أرقام غلط: ${bad.join("، ")} — الشكل ٠٥xxxxxxxx` };
    if (out.length > 20) return { ok: false, error: "أقصى ٢٠ رقم" };
    return { ok: true, value: out };
  }

  return { ok: false, error: `نوع مش مدعوم: ${t}` };
}

/* patch = {"<path>": value}. بترجّع {ok, values, errors[]}.
   الحفظ كله أو ولا حاجة: أي خطأ ⇒ مفيش كتابة خالص. */
export function validatePatch(patch) {
  const values = {};
  const errors = [];
  const src = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  for (const [path, raw] of Object.entries(src)) {
    const spec = FIELD_BY_PATH[path];
    if (!spec) { errors.push({ path, error: "حقل مش موجود في لوحة التوصيل" }); continue; }
    const r = coerceField(spec, raw);
    if (!r.ok) { errors.push({ path, error: r.error, label: spec.label }); continue; }
    values[path] = r.value;
  }
  if (!errors.length && !Object.keys(values).length) errors.push({ path: "", error: "مفيش أي حقل في الطلب" });
  return { ok: errors.length === 0, values, errors };
}

/* المفاتيح الخطيرة اللي اتغيّرت فعلاً (المتساوي مش تغيير، فالحفظ المتكرر
   مايطلبش تأكيد على الفاضي). */
export function dangerousChanges(values, settings) {
  const out = [];
  for (const [path, next] of Object.entries(values || {})) {
    const spec = FIELD_BY_PATH[path];
    if (!spec || !spec.danger) continue;
    const cur = effectiveOf(path, settings);
    if (sameValue(cur, next)) continue;
    if (spec.danger === "on" && next !== true) continue;
    if (spec.danger === "off" && next !== false) continue;
    out.push({ path, label: spec.label, from: cur, to: next, warn: dangerWarn(path, next) });
  }
  return out;
}

const sameValue = (a, b) => (Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every((x, i) => String(x) === String(b[i]))
  : String(a) === String(b));

function dangerWarn(path, next) {
  if (path === "delivery.provider") return `كل الطلبات الجديدة هتروح لـ«${next}». الشحنات الجارية بتفضل مع شركتها.`;
  if (path === "delivery.dispatchMode") return next === "manual"
    ? "مفيش أي طلب مندوب هيخرج من السيرفر — الكاشير لازم يطلب من لوحة الشركة بنفسه."
    : "السيرفر هيبدأ يطلب كباتن حقيقيين بفلوس حقيقية.";
  if (path === "shop.autoDispatch") return "الطلبات الأونلاين مش هتطلب مندوب لوحدها — محتاجة زرار من البورتال.";
  if (path === "delivery.districtCouriers.enabled") return "التوصيل بالحي هيفتح للعميل. عمر طلب إنه يفضل مقفول لحد ما الأسعار تتأكد.";
  if (path === "delivery.courierRouting.enabled") return "الطلبات هتتوزّع على شركات مختلفة بالمسافة — اتأكد إن توكن Cervo إنتاجي مش تجريبي.";
  return "مفتاح مؤثّر — راجعه قبل الحفظ.";
}

/* ═══ القيمة الفعّالة ═════════════════════════════════════════════════════
   «إيه المخزون» ≠ «إيه اللي الكود بيستعمله». بنحسب التانية من نفس دوال
   الإعداد اللي الكود بيناديها، عشان الشاشة تعرض الحقيقة مش نسخة منها. */
export function effectiveSettings(settings, envRead = (k) => (process.env[k] || "").trim()) {
  const d = (settings || {}).delivery || {};
  const shop = (settings || {}).shop || {};
  return {
    sla: { ...Object.fromEntries(ORDER_SLA_FIELDS.map(([k, , def]) => [k, def])), ...(d.sla || {}) },
    courierSla: courierSlaCfg(settings),
    leajlakContract: ljContract(d),
    routing: courierRoutingCfg(settings),
    district: districtCfg(settings),
    dispatch: dispatchMode(settings, envRead),
    dispatchDelayMin: dispatchDelayOf(settings),
    provider: String(d.provider || envRead("COURIER_PROVIDER") || "flyingarrow").toLowerCase(),
    autoDispatch: shop.autoDispatch !== false,
    autoRefundOnNoAccept: d.autoRefundOnNoAccept !== false,
    newOrderSms: d.newOrderSms !== false,
    staffSmsLanguage: d.staffSmsLanguage === "ar" ? "ar" : "en",
    alertPhones: Array.isArray(d.alertPhones) ? d.alertPhones : [],
    newOrderPhones: Array.isArray(d.newOrderPhones) ? d.newOrderPhones : [],
    ljAddressFormat: d.ljAddressFormat === "link" ? "link" : "coords",
    cervoAddressFormat: d.cervoAddressFormat === "coords" ? "coords" : "full",
    cervoAsciiLine: d.cervoAsciiLine !== false,
  };
}

export function effectiveOf(path, settings, envRead) {
  const e = effectiveSettings(settings, envRead);
  switch (path) {
    case "delivery.provider": return e.provider;
    case "delivery.dispatchMode": return e.dispatch.mode;
    case "delivery.dispatchDelayMin": return e.dispatchDelayMin;
    case "shop.autoDispatch": return e.autoDispatch;
    case "delivery.autoRefundOnNoAccept": return e.autoRefundOnNoAccept;
    case "delivery.newOrderSms": return e.newOrderSms;
    case "delivery.staffSmsLanguage": return e.staffSmsLanguage;
    case "delivery.alertPhones": return e.alertPhones;
    case "delivery.newOrderPhones": return e.newOrderPhones;
    case "delivery.ljAddressFormat": return e.ljAddressFormat;
    case "delivery.cervoAddressFormat": return e.cervoAddressFormat;
    case "delivery.cervoAsciiLine": return e.cervoAsciiLine;
    case "delivery.courierRouting.enabled": return e.routing.enabled;
    case "delivery.districtCouriers.enabled": return e.district.enabled;
    default: break;
  }
  if (path.startsWith("delivery.courierSla.")) return getAt({ x: e.courierSla }, "x." + path.slice("delivery.courierSla.".length));
  if (path.startsWith("delivery.leajlakContract.")) return e.leajlakContract[path.slice("delivery.leajlakContract.".length)];
  if (path.startsWith("delivery.sla.")) return e.sla[path.slice("delivery.sla.".length)];
  const raw = getAt(settings || {}, path);
  return raw === undefined ? null : raw;
}

/* منين جاية القيمة: مكتوبة في اللوحة، ولا افتراضي كود، ولا متغيّر بيئة
   بيغلبها. الشاشة بتلوّن الصف على الأساس ده. */
export function sourceOf(path, settings, envRead = (k) => (process.env[k] || "").trim()) {
  if (path === "delivery.dispatchMode") {
    const m = dispatchMode(settings, envRead);
    if (m.source.startsWith("env:")) return { kind: "env", note: m.source.slice(4), locked: Boolean(m.forced) };
  }
  if (path === "delivery.provider" && getAt(settings || {}, path) == null && envRead("COURIER_PROVIDER")) {
    return { kind: "env", note: "COURIER_PROVIDER", locked: false };
  }
  const raw = getAt(settings || {}, path);
  if (raw === undefined || raw === null || raw === "") return { kind: "default", note: "افتراضي الكود" };
  return { kind: "settings", note: "من اللوحة" };
}

/* وصف كامل للشاشة: مواصفة + مخزون + فعّال + مصدر. */
export function describeFields(settings, envRead) {
  return ALL_FIELDS.map((f) => {
    const stored = getAt(settings || {}, f.path);
    return {
      path: f.path, group: f.group, label: f.label, hint: f.hint || null,
      type: f.type, min: f.min ?? null, max: f.max ?? null, step: f.step ?? null,
      options: f.options || null, danger: f.danger || null,
      stored: stored === undefined ? null : stored,
      effective: effectiveOf(f.path, settings, envRead),
      source: sourceOf(f.path, settings, envRead),
    };
  });
}

/* بتطبّق القيم على نسخة من الإعدادات وبترجّع {next, delivery, shop}. */
export function applyPatch(settings, values) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  next.delivery = next.delivery && typeof next.delivery === "object" ? next.delivery : {};
  next.shop = next.shop && typeof next.shop === "object" ? next.shop : {};
  for (const [path, v] of Object.entries(values || {})) setAt(next, path, v);
  /* حارس المشوار البعيد عنده مفتاحين في الكود (`enabled` و`mode`)، و
     courierops.farGuardDecision بيشترط الاتنين. اللوحة بتعرض `mode` بس،
     فبنشتق `enabled` منه — غير كده اختيار «تنبيه بس» كان ممكن يفضل
     مقفول لأن `enabled:false` متسيب من حفظ قديم. */
  if (Object.prototype.hasOwnProperty.call(values || {}, "delivery.courierSla.farGuard.mode")) {
    setAt(next, "delivery.courierSla.farGuard.enabled", values["delivery.courierSla.farGuard.mode"] !== "off");
  }
  return { next, delivery: next.delivery, shop: next.shop };
}

/* سطر سجل النشاط: «مين غيّر إيه من إيه لإيه» — الخطير الأول بعلامة. */
export function auditLine(values, settings) {
  const danger = new Set(dangerousChanges(values, settings).map((d) => d.path));
  const parts = [];
  for (const [path, next] of Object.entries(values || {})) {
    const spec = FIELD_BY_PATH[path];
    const before = effectiveOf(path, settings);
    const fmt = (v) => (Array.isArray(v) ? (v.length ? v.join("،") : "—") : v === true ? "شغّال" : v === false ? "مقفول" : v === "" || v == null ? "—" : String(v));
    parts.push(`${danger.has(path) ? "⚠️ " : ""}${(spec && spec.label) || path}: ${fmt(before)} → ${fmt(next)}`);
  }
  return `🛵 التوصيل والمندوبين — ${parts.join(" · ")}`.slice(0, 500);
}

/* ═══ المسارات ═════════════════════════════════════════════════════════ */
export function register(app, ctx) {
  const { pool, getSettingsData, requireAdmin, jb } = ctx;
  const log = ctx.log || console;
  const J = jb || ((v) => JSON.stringify(v));
  const envRead = (k) => (process.env[k] || "").trim();

  /* سلّم الرسوم والنطاق بيعيشوا في dl_policies مش في الإعدادات — بنعرضهم
     للقراءة بس مع رابط لشاشة «المنطقة والرسوم» بدل ما نعمل محرّر تاني. */
  async function activePolicyMirror() {
    try {
      const r = await pool.query(
        "SELECT id, name, config FROM dl_policies WHERE active ORDER BY priority DESC, id LIMIT 1");
      const row = r.rows[0];
      if (!row) return { ok: false, reason: "no_policy" };
      const cfg = { ...DEFAULT_POLICY, ...(row.config || {}) };
      return {
        ok: true, id: row.id, name: row.name,
        baseKm: cfg.baseKm, baseFee: cfg.baseFee, perKm: cfg.perKm,
        maxKm: cfg.maxKm, maxStraightKm: cfg.maxStraightKm, routeFactor: cfg.routeFactor,
        minOrderTotal: cfg.minOrderTotal, feeCap: cfg.feeCap,
        freeOverTotal: cfg.freeOverTotal, freeCoverMax: cfg.freeCoverMax,
        farZoneEnabled: cfg.farZoneEnabled, farZoneFromKm: cfg.farZoneFromKm,
        farZoneMaxKm: cfg.farZoneMaxKm, farZonePerKm: cfg.farZonePerKm,
        feeByTotal: Array.isArray(cfg.feeByTotal) ? cfg.feeByTotal : null,
        neverBeatenByApps: cfg.neverBeatenByApps || null,
      };
    } catch (e) {
      return { ok: false, reason: "error", error: String(e && e.message || e) };
    }
  }

  /* متغيّرات البيئة اللي بتأثر على التوصيل — بنقول موجودة ولا لأ، من غير ما
     نطلّع قيمة سر. عمر بيعرف إن المفتاح ناقص من غير ما يفتح Coolify. */
  function envReport() {
    const flag = (k) => Boolean(envRead(k));
    return {
      locks: {
        DELIVERY_FORCE_MANUAL: envRead("DELIVERY_FORCE_MANUAL") || null,
        DELIVERY_DISPATCH_MODE: envRead("DELIVERY_DISPATCH_MODE") || null,
        COURIER_PROVIDER: envRead("COURIER_PROVIDER") || null,
      },
      keys: {
        LEAJLAK_TOKEN: flag("LEAJLAK_TOKEN"), LEAJLAK_SHOP_ID: flag("LEAJLAK_SHOP_ID"),
        LEAJLAK_WEBHOOK_SECRET: flag("LEAJLAK_WEBHOOK_SECRET"),
        CERVO_TOKEN: flag("CERVO_TOKEN"), CERVO_WEBHOOK_SECRET: flag("CERVO_WEBHOOK_SECRET"),
        FLYINGARROW_API_KEY: flag("FLYINGARROW_API_KEY"),
        GOOGLE_ROUTES_KEY: flag("GOOGLE_ROUTES_KEY"),
      },
      note: "المفاتيح بتتحط في Coolify على تطبيق freshcuts-api — مش من اللوحة. القفل اليدوي (DELIVERY_FORCE_MANUAL=1) بيغلب أي إعداد هنا.",
    };
  }

  app.get("/api/delivery/control", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const settings = await getSettingsData().catch(() => ({}));
    return c.json({
      ok: true,
      groups: GROUPS,
      fields: describeFields(settings, envRead),
      providers: API_PROVIDER_IDS,
      env: envReport(),
      zonePolicy: await activePolicyMirror(),
      defaults: {
        dispatchDelayMin: DEFAULT_DISPATCH_DELAY_MIN,
        dispatchModes: DISPATCH_MODES,
        courierSla: DEFAULT_COURIER_SLA,
        leajlakContract: DEFAULT_LJ_CONTRACT,
        courierRouting: DEFAULT_COURIER_ROUTING,
      },
    });
  });

  app.put("/api/delivery/control", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const body = await c.req.json().catch(() => ({}));
    const patch = body && body.patch && typeof body.patch === "object" ? body.patch : body;
    const v = validatePatch(patch);
    if (!v.ok) return c.json({ ok: false, error: "invalid", errors: v.errors }, 400);

    const settings = await getSettingsData().catch(() => ({}));
    const danger = dangerousChanges(v.values, settings);
    const confirmed = new Set(Array.isArray(body.confirm) ? body.confirm.map(String) : []);
    const missing = danger.filter((d) => !confirmed.has(d.path));
    if (missing.length) return c.json({ ok: false, error: "confirm_required", needConfirm: missing }, 409);

    const note = auditLine(v.values, settings);
    const { delivery, shop } = applyPatch(settings, v.values);

    /* بنكتب الفرعين دول بس. لو شاشة تانية حفظت في نفس اللحظة، تعديلها في أي
       مفتاح تاني بيفضل مكانه بدل ما بلوب كامل يدوس عليه. */
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         jsonb_set(COALESCE(data,'{}'::jsonb), '{delivery}', $1::jsonb, true),
         '{shop}', $2::jsonb, true), updated_at=NOW() WHERE id=1`,
      [J(delivery), J(shop)]);

    await ctx.auditNote?.(c, note);
    log.log?.(`[delivery-control] ${note}`);

    const after = await getSettingsData().catch(() => ({}));
    return c.json({ ok: true, changed: Object.keys(v.values), danger: danger.map((d) => d.path),
      note, fields: describeFields(after, envRead) });
  });

  return { FIELDS: ALL_FIELDS, validatePatch, dangerousChanges, describeFields };
}
