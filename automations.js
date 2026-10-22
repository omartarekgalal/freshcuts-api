/* ═══════════════════════════════════════════════════════════════════════════
   ⚡ AUTO1 (٢٢/١٠) — «مركز الأتمتة»: كل الفلوهات والقواعد الموجودة في مكان واحد

   عمر ٢٢/١٠: «عايز في لوحة التحكم قسم الاتمتة على أعلى مستوى … فيه كل الـrules
   اللي عندنا … مع إمكانية التعديل بسهولة من أي شاشة».

   المبدأ (settings-integrity «مصدر واحد لكل إعداد»):
     • الملف ده **قارئ وموزّع** بس. كل فلو بيفضل في موديوله (carts.js، cms.js،
       reviews.js، wabotrun.js، ackescalate.js …) بإعداداته وحراسه زي ما هي.
     • القراءة: من صف الإعدادات بنفس دوال التنظيف بتاعة كل موديول (cartCfg،
       botConfig، teamConfig، effectiveOf …) + أرقام كل فلو من مساره اللي
       شاشته بتقراه أصلاً (GET داخلي بنفس التوكن).
     • الكتابة: PATCH هنا بيتحوّل لنفس طلب الحفظ بتاع شاشة الفلو الأصلية
       (app.request بنفس التوكن) — نفس التحقق، نفس صلاحية القسم والمالك، ونفس
       سطر سجل النشاط. مفيش UPDATE settings في الملف ده خالص.
     • الأسماء والحدود والشرح: من مخطط كل موديول (wabotrun.SCHEMA،
       deliverycontrol.FIELD_BY_PATH، wateam.KNOBS، carts.CART_FIELDS …)؛ اللي
       مالوش مخطط بنكتب له اسم عربي هنا (نص لوحة، مش إعداد).
     • الفلوهات الجديدة (من «معرض القوالب») في autoflows.js — جدول لوحدها،
       مقفولة افتراضياً.
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import { cartCfg, CART_FIELDS } from "./carts.js";
import { openWaitCfg } from "./openwait.js";
import { botConfig, SCHEMA as BOT_SCHEMA } from "./wabotrun.js";
import { teamConfig, KNOBS as TEAM_KNOBS, LIMITS as TEAM_LIMITS } from "./wateam.js";
import { FIELD_BY_PATH as DELIVERY_FIELDS, effectiveOf as deliveryEffective } from "./deliverycontrol.js";
import { loyaltyCfgOf } from "./loyalty.js";
import { pulseCfg, LABELS as PULSE_LABELS, PULSE_LIMITS, slotsOf as pulseSlots } from "./revpulse.js";
import { healthCfg, HEALTH_LIMITS } from "./wahealth.js";
import { sweepConfig as portalSweepCfg, PORTAL_SETTING_KEYS } from "./portalsessions.js";
import { sendHoursCfg, nextSendOpenAt, isRestaurantOpenAt } from "./sendhours.js";
import { habitCfg, HABIT_SCHEMA } from "./wahabit.js";
import { cloudCfg } from "./wacloud.js";
import { ALERT_TYPES, controlCfg as staffControlCfg } from "./staffcontrol.js";
import { PATCH_RULES } from "./settings-guard.js";
import * as smsRules from "./smsrules.js";
import * as af from "./autoflows.js";

/* ── أدوات ───────────────────────────────────────────────────────────────── */
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export function getPath(obj, path) {
  let cur = obj;
  for (const k of String(path).split(".")) { if (cur == null || typeof cur !== "object") return undefined; cur = cur[k]; }
  return cur;
}
function nest(path, value) {
  const ks = String(path).split(".");
  const out = {};
  let cur = out;
  ks.forEach((k, i) => { if (i === ks.length - 1) cur[k] = value; else { cur[k] = {}; cur = cur[k]; } });
  return out;
}
function deepMerge(a, b) {
  const out = { ...(isObj(a) ? a : {}) };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}
const AR_DIG = "٠١٢٣٤٥٦٧٨٩";
export const ar = (n) => String(n).replace(/\d/g, (d) => AR_DIG[Number(d)]);
const pad = (n) => String(n).padStart(2, "0");
const hh = (h) => `${pad(Number(h) || 0)}:00`;
const fmtV = (v) => (v === null || v === undefined ? "—" : typeof v === "boolean" ? (v ? "شغّال" : "مقفول") : Array.isArray(v) ? `${v.length} عنصر` : typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v));

/* ── قيم الإعدادات الفعلية: نفس دالة التنظيف بتاعة كل موديول ───────────── */
const CAMP_DEFAULTS = Object.freeze({ smsEnabled: false, dailySmsCap: 1000, flowGapDays: 21, pushGapDays: 3, budgetSar: 0 });
export function campaignsCfg(s) {
  const raw = (((s || {}).cms || {}).campaigns) || {};
  const q = smsRules.quietOf(s || {});
  const g = smsRules.gapOf(raw);
  return { ...CAMP_DEFAULTS, ...raw, ...g, quietStart: q.start, quietEnd: q.end, smsEnabled: raw.smsEnabled === true };
}
const NORMALIZERS = [
  ["abandonedCarts.", (s) => cartCfg(s)],
  ["openWait.", (s) => openWaitCfg(s)],
  ["waBot.", (s) => botConfig(s)],
  ["waTeam.", (s) => teamConfig(s)],
  ["cms.loyalty.", (s) => loyaltyCfgOf(s)],
  ["cms.campaigns.", (s) => campaignsCfg(s)],
  ["revenuePulse.", (s) => pulseCfg(s)],
  ["waHealth.", (s) => healthCfg(s)],
  ["waSendHours.", (s) => sendHoursCfg(s)],
  ["waSender.byHabit.", (s) => habitCfg((s.waSender || {}).byHabit || {})],
  ["waCloud.", (s) => cloudCfg(s)],
];
const REVIEWS_DEFAULTS = Object.freeze({ active: true, threshold: 4, askAfterDelivery: true, askAfterMinutes: 30, askMaxAgeHours: 20, alertNegative: true });
export function valueAt(path, s) {
  s = s || {};
  if (path.startsWith("delivery.")) { const v = deliveryEffective(path, s, () => ""); return v === undefined ? getPath(s, path) : v; }
  if (path.startsWith("reviews.")) { const k = path.slice(8); const v = getPath(s, path); return v === undefined ? REVIEWS_DEFAULTS[k] : v; }
  if (path.startsWith("portals.")) {
    const k = path.slice(8), c = portalSweepCfg(s);
    const map = { renewEnabled: "enabled", renewSweepMin: "sweepMin" };
    return c[map[k] || k];
  }
  if (path.startsWith("notifications.")) {
    const n = s.notifications || {}, k = path.slice(14);
    if (k === "pushEnabled") return n.pushEnabled !== false;
    if (k === "smsEnabled" || k === "whatsappEnabled") return n[k] === true;
    if (k === "whatsappStages") return Array.isArray(n.whatsappStages) ? n.whatsappStages : [];
    return n[k];
  }
  if (path.startsWith("staffAlerts.types.")) {
    const id = path.split(".")[2];
    const t = (staffControlCfg(s).types || {})[id];
    return t ? t.enabled !== false : true;
  }
  for (const [pre, fn] of NORMALIZERS) if (path.startsWith(pre)) return getPath(fn(s), path.slice(pre.length));
  return getPath(s, path);
}

/* ── الحقول: اسم + شرح + نوع + حدود (من مخطط الموديول لو موجود) ────────── */
const L = (label, type = "bool", extra = {}) => ({ label, type, ...extra });
const LOCAL = {
  "abandonedCarts.enabled": L("السلات المتروكة شغّالة", "bool", { risky: "on" }),
  "abandonedCarts.pushEnabled": L("إشعار في الخطوة الأولى (ببلاش)"),
  "abandonedCarts.smsEnabled": L("SMS بعد واتساب", "bool", { risky: "on", help: "رسالة SMS مدفوعة لو واتساب ماوصلش. مقفول افتراضياً." }),
  "abandonedCarts.sms1AfterMinutes": L("الخطوة ١ بعد سكوت", "int", { min: 30, max: 240, unit: "دقيقة" }),
  "abandonedCarts.sms1WindowMinutes": L("الخطوة ١ تفضل متاحة لمدة", "int", { min: 15, max: 600, unit: "دقيقة" }),
  "abandonedCarts.sms2Enabled": L("الخطوة ٢ (تاني يوم)"),
  "abandonedCarts.sms2Hour": L("ساعة الخطوة ٢", "int", { min: 12, max: 21, unit: "الساعة" }),
  "abandonedCarts.sms2MinSubtotal": L("الخطوة ٢ للسلة من", "int", { min: 0, max: 10000, unit: "ر.س" }),
  "abandonedCarts.minSubtotal": L("أقل قيمة سلة", "int", { min: 0, max: 10000, unit: "ر.س" }),
  "abandonedCarts.requireVerifiedPhone": L("الجوال متأكد بس (حساب أو طلب قبل كده)"),
  "abandonedCarts.respectOpenHours": L("بس والمطعم فاتح"),
  "abandonedCarts.autoFirst": L("كوبون FIRST في رسالة أول طلب"),
  "openWait.enabled": L("«نبّهني لما تفتحوا» شغّال", "bool", { risky: "on" }),
  "openWait.text": L("نص الرسالة ({link} = رابط السلة)", "textarea", { max: 200 }),
  "openWait.openWindowMinutes": L("يتبعت خلال كام دقيقة من الفتح", "int", { min: 30, max: 720, unit: "دقيقة" }),
  "openWait.capPerRun": L("أقصى رسايل في الدورة", "int", { min: 1, max: 500, unit: "رسالة", risky: "up" }),
  "openWait.maxAgeHours": L("الطلب يفضل مستني لحد", "int", { min: 2, max: 168, unit: "ساعة" }),
  "openWait.pushEnabled": L("إشعار كمان"),
  "openWait.pushTitle": L("عنوان الإشعار", "text", { max: 60 }),
  "openWait.pushText": L("نص الإشعار", "text", { max: 140 }),
  "cms.loyalty.enabled": L("الولاء شغّال", "bool", { risky: "on" }),
  "cms.loyalty.every": L("كل كام طلب = مكافأة", "int", { min: 2, max: 20, unit: "طلب" }),
  "cms.loyalty.reward": L("المكافأة", "enum", { options: [["free_delivery", "توصيل مجاني"], ["percent", "خصم ٪"]] }),
  "cms.loyalty.percent": L("نسبة الخصم", "int", { min: 5, max: 50, unit: "٪" }),
  "cms.loyalty.validDays": L("صلاحية الكوبون", "int", { min: 3, max: 90, unit: "يوم" }),
  "cms.loyalty.smsEnabled": L("رسالة SMS بالكود لما يكسب"),
  "cms.loyalty.minTotal": L("أقل طلب تتستخدم عليه", "int", { min: 0, max: 1000, unit: "ر.س" }),
  "reviews.active": L("صفحة التقييم شغّالة"),
  "reviews.askAfterDelivery": L("اطلب تقييم بعد التسليم (المفتاح الرئيسي)", "bool", { risky: "on" }),
  "reviews.askAfterMinutes": L("بعد التسليم بـ (النظام القديم)", "int", { min: 1, max: 720, unit: "دقيقة" }),
  "reviews.askMaxAgeHours": L("الطلب يتلغي لو أقدم من", "int", { min: 1, max: 72, unit: "ساعة" }),
  "reviews.threshold": L("من كام نجمة يروح جوجل", "int", { min: 2, max: 5, unit: "نجوم" }),
  "cms.campaigns.smsEnabled": L("SMS التسويقي (الحملات والأتمتة كلها)", "bool", { risky: "on", help: "المفتاح الواحد لكل SMS تسويقي. مقفول ⇒ مفيش SMS تسويقي من أي فلو." }),
  "cms.campaigns.dailySmsCap": L("السقف اليومي لأجزاء الـSMS", "int", { min: 0, max: 20000, unit: "جزء", risky: "up" }),
  "cms.campaigns.quietStart": L("ساعات الهدوء من", "int", { min: 0, max: 23, unit: "الساعة", risky: "any", help: "مصدر واحد لكل رسايل التسويق (SMS والإشعارات)." }),
  "cms.campaigns.quietEnd": L("ساعات الهدوء لحد", "int", { min: 0, max: 23, unit: "الساعة", risky: "any" }),
  "cms.campaigns.flowGapDays": L("فاصل الأتمتة (أقل مدة بين رسالتين)", "int", { min: 7, max: 180, unit: "يوم", risky: "down" }),
  "cms.campaigns.pushGapDays": L("فاصل الإشعارات", "int", { min: 0, max: 60, unit: "يوم", risky: "down" }),
  "cms.campaigns.maxPerWeek": L("أقصى رسايل للعميل في الأسبوع", "int", { min: 0, max: 14, unit: "رسالة", risky: "up" }),
  "cms.campaigns.maxPerMonth": L("أقصى رسايل للعميل في الشهر", "int", { min: 0, max: 60, unit: "رسالة", risky: "up" }),
  "cms.campaigns.budgetSar": L("ميزانية SMS (٠ = من غير حد)", "number", { min: 0, max: 1000000, unit: "ر.س", risky: "any" }),
  "waSendHours.enabled": L("واتساب الآلي بمواعيد المطعم بس", "bool", { risky: "off" }),
  "waSendHours.stopBeforeCloseMin": L("يقف قبل القفل بـ", "int", { min: 0, max: 180, unit: "دقيقة" }),
  "waCloud.enabled": L("حملات واتساب شغّالة", "bool", { risky: "on" }),
  "waCloud.dailyCap": L("سقف حملات واتساب في اليوم", "int", { min: 1, max: 100000, unit: "رسالة", risky: "up" }),
  "waCloud.hourCap": L("سقف الساعة", "int", { min: 1, max: 10000, unit: "رسالة", risky: "up" }),
  "waCloud.spendDaySar": L("سقف الصرف اليومي", "number", { min: 0, max: 100000, unit: "ر.س", risky: "up" }),
  "waCloud.brakeStopPct": L("فرملة: إيقاف لو الإيقافات أكتر من", "number", { min: 0.5, max: 100, unit: "٪", risky: "up" }),
  "waCloud.brakeFailPct": L("فرملة: إيقاف لو الفشل أكتر من", "number", { min: 1, max: 100, unit: "٪", risky: "up" }),
  "waCloud.custCap7d": L("العميل: أقصى حملات في ٧ أيام", "int", { min: 1, max: 3, unit: "رسالة", risky: "up" }),
  "waCloud.custCap30d": L("العميل: أقصى حملات في ٣٠ يوم", "int", { min: 1, max: 10, unit: "رسالة", risky: "up" }),
  "waHealth.enabled": L("مراقب صحة واتساب شغّال"),
  "waHealth.sms": L("التنبيه بـSMS"),
  "waHealth.ownerWa": L("وكمان واتساب للمالك"),
  "waHealth.everyMin": L("الفحص كل", "int", { min: HEALTH_LIMITS.everyMin?.[0] ?? 5, max: HEALTH_LIMITS.everyMin?.[1] ?? 180, unit: "دقيقة" }),
  "waHealth.repeatHours": L("تكرار التنبيه لو المشكلة لسه موجودة", "int", { min: 1, max: 72, unit: "ساعة" }),
  "waHealth.recovery": L("رسالة «رجع تمام»"),
  "waHealth.monthBudgetSar": L("ميزانية واتساب الشهرية (٠ = من غير)", "number", { min: 0, max: 1000000, unit: "ر.س" }),
  "portals.renewEnabled": L("تجديد جلسات هنقرستيشن ونينجا"),
  "portals.alertsEnabled": L("تنبيه لما الجلسة تقع"),
  "portals.alertRepeatHours": L("تكرار التنبيه كل", "int", { min: PORTAL_SETTING_KEYS.alertRepeatHours[0], max: PORTAL_SETTING_KEYS.alertRepeatHours[1], unit: "ساعة" }),
  "portals.soonHours": L("«قربت تخلص» قبل", "int", { min: PORTAL_SETTING_KEYS.soonHours[0], max: PORTAL_SETTING_KEYS.soonHours[1], unit: "ساعة" }),
  "adsGuard.stopAll": L("إيقاف كل الإعلانات", "bool", { risky: "any" }),
  "adsGuard.window.from": L("نافذة الإعلانات من", "hhmm", { risky: "any" }),
  "adsGuard.window.to": L("نافذة الإعلانات لحد", "hhmm", { risky: "any" }),
  "adsGuard.defaultCap": L("السقف اليومي الافتراضي", "int", { min: 0, max: 20000, unit: "ر.س", risky: "up" }),
  "adsGuard.revenueCap.enabled": L("سقف الإعلانات من الدخل", "bool", { risky: "any" }),
  "adsGuard.revenueCap.pct": L("النسبة من الدخل", "number", { min: 1, max: 50, unit: "٪", risky: "up" }),
  "adsGuard.revenueCap.maxTotal": L("السقف الصلب", "int", { min: 50, max: 20000, unit: "ر.س", risky: "up" }),
  "adsGuard.killRule.auto": L("قاعدة الـ٣ أيام (إيقاف الحملة الخسرانة)", "bool", { risky: "any" }),
  "adsGuard.killRule.stopIfCpaOver": L("إيقاف لو تكلفة العميل فوق", "number", { min: 1, max: 1000, unit: "ر.س", risky: "up" }),
  "adsGuard.intraday.enabled": L("قاعدة الساعة ٨ (صرف من غير عملاء)", "bool", { risky: "any" }),
  "adsGuard.intraday.spendOver": L("قاعدة الساعة ٨: صرف أكتر من", "int", { min: 0, max: 20000, unit: "ر.س", risky: "up" }),
  "adsGuard.floor": L("الأرضية اليومية", "int", { min: 0, max: 100000, unit: "ر.س" }),
  "adsGuard.hardCap": L("السقف الصلب اليومي", "int", { min: 0, max: 100000, unit: "ر.س", risky: "up" }),
  "waTeam.ladder.enabled": L("سلّم التصعيد: المدير ثم المُلّاك", "bool", { risky: "off" }),
  "waTeam.ladder.managerAfterMin": L("للمدير بعد (من غير استلام)", "int", { min: TEAM_LIMITS["ladder.managerAfterMin"][0], max: TEAM_LIMITS["ladder.managerAfterMin"][1], unit: "دقيقة" }),
  "waTeam.ladder.ownersAfterMin": L("للمُلّاك بعد كمان", "int", { min: TEAM_LIMITS["ladder.ownersAfterMin"][0], max: TEAM_LIMITS["ladder.ownersAfterMin"][1], unit: "دقيقة" }),
  "notifications.whatsappEnabled": L("رسايل الطلب على واتساب", "bool", { readOnly: "من «واتساب ← الإعدادات»" }),
  "notifications.smsEnabled": L("رسايل الطلب SMS", "bool", { readOnly: "من «الإعدادات ← الإشعارات»" }),
  "notifications.pushEnabled": L("إشعارات الطلب", "bool", { readOnly: "من «الإعدادات ← الإشعارات»" }),
  "notifications.whatsappStages": L("مراحل واتساب الشغّالة", "list", { readOnly: "من «واتساب ← الإعدادات ← المراحل» (بيتأكد إن القالب معتمد)" }),
};
for (const t of ALERT_TYPES) LOCAL[`staffAlerts.types.${t.id}.enabled`] = L(`SMS الفريق: ${t.label}`, "bool", { help: t.hint || "", risky: t.critical ? "off" : null });

const typeOfSchema = (t) => (t === "boolean" || t === "bool" ? "bool" : t === "number" || t === "num" || t === "int" ? "int" : t === "enum" ? "enum" : t === "phones" ? "list" : t === "keys" ? "list" : t === "hhmm" ? "hhmm" : "text");
export function fieldSpec(path) {
  let spec = null;
  if (path.startsWith("waBot.")) {
    const s = BOT_SCHEMA[path.slice(6)];
    if (s) spec = { label: s.ar, help: s.help || "", type: typeOfSchema(s.type), min: s.min, max: s.max, unit: s.unit, options: s.options ? s.options.map((o, i) => [o, (s.optionsAr && s.optionsAr[i]) || o]) : undefined };
  } else if (path.startsWith("delivery.")) {
    const f = DELIVERY_FIELDS[path];
    if (f) spec = { label: f.label, help: f.hint || "", type: f.type === "bool" ? "bool" : f.type === "phones" ? "list" : f.type === "enum" ? "enum" : f.type === "int" ? "int" : f.type === "num" ? "number" : typeOfSchema(f.type), min: f.min, max: f.max, unit: f.unit, options: f.options ? f.options.map((o) => (Array.isArray(o) ? o : [o.v ?? o.value ?? o, o.label ?? o])) : undefined, risky: f.danger ? "any" : null };
  } else if (path.startsWith("waTeam.")) {
    const key = path.slice(7), k = TEAM_KNOBS.find((x) => x.key === key), lim = TEAM_LIMITS[key];
    if (k) spec = { label: k.label, help: k.hint || "", type: k.type === "bool" ? "bool" : "int", min: lim?.[0], max: lim?.[1], unit: k.unit };
  } else if (path.startsWith("abandonedCarts.")) {
    const f = CART_FIELDS[path.slice(15)];
    if (f) spec = { label: f.ar, help: f.hint || "", type: f.type === "bool" ? "bool" : f.type === "int" ? "int" : f.type === "enum" ? "enum" : "text", min: f.min, max: f.max };
  } else if (path.startsWith("revenuePulse.")) {
    const k = path.slice(13);
    if (PULSE_LABELS[k]) spec = { label: PULSE_LABELS[k], help: "", type: PULSE_LIMITS[k] ? "int" : k === "closeAt" ? "hhmm" : "bool", min: PULSE_LIMITS[k]?.[0], max: PULSE_LIMITS[k]?.[1] };
  } else if (path.startsWith("waSender.byHabit.")) {
    const s = HABIT_SCHEMA[path.slice(17)];
    if (s) spec = { label: s.ar, help: s.help || "", type: typeOfSchema(s.type), min: s.min, max: s.max, unit: s.unit };
  }
  const local = LOCAL[path];
  spec = { ...(spec || {}), ...(local || {}) };
  if (!spec.label) spec.label = path.split(".").slice(-1)[0];
  if (!spec.type) spec.type = "text";
  spec.path = path;
  return spec;
}

/* ═══ الكتّاب: كل مسار إعداد ⇒ طلب الحفظ بتاع شاشته الأصلية (بنفس التوكن) ═══
   build(changes[{path,value}], settings) ⇒ {method, path, body} — الجسم بالشكل اللي
   المسار الأصلي مستنيه بالظبط (بعضهم بيدمج، وبعضهم لازم الكائن كله). */
const rel = (pre, path) => path.slice(pre.length);
const patchRuleFor = (path) => PATCH_RULES.find((r) => r.re.test(path));
export const WRITERS = [
  { id: "carts", pre: "abandonedCarts.", label: "السلات المتروكة", build: (ch) => ({ method: "PUT", path: "/api/carts/recovery", body: Object.fromEntries(ch.map((x) => [rel("abandonedCarts.", x.path), x.value])) }) },
  /* PUT /api/cms/openwait بيبدّل الكائن كله ⇒ الحالي + التغيير */
  { id: "openwait", pre: "openWait.", label: "منتظرين الفتح", build: (ch, s) => ({ method: "PUT", path: "/api/cms/openwait", body: { ...openWaitCfg(s), ...Object.fromEntries(ch.map((x) => [rel("openWait.", x.path), x.value])) } }) },
  /* configFromBody بيدمج على اللي متخزّن (والكائنات المتداخلة reviewFlow/utilityFirst/assist بتدمج جوّاها) */
  { id: "wabot", pre: "waBot.", label: "إعدادات البوت", owner: true, build: (ch) => ({ method: "PUT", path: "/api/cms/wabot/config", body: ch.reduce((b, x) => deepMerge(b, nest(rel("waBot.", x.path), x.value)), {}) }) },
  { id: "team", pre: "waTeam.", label: "تواصل الفريق", owner: true, build: (ch) => ({ method: "PUT", path: "/api/cms/wabot/team", body: ch.reduce((b, x) => deepMerge(b, nest(rel("waTeam.", x.path), x.value)), {}) }) },
  /* لوحة التوصيل: patch بالمسار الكامل + confirm للحقول الخطرة (409 confirm_required بيرجع للوحة زي ما هو) */
  { id: "delivery", pre: "delivery.", label: "التوصيل والتنبيهات", build: (ch, s, o = {}) => ({ method: "PUT", path: "/api/delivery/control", body: { patch: Object.fromEntries(ch.map((x) => [x.path, x.value])), ...(o.confirm ? { confirm: ch.map((x) => x.path) } : {}) } }) },
  { id: "reviews", pre: "reviews.", label: "التقييمات", build: (ch) => ({ method: "PUT", path: "/api/cms/reviews/settings", body: Object.fromEntries(ch.map((x) => [rel("reviews.", x.path), x.value])) }) },
  /* PUT /api/cms/loyalty: enabled لازم true صريحة وأي مفتاح ناقص بيرجع للافتراضي ⇒ الحالي كله + التغيير */
  { id: "loyalty", pre: "cms.loyalty.", label: "الولاء", build: (ch, s) => { const cur = loyaltyCfgOf(s); const { startedAt: _st, ...rest } = cur; return { method: "PUT", path: "/api/cms/loyalty", body: { ...rest, ...Object.fromEntries(ch.map((x) => [rel("cms.loyalty.", x.path), x.value])) } }; } },
  /* PUT /api/cms/campaign-settings: smsEnabled + dailySmsCap لازم يتبعتوا دايماً (لو ناقصين بيتقفل الـSMS والسقف ٠) */
  { id: "campaigns", pre: "cms.campaigns.", label: "قواعد الحملات والـSMS", build: (ch, s) => { const cur = campaignsCfg(s); const body = { smsEnabled: cur.smsEnabled === true, dailySmsCap: Number(cur.dailySmsCap) || 0 }; for (const x of ch) body[rel("cms.campaigns.", x.path)] = x.value; return { method: "PUT", path: "/api/cms/campaign-settings", body }; } },
  { id: "staffalerts", pre: "staffAlerts.types.", label: "تنبيهات الفريق", build: (ch, s) => {
    const types = {}; const cur = staffControlCfg(s).types || {};
    for (const x of ch) { const id = x.path.split(".")[2]; const t = cur[id] || {}; types[id] = { enabled: x.value !== false, mute: t.mute || [], codes: t.codes || {} }; }
    return { method: "POST", path: "/api/cms/staff-alerts", body: { types } };
  } },
  { id: "pulse", pre: "revenuePulse.", label: "رسالة الدخل", owner: true, build: (ch) => ({ method: "POST", path: "/api/cms/revenue-pulse/settings", body: Object.fromEntries(ch.map((x) => [rel("revenuePulse.", x.path), x.value])) }) },
  { id: "wahealth", pre: "waHealth.", label: "صحة واتساب", owner: true, build: (ch) => ({ method: "POST", path: "/api/cms/wa-health/settings", body: Object.fromEntries(ch.map((x) => [rel("waHealth.", x.path), x.value])) }) },
  { id: "habit", pre: "waSender.byHabit.", label: "الإرسال على عادة العميل", build: (ch) => ({ method: "POST", path: "/api/cms/wa-sender/settings", body: { byHabit: Object.fromEntries(ch.map((x) => [rel("waSender.byHabit.", x.path), x.value])) } }) },
  { id: "sendhours", pre: "waSendHours.", label: "مواعيد الإرسال", owner: true, build: (ch) => ({ method: "PUT", path: "/api/cms/wa-send-hours", body: Object.fromEntries(ch.map((x) => [rel("waSendHours.", x.path), x.value])) }) },
  { id: "portals", pre: "portals.", label: "جلسات البوابات", owner: true, build: (ch) => ({ method: "POST", path: "/api/portals/settings", body: Object.fromEntries(ch.map((x) => [rel("portals.", x.path), x.value])) }) },
  { id: "wacloud", pre: "waCloud.", label: "حملات واتساب", owner: true, build: (ch) => ({ method: "POST", path: "/api/cms/wa-cloud/settings", body: Object.fromEntries(ch.map((x) => [rel("waCloud.", x.path), x.value])) }) },
  /* adsGuard / jobs: POST /api/settings/patch (المالك). المسار نفسه في الـallowlist، وإلا أبوه (intraday / killRule / revenueCap) بكائن جزئي بيتدمج */
  { id: "patch", pre: ["adsGuard.", "jobs."], label: "حارس الإعلانات والمهام", owner: true, build: (ch) => {
    const out = [];
    for (const x of ch) {
      if (patchRuleFor(x.path)) { out.push({ path: x.path, value: x.value }); continue; }
      const ks = x.path.split(".");
      const parent = ks.slice(0, -1).join(".");
      if (patchRuleFor(parent)) { const hit = out.find((o) => o.path === parent); if (hit) hit.value = { ...hit.value, [ks.at(-1)]: x.value }; else out.push({ path: parent, value: { [ks.at(-1)]: x.value } }); continue; }
      out.push({ path: x.path, value: x.value });      // هيترفض من validatePatch برسالة عربي — مش هنتخطاه
    }
    return { method: "POST", path: "/api/settings/patch", body: { changes: out } };
  } },
  /* فلوهات cms_flows (اطلب تاني / استرجاع / أي أتمتة شريحة): المفتاح لوحده = {active}، غير كده الصف كله + التغيير */
  { id: "cmsflow", pre: "cmsFlows.", label: "أتمتة الشرائح", build: (ch, s, o = {}) => {
    const id = Number(ch[0].path.split(".")[1]);
    if (ch.length === 1 && ch[0].path.endsWith(".active")) return { method: "PUT", path: `/api/cms/flows/${id}`, body: { active: ch[0].value === true } };
    const row = (o.cmsFlows || []).find((f) => Number(f.id) === id) || {};
    const body = { name: row.name, segment: row.segment, channel: row.channel, message: row.message, coupon: row.coupon, holdout_pct: row.holdout_pct, offer: row.offer, offer_min_total: row.offer_min_total, offer_valid_days: row.offer_valid_days };
    for (const x of ch) body[x.path.split(".")[2]] = x.value;
    return { method: "PUT", path: `/api/cms/flows/${id}`, body };
  } },
];
export function writerFor(path) {
  return WRITERS.find((w) => (Array.isArray(w.pre) ? w.pre.some((p) => path.startsWith(p)) : path.startsWith(w.pre))) || null;
}
/* {path:value} ⇒ [{writer, req}] — مجموعة لكل كاتب، بالترتيب */
export function planWrites(changes, settings, opts = {}) {
  const groups = new Map();
  const unknown = [];
  for (const [path, value] of Object.entries(changes || {})) {
    const w = writerFor(path);
    if (!w) { unknown.push(path); continue; }
    const key = w.id === "cmsflow" ? `cmsflow:${path.split(".")[1]}` : w.id;
    if (!groups.has(key)) groups.set(key, { w, ch: [] });
    groups.get(key).ch.push({ path, value });
  }
  return { unknown, plan: [...groups.values()].map(({ w, ch }) => ({ writer: w.id, label: w.label, owner: Boolean(w.owner), paths: ch.map((x) => x.path), req: w.build(ch, settings || {}, opts) })) };
}

/* تغيير خطر = محتاج تأكيد: تشغيل فلو بيبعت لعملاء، رفع سقف، تقليل فاصل، تغيير ساعات الهدوء */
export function riskyChanges(changes, settings, flow = null) {
  const out = [];
  for (const [path, to] of Object.entries(changes || {})) {
    const spec = (flow?.fields || []).find((f) => f.path === path) || fieldSpec(path);
    const from = flow?.values && path in flow.values ? flow.values[path] : valueAt(path, settings);
    let r = spec.risky || null;
    if (!r && flow && flow.switch === path && flow.audience === "customers") r = "on";
    if (!r) continue;
    const why = r === "on" && to === true && from !== true ? "تشغيل رسايل للعملاء"
      : r === "off" && to === false && from !== false ? "إيقاف حارس/تنبيه مهم"
        : r === "up" && Number(to) > Number(from) ? "رفع سقف"
          : r === "down" && Number(to) < Number(from) ? "تقليل الفاصل بين الرسايل"
            : r === "any" && JSON.stringify(to) !== JSON.stringify(from) ? "إعداد حسّاس" : null;
    if (why) out.push({ path, label: spec.label, from, to, why });
  }
  return out;
}

/* التحقق المبدئي قبل الإرسال (نفس الحدود اللي في المخطط) — السيرفر الأصلي بيتحقق تاني */
export function precheck(changes, flow) {
  const errors = [];
  const byPath = new Map((flow?.fields || []).map((f) => [f.path, f]));
  for (const [path, v] of Object.entries(changes || {})) {
    const s = byPath.get(path);
    if (!s) { errors.push({ path, error: "الإعداد ده مش من الفلو ده" }); continue; }
    if (s.readOnly) { errors.push({ path, error: `${s.label}: للقراية بس هنا — ${s.readOnly}` }); continue; }
    if (s.type === "bool" && typeof v !== "boolean") errors.push({ path, error: `${s.label}: شغّال أو مقفول` });
    if ((s.type === "int" || s.type === "number") && (v === "" || v === null || !Number.isFinite(Number(v)))) errors.push({ path, error: `${s.label}: لازم رقم` });
    else if ((s.type === "int" || s.type === "number") && ((s.min != null && Number(v) < s.min) || (s.max != null && Number(v) > s.max))) errors.push({ path, error: `${s.label}: من ${ar(s.min)} لـ${ar(s.max)}` });
    if (s.type === "hhmm" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) errors.push({ path, error: `${s.label}: HH:MM` });
    if ((s.type === "text" || s.type === "textarea") && s.max && String(v ?? "").length > s.max) errors.push({ path, error: `${s.label}: ${ar(s.max)} حرف بالكتير` });
    if (s.type === "enum" && s.options && !s.options.some(([o]) => o === v)) errors.push({ path, error: `${s.label}: اختيار مش معروف` });
  }
  return errors;
}

/* ═══ الكتالوج: كل فلو/قاعدة موجودة النهارده (من الكود — الجرد في README الشريحة) ══
   x = السياق: s الإعدادات، bot/team/camp منظّفين، d ردود المسارات (GET داخلي)، tpl حالة القوالب، now.
   كل فلو: الاسم، الفئة، المحفّز، الجمهور، القنوات، المفتاح، الحقول (مسارات الإعدادات)، العُقد
   (للكانفاس)، السقوف والهدوء، المواعيد (للتايم لاين)، الحالة، الأرقام، التحذيرات، والسجل. */
export const CATEGORIES = Object.freeze([
  { id: "customers", label: "رسايل العملاء (تسويق واسترجاع)", icon: "💌" },
  { id: "service", label: "خدمة العميل ورسايل الطلب", icon: "🧾" },
  { id: "team", label: "تنبيهات الفريق والتصعيد", icon: "📟" },
  { id: "rules", label: "القواعد والحرّاس (بتمشي على الكل)", icon: "🛡" },
  { id: "ads", label: "الإعلانات والمهام المجدولة", icon: "📣" },
  { id: "custom", label: "فلوهات جديدة (من المعرض)", icon: "✨" },
]);
const CH_AR = { push: "إشعار", wa: "واتساب", sms: "SMS", staff: "الفريق", portal: "البوابة", ads: "الإعلانات" };
const node = (id, type, label, sub = "", extra = {}) => ({ id, type, label, sub, ...extra });
const mins = (n) => (Number(n) >= 60 && Number(n) % 60 === 0 ? `${ar(Number(n) / 60)} ساعة` : `${ar(n)} دقيقة`);
const onOff = (b) => (b ? "شغّال" : "مقفول");
const tplOk = (x, name) => { if (!name) return null; const st = x.tpl?.get(name); return st == null ? null : st === "APPROVED"; };
const tplWarn = (x, names) => names.filter(Boolean).map((n) => [n, tplOk(x, n)]).filter(([, ok]) => ok === false)
  .map(([n]) => ({ level: "warn", text: `القالب ${n} مش معتمد عند ميتا — الخطوة دي هتقع على البديل`, link: "#store/wa/templates" }));
const botState = (x) => (x.bot.mode === "live" ? "live" : x.bot.mode === "test" ? "test" : "off");
const waBlock = (x) => (!x.master ? "مفتاح واتساب الرئيسي مقفول (واتساب ← الإعدادات)" : null);
/* حالة فلو واتساب بيعدّي على البوت: مقفول ⇒ off؛ البوت مقفول ⇒ dormant؛ تجربة ⇒ test */
function botFlowStatus(on, x, label = "") {
  if (!on) return { state: "off", why: `${label}مقفول` };
  if (waBlock(x)) return { state: "dormant", why: waBlock(x) };
  const b = botState(x);
  if (b === "off") return { state: "dormant", why: "شغّال بس البوت مقفول ⇒ مابيبعتش" };
  if (b === "test") return { state: "test", why: "البوت في وضع التجربة ⇒ لأرقام التجربة بس" };
  return { state: "on", why: "شغّال للعملاء" };
}
const quietSms = (x) => `ساعات الهدوء: من ${hh(x.camp.quietStart)} لـ${hh(x.camp.quietEnd)} (مصدر واحد: قواعد الحملات)`;
const waHoursTxt = (x) => (x.sendHours.active ? `مواعيد المطعم (يقف قبل القفل بـ${ar(x.sendHours.stopBeforeCloseMin)} د)` : "الساعات القديمة للمسار");
const windowDaily = (from, to, label) => ({ kind: "window", from, to, label });
const sumObj = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);

/* أوقات الفتح الجاية (٧ أيام) من settings.hours — للتايم لاين */
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function openingsNext(s, now, days = 7, offsetMin = 0) {
  const h = s?.hours;
  if (!h || h.enabled === false || !h.days) return [];
  const out = [];
  const base = new Date(now).getTime();
  for (let i = 0; i <= days; i++) {
    const t = new Date(base + i * 86400_000 + 3 * 3600_000);
    const day = h.days[DAY_KEYS[t.getUTCDay()]];
    if (!day || day.closed || !/^\d{1,2}:\d{2}$/.test(String(day.open || ""))) continue;
    const [H, M] = String(day.open).split(":").map(Number);
    const at = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), H, M) - 3 * 3600_000 + offsetMin * 60_000;
    if (at > base && at < base + days * 86400_000) out.push(new Date(at).toISOString());
  }
  return out;
}

export const CATALOG = [
  /* ─────────────── 💌 رسايل العملاء ─────────────── */
  {
    id: "carts", name: "السلات المتروكة", icon: "🧺", cat: "customers", audience: "customers", source: "carts.js", screen: "#store/grow/carts",
    desc: "عميل حط أكل في السلة ومشي من غير ما يدفع ⇒ إشعار ثم واتساب ثم SMS، وخطوة تانية تاني يوم.",
    trigger: { type: "event", label: "سلة فيها أصناف ورقم جوال واتسكتت" }, channels: ["push", "wa", "sms"],
    switch: "abandonedCarts.enabled",
    fields: ["abandonedCarts.enabled", "abandonedCarts.sms1AfterMinutes", "abandonedCarts.pushEnabled", "abandonedCarts.waEnabled", "abandonedCarts.waInWindowText", "abandonedCarts.waTemplate1",
      "abandonedCarts.smsFallback", "abandonedCarts.smsEnabled", "abandonedCarts.sms1WindowMinutes", "abandonedCarts.sms2Enabled", "abandonedCarts.sms2Hour", "abandonedCarts.sms2MinSubtotal", "abandonedCarts.waTemplate2",
      "abandonedCarts.waTemplate2First", "abandonedCarts.maxPerWeek", "abandonedCarts.cooldownDays", "abandonedCarts.minSubtotal", "abandonedCarts.requireVerifiedPhone", "abandonedCarts.respectOpenHours", "abandonedCarts.autoFirst"],
    nodes: (v) => [
      node("t", "trigger", "سلة اتسابت", `فيها أصناف ≥ ${ar(v["abandonedCarts.minSubtotal"])} ر.س وجوال${v["abandonedCarts.requireVerifiedPhone"] ? " متأكد" : ""}`, { paths: ["abandonedCarts.enabled", "abandonedCarts.minSubtotal", "abandonedCarts.requireVerifiedPhone", "abandonedCarts.respectOpenHours"] }),
      node("w1", "wait", `استنى ${mins(v["abandonedCarts.sms1AfterMinutes"])}`, `ولحد ${mins(v["abandonedCarts.sms1WindowMinutes"])} بعدها`, { paths: ["abandonedCarts.sms1AfterMinutes", "abandonedCarts.sms1WindowMinutes"] }),
      node("s1", "send", "الخطوة ١", [v["abandonedCarts.pushEnabled"] && "إشعار", v["abandonedCarts.waEnabled"] && "واتساب", v["abandonedCarts.smsFallback"] && v["abandonedCarts.smsEnabled"] && "SMS لو واتساب ماوصلش"].filter(Boolean).join(" ← ") || "مفيش قناة شغّالة",
        { channel: "wa", paths: ["abandonedCarts.pushEnabled", "abandonedCarts.waEnabled", "abandonedCarts.waInWindowText", "abandonedCarts.waTemplate1", "abandonedCarts.smsFallback", "abandonedCarts.smsEnabled"] }),
      node("b1", "branch", "اشترى؟", "أي طلب مدفوع ⇒ خروج"),
      node("w2", "wait", `تاني يوم الساعة ${ar(v["abandonedCarts.sms2Hour"])}`, `للسلة ≥ ${ar(v["abandonedCarts.sms2MinSubtotal"])} ر.س`, { paths: ["abandonedCarts.sms2Enabled", "abandonedCarts.sms2Hour", "abandonedCarts.sms2MinSubtotal"] }),
      node("s2", "send", "الخطوة ٢", v["abandonedCarts.sms2Enabled"] ? "واتساب ثم SMS" : "مقفولة", { channel: "wa", paths: ["abandonedCarts.waTemplate2", "abandonedCarts.waTemplate2First"] }),
      node("g", "goal", "الهدف: طلب مدفوع", "استرجاع السلة (خلال ٧٢ ساعة)"),
      node("cap", "guard", `بالكتير ${ar(v["abandonedCarts.maxPerWeek"])} رسالة في ${ar(v["abandonedCarts.cooldownDays"])} يوم`, "الإشعار ببلاش ومش محسوب", { paths: ["abandonedCarts.maxPerWeek", "abandonedCarts.cooldownDays"] }),
    ],
    caps: (v) => [["رسايل للجوال", `${ar(v["abandonedCarts.maxPerWeek"])} في ${ar(v["abandonedCarts.cooldownDays"])} يوم`], ["كل دورة", "٤٠ سلة لكل خطوة"]],
    quiet: (v, x) => `${quietSms(x)} للـSMS والإشعار · واتساب: ${waHoursTxt(x)}${v["abandonedCarts.respectOpenHours"] ? " · والمطعم فاتح بس" : ""}`,
    when: (v) => [{ kind: "every", minutes: 5, label: `بيفحص كل ٥ دقايق — الخطوة ١ بعد ${mins(v["abandonedCarts.sms1AfterMinutes"])}` }, ...(v["abandonedCarts.sms2Enabled"] ? [{ kind: "daily", at: hh(v["abandonedCarts.sms2Hour"]), label: "الخطوة ٢ (تاني يوم)" }] : [])],
    status: (v) => (v["abandonedCarts.enabled"] ? { state: "on", why: v["abandonedCarts.smsEnabled"] ? "إشعار + واتساب + SMS" : "إشعار + واتساب (الـSMS مقفول)" } : { state: "off", why: "مقفول" }),
    sources: ["/api/carts/recovery"],
    metrics: (d) => { const r = d["/api/carts/recovery"]; if (!r?.d7) return null; const m = (o, w, l) => ({ window: w, label: l, entered: o.abandoned, sent: { push: o.push, wa: o.wa, sms: o.sms }, converted: o.recovered, revenue: Math.round(o.revenue || 0), cost: Math.round((o.cost || 0) * 100) / 100, extra: [["فتحوا الرابط", o.opened], ["قيمة السلات", `${ar(o.abandonedValue || 0)} ر.س`]] }); return [m(r.d7, "7d", "آخر ٧ أيام"), m(r.today, "today", "النهارده")]; },
    health: (v, x) => [...tplWarn(x, v["abandonedCarts.waEnabled"] ? [v["abandonedCarts.waTemplate1"], v["abandonedCarts.sms2Enabled"] && v["abandonedCarts.waTemplate2"]] : []),
      ...(v["abandonedCarts.smsEnabled"] && !x.camp.smsEnabled ? [{ level: "info", text: "SMS السلة شغّال بس SMS التسويقي مقفول في قواعد الحملات ⇒ مفيش SMS", path: "cms.campaigns.smsEnabled" }] : []),
      ...(waBlock(x) && v["abandonedCarts.waEnabled"] ? [{ level: "warn", text: `${waBlock(x)} ⇒ خطوة واتساب مش هتطلع` }] : [])],
    test: { kind: "inner", method: "POST", path: "/api/cms/sms/templates/test", body: (phone) => ({ id: "cart.sms1", phone }), label: "SMS الخطوة ١ (النص بس)" },
  },
  {
    id: "openwait", name: "نبّهني لما تفتحوا", icon: "🔔", cat: "customers", audience: "customers", source: "openwait.js", screen: "#store/grow/carts",
    desc: "العميل حاول يطلب والمطعم مقفول وساب رقمه ⇒ أول ما نفتح: إشعار + SMS برابط سلته.",
    trigger: { type: "event", label: "العميل ساب رقمه والمطعم مقفول" }, channels: ["push", "sms"], switch: "openWait.enabled",
    fields: ["openWait.enabled", "openWait.openWindowMinutes", "openWait.capPerRun", "openWait.maxAgeHours", "openWait.text", "openWait.pushEnabled", "openWait.pushTitle", "openWait.pushText"],
    nodes: (v) => [
      node("t", "trigger", "ساب رقمه وإحنا مقفولين", "«نبّهني لما تفتحوا»", { paths: ["openWait.enabled", "openWait.maxAgeHours"] }),
      node("w", "wait", "لحد ما نفتح", `خلال ${mins(v["openWait.openWindowMinutes"])} من الفتح`, { paths: ["openWait.openWindowMinutes"] }),
      node("s", "send", "إشعار + SMS", "برابط السلة المحفوظة", { channel: "sms", paths: ["openWait.text", "openWait.pushEnabled", "openWait.pushTitle", "openWait.pushText"] }),
      node("g", "goal", "الهدف: طلب", "خلال ٧٢ ساعة"),
      node("cap", "guard", `بالكتير ${ar(v["openWait.capPerRun"])} في الدقيقة`, "رسالة واحدة للجوال في اليوم", { paths: ["openWait.capPerRun"] }),
    ],
    caps: (v) => [["كل دورة (دقيقة)", ar(v["openWait.capPerRun"])], ["للجوال", "مرة في اليوم"]],
    quiet: (v, x) => `بس بعد الفتح · الرقم اللي مش متأكد: ${quietSms(x)}`,
    when: (v, x) => [{ kind: "points", at: openingsNext(x.s, x.now), label: "وقت الفتح" }, { kind: "every", minutes: 1, label: `خلال ${mins(v["openWait.openWindowMinutes"])} من الفتح` }],
    status: (v) => (v["openWait.enabled"] ? { state: "on", why: "شغّال" } : { state: "off", why: "مقفول" }),
    sources: ["/api/cms/openwait"],
    metrics: (d) => { const st = d["/api/cms/openwait"]?.stats; if (!st) return null; return [{ window: "7d", label: "آخر ٧ أيام", entered: null, sent: { sms: st.notified_7d }, converted: st.converted_7d, extra: [["مستنيين دلوقتي", st.waiting], ["سجّلوا النهارده", st.joined_today], ["قيمة المستنيين", `${ar(Math.round(st.waitingValue || st.waiting_value || 0))} ر.س`]] }]; },
    health: (v, x) => (!x.s.hours ? [{ level: "warn", text: "مواعيد المطعم مش متعرّفة ⇒ مش هنعرف وقت الفتح", link: "#store/settings" }] : []),
    test: { kind: "inner", method: "POST", path: "/api/cms/openwait/test", body: (phone) => ({ phone }), label: "الإشعار والرسالة لرقمك" },
  },
  {
    id: "openfu", name: "نكمّل لما نفتح (واتساب)", icon: "🌅", cat: "customers", audience: "customers", source: "waopenfu.js · wabotrun.js", screen: "#store/wa/ai",
    desc: "العميل طلب على واتساب والمطعم مقفول ⇒ رسالة حرة واحدة ببلاش وقت الفتح بسلته وسعرها الحي.",
    trigger: { type: "event", label: "طلب على واتساب والمطعم مقفول" }, channels: ["wa"], switch: "waBot.openFollowUp",
    fields: ["waBot.openFollowUp", "waBot.openFollowUpDelayMin", "waBot.openFollowUpPlain", "waBot.openFollowUpDailyCap"],
    nodes: (v) => [
      node("t", "trigger", "طلب والمطعم مقفول", "المساعد جهّز السلة أو العميل قال «أبي أطلب»", { paths: ["waBot.openFollowUp", "waBot.openFollowUpPlain"] }),
      node("w", "wait", `الفتح + ${mins(v["waBot.openFollowUpDelayMin"])}`, "لو النافذة لسه مفتوحة", { paths: ["waBot.openFollowUpDelayMin"] }),
      node("b", "branch", "كتب أو طلب من ساعتها؟", "نعم ⇒ مفيش رسالة"),
      node("s", "send", "رسالة حرة ببلاش", "«فتحنا الحين 👋 سلتك جاهزة…»", { channel: "wa" }),
      node("cap", "guard", `بالكتير ${ar(v["waBot.openFollowUpDailyCap"])} في اليوم`, "عمرها ما قالب مدفوع", { paths: ["waBot.openFollowUpDailyCap"] }),
    ],
    caps: (v) => [["في اليوم", ar(v["waBot.openFollowUpDailyCap"])], ["للعميل", "مرة واحدة"]],
    quiet: (v, x) => `وقت الفتح بس · ${waHoursTxt(x)}`,
    when: (v, x) => [{ kind: "points", at: openingsNext(x.s, x.now, 7, Number(v["waBot.openFollowUpDelayMin"]) || 0), label: "مع الفتح" }],
    status: (v, x) => botFlowStatus(v["waBot.openFollowUp"] && Number(v["waBot.openFollowUpDailyCap"]) > 0, x),
    detailSources: ["/api/cms/wabot/assist/stats?days=7"],
    log: (d) => (d["/api/cms/wabot/assist/stats?days=7"]?.openFollowups?.recent || []).slice(0, 20).map((r) => ({ at: r.at || r.created_at, text: `${r.status || ""}${r.reason ? ` · ${r.reason}` : ""}${r.via ? ` · ${r.via}` : ""}` })),
    metricsDetail: (d) => { const o = d["/api/cms/wabot/assist/stats?days=7"]?.openFollowups; if (!o) return null; const by = {}; for (const r of o.byStatus || []) by[r.status] = (by[r.status] || 0) + r.n; return [{ window: "7d", label: "آخر ٧ أيام", sent: { wa: by.sent || 0 }, skipped: Object.fromEntries((o.byStatus || []).filter((r) => r.status === "skipped").map((r) => [r.reason || "skipped", r.n])) }]; },
    health: (v, x) => (waBlock(x) ? [{ level: "warn", text: waBlock(x) }] : []),
    test: null,
  },
  {
    id: "reviews", name: "طلب التقييم + نجوم جوجل", icon: "⭐", cat: "service", audience: "customers", source: "reviews.js · wareviews.js · wabotrun.js", screen: "#store/grow/reviews",
    desc: "بعد التسليم: سؤال التقييم على واتساب (قايمة نجوم)، ٤–٥ نجوم ⇒ جوجل، ٣ أو أقل ⇒ اعتذار وتحويل عاجل للمدير. لو واتساب مش متاح ⇒ SMS.",
    trigger: { type: "event", label: "الطلب اتسلّم (توصيل / استلام / طاولة / فرع)" }, channels: ["wa", "sms"], switch: "reviews.askAfterDelivery",
    fields: ["reviews.askAfterDelivery", "waBot.reviewWhatsApp", "waBot.reviewFlow.enabled", "waBot.reviewFlow.deliveryMin", "waBot.reviewFlow.pickupMin", "waBot.reviewFlow.tableMin", "waBot.reviewFlow.dineinMin",
      "waBot.reviewFlow.takeawayMin", "waBot.reviewFlow.appsMin", "waBot.reviewFlow.delivery", "waBot.reviewFlow.pickup", "waBot.reviewFlow.table", "waBot.reviewFlow.dinein", "waBot.reviewFlow.takeaway", "waBot.reviewFlow.apps",
      "waBot.reviewFlow.capDays", "waBot.reviewFlow.starsTemplate", "waBot.reviewFlow.smsVisits", "waBot.reviewFlow.googleRatedPolicy", "waBot.reviewFlow.googleRatedCooldownDays", "reviews.threshold", "reviews.askMaxAgeHours", "reviews.askAfterMinutes"],
    nodes: (v) => [
      node("t", "trigger", "الطلب اتسلّم", "توصيل · استلام · طاولة · فرع · تطبيقات", { paths: ["reviews.askAfterDelivery", "waBot.reviewFlow.delivery", "waBot.reviewFlow.pickup", "waBot.reviewFlow.table", "waBot.reviewFlow.dinein", "waBot.reviewFlow.takeaway", "waBot.reviewFlow.apps"] }),
      node("w", "wait", `توصيل بعد ${mins(v["waBot.reviewFlow.deliveryMin"])}`, `استلام ${mins(v["waBot.reviewFlow.pickupMin"])} · فرع ${mins(v["waBot.reviewFlow.dineinMin"])}`, { paths: ["waBot.reviewFlow.deliveryMin", "waBot.reviewFlow.pickupMin", "waBot.reviewFlow.tableMin", "waBot.reviewFlow.dineinMin", "waBot.reviewFlow.takeawayMin", "waBot.reviewFlow.appsMin"] }),
      node("c", "guard", "حرّاس", `مرة كل ${ar(v["waBot.reviewFlow.capDays"])} يوم · مش لو فيه شكوى أو تحويل مفتوح`, { paths: ["waBot.reviewFlow.capDays", "reviews.askMaxAgeHours"] }),
      node("s", "send", v["waBot.reviewFlow.enabled"] ? "قايمة نجوم على واتساب" : "رابط صفحة التقييم", v["waBot.reviewWhatsApp"] ? "واتساب أولاً ثم SMS" : "SMS", { channel: "wa", paths: ["waBot.reviewWhatsApp", "waBot.reviewFlow.enabled", "waBot.reviewFlow.starsTemplate", "waBot.reviewFlow.smsVisits"] }),
      node("b", "branch", `${ar(v["reviews.threshold"])}+ نجوم؟`, "نعم ⇒ زر جوجل · لا ⇒ اعتذار + تحويل عاجل للمدير", { paths: ["reviews.threshold", "waBot.reviewFlow.googleRatedPolicy", "waBot.reviewFlow.googleRatedCooldownDays"] }),
      node("g", "goal", "الهدف: تقييم", "وتقييم جوجل للراضيين"),
    ],
    caps: (v) => [["للعميل", `مرة كل ${ar(v["waBot.reviewFlow.capDays"])} يوم`], ["عمر الطلب", `لحد ${ar(v["reviews.askMaxAgeHours"])} ساعة`]],
    quiet: (v, x) => (x.sendHours.active ? waHoursTxt(x) : "ساعات هدوء التقييم من إعداداته"),
    when: (v) => [{ kind: "every", minutes: 5, label: `بعد التسليم بـ${mins(v["waBot.reviewFlow.deliveryMin"])} (توصيل)` }],
    status: (v, x) => (!v["reviews.askAfterDelivery"] ? { state: "off", why: "مقفول" } : v["waBot.reviewWhatsApp"] && botState(x) !== "live" ? { state: "partial", why: "شغّال بـSMS — واتساب مستني البوت «شغّال»" } : { state: "on", why: "شغّال" }),
    sources: ["/api/cms/reviews/stats?days=7"],
    metrics: (d) => { const r = d["/api/cms/reviews/stats?days=7"]; if (!r?.invites) return null; const i = r.invites; return [{ window: "7d", label: "آخر ٧ أيام", entered: (i.sent || 0) + (i.skipped || 0), sent: { wa: r.viaWhatsapp ?? null, total: i.sent }, converted: i.rated, extra: [["متوسط النجوم", i.avg != null ? ar(Number(i.avg).toFixed(1)) : "—"], ["راحوا جوجل", i.toGoogle], ["نسبة الرد", i.replyRate != null ? `${ar(Math.round(i.replyRate * (i.replyRate <= 1 ? 100 : 1)))}٪` : "—"]] }]; },
    health: (v, x) => [...(v["waBot.reviewFlow.starsTemplate"] ? tplWarn(x, ["fc_review_stars"]) : []), ...(!x.s.reviews?.googleUrl && !x.s.googlePlace ? [{ level: "info", text: "رابط جوجل مش متسجّل ⇒ الراضيين مش هيروحوا جوجل", link: "#store/grow/reviews" }] : [])],
    test: { kind: "inner", method: "POST", path: "/api/cms/reviews/invites/test", body: (phone) => ({ phone, channel: "wa", kind: "delivery" }), label: "طلب تقييم على واتساب (أرقام تجربة البوت بس)" },
  },
  {
    id: "loyalty", name: "مكافأة الولاء + SMS بالكود", icon: "🎁", cat: "customers", audience: "customers", source: "loyalty.js · cms.js", screen: "#store/customers/loyalty",
    desc: "كل N طلب من الموقع = كوبون مربوط بجوال العميل، وإشعار + SMS بالكود.",
    trigger: { type: "event", label: "العميل وصل لعدد الطلبات" }, channels: ["push", "sms"], switch: "cms.loyalty.enabled",
    fields: ["cms.loyalty.enabled", "cms.loyalty.every", "cms.loyalty.reward", "cms.loyalty.percent", "cms.loyalty.validDays", "cms.loyalty.minTotal", "cms.loyalty.smsEnabled"],
    nodes: (v) => [
      node("t", "trigger", `كل ${ar(v["cms.loyalty.every"])} طلب من الموقع`, "طلبات مدفوعة من بداية الولاء", { paths: ["cms.loyalty.enabled", "cms.loyalty.every"] }),
      node("r", "send", v["cms.loyalty.reward"] === "percent" ? `كوبون خصم ${ar(v["cms.loyalty.percent"])}٪` : "كوبون توصيل مجاني", `صالح ${ar(v["cms.loyalty.validDays"])} يوم · من ${ar(v["cms.loyalty.minTotal"])} ر.س`, { channel: "push", paths: ["cms.loyalty.reward", "cms.loyalty.percent", "cms.loyalty.validDays", "cms.loyalty.minTotal"] }),
      node("s", "send", "SMS بالكود", v["cms.loyalty.smsEnabled"] ? "رسالة واحدة (أقرب كوبون بيخلص)" : "مقفول", { channel: "sms", paths: ["cms.loyalty.smsEnabled"] }),
      node("g", "goal", "الهدف: يستخدم الكوبون", ""),
    ],
    caps: () => [["للعميل", "SMS واحدة لكل مجموعة مكافآت"]],
    quiet: (v, x) => quietSms(x),
    when: () => [{ kind: "every", minutes: 15, label: "بيحسب كل ربع ساعة" }],
    status: (v, x) => (!v["cms.loyalty.enabled"] ? { state: "off", why: "مقفول" } : v["cms.loyalty.smsEnabled"] && !x.camp.smsEnabled ? { state: "partial", why: "الكوبون والإشعار شغّالين — SMS التسويقي مقفول" } : { state: "on", why: "شغّال" }),
    sources: ["/api/cms/loyalty"],
    metrics: (d) => { const st = d["/api/cms/loyalty"]?.stats; if (!st) return null; return [{ window: "all", label: "من البداية", entered: st.members, sent: { sms: st.sms?.sent }, converted: st.rewardsUsed, cost: st.sms?.cost, skipped: st.sms?.skipped ? { skipped: st.sms.skipped } : {}, extra: [["مكافآت اتعملت", st.rewardsIssued], ["قربوا", st.eligibleSoon], ["ضغطات الرابط", st.sms?.clicks]] }]; },
    health: (v, x) => (v["cms.loyalty.enabled"] && x.camp.brake ? [{ level: "warn", text: "فرملة الإيقاف مشدودة ⇒ SMS الولاء واقف", path: "cms.campaigns.smsEnabled" }] : []),
    test: null,
  },
  {
    id: "windowKeeper", name: "حارس النافذة (رسالة قبل ما تقفل)", icon: "⏳", cat: "customers", audience: "customers", source: "wabotrun.js (SB4)", screen: "#store/wa/journey",
    desc: "قبل ما نافذة الـ٢٤ ساعة تقفل: رسالة حرة واحدة لو فيه سبب مفيد (طلب شغّال، مكافأة بتخلص، سلة).",
    trigger: { type: "event", label: `بعد ساعات من آخر رسالة للعميل` }, channels: ["wa"], switch: "waBot.windowKeeper",
    fields: ["waBot.windowKeeper", "waBot.windowKeeperHour", "waBot.windowKeeperDailyCap", "waBot.windowKeeperWeekly", "waBot.windowKeeperQuietStart", "waBot.windowKeeperQuietEnd"],
    nodes: (v) => [
      node("t", "trigger", "العميل كلّمنا", "نافذة ٢٤ ساعة اتفتحت"),
      node("w", "wait", `استنى ${ar(v["waBot.windowKeeperHour"])} ساعة`, "من آخر رسالة منه", { paths: ["waBot.windowKeeperHour"] }),
      node("b", "branch", "فيه حاجة مفيدة؟", "طلب شغّال / مكافأة / سلة — غير كده مفيش"),
      node("s", "send", "رسالة حرة ببلاش", "مرة في النافذة", { channel: "wa", paths: ["waBot.windowKeeper"] }),
      node("cap", "guard", `${ar(v["waBot.windowKeeperDailyCap"])} في اليوم · ${ar(v["waBot.windowKeeperWeekly"])} للعميل في الأسبوع`, "", { paths: ["waBot.windowKeeperDailyCap", "waBot.windowKeeperWeekly", "waBot.windowKeeperQuietStart", "waBot.windowKeeperQuietEnd"] }),
    ],
    caps: (v) => [["في اليوم", ar(v["waBot.windowKeeperDailyCap"])], ["للعميل/أسبوع", ar(v["waBot.windowKeeperWeekly"])]],
    quiet: (v, x) => (x.sendHours.active ? waHoursTxt(x) : `هدوء من ${hh(v["waBot.windowKeeperQuietStart"])} لـ${hh(v["waBot.windowKeeperQuietEnd"])}`),
    when: (v) => [windowDaily(hh(v["waBot.windowKeeperQuietEnd"]), hh(v["waBot.windowKeeperQuietStart"]), "خارج الهدوء")],
    status: (v, x) => botFlowStatus(v["waBot.windowKeeper"] && Number(v["waBot.windowKeeperDailyCap"]) > 0, x),
    health: (v, x) => (waBlock(x) ? [{ level: "warn", text: waBlock(x) }] : []),
    test: null,
  },
  {
    id: "replyFollow", name: "متابعة اللي ردّ وماطلبش (FU1)", icon: "💬", cat: "customers", audience: "customers", source: "wafollow.js · wabotrun.js", screen: "#store/wa/journey",
    desc: "عميل ردّ على حملة أو ضغط زر وسكت ⇒ رسالة حرة واحدة ببلاش بعد السكوت: سطرين + «أبغى أطلب / لا شكراً».",
    trigger: { type: "event", label: "رد على حملة أو ضغط زر وسكت" }, channels: ["wa"], switch: "waBot.replyFollowUp",
    fields: ["waBot.replyFollowUp", "waBot.replyFollowUpMin", "waBot.replyFollowUpOffer", "waBot.replyFollowUpLooked", "waBot.replyFollowUpFav", "waBot.replyFollowUpFromHour", "waBot.replyFollowUpToHour",
      "waBot.replyFollowUpDailyCap", "waBot.replyFollowUpDeclineDays", "waBot.replyFollowUpIgnoredMax", "waBot.replyFollowUpIgnoredDays", "waBot.replyFollowUpBrakePct"],
    nodes: (v) => [
      node("t", "trigger", "رد/ضغط وسكت", "حملة أو زر منيو/صنف/بوكس", { paths: ["waBot.replyFollowUp", "waBot.replyFollowUpOffer", "waBot.replyFollowUpLooked", "waBot.replyFollowUpFav"] }),
      node("w", "wait", `سكوت ${mins(v["waBot.replyFollowUpMin"])}`, `في الساعات من ${ar(v["waBot.replyFollowUpFromHour"])} لـ${ar(v["waBot.replyFollowUpToHour"])}`, { paths: ["waBot.replyFollowUpMin", "waBot.replyFollowUpFromHour", "waBot.replyFollowUpToHour"] }),
      node("b", "branch", "طلب / قال لا / اشتكى؟", "نعم ⇒ مفيش متابعة", { paths: ["waBot.replyFollowUpDeclineDays", "waBot.replyFollowUpIgnoredMax", "waBot.replyFollowUpIgnoredDays"] }),
      node("s", "send", "رسالة حرة + زرّين", "«أبغى أطلب» / «لا شكراً»", { channel: "wa" }),
      node("g", "goal", "الهدف: طلب خلال ٢٤ ساعة", ""),
      node("cap", "guard", `${ar(v["waBot.replyFollowUpDailyCap"])} في اليوم · فرملة ${ar(v["waBot.replyFollowUpBrakePct"])}٪ إيقاف`, "", { paths: ["waBot.replyFollowUpDailyCap", "waBot.replyFollowUpBrakePct"] }),
    ],
    caps: (v) => [["في اليوم", ar(v["waBot.replyFollowUpDailyCap"])], ["فرملة", `${ar(v["waBot.replyFollowUpBrakePct"])}٪ إيقافات`]],
    quiet: (v, x) => (x.sendHours.active ? waHoursTxt(x) : `من ${ar(v["waBot.replyFollowUpFromHour"])}:٠٠ لـ${ar(v["waBot.replyFollowUpToHour"])}:٣٠`),
    when: (v) => [windowDaily(hh(v["waBot.replyFollowUpFromHour"]), hh(v["waBot.replyFollowUpToHour"]), "الساعات المسموحة")],
    status: (v, x) => botFlowStatus(v["waBot.replyFollowUp"], x),
    sources: ["/api/cms/wabot/followups"],
    metrics: (d) => { const t = d["/api/cms/wabot/followups"]?.totals; if (!t) return null; return [{ window: "today", label: "النهارده", sent: { wa: t.sent }, converted: t.paid_orders, revenue: Math.round(t.paid_sar || 0), extra: [["ردّوا", t.replied], ["قالوا أيوه", t.said_yes], ["قالوا لا", t.said_no], ["وقّفوا", t.stopped]] }]; },
    health: (v, x, d) => [...(d["/api/cms/wabot/followups"]?.brake?.on || d["/api/cms/wabot/followups"]?.brake?.active ? [{ level: "error", text: "فرملة المتابعة مشدودة (إيقافات كتير) ⇒ المتابعة واقفة لحد ما المالك يفكّها", link: "#store/wa/journey" }] : []), ...(waBlock(x) ? [{ level: "warn", text: waBlock(x) }] : [])],
    test: null,
  },
  {
    id: "leadFollow", name: "متابعة المحادثة اللي ماخدتش رد + «أنا معك»", icon: "🙋", cat: "customers", audience: "customers", source: "wabotrun.js (EX6) · waassistrun.js (PK1)", screen: "#store/wa/ai",
    desc: "عميل كتب وماخدش رد مفيد ومحدش من الفريق رد ⇒ متابعة واحدة. والمساعد بيبعت «أنا معك» لو العميل سكت في نص الطلب.",
    trigger: { type: "event", label: "رسالة عميل من غير رد مفيد" }, channels: ["wa"], switch: null,
    fields: ["waBot.leadFollowUpMin", "waBot.assist.nudgeMin", "waBot.assist.followUpCloseGuardMin"],
    nodes: (v) => [
      node("t", "trigger", "كتب وماخدش رد مفيد", "البوت سكت / بره النطاق / «ما فهمت»"),
      node("w", "wait", Number(v["waBot.leadFollowUpMin"]) ? `استنى ${mins(v["waBot.leadFollowUpMin"])}` : "مقفول", "", { paths: ["waBot.leadFollowUpMin"] }),
      node("s", "send", "متابعة واحدة في اليوم", "مش بعد إيقاف أو شكوى أو والمطعم مقفل", { channel: "wa" }),
      node("w2", "wait", Number(v["waBot.assist.nudgeMin"]) ? `«أنا معك» بعد ${mins(v["waBot.assist.nudgeMin"])}` : "«أنا معك» مقفول", "لو سكت في نص الطلب مع المساعد", { paths: ["waBot.assist.nudgeMin", "waBot.assist.followUpCloseGuardMin"] }),
    ],
    caps: () => [["للمحادثة", "مرة في اليوم"]],
    quiet: (v, x) => waHoursTxt(x),
    when: () => [{ kind: "always", label: "طول ما المطعم فاتح" }],
    status: (v, x) => botFlowStatus(Number(v["waBot.leadFollowUpMin"]) > 0 || Number(v["waBot.assist.nudgeMin"]) > 0, x),
    health: () => [], test: null,
  },
  {
    id: "paidNote", name: "تأكيد الطلب جوّه المحادثة", icon: "✅", cat: "service", audience: "customers", source: "wabotrun.js", screen: "#store/wa/journey",
    desc: "العميل اللي كلّم البوت وطلب من الموقع ⇒ تأكيد قصير في نفس المحادثة (مرة واحدة).",
    trigger: { type: "event", label: "طلب مدفوع من رقم كلّم البوت آخر ٢٤ ساعة" }, channels: ["wa"], switch: "waBot.paidNoteEnabled",
    fields: ["waBot.paidNoteEnabled", "waBot.paidNoteDedupeMin"],
    nodes: (v) => [node("t", "trigger", "طلب مدفوع", "والرقم كلّم البوت آخر ٢٤ ساعة"), node("s", "send", "تأكيد ببلاش", `مرة واحدة (مفيش تكرار خلال ${mins(v["waBot.paidNoteDedupeMin"])})`, { channel: "wa", paths: ["waBot.paidNoteEnabled", "waBot.paidNoteDedupeMin"] })],
    caps: () => [["للطلب", "مرة واحدة"]], quiet: () => "رسالة خدمية — مابتستناش الهدوء", when: () => [{ kind: "always", label: "مع كل طلب" }],
    status: (v, x) => botFlowStatus(v["waBot.paidNoteEnabled"], x), health: () => [], test: null,
  },
  {
    id: "orderStages", name: "رسايل مراحل الطلب", icon: "🛵", cat: "service", audience: "customers", source: "notify.js · whatsapp.js · wapolicy.js", screen: "#store/wa/settings",
    desc: "استلمنا ← بنجهز ← مع المندوب ← اتوصل: إشعار + واتساب (ببلاش والنافذة مفتوحة) أو SMS للمراحل المختارة.",
    trigger: { type: "event", label: "حالة الطلب اتغيّرت" }, channels: ["push", "wa", "sms"], switch: null,
    fields: ["notifications.whatsappEnabled", "notifications.smsEnabled", "notifications.pushEnabled", "notifications.whatsappStages", "waBot.windowFreeUpdates", "waBot.closedPolicy", "waBot.closedSkipPreparing", "waBot.mergeDeliveredReview", "waBot.courierTemplate", "waBot.orderMsgCap"],
    nodes: (v) => [
      node("t", "trigger", "الحالة اتغيّرت", "استلمنا · بنجهز · مع المندوب · جاهز · اتوصل"),
      node("s1", "send", "إشعار", onOff(v["notifications.pushEnabled"] !== false), { channel: "push", paths: ["notifications.pushEnabled"] }),
      node("b", "branch", "النافذة مفتوحة؟", v["waBot.windowFreeUpdates"] ? "نعم ⇒ رسالة حرة ببلاش" : "القالب دايماً", { paths: ["waBot.windowFreeUpdates", "waBot.closedPolicy", "waBot.closedSkipPreparing", "waBot.mergeDeliveredReview"] }),
      node("s2", "send", "واتساب", v["notifications.whatsappEnabled"] ? `${ar((v["notifications.whatsappStages"] || []).length)} مرحلة` : "مقفول", { channel: "wa", paths: ["notifications.whatsappEnabled", "notifications.whatsappStages", "waBot.courierTemplate"] }),
      node("s3", "send", "SMS", v["notifications.smsEnabled"] ? "للمراحل المختارة لو واتساب ماغطّاش" : "مقفول", { channel: "sms", paths: ["notifications.smsEnabled"] }),
      node("cap", "guard", `بالكتير ${ar(v["waBot.orderMsgCap"])} رسالة واتساب للطلب`, "", { paths: ["waBot.orderMsgCap"] }),
    ],
    caps: (v) => [["للطلب", `${ar(v["waBot.orderMsgCap"])} رسايل واتساب`]], quiet: () => "خدمية — في أي وقت", when: () => [{ kind: "always", label: "مع كل تغيير حالة" }],
    status: (v, x) => (v["notifications.whatsappEnabled"] && x.master ? { state: "on", why: "إشعار + واتساب" } : v["notifications.whatsappEnabled"] ? { state: "partial", why: "واتساب مستني المفتاح الرئيسي" } : { state: "partial", why: "إشعار و/أو SMS بس" }),
    sources: ["/api/cms/wa-cloud/checklist"],
    health: (v, x, d) => (d["/api/cms/wa-cloud/checklist"]?.stages || []).filter((r) => r.enabled && r.metaStatus && r.metaStatus !== "APPROVED").map((r) => ({ level: "warn", text: `مرحلة «${r.label || r.stage}»: القالب ${r.template} حالته ${r.metaStatus}`, link: "#store/wa/templates" })),
    test: null,
  },
  {
    id: "utilityFirst", name: "الخدمي أولاً + بدائل القوالب (UT1/UT2)", icon: "💸", cat: "rules", audience: "none", source: "wautility-cfg.js · warewrite.js", screen: "#store/wa/templates",
    desc: "مفيش سعر تسويق على رسالة خدمية: قالب ميتا صنّفته تسويق ⇒ رسالة حرة أو قالب خدمي معتمد أو SMS. والقوالب القديمة بتتبدّل بالجديدة أول ما تتعتمد.",
    trigger: { type: "rule", label: "قبل أي قالب يطلع" }, channels: ["wa"], switch: null,
    fields: ["waBot.utilityFirst.staff", "waBot.utilityFirst.customers", "waBot.utilityFirst.reviewStarsAsMarketing", "waBot.utilityFirst.rewriteReviewStars", "waBot.utilityFirst.rewriteInboxSummary", "waBot.utilityFirst.rewriteTaskNotice", "waBot.utilityFirst.rewriteCheckoutWatchdog", "waBot.utilityFirst.rewriteWaitlistOpen"],
    nodes: (v) => [node("t", "trigger", "قالب هيطلع", "فريق أو عميل"), node("b", "branch", "ميتا صنّفته تسويق؟", "نعم ⇒ حر / قالب خدمي / SMS", { paths: ["waBot.utilityFirst.staff", "waBot.utilityFirst.customers", "waBot.utilityFirst.reviewStarsAsMarketing"] }),
      node("r", "guard", "بدائل القوالب", "القديم ⇒ الجديد لما يتعتمد", { paths: ["waBot.utilityFirst.rewriteReviewStars", "waBot.utilityFirst.rewriteInboxSummary", "waBot.utilityFirst.rewriteTaskNotice", "waBot.utilityFirst.rewriteCheckoutWatchdog", "waBot.utilityFirst.rewriteWaitlistOpen"] })],
    caps: () => [], quiet: () => "", when: () => [{ kind: "always", label: "على كل قالب" }],
    status: (v) => (v["waBot.utilityFirst.staff"] && v["waBot.utilityFirst.customers"] ? { state: "on", why: "الفريق والعملاء" } : v["waBot.utilityFirst.staff"] || v["waBot.utilityFirst.customers"] ? { state: "partial", why: "جزء بس" } : { state: "off", why: "مقفول" }),
    sources: ["/api/cms/wa-cloud/utility-rewrites"],
    health: (v, x, d) => (d["/api/cms/wa-cloud/utility-rewrites"]?.rows || []).filter((r) => r.switchOn && r.wired && r.newStatus && r.newStatus !== "APPROVED").map((r) => ({ level: "info", text: `البديل ${r.new} لسه ${r.newStatus} ⇒ القديم ${r.old} شغّال`, link: "#store/wa/templates" })),
    test: null,
  },
  {
    id: "journeyBursts", name: "مفيش رسايل ورا بعض (CJ1a)", icon: "🧭", cat: "rules", audience: "none", source: "wajourney.js", screen: "#store/wa/journey",
    desc: "بعد أي رسالة للعميل، الرسايل المبادِرة بتستنى بدل ما تيجي ورا بعض، وتأكيد الطلب مرة واحدة، وسقف لرسايل الطلب.",
    trigger: { type: "rule", label: "قبل أي رسالة مبادِرة" }, channels: ["wa", "sms"], switch: "waBot.journeyBursts",
    fields: ["waBot.journeyBursts", "waBot.burstHoldMin", "waBot.burstHoldMaxMin", "waBot.paidNoteDedupeMin", "waBot.courierSmsWaMin", "waBot.orderMsgCap", "waBot.orderMsgTail"],
    nodes: (v) => [node("t", "trigger", "رسالة مبادِرة جاية", "حملة · متابعة · حارس النافذة · تقييم · SMS السلة"),
      node("w", "wait", `استنى ${mins(v["waBot.burstHoldMin"])} بعد آخر رسالة`, `ولو طوّلت ${mins(v["waBot.burstHoldMaxMin"])} ⇒ تتلغي`, { paths: ["waBot.burstHoldMin", "waBot.burstHoldMaxMin"] }),
      node("c", "guard", `سقف الطلب ${ar(v["waBot.orderMsgCap"])} رسايل`, `${ar(v["waBot.orderMsgTail"])} محجوزين للمراحل المهمة`, { paths: ["waBot.orderMsgCap", "waBot.orderMsgTail", "waBot.paidNoteDedupeMin", "waBot.courierSmsWaMin"] })],
    caps: (v) => [["انتظار", mins(v["waBot.burstHoldMin"])], ["رسايل الطلب", ar(v["waBot.orderMsgCap"])]], quiet: () => "", when: () => [{ kind: "always", label: "على كل رسالة مبادِرة" }],
    status: (v) => (v["waBot.journeyBursts"] ? { state: "on", why: "شغّال" } : { state: "off", why: "مقفول" }), health: () => [], test: null,
  },
  {
    id: "habit", name: "الإرسال على عادة العميل (CJ1b)", icon: "🕰", cat: "rules", audience: "none", source: "wahabit.js · wasender.js", screen: "#store/wa/journey",
    desc: "كل مستلم في حملة واتساب ياخد رسالته قبل الساعة اللي متعوّد يطلب فيها بدل ما الحملة كلها تطلع مرة واحدة.",
    trigger: { type: "rule", label: "حملة واتساب مجدولة" }, channels: ["wa"], switch: "waSender.byHabit.enabled",
    fields: ["waSender.byHabit.enabled", "waSender.byHabit.leadMin", "waSender.byHabit.fromHour", "waSender.byHabit.nightCutoffHour", "waSender.byHabit.fallbackHour", "waSender.byHabit.spreadQuiet", "waSender.byHabit.maxPerHour"],
    nodes: (v) => [node("t", "trigger", "حملة اتجدولت", ""), node("w", "wait", `قبل ساعته بـ${mins(v["waSender.byHabit.leadMin"])}`, `من ${ar(v["waSender.byHabit.fromHour"])} لحد ${ar(v["waSender.byHabit.nightCutoffHour"])} · من غير ساعة ⇒ ${ar(v["waSender.byHabit.fallbackHour"])}`, { paths: ["waSender.byHabit.leadMin", "waSender.byHabit.fromHour", "waSender.byHabit.nightCutoffHour", "waSender.byHabit.fallbackHour", "waSender.byHabit.spreadQuiet", "waSender.byHabit.maxPerHour"] })],
    caps: () => [], quiet: (v, x) => waHoursTxt(x), when: (v) => [windowDaily(hh(v["waSender.byHabit.fromHour"]), hh(v["waSender.byHabit.nightCutoffHour"]), "توزيع الحملة")],
    status: (v) => (v["waSender.byHabit.enabled"] ? { state: "on", why: "شغّال" } : { state: "off", why: "مقفول (الحملة بتطلع دفعة واحدة)" }), health: () => [], test: null,
  },
  {
    id: "campaignRules", name: "قواعد الـSMS والحملات (الهدوء والفاصل والسقف والفرملة)", icon: "🛡", cat: "rules", audience: "none", source: "cms.js · smsrules.js", screen: "#store/grow/campaigns",
    desc: "المصدر الواحد لساعات الهدوء، الفاصل بين الرسايل، سقف العميل في الأسبوع/الشهر، السقف اليومي، الميزانية، وفرملة ٥٪ إيقافات.",
    trigger: { type: "rule", label: "قبل أي SMS أو إشعار تسويقي" }, channels: ["sms", "push"], switch: "cms.campaigns.smsEnabled",
    fields: ["cms.campaigns.smsEnabled", "cms.campaigns.dailySmsCap", "cms.campaigns.quietStart", "cms.campaigns.quietEnd", "cms.campaigns.flowGapDays", "cms.campaigns.pushGapDays", "cms.campaigns.maxPerWeek", "cms.campaigns.maxPerMonth", "cms.campaigns.budgetSar"],
    nodes: (v, x) => [node("t", "trigger", "رسالة تسويقية جاية", "حملة · أتمتة · سلة · ولاء"),
      node("q", "guard", `هدوء من ${hh(v["cms.campaigns.quietStart"])} لـ${hh(v["cms.campaigns.quietEnd"])}`, "", { paths: ["cms.campaigns.quietStart", "cms.campaigns.quietEnd"] }),
      node("g", "guard", `فاصل ${ar(v["cms.campaigns.flowGapDays"])} يوم للأتمتة`, `بالكتير ${ar(v["cms.campaigns.maxPerWeek"])}/أسبوع · ${ar(v["cms.campaigns.maxPerMonth"])}/شهر`, { paths: ["cms.campaigns.flowGapDays", "cms.campaigns.pushGapDays", "cms.campaigns.maxPerWeek", "cms.campaigns.maxPerMonth"] }),
      node("c", "guard", `السقف اليومي ${ar(v["cms.campaigns.dailySmsCap"])} جزء`, Number(v["cms.campaigns.budgetSar"]) ? `ميزانية ${ar(v["cms.campaigns.budgetSar"])} ر.س` : "من غير ميزانية", { paths: ["cms.campaigns.dailySmsCap", "cms.campaigns.budgetSar", "cms.campaigns.smsEnabled"] }),
      node("b", "guard", x.camp.brake ? "🛑 الفرملة مشدودة" : "فرملة ٥٪ إيقافات", "≥٢٠ رسالة و٥٪ وقّفوا خلال ٣٠ د ⇒ كله يقف")],
    caps: (v) => [["يومي", `${ar(v["cms.campaigns.dailySmsCap"])} جزء`], ["العميل/أسبوع", ar(v["cms.campaigns.maxPerWeek"])]], quiet: (v) => `من ${hh(v["cms.campaigns.quietStart"])} لـ${hh(v["cms.campaigns.quietEnd"])}`,
    when: (v) => [windowDaily(hh(v["cms.campaigns.quietEnd"]), hh(v["cms.campaigns.quietStart"]), "مسموح SMS وإشعارات")],
    status: (v, x) => (x.camp.brake ? { state: "error", why: "فرملة الإيقاف مشدودة — كل SMS تسويقي واقف" } : v["cms.campaigns.smsEnabled"] ? { state: "on", why: "SMS التسويقي شغّال" } : { state: "off", why: "SMS التسويقي مقفول (الإشعارات شغّالة)" }),
    health: (v, x) => [...(x.camp.brake ? [{ level: "error", text: `فرملة الإيقاف اتشدّت ${x.camp.brake.at ? `(${String(x.camp.brake.at).slice(0, 16).replace("T", " ")})` : ""} — فكّها من «الحملات» بعد ما تشوف السبب`, link: "#store/grow/campaigns" }] : [])],
    test: null,
  },
  {
    id: "waCampaignRules", name: "سقوف وفرامل حملات واتساب", icon: "🚦", cat: "rules", audience: "none", source: "wacloud.js · waquality.js · wasender.js", screen: "#store/wa/campaigns",
    desc: "سقف اليوم والساعة والصرف، فرملة الإيقافات والفشل، وسقف العميل (حملة في الأسبوع).",
    trigger: { type: "rule", label: "كل دفعة حملة واتساب" }, channels: ["wa"], switch: "waCloud.enabled",
    fields: ["waCloud.enabled", "waCloud.dailyCap", "waCloud.hourCap", "waCloud.spendDaySar", "waCloud.brakeStopPct", "waCloud.brakeFailPct", "waCloud.custCap7d", "waCloud.custCap30d"],
    nodes: (v) => [node("t", "trigger", "دفعة حملة", ""), node("c", "guard", `${ar(v["waCloud.dailyCap"])}/يوم · ${ar(v["waCloud.hourCap"])}/ساعة`, `صرف ${ar(v["waCloud.spendDaySar"])} ر.س/يوم`, { paths: ["waCloud.dailyCap", "waCloud.hourCap", "waCloud.spendDaySar"] }),
      node("b", "guard", `فرملة ${ar(v["waCloud.brakeStopPct"])}٪ إيقاف · ${ar(v["waCloud.brakeFailPct"])}٪ فشل`, "", { paths: ["waCloud.brakeStopPct", "waCloud.brakeFailPct"] }),
      node("u", "guard", `العميل: ${ar(v["waCloud.custCap7d"])} في ٧ أيام · ${ar(v["waCloud.custCap30d"])} في ٣٠`, "", { paths: ["waCloud.custCap7d", "waCloud.custCap30d"] })],
    caps: (v) => [["يومي", ar(v["waCloud.dailyCap"])], ["صرف", `${ar(v["waCloud.spendDaySar"])} ر.س`]], quiet: (v, x) => waHoursTxt(x), when: () => [{ kind: "always", label: "على كل حملة" }],
    status: (v, x) => (!v["waCloud.enabled"] ? { state: "off", why: "حملات واتساب مقفولة" } : waBlock(x) ? { state: "dormant", why: waBlock(x) } : { state: "on", why: "شغّالة" }), health: () => [], test: null,
  },
  {
    id: "sendHours", name: "مواعيد الإرسال الآلي (بمواعيد المطعم)", icon: "🕐", cat: "rules", audience: "none", source: "sendhours.js", screen: "#store/wa/settings",
    desc: "واتساب الآلي (حملات، متابعات، تقييم، سلة، حارس النافذة) بيطلع بس والمطعم فاتح، ويقف قبل القفل بشوية.",
    trigger: { type: "rule", label: "قبل أي واتساب آلي" }, channels: ["wa"], switch: "waSendHours.enabled",
    fields: ["waSendHours.enabled", "waSendHours.stopBeforeCloseMin"],
    nodes: (v) => [node("t", "trigger", "واتساب آلي جاي", ""), node("c", "guard", "المطعم فاتح؟", `ويقف قبل القفل بـ${mins(v["waSendHours.stopBeforeCloseMin"])}`, { paths: ["waSendHours.enabled", "waSendHours.stopBeforeCloseMin"] })],
    caps: () => [], quiet: () => "", when: (v, x) => [{ kind: "points", at: openingsNext(x.s, x.now), label: "فتح" }],
    status: (v, x) => (!v["waSendHours.enabled"] ? { state: "off", why: "مقفول (كل مسار بساعاته القديمة)" } : x.sendHours.active ? { state: "on", why: isRestaurantOpenAt(x.now, x.s) ? "المطعم فاتح دلوقتي" : "المطعم مقفول دلوقتي ⇒ واتساب الآلي مستني" } : { state: "partial", why: "مواعيد المطعم مش متعرّفة" }),
    health: (v, x) => (v["waSendHours.enabled"] && !x.sendHours.active ? [{ level: "warn", text: "مواعيد المطعم مش متعرّفة ⇒ المسارات راجعة لساعاتها القديمة" }] : []), test: null,
  },
  /* ─────────────── 📟 الفريق ─────────────── */
  {
    id: "ackEscalation", name: "طلب جديد ماتشافش ⇒ تصعيد", icon: "🔔", cat: "team", audience: "staff", source: "ackescalate.js", screen: "#store/ops/courier",
    desc: "طلب مدفوع محدش ضغط «شفته» ولا قبله: إشعار بوابة تاني ⇒ واتساب للكاشير والمدير ⇒ SMS للمدير والمالك.",
    trigger: { type: "event", label: "طلب مدفوع لسه ماتشافش" }, channels: ["portal", "wa", "sms"], switch: "delivery.ackEscalation.enabled",
    fields: ["delivery.ackEscalation.enabled", "delivery.ackEscalation.escalateAfterSec", "delivery.ackEscalation.step2AfterSec", "delivery.ackEscalation.step3AfterSec", "delivery.ackEscalation.step2Cashier",
      "delivery.ackEscalation.step2Manager", "delivery.ackEscalation.step3Manager", "delivery.ackEscalation.step3Owner", "delivery.ackEscalation.step3AlertPhones", "delivery.ackEscalation.quietWhenClosed", "delivery.ackEscalation.maxAgeMin"],
    nodes: (v) => [
      node("t", "trigger", "طلب مدفوع", "محدش ضغط «شفته» ولا اتقبل", { paths: ["delivery.ackEscalation.enabled", "delivery.ackEscalation.maxAgeMin", "delivery.ackEscalation.quietWhenClosed"] }),
      node("w1", "wait", `${ar(v["delivery.ackEscalation.escalateAfterSec"])} ث`, "", { paths: ["delivery.ackEscalation.escalateAfterSec"] }),
      node("s1", "send", "إشعار البوابة تاني", "بيرنّ على كل الأجهزة", { channel: "portal" }),
      node("w2", "wait", `${ar(v["delivery.ackEscalation.step2AfterSec"])} ث`, "", { paths: ["delivery.ackEscalation.step2AfterSec"] }),
      node("s2", "send", "واتساب", [v["delivery.ackEscalation.step2Cashier"] && "الكاشير", v["delivery.ackEscalation.step2Manager"] && "المدير"].filter(Boolean).join(" + ") || "—", { channel: "wa", paths: ["delivery.ackEscalation.step2Cashier", "delivery.ackEscalation.step2Manager"] }),
      node("w3", "wait", `${ar(v["delivery.ackEscalation.step3AfterSec"])} ث`, "", { paths: ["delivery.ackEscalation.step3AfterSec"] }),
      node("s3", "send", "SMS", [v["delivery.ackEscalation.step3Manager"] && "المدير", v["delivery.ackEscalation.step3Owner"] && "المالك", v["delivery.ackEscalation.step3AlertPhones"] && "أرقام الإنذار"].filter(Boolean).join(" + ") || "—", { channel: "sms", paths: ["delivery.ackEscalation.step3Manager", "delivery.ackEscalation.step3Owner", "delivery.ackEscalation.step3AlertPhones"] }),
      node("g", "goal", "بيقف أول ما", "حد يشوفه / يتقبل / يتلغي"),
    ],
    caps: (v) => [["عمر الطلب", `${ar(v["delivery.ackEscalation.maxAgeMin"])} د`]], quiet: (v) => (v["delivery.ackEscalation.quietWhenClosed"] ? "ساكت والمطعم مقفول" : "في أي وقت"),
    when: () => [{ kind: "always", label: "مع كل طلب مدفوع" }],
    status: (v) => (v["delivery.ackEscalation.enabled"] ? { state: "on", why: "شغّال" } : { state: "off", why: "مقفول" }),
    sources: ["/api/cms/ack-escalations"],
    metrics: (d) => { const st = d["/api/cms/ack-escalations"]?.stats; if (!st) return null; return [{ window: "boot", label: "من آخر تشغيل للسيرفر", sent: { portal: st.steps?.["1"] ?? st.steps?.[1], wa: st.steps?.["2"] ?? st.steps?.[2], sms: st.steps?.["3"] ?? st.steps?.[3] }, extra: [["وقفات (اتشاف/اتقبل)", st.stops], ["أخطاء", st.errors]] }]; },
    log: (d) => (d["/api/cms/ack-escalations"]?.rows || []).slice(0, 20).map((r) => ({ at: r.started_at || r.paid_at, text: `${r.order_no} · خطوة ${ar(r.step || 0)}${r.stop_reason ? ` · وقف: ${r.stop_reason}` : ""}` })),
    health: () => [], test: null,
  },
  {
    id: "staffAlerts", name: "رسايل الإدارة (طلب جديد + تأخير التشغيل)", icon: "📟", cat: "team", audience: "staff", source: "staffalerts.js · shop.js · staffcontrol.js", screen: "#store/ops/staffsms",
    desc: "SMS للإدارة مع كل طلب أونلاين، وإنذار لما الطلب يتأخر في القبول/التحضير/التسليم، ومفاتيح كتم لكل نوع.",
    trigger: { type: "event", label: "طلب جديد / تأخير / مشكلة ربط" }, channels: ["sms"], switch: "delivery.newOrderSms",
    fields: ["delivery.newOrderSms", "delivery.prepBreachSms", "delivery.sla.acceptMinutes", "delivery.sla.acceptBreachMinutes", "delivery.sla.prepMinutes", "delivery.sla.prepBreachMinutes", "delivery.sla.deliverMinutes", "delivery.sla.deliverBreachMinutes",
      ...ALERT_TYPES.map((t) => `staffAlerts.types.${t.id}.enabled`)],
    nodes: (v) => [node("t", "trigger", "طلب أونلاين / مشكلة", "كل ~٢ دقيقة بيراجع المواعيد"),
      node("s1", "send", "رسالة طلب جديد", onOff(v["delivery.newOrderSms"]), { channel: "sms", paths: ["delivery.newOrderSms", "staffAlerts.types.new_order.enabled"] }),
      node("w", "wait", `القبول ${ar(v["delivery.sla.acceptMinutes"])}/${ar(v["delivery.sla.acceptBreachMinutes"])} د`, `التحضير ${ar(v["delivery.sla.prepMinutes"])}/${ar(v["delivery.sla.prepBreachMinutes"])} · التوصيل ${ar(v["delivery.sla.deliverMinutes"])}/${ar(v["delivery.sla.deliverBreachMinutes"])}`, { paths: ["delivery.sla.acceptMinutes", "delivery.sla.acceptBreachMinutes", "delivery.sla.prepMinutes", "delivery.sla.prepBreachMinutes", "delivery.sla.deliverMinutes", "delivery.sla.deliverBreachMinutes"] }),
      node("s2", "send", "إنذار التأخير", "SMS للإدارة (المستوى ٢+)", { channel: "sms", paths: ["delivery.prepBreachSms", "staffAlerts.types.sla.enabled"] }),
      node("m", "guard", "مفاتيح الكتم لكل نوع", `${ar(ALERT_TYPES.length)} نوع`, { paths: ALERT_TYPES.map((t) => `staffAlerts.types.${t.id}.enabled`) })],
    caps: () => [["كل إنذار", "مرة لكل طلب ومستوى"]], quiet: () => "في أي وقت", when: () => [{ kind: "always", label: "مع كل طلب" }],
    status: (v) => { const off = ALERT_TYPES.filter((t) => v[`staffAlerts.types.${t.id}.enabled`] === false).length; return off ? { state: "partial", why: `${ar(off)} نوع مكتوم` } : { state: "on", why: "كل الأنواع شغّالة" }; },
    sources: ["/api/cms/staff-alerts?days=7"],
    metrics: (d) => { const t = d["/api/cms/staff-alerts?days=7"]?.totals; if (!t) return null; return [{ window: "7d", label: "آخر ٧ أيام", sent: { sms: t.n }, cost: t.cost, skipped: t.suppressed ? { muted: t.suppressed } : {}, extra: [["في اليوم", t.perDay != null ? ar(Math.round(t.perDay)) : "—"], ["الشهر بالمعدل ده", t.monthly != null ? `${ar(Math.round(t.monthly))} ر.س` : "—"]] }]; },
    health: (v, x) => ((x.s.delivery?.alertPhones || []).length ? [] : [{ level: "error", text: "مفيش أرقام إنذار ⇒ الإنذارات الحرجة مش هتوصل حد", link: "#store/ops/courier" }]),
    test: { kind: "inner", method: "POST", path: "/api/shop/staff-sms/test", body: () => ({}), label: "رسالة تجربة لأرقام الإدارة" },
  },
  {
    id: "courierOps", name: "المندوب: تأخير / رفض / مشوار بعيد", icon: "🛵", cat: "team", audience: "staff", source: "courierops.js", screen: "#store/ops/courier",
    desc: "كل دقيقة: تأخير التعيين أو الوصول أو التوصيل ⇒ SMS للإدارة، ورفض/إلغاء المندوب، وحارس المشوار البعيد.",
    trigger: { type: "event", label: "شحنة مندوب اتأخرت أو اترفضت" }, channels: ["sms"], switch: "delivery.courierSla.alertStaff",
    fields: ["delivery.courierSla.alertStaff", "delivery.courierSla.customerSms", "delivery.courierSla.assignMin", "delivery.courierSla.arriveTargetMin", "delivery.courierSla.arriveMin", "delivery.courierSla.alertOverMin", "delivery.courierSla.farGuard.mode", "delivery.courierSla.farGuard.fromKm"],
    nodes: (v) => [node("t", "trigger", "شحنة مندوب", "كل دقيقة"), node("c", "guard", `التعيين ${ar(v["delivery.courierSla.assignMin"])} د · الوصول ${ar(v["delivery.courierSla.arriveTargetMin"])} د`, `حد العقد ${ar(v["delivery.courierSla.arriveMin"])} د`, { paths: ["delivery.courierSla.assignMin", "delivery.courierSla.arriveTargetMin", "delivery.courierSla.arriveMin", "delivery.courierSla.alertOverMin"] }),
      node("s", "send", "SMS للإدارة", onOff(v["delivery.courierSla.alertStaff"]), { channel: "sms", paths: ["delivery.courierSla.alertStaff"] }),
      node("s2", "send", "رسالة للعميل (مندوب بديل)", onOff(v["delivery.courierSla.customerSms"]), { channel: "sms", paths: ["delivery.courierSla.customerSms"] }),
      node("f", "guard", `المشوار البعيد > ${ar(v["delivery.courierSla.farGuard.fromKm"] ?? "")} كم`, String(v["delivery.courierSla.farGuard.mode"] || ""), { paths: ["delivery.courierSla.farGuard.mode", "delivery.courierSla.farGuard.fromKm"] })],
    caps: () => [["كل مخالفة", "مرة واحدة (أقل من ٤٥ د)"]], quiet: () => "في أي وقت", when: () => [{ kind: "every", minutes: 1, label: "كل دقيقة" }],
    status: (v) => (v["delivery.courierSla.alertStaff"] ? { state: "on", why: "شغّال" } : { state: "off", why: "الإنذار مقفول (المخالفات بتتسجّل)" }),
    health: () => [], test: null,
  },
  {
    id: "portalOffline", name: "البوابة مقفولة وقت الشغل", icon: "📴", cat: "team", audience: "staff", source: "wateam.js · wahandover.js", screen: "#store/wa/settings",
    desc: "مفيش جهاز كاشير فاتح البوابة وقت الشغل ⇒ واتساب للكاشير، وبعد كام مرة ⇒ المدير، ورسالة «رجعت».",
    trigger: { type: "event", label: "مفيش جهاز كاشير فاتح البوابة" }, channels: ["wa", "portal"], switch: "waTeam.portalOffline.enabled",
    fields: ["waTeam.portalOffline.enabled", "waTeam.portalOffline.afterMin", "waTeam.portalOffline.repeatMin", "waTeam.portalOffline.managerAfter", "waTeam.portalOffline.backStableMin", "waTeam.portalOffline.dailyCap", "waTeam.portalOffline.backNotice", "waTeam.portalOffline.managerOnHold", "waTeam.portalOffline.countBackground"],
    nodes: (v) => [node("t", "trigger", "البوابة مقفولة", `مفيش إشارة ${mins(v["waTeam.portalOffline.afterMin"])}`, { paths: ["waTeam.portalOffline.enabled", "waTeam.portalOffline.afterMin", "waTeam.portalOffline.countBackground"] }),
      node("s1", "send", "واتساب للكاشير", `يتكرر كل ${mins(v["waTeam.portalOffline.repeatMin"])}`, { channel: "wa", paths: ["waTeam.portalOffline.repeatMin"] }),
      node("b", "branch", `بعد ${ar(v["waTeam.portalOffline.managerAfter"])} مرات`, "⇒ المدير", { paths: ["waTeam.portalOffline.managerAfter", "waTeam.portalOffline.managerOnHold"] }),
      node("s2", "send", "واتساب للمدير", "", { channel: "wa" }),
      node("g", "goal", "البوابة رجعت", `ثابتة ${mins(v["waTeam.portalOffline.backStableMin"])} ⇒ «رجعت»`, { paths: ["waTeam.portalOffline.backStableMin", "waTeam.portalOffline.backNotice"] }),
      node("cap", "guard", `${ar(v["waTeam.portalOffline.dailyCap"])} رسالة للرقم في اليوم`, "", { paths: ["waTeam.portalOffline.dailyCap"] })],
    caps: (v) => [["للرقم/يوم", ar(v["waTeam.portalOffline.dailyCap"])]], quiet: () => "وقت الشغل بس", when: (v, x) => [{ kind: "window", from: "open", to: "close", label: "وقت الشغل" }],
    status: (v, x) => (!x.team.enabled ? { state: "dormant", why: "تواصل الفريق على واتساب مقفول" } : v["waTeam.portalOffline.enabled"] ? { state: "on", why: "شغّال" } : { state: "off", why: "مقفول" }),
    sources: ["/api/cms/wabot/team"],
    metrics: (d) => { const p = d["/api/cms/wabot/team"]?.portal; if (!p) return null; return [{ window: "today", label: "النهارده", sent: { wa: p.sentToday }, extra: [["فشل", p.failedToday], ["البوابة دلوقتي", p.cashier?.open ? "مفتوحة ✅" : "مقفولة ⚠️"]] }]; },
    health: (v, x, d) => (d["/api/cms/wabot/team"]?.portal?.cashier && !d["/api/cms/wabot/team"].portal.cashier.open && d["/api/cms/wabot/team"].portal.working ? [{ level: "warn", text: "بوابة الكاشير مقفولة دلوقتي وقت الشغل" }] : []), test: null,
  },
  {
    id: "handover", name: "تحويل لموظف: الرنّة + السلّم + السكوت بعد الاستلام", icon: "🙋‍♂️", cat: "team", audience: "staff", source: "wahandover.js · waflow.js · wabotrun.js (BF1)", screen: "#store/wa/settings",
    desc: "عميل محتاج موظف ⇒ البوابة ترنّ لحد ما حد يستلم، بعدها المدير ثم المُلّاك. واستلم وسكت ⇒ تنبيه وتصعيد.",
    trigger: { type: "event", label: "تحويل محادثة لموظف" }, channels: ["portal", "wa", "sms"], switch: "waTeam.ladder.enabled",
    fields: ["waTeam.portalRing.enabled", "waTeam.portalRing.everyMin", "waTeam.portalRing.capMin", "waTeam.ladder.enabled", "waTeam.ladder.managerAfterMin", "waTeam.ladder.ownersAfterMin", "waTeam.ladder.managerPush", "waTeam.ladder.managerDirect",
      "waBot.handoverRealertMin", "waBot.claimSilentMin", "waBot.claimEscalate"],
    nodes: (v) => [node("t", "trigger", "تحويل لموظف", "شكوى / سؤال / طلب مدير"),
      node("r", "send", "البوابة ترنّ", v["waTeam.portalRing.enabled"] ? `كل ${mins(v["waTeam.portalRing.everyMin"])} لحد ${mins(v["waTeam.portalRing.capMin"])}` : "مقفول", { channel: "portal", paths: ["waTeam.portalRing.enabled", "waTeam.portalRing.everyMin", "waTeam.portalRing.capMin"] }),
      node("w1", "wait", `${mins(v["waTeam.ladder.managerAfterMin"])} من غير استلام`, "", { paths: ["waTeam.ladder.enabled", "waTeam.ladder.managerAfterMin", "waTeam.ladder.managerDirect"] }),
      node("s1", "send", "المدير", v["waTeam.ladder.managerPush"] ? "واتساب + إشعار بوابة" : "واتساب", { channel: "wa", paths: ["waTeam.ladder.managerPush"] }),
      node("w2", "wait", `${mins(v["waTeam.ladder.ownersAfterMin"])} كمان`, "", { paths: ["waTeam.ladder.ownersAfterMin"] }),
      node("s2", "send", "المُلّاك", "واتساب / قالب / SMS", { channel: "wa" }),
      node("c", "guard", Number(v["waBot.claimSilentMin"]) ? `استلم وسكت ${mins(v["waBot.claimSilentMin"])}` : "السكوت بعد الاستلام مقفول", v["waBot.claimEscalate"] ? "⇒ رنّة + تصعيد للمدير" : "⇒ رنّة بس", { paths: ["waBot.claimSilentMin", "waBot.claimEscalate", "waBot.handoverRealertMin"] }),
      node("g", "goal", "موظف رد على العميل", "")],
    caps: () => [["السلّم", "لحد ١٢٠ دقيقة من التحويل"]], quiet: () => "في أي وقت", when: () => [{ kind: "always", label: "مع كل تحويل" }],
    status: (v, x) => (!v["waTeam.ladder.enabled"] && !v["waTeam.portalRing.enabled"] ? { state: "off", why: "مقفول" } : !x.team.enabled ? { state: "partial", why: "الرنّة شغّالة — واتساب الفريق مقفول" } : { state: "on", why: "شغّال" }),
    health: (v, x) => tplWarn(x, ["fc_staff_wa_handoff"]), test: null,
  },
  {
    id: "selfReview", name: "المراجعة الليلية + دروس ماجد", icon: "🌙", cat: "team", audience: "none", source: "walearn.js", screen: "#store/wa/report",
    desc: "كل ليلة بعد القفل: فحص محادثات اليوم (أسعار غلط، لهجة، وعود، تحويل من غير رد…) ⇒ «مشتبه» في سجل الأخطاء، والمتأكد يبقى درس لماجد. مابيبعتش رسايل.",
    trigger: { type: "schedule", label: "كل ليلة" }, channels: [], switch: "waBot.selfReview",
    fields: ["waBot.selfReview", "waBot.selfReviewHour", "waBot.selfReviewMinute", "waBot.selfReviewMax", "waBot.lessonsEnabled", "waBot.lessonsMaxChars"],
    nodes: (v) => [node("t", "trigger", `كل يوم ${pad(v["waBot.selfReviewHour"])}:${pad(v["waBot.selfReviewMinute"])}`, "على اليوم اللي خلص", { paths: ["waBot.selfReview", "waBot.selfReviewHour", "waBot.selfReviewMinute"] }),
      node("c", "guard", `بيفحص لحد ${ar(v["waBot.selfReviewMax"])} حالة`, "١٣ نوع غلطة", { paths: ["waBot.selfReviewMax"] }),
      node("g", "goal", "دروس ماجد", v["waBot.lessonsEnabled"] ? `لحد ${ar(v["waBot.lessonsMaxChars"])} حرف` : "مقفولة", { paths: ["waBot.lessonsEnabled", "waBot.lessonsMaxChars"] })],
    caps: () => [], quiet: () => "", when: (v) => [{ kind: "daily", at: `${pad(v["waBot.selfReviewHour"])}:${pad(v["waBot.selfReviewMinute"])}`, label: "المراجعة الليلية" }],
    status: (v, x) => (!v["waBot.selfReview"] ? { state: "off", why: "مقفول" } : botState(x) === "off" ? { state: "dormant", why: "البوت مقفول ⇒ مفيش مراجعة" } : { state: "on", why: "شغّال" }),
    sources: ["/api/cms/wabot/selfreview"],
    metrics: (d) => { const runs = d["/api/cms/wabot/selfreview"]?.runs || []; if (!runs.length) return null; const w = runs.slice(0, 7); return [{ window: "7d", label: "آخر ٧ ليالي", entered: w.reduce((a, r) => a + (Number(r.found) || 0), 0), converted: w.reduce((a, r) => a + (Number(r.filed) || 0), 0), extra: [["آخر تشغيل", w[0].day]] }]; },
    log: (d) => (d["/api/cms/wabot/selfreview"]?.runs || []).slice(0, 14).map((r) => ({ at: r.finished_at || r.started_at, text: `${r.day}: لقى ${ar(r.found || 0)} · اتسجّل ${ar(r.filed || 0)}` })),
    health: () => [], test: null,
  },
  {
    id: "revenuePulse", name: "رسالة الدخل الدورية للمالك", icon: "💰", cat: "team", audience: "staff", source: "revpulse.js", screen: "#store/overview/daily",
    desc: "كل كام ساعة وقت الشغل: الدخل والطلبات للمالك على واتساب ببلاش (أو SMS)، وملخص القفلة.",
    trigger: { type: "schedule", label: "مواعيد ثابتة وقت الشغل" }, channels: ["wa", "sms"], switch: "revenuePulse.enabled",
    fields: ["revenuePulse.enabled", "revenuePulse.fromHour", "revenuePulse.toHour", "revenuePulse.everyH", "revenuePulse.close", "revenuePulse.closeAt", "revenuePulse.wa", "revenuePulse.sms", "revenuePulse.skipNoChange", "revenuePulse.alertLine"],
    nodes: (v) => [node("t", "trigger", `كل ${ar(v["revenuePulse.everyH"])} ساعة`, `من ${ar(v["revenuePulse.fromHour"])} لحد ${ar(v["revenuePulse.toHour"])}`, { paths: ["revenuePulse.enabled", "revenuePulse.fromHour", "revenuePulse.toHour", "revenuePulse.everyH"] }),
      node("b", "branch", "فيه طلبات جديدة؟", v["revenuePulse.skipNoChange"] ? "لا ⇒ مفيش رسالة" : "بتطلع دايماً", { paths: ["revenuePulse.skipNoChange"] }),
      node("s", "send", "واتساب ببلاش ← SMS", "", { channel: "wa", paths: ["revenuePulse.wa", "revenuePulse.sms", "revenuePulse.alertLine"] }),
      node("c", "send", "ملخص القفلة", v["revenuePulse.close"] ? String(v["revenuePulse.closeAt"]) : "مقفول", { channel: "wa", paths: ["revenuePulse.close", "revenuePulse.closeAt"] })],
    caps: () => [], quiet: () => "", when: (v, x) => { try { return [{ kind: "dailyMany", at: pulseSlots(pulseCfg(x.s)).map((z) => z.key), label: "رسالة الدخل" }]; } catch { return []; } },
    status: (v) => (v["revenuePulse.enabled"] ? { state: "on", why: "شغّال" } : { state: "off", why: "مقفول" }),
    sources: ["/api/cms/revenue-pulse"],
    log: (d) => (d["/api/cms/revenue-pulse"]?.log || []).slice(0, 20).map((r) => ({ at: r.at, text: `${r.day} ${r.slot} · ${r.status}${r.reason ? ` (${r.reason})` : ""}` })),
    metrics: (d) => { const l = d["/api/cms/revenue-pulse"]?.log || []; if (!l.length) return null; const sent = l.filter((r) => r.status === "sent").length; return [{ window: "last20", label: "آخر ٢٠ ميعاد", sent: { wa: sent }, skipped: { skipped: l.length - sent } }]; },
    health: () => [], test: { kind: "inner", method: "POST", path: "/api/cms/revenue-pulse/test", body: () => ({}), label: "رسالة تجربة لأرقام المالك" },
  },
  {
    id: "waHealth", name: "مراقب صحة واتساب", icon: "🩺", cat: "team", audience: "staff", source: "wahealth.js", screen: "#store/wa/settings",
    desc: "كل ربع ساعة: الرصيد والدفع والجودة والحد واسم العرض ⇒ SMS (وواتساب) للمالك لو فيه مشكلة، ورسالة لما ترجع.",
    trigger: { type: "schedule", label: "فحص دوري" }, channels: ["sms", "wa"], switch: "waHealth.enabled",
    fields: ["waHealth.enabled", "waHealth.everyMin", "waHealth.sms", "waHealth.ownerWa", "waHealth.repeatHours", "waHealth.recovery", "waHealth.monthBudgetSar"],
    nodes: (v) => [node("t", "trigger", `كل ${mins(v["waHealth.everyMin"])}`, "+ فحص سريع بعد أي خطأ حرج", { paths: ["waHealth.enabled", "waHealth.everyMin"] }),
      node("b", "branch", "فيه مشكلة جديدة؟", `أو لسه موجودة بعد ${ar(v["waHealth.repeatHours"])} ساعة`, { paths: ["waHealth.repeatHours", "waHealth.monthBudgetSar"] }),
      node("s", "send", "SMS + واتساب للمالك", "", { channel: "sms", paths: ["waHealth.sms", "waHealth.ownerWa"] }), node("g", "goal", "«رجع تمام»", onOff(v["waHealth.recovery"]), { paths: ["waHealth.recovery"] })],
    caps: () => [], quiet: () => "في أي وقت", when: (v) => [{ kind: "every", minutes: Number(v["waHealth.everyMin"]) || 15, label: "فحص" }],
    status: (v) => (v["waHealth.enabled"] ? { state: "on", why: "شغّال" } : { state: "off", why: "مقفول" }),
    sources: ["/api/cms/wa-health"],
    health: (v, x, d) => (d["/api/cms/wa-health"]?.alerts || d["/api/cms/wa-health"]?.state?.last?.issues || []).filter((i) => i && (i.level === "crit" || i.level === "warn")).slice(0, 3).map((i) => ({ level: i.level === "crit" ? "error" : "warn", text: `واتساب: ${i.ar || i.text || i.key}` })),
    log: (d) => (d["/api/cms/wa-health"]?.log || []).slice(0, 10).map((r) => ({ at: r.at, text: r.text || r.kind || "" })),
    test: { kind: "inner", method: "POST", path: "/api/cms/wa-health/test", body: () => ({}), label: "رسالة تجربة للمالك" },
  },
  {
    id: "portalSessions", name: "جلسات هنقرستيشن ونينجا", icon: "🔁", cat: "team", audience: "staff", source: "portalsessions.js", screen: "#store/settings/portals",
    desc: "تجديد تلقائي للجلسات قبل ما تخلص، وSMS للإدارة لو جلسة وقعت أو قربت تخلص.",
    trigger: { type: "schedule", label: "فحص دوري" }, channels: ["sms"], switch: "portals.alertsEnabled",
    fields: ["portals.renewEnabled", "portals.alertsEnabled", "portals.alertRepeatHours", "portals.soonHours"],
    nodes: (v) => [node("t", "trigger", "فحص الجلسات", "", { paths: ["portals.renewEnabled"] }), node("b", "branch", "الجلسة وقعت أو قربت؟", `قبل ${ar(v["portals.soonHours"])} ساعة`, { paths: ["portals.soonHours"] }),
      node("s", "send", "SMS للإدارة", `مرة كل ${ar(v["portals.alertRepeatHours"])} ساعة`, { channel: "sms", paths: ["portals.alertsEnabled", "portals.alertRepeatHours"] })],
    caps: (v) => [["تكرار", `${ar(v["portals.alertRepeatHours"])} ساعة`]], quiet: () => "", when: () => [{ kind: "every", minutes: 30, label: "فحص" }],
    status: (v) => (v["portals.alertsEnabled"] || v["portals.renewEnabled"] ? { state: "on", why: [v["portals.renewEnabled"] && "تجديد", v["portals.alertsEnabled"] && "تنبيه"].filter(Boolean).join(" + ") } : { state: "off", why: "مقفول" }),
    health: () => [], test: null,
  },
  /* ─────────────── 📣 الإعلانات والمهام ─────────────── */
  {
    id: "adsGuard", name: "حارس الإعلانات (fc-adsentry)", icon: "🛡", cat: "ads", audience: "ads", source: "fc-adsentry (السيرفر) — بيقرا settings.adsGuard", screen: "#store/grow/adsctl",
    desc: "مهمة على السيرفر كل ربع ساعة: نافذة الإعلانات، السقف اليومي، سقف من الدخل، قاعدة الساعة ٨، وقاعدة الـ٣ أيام. التعديل هنا بيكتب نفس الإعدادات اللي الحارس بيقراها.",
    trigger: { type: "schedule", label: "كل ربع ساعة (مهمة السيرفر)" }, channels: ["ads"], switch: "adsGuard.stopAll", switchInverted: true,
    fields: ["adsGuard.stopAll", "adsGuard.window.from", "adsGuard.window.to", "adsGuard.defaultCap", "adsGuard.revenueCap.enabled", "adsGuard.revenueCap.pct", "adsGuard.revenueCap.maxTotal", "adsGuard.intraday.enabled", "adsGuard.intraday.spendOver", "adsGuard.killRule.auto", "adsGuard.killRule.stopIfCpaOver", "adsGuard.floor", "adsGuard.hardCap"],
    nodes: (v) => [node("t", "trigger", "كل ربع ساعة", "مهمة fc-adsentry على السيرفر"),
      node("w", "guard", `النافذة ${v["adsGuard.window.from"] || "—"} ← ${v["adsGuard.window.to"] || "—"}`, "بره النافذة ⇒ الإعلانات تقف", { paths: ["adsGuard.window.from", "adsGuard.window.to", "adsGuard.stopAll"] }),
      node("c", "guard", `السقف ${ar(v["adsGuard.defaultCap"] ?? "—")} ر.س`, v["adsGuard.revenueCap.enabled"] ? `من الدخل ${ar(v["adsGuard.revenueCap.pct"] ?? "")}٪ · صلب ${ar(v["adsGuard.revenueCap.maxTotal"] ?? "")}` : "سقف الدخل مقفول", { paths: ["adsGuard.defaultCap", "adsGuard.revenueCap.enabled", "adsGuard.revenueCap.pct", "adsGuard.revenueCap.maxTotal", "adsGuard.floor", "adsGuard.hardCap"] }),
      node("i", "branch", "الساعة ٨: صرف من غير عملاء؟", v["adsGuard.intraday.enabled"] ? `صرف > ${ar(v["adsGuard.intraday.spendOver"] ?? "")} ر.س ⇒ إيقاف` : "مقفولة", { paths: ["adsGuard.intraday.enabled", "adsGuard.intraday.spendOver"] }),
      node("k", "branch", "٣ أيام خسرانة؟", v["adsGuard.killRule.auto"] ? `تكلفة العميل > ${ar(v["adsGuard.killRule.stopIfCpaOver"] ?? "")} ⇒ إيقاف` : "مقفولة", { paths: ["adsGuard.killRule.auto", "adsGuard.killRule.stopIfCpaOver"] })],
    caps: (v) => [["السقف", `${ar(v["adsGuard.defaultCap"] ?? "—")} ر.س`]], quiet: () => "",
    when: (v) => (v["adsGuard.window.from"] ? [windowDaily(v["adsGuard.window.from"], v["adsGuard.window.to"], "نافذة الإعلانات")] : []),
    status: (v) => (v["adsGuard.stopAll"] ? { state: "error", why: "🛑 كل الإعلانات موقوفة" } : { state: "on", why: "الحارس شغّال" }),
    sources: ["/api/settings/ads-guard/status"],
    metrics: (d) => { const st = d["/api/settings/ads-guard/status"]; if (!st?.lastRun) return null; const lr = st.lastRun; return [{ window: "today", label: "آخر دورة", cost: lr.spend ?? lr.spent ?? null, extra: [["وقت الدورة", st.updatedAt ? String(st.updatedAt).slice(11, 16) : "—"], ["آخر أمر", st.lastAction ? `${st.lastAction.action || ""} ${st.lastAction.name || ""}`.trim() : "—"]] }]; },
    health: (v, x, d) => { const st = d["/api/settings/ads-guard/status"]; const out = []; if (st?.updatedAt && Date.now() - Date.parse(st.updatedAt) > 45 * 60_000) out.push({ level: "error", text: "الحارس مااشتغلش من أكتر من ٤٥ دقيقة — اتأكد من مهمة السيرفر" }); for (const [p, x2] of Object.entries(st?.platformStopped || {})) if (x2) out.push({ level: "warn", text: `منصة ${p} موقوفة من الحارس` }); return out; },
    test: null,
  },
];

/* المهام المجدولة: من settings.jobs نفسه (الاسم والمفتاح ولحد إمتى) — فلو لكل مهمة */
export function jobFlows(s) {
  return Object.entries(isObj(s?.jobs) ? s.jobs : {}).filter(([n, j]) => /^[A-Za-z0-9_-]{1,40}$/.test(n) && isObj(j)).map(([n, j]) => ({
    id: `job-${n}`, name: j.label || `مهمة ${n}`, icon: "⏱", cat: "ads", audience: "none", source: `${n} (مهمة على السيرفر — fc-job-gate)`, screen: "#store/grow/adsctl",
    desc: "مهمة مجدولة على السيرفر بتقرا مفتاحها من الإعدادات قبل كل تشغيل.", trigger: { type: "schedule", label: "مؤقت السيرفر" }, channels: [],
    switch: `jobs.${n}.enabled`, fields: [`jobs.${n}.enabled`, `jobs.${n}.until`], fieldLabels: { [`jobs.${n}.enabled`]: L(`المهمة ${n} شغّالة`, "bool", { risky: "any" }), [`jobs.${n}.until`]: L("شغّالة لحد (فاضي = دايماً)", "date") },
    nodes: (v) => [node("t", "trigger", "مؤقت السيرفر", n, { paths: [`jobs.${n}.enabled`] }), node("g", "goal", v[`jobs.${n}.until`] ? `لحد ${v[`jobs.${n}.until`]}` : "من غير تاريخ نهاية", "", { paths: [`jobs.${n}.until`] })],
    caps: () => [], quiet: () => "", when: () => [], status: (v) => (v[`jobs.${n}.enabled`] === false ? { state: "off", why: "مقفولة" } : { state: "on", why: "شغّالة" }), health: () => [], test: null,
  }));
}

/* أتمتة الشرائح (cms_flows): كل صف = فلو. «اطلب تاني» (second_nudge) و«استرجاع ٢١» (lapsed_21) لو مش موجودين بيظهروا «مش متعمل». */
export const CMS_FLOW_TEMPLATES = Object.freeze([
  { segment: "second_nudge", name: "اطلب تاني — بعد أول طلب من الموقع بـ٥ أيام", icon: "🔁", channel: "sms", offer: null, holdout_pct: 10,
    message: "شكراً لطلبك من فريش كاتس! كل ٣ طلبات من الموقع تكسب توصيل مجاني. اطلب: {link}" },
  { segment: "lapsed_21", name: "استرجاع — غايب ٢١ يوم", icon: "💔", channel: "sms", offer: "winback", holdout_pct: 10,
    message: "وحشتنا! لك توصيل مجاني على طلبك الجاي من الموقع فوق ٦٠ ريال. اطلب الحين: {link}" },
]);
export function cmsFlowEntries(rows, segLabel = (s) => s) {
  const list = (rows || []).map((f) => ({
    id: `cmsflow-${f.id}`, cmsId: f.id, name: f.name, icon: f.segment === "second_nudge" ? "🔁" : f.segment === "lapsed_21" ? "💔" : "🎯", cat: "customers", audience: "customers",
    source: "cms.js (cms_flows)", screen: "#store/grow/campaigns", desc: `رسالة تلقائية لكل اللي «بيدخل» شريحة «${segLabel(f.segment)}» (بنفحص كل ساعة). الموجودين وقت التشغيل = نقطة بداية من غير إرسال.`,
    trigger: { type: "segment", label: `دخل «${segLabel(f.segment)}»` }, channels: [f.channel === "sms" ? "sms" : "push"], switch: `cmsFlows.${f.id}.active`,
    fields: [`cmsFlows.${f.id}.active`, `cmsFlows.${f.id}.message`, `cmsFlows.${f.id}.holdout_pct`],
    fieldLabels: { [`cmsFlows.${f.id}.active`]: L("الأتمتة شغّالة", "bool", { risky: "on" }), [`cmsFlows.${f.id}.message`]: L("نص الرسالة ({name} {link} {coupon})", "textarea", { max: 600 }), [`cmsFlows.${f.id}.holdout_pct`]: L("المحجوزين للقياس (holdout)", "int", { min: 0, max: 50, unit: "٪" }) },
    values: { [`cmsFlows.${f.id}.active`]: Boolean(f.active), [`cmsFlows.${f.id}.message`]: f.message || "", [`cmsFlows.${f.id}.holdout_pct`]: f.holdout_pct == null ? 10 : Number(f.holdout_pct) },
    nodes: (v) => [node("t", "trigger", `دخل «${segLabel(f.segment)}»`, "بنفحص كل ساعة", { paths: [`cmsFlows.${f.id}.active`] }),
      node("h", "branch", `${ar(v[`cmsFlows.${f.id}.holdout_pct`])}٪ محجوزين`, "مايتبعتلهمش ⇒ نقيس الأثر الحقيقي", { paths: [`cmsFlows.${f.id}.holdout_pct`] }),
      node("s", "send", f.channel === "sms" ? "SMS برابط شخصي" : "إشعار", f.offer === "winback" ? "مع كوبون توصيل مجاني شخصي" : f.coupon ? `كوبون ${f.coupon}` : "", { channel: f.channel === "sms" ? "sms" : "push", paths: [`cmsFlows.${f.id}.message`] }),
      node("g", "goal", "الهدف: طلب خلال ٧ أيام", "داخلين قصاد محجوزين")],
    caps: (v, x) => [["فاصل الأتمتة", `${ar(x.camp.flowGapDays)} يوم`], ["كل دورة", "٢٠٠ رسالة"]], quiet: (v, x) => quietSms(x),
    when: (v, x) => [windowDaily(hh(x.camp.quietEnd), hh(x.camp.quietStart), "كل ساعة خارج الهدوء")],
    status: (v, x) => (!f.active ? { state: "off", why: "مقفولة" } : f.channel === "sms" && !x.camp.smsEnabled ? { state: "dormant", why: "SMS التسويقي مقفول" } : f.channel === "sms" && x.camp.brake ? { state: "error", why: "فرملة الإيقاف مشدودة" } : { state: "on", why: "شغّالة" }),
    metricsRow: f.stats || null,
    health: (v, x) => (f.active && f.channel === "sms" && !x.camp.smsEnabled ? [{ level: "warn", text: "الأتمتة شغّالة بس SMS التسويقي مقفول ⇒ مابيتبعتش", path: "cms.campaigns.smsEnabled" }] : []),
    test: { kind: "inner", method: "POST", path: `/api/cms/flows/${f.id}/test-send`, body: (phone) => ({ phone }), label: "الرسالة لرقمك (أرقام الفريق بس)", ownerOnly: true },
    raw: f,
  }));
  const have = new Set((rows || []).map((f) => f.segment));
  for (const t of CMS_FLOW_TEMPLATES) if (!have.has(t.segment)) list.push({
    id: `cmsflow-new-${t.segment}`, name: t.name, icon: t.icon, cat: "customers", audience: "customers", source: "cms.js (cms_flows)", screen: "#store/grow/campaigns",
    desc: `مش متعمل لسه. «أضف» بيعمله مقفول، وأول تشغيل = نقطة بداية من غير إرسال.`, trigger: { type: "segment", label: `دخل «${segLabel(t.segment)}»` }, channels: [t.channel],
    switch: null, fields: [], values: {}, missing: true, template: t,
    nodes: () => [node("t", "trigger", `دخل «${segLabel(t.segment)}»`, ""), node("s", "send", "SMS", t.message.slice(0, 60), { channel: "sms" }), node("g", "goal", "طلب خلال ٧ أيام", "")],
    caps: () => [], quiet: (v, x) => quietSms(x), when: () => [], status: () => ({ state: "missing", why: "مش متعمل — أضفه من المعرض" }), health: () => [], test: null,
  });
  return list;
}
const metricsOfCmsRow = (st) => {
  if (!st || !st.sent) return null;
  return [{ window: "all", label: "من البداية", entered: (st.sent.n || 0) + (st.holdout?.n || 0), sent: { sms: st.sent.n }, converted: st.sent.ordered7, revenue: st.sent.rev7, cost: st.sent.cost,
    lift: { pct: st.lift7, reliable: Boolean(st.liftReliable), holdout: st.holdout?.n || 0 }, skipped: st.failed ? { failed: st.failed } : {},
    extra: [["ضغطوا", st.sent.clicked], ["وقّفوا", st.sent.optouts], ["وصلت", st.dlrAvailable ? st.sent.delivered : "—"]] }];
};

/* ═══ فلوهات المحرّك الجديد (autoflows.js) بنفس شكل الكتالوج ═══════════════ */
const STEP_AR = { push: "إشعار", sms: "SMS", wa_template: "قالب واتساب", wa_text: "واتساب حر", staff_alert: "تنبيه للفريق" };
export function customEntries(rows, statsById = new Map(), segLabel = (s) => s) {
  return (rows || []).map((f) => {
    const v0 = af.validateDef(f.def);
    const def = v0.def;
    const d = af.describeDef(def, segLabel);
    const chans = d.channels.map((c) => (c === "wa_template" || c === "wa_text" ? "wa" : c === "staff_alert" ? "staff" : c));
    const staffOnly = d.channels.length && d.channels.every((c) => c === "staff_alert");
    const sw = `auto.${f.id}.active`;
    return {
      id: `auto-${f.id}`, autoId: f.id, name: f.name, icon: f.icon || "✨", cat: "custom", audience: staffOnly ? "staff" : "customers", source: "autoflows.js (فلو جديد)", screen: null,
      desc: `${d.trigger} ⇒ ${d.channels.map((c) => STEP_AR[c] || c).join(" ← ") || "—"}${def.goal ? ` · الهدف طلب خلال ${ar(def.goal.withinDays)} يوم` : ""}`,
      trigger: { type: def.trigger.type === "segment_entry" ? "segment" : def.trigger.type, label: d.trigger }, channels: [...new Set(chans)], switch: sw,
      fields: [sw], fieldLabels: { [sw]: L("الفلو شغّال", "bool", { risky: "on" }) }, values: { [sw]: Boolean(f.active) }, def, defErrors: v0.ok ? [] : v0.errors, custom: true,
      nodes: () => [
        node("t", "trigger", d.trigger, def.conditions.length ? def.conditions.map((c) => `${(af.CONDITION_FIELDS.find((x) => x.id === c.field) || {}).label} ${af.OPS[c.op]} ${ar(c.value)}`).join(" · ") : "", { step: "trigger" }),
        ...(def.holdoutPct ? [node("h", "branch", `${ar(def.holdoutPct)}٪ محجوزين`, "لقياس الأثر", { step: "holdout" })] : []),
        ...def.steps.map((s) => (s.type === "wait" ? node(s.id, "wait", `استنى ${mins(s.minutes)}`, "", { step: s.id })
          : s.type === "branch" ? node(s.id, "branch", `${(af.BRANCH_CHECKS.find((b) => b.id === s.check) || {}).label || s.check} (${ar(s.withinHours)} ساعة)`, `نعم ⇒ ${s.yes === "exit" ? "خروج" : s.yes === "next" ? "الجاي" : s.yes} · لا ⇒ ${s.no === "exit" ? "خروج" : s.no === "next" ? "الجاي" : s.no}`, { step: s.id })
            : node(s.id, "send", STEP_AR[s.channel] || s.channel, String(s.text || s.template || "").slice(0, 70), { step: s.id, channel: s.channel === "staff_alert" ? "staff" : s.channel.startsWith("wa") ? "wa" : s.channel }))),
        ...(def.goal ? [node("g", "goal", `الهدف: طلب خلال ${ar(def.goal.withinDays)} يوم`, def.exitOnGoal ? "اللي يطلب يخرج من الفلو" : "", { step: "goal" })] : []),
        node("cap", "guard", `مرة كل ${ar(def.caps.reenterDays)} يوم للعميل`, `${ar(def.caps.perRun)} في الدورة · ${ar(def.caps.perDay)} في اليوم`, { step: "caps" }),
      ],
      caps: () => [["للعميل", `مرة كل ${ar(def.caps.reenterDays)} يوم`], ["في اليوم", ar(def.caps.perDay)]],
      quiet: (v, x) => `${quietSms(x)} · واتساب: ${waHoursTxt(x)}`,
      when: (v, x) => (def.trigger.type === "schedule" ? [{ kind: "points", at: af.nextScheduleTimes(def.trigger, x.now, 7), label: f.name }] : [{ kind: "every", minutes: 60, label: def.trigger.type === "event" ? "بعد الحدث (بنفحص كل ١٠ دقايق)" : "بنفحص الشريحة كل ساعة" }]),
      status: () => (!v0.ok ? { state: "error", why: "الفلو فيه غلطة — افتحه وصلّحه" } : f.active ? { state: "on", why: `شغّال من ${f.activated_at ? String(f.activated_at).slice(0, 10) : "—"}` } : { state: "off", why: "مقفول (مسودة)" }),
      metricsRow: statsById.get(f.id) || null,
      health: (v, x) => [...(chans.includes("sms") && !x.camp.smsEnabled ? [{ level: "warn", text: "فيه خطوة SMS وSMS التسويقي مقفول ⇒ هتتشال", path: "cms.campaigns.smsEnabled" }] : []),
        ...tplWarn(x, def.steps.filter((s) => s.channel === "wa_template").map((s) => s.template)), ...(chans.includes("wa") && waBlock(x) ? [{ level: "warn", text: waBlock(x) }] : [])],
      test: { kind: "custom", label: "أول رسالة لرقمك (أرقام الفريق والتجربة بس)" },
      lastRunAt: f.last_run_at || null,
    };
  });
}
const metricsOfCustom = (st) => (st ? [{ window: "7d", label: "آخر ٧ أيام", entered: st.entered, sent: st.sent, converted: st.converted, revenue: st.revenue, cost: st.cost, skipped: st.skipped,
  lift: st.holdout ? { pct: st.lift7, reliable: st.liftReliable, holdout: st.holdout } : null, extra: [["فشل", st.failed], ["تجارب", st.tests]] }] : null);

/* ═══ معرض القوالب ═════════════════════════════════════════════════════ */
export const GALLERY = Object.freeze([
  { id: "classic-second_nudge", kind: "classic", icon: "🔁", name: "اطلب تاني — يوم ٥ بعد أول طلب", hint: "SMS برابط شخصي + holdout ١٠٪ (أتمتة الشرائح الحالية)", cms: CMS_FLOW_TEMPLATES[0] },
  { id: "classic-lapsed_21", kind: "classic", icon: "💔", name: "استرجاع — غايب ٢١ يوم", hint: "SMS + كوبون توصيل مجاني شخصي", cms: CMS_FLOW_TEMPLATES[1] },
  { id: "welcome-first", kind: "engine", icon: "👋", name: "ترحيب بعد أول طلب", hint: "إشعار شكر بعد يوم، ولو ماطلبش تاني خلال ٤ أيام ⇒ SMS",
    def: { trigger: { type: "event", event: "first_order" }, steps: [{ id: "w1", type: "wait", minutes: 1440 }, { id: "s1", type: "send", channel: "push", title: "شكراً لك 🍔", text: "يا {name}، نتمنى الأكل عجبك! كل ٣ طلبات من الموقع = توصيل مجاني." }, { id: "w2", type: "wait", minutes: 5760 }, { id: "b1", type: "branch", check: "ordered", withinHours: 96, yes: "exit", no: "next" }, { id: "s2", type: "send", channel: "sms", text: "وحشتنا يا {name}! اطلب وجبتك الجاية من موقعنا: freshcuts.sa" }], goal: { type: "order", withinDays: 7 }, caps: { reenterDays: 365, perRun: 100, perDay: 200 }, holdoutPct: 10 } },
  { id: "vip-thursday", kind: "engine", icon: "👑", name: "كبار العملاء — إشعار الخميس", hint: "كل خميس ٥ العصر لكبار العملاء (إشعار ببلاش)",
    def: { trigger: { type: "schedule", segment: "vip", days: [4], at: "17:00" }, steps: [{ id: "s1", type: "send", channel: "push", title: "خميسك عندنا 🔥", text: "يا {name}، الشوي جاهز على الفحم — اطلب قبل الزحمة." }], goal: { type: "order", withinDays: 2 }, caps: { reenterDays: 7, perRun: 300, perDay: 300 }, holdoutPct: 10 } },
  { id: "at-risk", kind: "engine", icon: "⚠️", name: "عميل في خطر (٢٢–٤٥ يوم)", hint: "إشعار، وبعد يومين لو ماطلبش ⇒ SMS",
    def: { trigger: { type: "segment_entry", segment: "at_risk" }, steps: [{ id: "s1", type: "send", channel: "push", title: "وحشتنا 💛", text: "يا {name}، فاتك الشوي على الفحم؟ اطلب الحين." }, { id: "w1", type: "wait", minutes: 2880 }, { id: "b1", type: "branch", check: "ordered", withinHours: 48, yes: "exit", no: "next" }, { id: "s2", type: "send", channel: "sms", text: "يا {name} وحشتنا! طلبك الجاي من الموقع: freshcuts.sa" }], goal: { type: "order", withinDays: 7 }, caps: { reenterDays: 30, perRun: 100, perDay: 150 }, holdoutPct: 10 } },
  { id: "vip-order-alert", kind: "engine", icon: "📟", name: "تنبيه الفريق: عميل كبير طلب", hint: "طلب مدفوع من عميل صرف ١٠٠٠+ ⇒ SMS للإدارة يهتموا بيه",
    def: { trigger: { type: "event", event: "order_paid" }, conditions: [{ field: "spent", op: "gte", value: 1000 }], steps: [{ id: "s1", type: "send", channel: "staff_alert", text: "VIP order from a top customer — give it extra care" }], caps: { reenterDays: 1, perRun: 50, perDay: 50 }, holdoutPct: 0 } },
  { id: "second-order-thanks", kind: "engine", icon: "🎉", name: "شكراً على الطلب التاني", hint: "بعد الطلب التاني: إشعار يذكّره بالولاء",
    def: { trigger: { type: "event", event: "order_paid" }, conditions: [{ field: "orders", op: "eq", value: 2 }], steps: [{ id: "w1", type: "wait", minutes: 180 }, { id: "s1", type: "send", channel: "push", title: "طلبك التاني 🎉", text: "يا {name}، طلب واحد كمان ويوصلك التوصيل المجاني!" }], caps: { reenterDays: 365, perRun: 100, perDay: 200 }, holdoutPct: 0 } },
  { id: "dormant-wa", kind: "engine", icon: "🟢", name: "غايبين ٤٦–٩٠ يوم — قالب واتساب", hint: "قالب تسويقي معتمد (اختار القالب قبل التشغيل)",
    def: { trigger: { type: "segment_entry", segment: "dormant" }, steps: [{ id: "s1", type: "send", channel: "wa_template", template: "", params: ["{name}"] }], goal: { type: "order", withinDays: 7 }, caps: { reenterDays: 60, perRun: 50, perDay: 100 }, holdoutPct: 10 } },
  { id: "blank", kind: "engine", icon: "✏️", name: "فلو فاضي", hint: "ابدأ من الصفر: محفّز + رسالة + هدف",
    def: { trigger: { type: "segment_entry", segment: "" }, steps: [{ id: "s1", type: "send", channel: "push", title: "فريش كاتس 🍔", text: "" }], goal: { type: "order", withinDays: 7 }, holdoutPct: 10 } },
]);

/* ═══ التلخيص: فلو ⇒ JSON للوحة ═════════════════════════════════════════ */
const safe = (fn, d = null) => { try { const r = fn(); return r === undefined ? d : r; } catch { return d; } };
export function summarize(def, x, access = { owner: true, canEditPath: () => true }) {
  const fields = (def.fields || []).map((p) => ({ ...fieldSpec(p), ...((def.fieldLabels || {})[p] || {}), path: p }));
  const values = def.values ? { ...def.values } : Object.fromEntries(fields.map((f) => [f.path, valueAt(f.path, x.s)]));
  for (const f of fields) {
    const w = def.custom ? { owner: false } : writerFor(f.path);
    f.editable = !f.readOnly && Boolean(w) && (access.owner || (!w.owner && access.canEditPath(f.path)));
    if (!f.editable && !f.readOnly) f.lock = !w ? "مالوش مسار حفظ" : w.owner && !access.owner ? "للمالك بس" : "مش ضمن صلاحية دورك";
  }
  const status = safe(() => def.status(values, x), { state: "unknown", why: "—" });
  const metrics = def.metricsRow !== undefined ? (def.custom ? metricsOfCustom(def.metricsRow) : metricsOfCmsRow(def.metricsRow)) : def.metrics ? safe(() => def.metrics(x.d, values, x)) : null;
  return {
    id: def.id, name: def.name, icon: def.icon, cat: def.cat, desc: def.desc, source: def.source, screen: def.screen, audience: def.audience,
    trigger: def.trigger, channels: def.channels || [], switch: def.switch || null, switchInverted: Boolean(def.switchInverted), missing: Boolean(def.missing), custom: Boolean(def.custom),
    enabled: def.switch ? (def.switchInverted ? values[def.switch] !== true : values[def.switch] === true) : null,
    status, fields, values,
    nodes: safe(() => def.nodes(values, x), []),
    caps: safe(() => def.caps(values, x), []), quiet: safe(() => def.quiet(values, x), ""), when: safe(() => def.when(values, x), []),
    metrics, health: safe(() => def.health(values, x, x.d), []) || [],
    test: def.test ? { label: def.test.label, ownerOnly: Boolean(def.test.ownerOnly), needsPhone: def.test.kind === "custom" || /\(phone\)/.test(String(def.test.body)) } : null,
    canToggle: Boolean(def.switch) && fields.some((f) => f.path === def.switch && f.editable),
    template: def.template || null, def: def.def || null, defErrors: def.defErrors || [], lastRunAt: def.lastRunAt || null,
  };
}
export function templateStatusMap(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const sts = (r.statuses || []).map((s) => s.status).filter(Boolean);
    if (sts.length) m.set(r.name, sts.includes("APPROVED") ? "APPROVED" : sts[0]);
  }
  return m;
}
export function buildContext(s, d = {}, now = new Date()) {
  const bot = safe(() => botConfig(s), { mode: "off" });
  return {
    s, d, now, bot, team: safe(() => teamConfig(s), { enabled: true }), camp: campaignsCfg(s),
    master: Boolean(s?.waMaster && s.waMaster.enabled === true), sendHours: sendHoursCfg(s),
    tpl: templateStatusMap(d["/api/cms/wa/templates"]?.rows || d["/api/cms/wa/templates"]?.templates || []),
  };
}
export function globalsOf(x) {
  return {
    botMode: x.bot.mode, waMaster: x.master, smsMarketing: x.camp.smsEnabled, brake: x.camp.brake || null,
    quiet: { start: x.camp.quietStart, end: x.camp.quietEnd, text: `من ${hh(x.camp.quietStart)} لـ${hh(x.camp.quietEnd)}` },
    sendHours: { active: x.sendHours.active, stopBeforeCloseMin: x.sendHours.stopBeforeCloseMin, openNow: safe(() => isRestaurantOpenAt(x.now, x.s), null),
      nextOpen: safe(() => { const t = nextSendOpenAt(x.now, x.s); return t ? t.toISOString() : null; }, null) },
    openings: openingsNext(x.s, x.now),
  };
}

/* ═══ المسارات ══════════════════════════════════════════════════════════ */
const normPhone = (p) => { const d = String(p || "").replace(/\D/g, "").replace(/^(966|0)/, ""); return /^5\d{8}$/.test(d) ? d : null; };
export function testPhoneSet(s) {
  const out = new Set();
  for (const p of safe(() => [...smsRules.teamPhoneSet(s)], []) || []) { const n = normPhone(p); if (n) out.add(n); }
  for (const p of (s?.waBot?.testPhones || [])) { const n = normPhone(p); if (n) out.add(n); }
  for (const p of (s?.delivery?.alertPhones || [])) { const n = normPhone(p); if (n) out.add(n); }
  return out;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, isOwner, auditNote } = ctx;
  const cms = () => (typeof deps.cms === "function" ? deps.cms() : deps.cms) || null;
  const note = (c, s) => (typeof auditNote === "function" ? auditNote(c, s).catch?.(() => {}) : null);
  const paidOf = typeof deps.paidSqlFn === "function" ? deps.paidSqlFn : (a) => `${a}.status IN ('paid','pos_created','accepted','courier_requested','courier_assigned','on_the_way','delivered')`;
  const store = deps.store || af.pgStore(pool, { paidSql: paidOf("o") });
  const now = () => (deps.now ? deps.now() : new Date());

  /* GET داخلي بنفس التوكن (نفس الصلاحية بالظبط) — مهلة لكل مسار، والفشل مابيوقّعش الصفحة */
  async function inner(c, method, path, body, { timeoutMs = 9000 } = {}) {
    const headers = { "content-type": "application/json" };
    const auth = c.req.header("Authorization");
    if (auth) headers.authorization = auth;
    const run = (async () => {
      const res = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let json = null; try { json = await res.json(); } catch { /* مش JSON */ }
      return { status: res.status, ok: res.status < 400 && (!json || json.ok !== false), json };
    })();
    const to = new Promise((r) => { const t = setTimeout(() => r({ status: 504, ok: false, json: { error: "timeout" } }), timeoutMs); t.unref?.(); });
    try { return await Promise.race([run, to]); } catch (e) { return { status: 500, ok: false, json: { error: String(e?.message || e) } }; }
  }

  /* صلاحية التعديل لمسار إعداد: المالك كله؛ غيره حسب قسم مسار الحفظ الأصلي */
  async function accessOf(c) {
    const owner = Boolean(await isOwner(c));
    if (owner) return { owner: true, canEditPath: () => true, role: "owner" };
    const api = cms();
    let role = null, perms = null;
    try { const u = await api?.whoami?.(c); role = u?.role || null; perms = role ? (await api.effectivePerms())[role] : null; } catch { /* */ }
    return { owner: false, role, canEditPath: (p) => { const w = writerFor(p); if (!w || w.owner || !perms || !api?.sectionOf) return false; const req = w.build([{ path: p, value: null }], {}, {}); return perms[api.sectionOf(req.path)] === "edit"; } };
  }

  const cache = new Map();
  const segLabelOf = (list) => { const m = new Map((list || []).map((x) => [x.id, x.label || x.name || x.id])); return (id) => m.get(id) || id; };
  async function collect(c, { fresh = false, extra = [] } = {}) {
    const key = crypto.createHash("sha1").update(String(c.req.header("Authorization") || "")).digest("hex") + extra.join(",");
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 45_000) return hit.v;
    const s = (await getSettingsData()) || {};
    const paths = [...new Set(["/api/cms/flows", "/api/cms/wa/templates", ...CATALOG.flatMap((f) => f.sources || []), ...extra])];
    const res = await Promise.all(paths.map((p) => inner(c, "GET", p)));
    const d = {}, failed = {};
    paths.forEach((p, i) => { if (res[i].ok) d[p] = res[i].json; else failed[p] = res[i].status; });
    let customRows = [];
    try { customRows = await store.listFlows(); } catch (e) { failed.autoflows = String(e.message || e).slice(0, 80); }
    const since7 = new Date(now().getTime() - 7 * 86400_000).toISOString();
    const statsById = new Map();
    await Promise.all(customRows.map(async (f) => { try { statsById.set(f.id, await store.stats(f.id, since7)); } catch { /* */ } }));
    const segs = safe(() => cms()?.segmentList?.() || [], []) || [];
    const v = { s, d, failed, customRows, statsById, segs, at: Date.now() };
    cache.set(key, { at: Date.now(), v });
    if (cache.size > 50) cache.delete(cache.keys().next().value);
    return v;
  }
  function allDefs(v) {
    const seg = segLabelOf(v.segs);
    return [...CATALOG, ...jobFlows(v.s), ...cmsFlowEntries(v.d["/api/cms/flows"]?.flows || [], seg), ...customEntries(v.customRows, v.statsById, seg)];
  }
  function builderInfo(v) {
    const approved = [...templateStatusMap(v.d["/api/cms/wa/templates"]?.rows || []).entries()].filter(([, st]) => st === "APPROVED").map(([n]) => n).sort();
    return { triggers: af.TRIGGERS, events: af.EVENTS, channels: af.CHANNELS, branchChecks: af.BRANCH_CHECKS, conditionFields: af.CONDITION_FIELDS, ops: af.OPS, stepTypes: af.STEP_TYPES,
      capLimits: af.CAP_LIMITS, capDefaults: af.CAP_DEFAULTS, segments: (v.segs || []).map((x) => ({ id: x.id, label: x.label || x.name || x.id, hint: x.hint || x.desc || "" })), templates: approved,
      gallery: GALLERY.map((g) => ({ id: g.id, kind: g.kind, icon: g.icon, name: g.name, hint: g.hint, def: g.def || null })) };
  }

  app.get("/api/cms/automations", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const v = await collect(c, { fresh: c.req.query("fresh") === "1" });
    const x = buildContext(v.s, v.d, now());
    const access = await accessOf(c);
    const flows = allDefs(v).map((def) => summarize(def, x, access));
    const health = flows.flatMap((f) => (f.health || []).map((h) => ({ ...h, flowId: f.id, flowName: f.name }))).sort((a, b) => ["error", "warn", "info"].indexOf(a.level) - ["error", "warn", "info"].indexOf(b.level));
    return c.json({ ok: true, generatedAt: new Date(v.at).toISOString(), categories: CATEGORIES, flows, health, globals: globalsOf(x), builder: builderInfo(v),
      unavailable: v.failed, access: { owner: access.owner, role: access.role || "owner" }, testPhones: access.owner ? [...testPhoneSet(v.s)].map((p) => `0${p}`) : [] });
  });

  async function findDef(c, id, opts) {
    const v = await collect(c, opts);
    return { v, def: allDefs(v).find((f) => f.id === id) || null };
  }

  app.get("/api/cms/automations/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = c.req.param("id");
    const base = CATALOG.find((f) => f.id === id);
    const { v, def } = await findDef(c, id, { fresh: c.req.query("fresh") === "1", extra: base?.detailSources || [] });
    if (!def) return c.json({ ok: false, error: "not_found", message: "الفلو ده مش موجود" }, 404);
    const x = buildContext(v.s, v.d, now());
    const flow = summarize(def, x, await accessOf(c));
    if (def.metricsDetail) flow.metrics = safe(() => def.metricsDetail(v.d)) || flow.metrics;
    let log = def.log ? safe(() => def.log(v.d), []) : [];
    if (def.cmsId) { const r = await inner(c, "GET", `/api/cms/flows-runs?flow=${def.cmsId}&limit=20`); log = (r.json?.runs || []).map((x2) => ({ at: x2.at, text: `دخل ${ar(x2.entrants || 0)} · اتبعت ${ar(x2.sent || 0)} · محجوز ${ar(x2.holdout || 0)}${x2.stopped ? ` · ${x2.stopped}` : ""}` })); }
    if (def.autoId) {
      const runs = await store.recentRuns(def.autoId, 20).catch(() => []);
      log = runs.map((r) => ({ at: r.at, text: `${r.note ? `${r.note} · ` : ""}دخل ${ar(r.entered || 0)} · اتبعت ${ar(r.sent || 0)} · محجوز ${ar(r.holdout || 0)} · هدف ${ar(r.converted || 0)}${sumObj(r.skipped) ? ` · اتشال ${ar(sumObj(r.skipped))}` : ""}` }));
      flow.events = (await store.recentEvents(def.autoId, 30).catch(() => [])).map((e) => ({ at: e.at, kind: e.kind, channel: e.channel, step: e.step_id, reason: e.reason, tail: e.tail || (e.phone_norm ? String(e.phone_norm).slice(-4) : null) }));
    }
    /* سجل النشاط: كل تعديل اتعمل على الفلو ده (من هنا أو من شاشته القديمة) */
    const reqPaths = [...new Set((def.fields || []).map((p) => { const w = writerFor(p); return w ? w.build([{ path: p, value: null }], v.s, {}).path : null; }).filter(Boolean))];
    let activity = [];
    try {
      activity = (await pool.query(
        `SELECT at, actor_name, role, method, path, note FROM cms_audit
          WHERE note LIKE $1 OR (method <> 'GET' AND path = ANY($2::text[])) ORDER BY at DESC LIMIT 30`, [`⚡ [${id}]%`, reqPaths])).rows
        .map((r) => ({ at: r.at, who: r.actor_name || r.role || "—", via: String(r.path || "").startsWith("/api/cms/automations") ? "مركز الأتمتة" : "الشاشة الأصلية", note: r.note || `${r.method} ${r.path}` }));
    } catch { /* السجل اختياري */ }
    return c.json({ ok: true, flow, log, activity });
  });

  /* التعديل: نفس مسار حفظ شاشة الفلو، بنفس التوكن */
  async function applyChanges(c, def, changes, { confirm = false, v }) {
    if (def.custom) return applyCustom(c, def, changes, { confirm });
    const flowSum = summarize(def, buildContext(v.s, v.d, now()), await accessOf(c));
    const errors = precheck(changes, flowSum);
    if (errors.length) return { status: 400, body: { ok: false, error: "invalid", errors, message: errors.map((e) => e.error).join(" · ") } };
    const locked = flowSum.fields.filter((f) => f.path in changes && !f.editable);
    if (locked.length) return { status: 403, body: { ok: false, error: "forbidden", message: locked.map((f) => `${f.label}: ${f.lock}`).join(" · ") } };
    const risky = riskyChanges(changes, v.s, flowSum);
    if (risky.length && !confirm) return { status: 409, body: { ok: false, error: "confirm_required", needConfirm: true, risky, message: "التغيير ده محتاج تأكيد" } };
    const { plan, unknown } = planWrites(changes, v.s, { confirm, cmsFlows: v.d["/api/cms/flows"]?.flows || [] });
    if (unknown.length) return { status: 400, body: { ok: false, error: "invalid", message: `مالوش مسار حفظ: ${unknown.join(", ")}` } };
    const results = [];
    for (const p of plan) {
      const r = await inner(c, p.req.method, p.req.path, p.req.body);
      results.push({ writer: p.writer, label: p.label, status: r.status, ok: r.ok });
      if (!r.ok) {
        const msg = r.json?.message || (Array.isArray(r.json?.errors) ? r.json.errors.map((e) => (typeof e === "string" ? e : e.error || e.path)).join(" · ") : null) || r.json?.error || `HTTP ${r.status}`;
        return { status: r.status === 409 ? 409 : r.status >= 400 && r.status < 500 ? r.status : 502, body: { ok: false, error: r.json?.error || "save_failed", message: `«${p.label}» رفض الحفظ: ${msg}`, results, needConfirm: r.json?.error === "confirm_required" } };
      }
    }
    const line = `⚡ [${def.id}] «${def.name}»: ${Object.entries(changes).map(([p, val]) => `${(flowSum.fields.find((f) => f.path === p) || {}).label || p}: ${fmtV(flowSum.values[p])} ← ${fmtV(val)}`).join(" · ")}`.slice(0, 500);
    await note(c, line);
    cache.clear();
    return { status: 200, body: { ok: true, results, note: line } };
  }

  /* الفلوهات الجديدة: التشغيل للمالك بس (زي بدء الحملات)، والتعديل لدور «العملاء» */
  async function applyCustom(c, def, changes, { confirm }) {
    const sw = def.switch;
    const keys = Object.keys(changes);
    if (keys.some((k) => k !== sw)) return { status: 400, body: { ok: false, error: "invalid", message: "عدّل خطوات الفلو من «تعديل الفلو»" } };
    const on = changes[sw] === true;
    if (on && !(await isOwner(c))) return { status: 403, body: { ok: false, error: "owner_only", message: "تشغيل فلو جديد للمالك بس" } };
    if (on) { const val = await validateFor(c, def.def); const errs = [...def.defErrors, ...val.errors]; if (errs.length) return { status: 400, body: { ok: false, error: "invalid", errors: errs, message: `صلّح الفلو الأول: ${errs.map((e) => e.error).join(" · ")}` } }; }
    if (on && !def.values[sw] && !confirm) return { status: 409, body: { ok: false, error: "confirm_required", needConfirm: true, risky: [{ path: sw, label: "الفلو شغّال", from: false, to: true, why: def.audience === "customers" ? "تشغيل رسايل للعملاء" : "تشغيل تنبيهات" }], message: "التشغيل محتاج تأكيد" } };
    await store.updateFlow(def.autoId, on ? { active: true, activated_at: now().toISOString(), baseline_at: null, last_event_at: null, last_slot: null } : { active: false });
    const line = `⚡ [${def.id}] «${def.name}»: ${on ? "اتشغّل" : "اتقفل"}`;
    await note(c, line); cache.clear();
    return { status: 200, body: { ok: true, note: line } };
  }

  app.patch("/api/cms/automations/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    if (!isObj(b?.changes) || !Object.keys(b.changes).length) return c.json({ ok: false, error: "invalid", message: "مفيش تغييرات" }, 400);
    if (Object.keys(b.changes).length > 30) return c.json({ ok: false, error: "invalid", message: "تغييرات كتير في طلب واحد" }, 400);
    const { v, def } = await findDef(c, c.req.param("id"), { fresh: true });
    if (!def) return c.json({ ok: false, error: "not_found" }, 404);
    const r = await applyChanges(c, def, b.changes, { confirm: b.confirm === true, v });
    return c.json(r.body, r.status);
  });

  async function toggle(c, id, on, confirm) {
    const { v, def } = await findDef(c, id, { fresh: true });
    if (!def) return { status: 404, body: { ok: false, error: "not_found" } };
    if (!def.switch) return { status: 400, body: { ok: false, error: "no_switch", message: "الفلو ده مالوش مفتاح واحد — اتحكم فيه من إعداداته" } };
    const val = def.switchInverted ? !on : on;
    return applyChanges(c, def, { [def.switch]: val }, { confirm, v });
  }
  app.post("/api/cms/automations/:id/pause", async (c) => { const err = await requireAdmin(c); if (err) return err; const b = await c.req.json().catch(() => ({})); const r = await toggle(c, c.req.param("id"), false, b?.confirm === true); return c.json(r.body, r.status); });
  app.post("/api/cms/automations/:id/resume", async (c) => { const err = await requireAdmin(c); if (err) return err; const b = await c.req.json().catch(() => ({})); const r = await toggle(c, c.req.param("id"), true, b?.confirm === true); return c.json(r.body, r.status); });
  app.post("/api/cms/automations/bulk", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const ids = Array.isArray(b?.ids) ? b.ids.slice(0, 40).map(String) : [];
    if (!ids.length || !["pause", "resume"].includes(b?.action)) return c.json({ ok: false, error: "invalid", message: "اختار فلوهات وإيقاف/تشغيل" }, 400);
    const out = [];
    for (const id of ids) { const r = await toggle(c, id, b.action === "resume", b.confirm === true); out.push({ id, ok: r.body.ok, status: r.status, message: r.body.message || null, risky: r.body.risky || null }); }
    const need = out.filter((x) => x.status === 409);
    return c.json({ ok: out.every((x) => x.ok), results: out, needConfirm: need.length > 0 && !b.confirm }, need.length && !b.confirm ? 409 : 200);
  });

  /* «جرّب على موبايلي»: أرقام الفريق والتجربة بس — مايدخلش حد في الفلو */
  app.post("/api/cms/automations/:id/test", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const { v, def } = await findDef(c, c.req.param("id"));
    if (!def) return c.json({ ok: false, error: "not_found" }, 404);
    if (!def.test) return c.json({ ok: false, error: "no_test", message: "التجربة للفلو ده من شاشته" }, 400);
    if (def.test.ownerOnly && !(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "التجربة للمالك بس" }, 403);
    const allowed = testPhoneSet(v.s);
    const phone = normPhone(b?.phone);
    const needsPhone = def.test.kind === "custom" || /\(phone\)/.test(String(def.test.body));
    if (needsPhone && (!phone || !allowed.has(phone))) return c.json({ ok: false, error: "not_test_phone", message: "التجربة لأرقام الفريق والتجربة بس (أرقام الإنذار / أرقام تجربة البوت / قايمة الفريق)" }, 400);
    if (def.test.kind === "custom") {
      const flow = await store.getFlow(def.autoId);
      const r = await engine().testSend(flow, phone, { allowed });
      await note(c, `⚡ [${def.id}] «${def.name}»: تجربة لـ…${phone.slice(-4)} ${r.ok ? "اتبعتت" : `فشلت (${r.error})`}`);
      return c.json(r, r.ok ? 200 : 400);
    }
    const r = await inner(c, def.test.method, def.test.path, def.test.body(phone));
    await note(c, `⚡ [${def.id}] «${def.name}»: تجربة ${needsPhone ? `لـ…${phone.slice(-4)}` : "لأرقام الفريق"} ${r.ok ? "اتبعتت" : "فشلت"}`);
    return c.json({ ok: r.ok, status: r.status, result: r.json }, r.ok ? 200 : r.status >= 400 && r.status < 500 ? r.status : 502);
  });

  /* ── الفلوهات الجديدة: إنشاء / تعديل / أرشفة / من قالب ── */
  async function validateFor(c, def) {
    const v = await collect(c);
    const segments = new Set((v.segs || []).map((x) => x.id));
    const templates = new Set([...templateStatusMap(v.d["/api/cms/wa/templates"]?.rows || []).entries()].filter(([, st]) => st === "APPROVED").map(([n]) => n));
    return af.validateDef(def, { segments: segments.size ? segments : null, templates: templates.size ? templates : null });
  }
  const who = async (c) => { try { const u = await cms()?.whoami?.(c); return (u && (u.name || u.username)) || null; } catch { return null; } };
  app.post("/api/cms/automations/custom", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const name = String(b?.name || "").trim().slice(0, 80);
    if (!name) return c.json({ ok: false, error: "invalid", message: "اكتب اسم للفلو" }, 400);
    const val = await validateFor(c, b.def);
    /* المسودة بتتحفظ حتى لو ناقصة (عشان المالك يكمّل) — بس التشغيل بيرفض أي غلطة */
    const row = await store.createFlow({ name, icon: String(b.icon || "✨").slice(0, 8), def: val.def, template: b.template ? String(b.template).slice(0, 40) : null, createdBy: await who(c) });
    await note(c, `⚡ [auto-${row.id}] «${name}»: فلو جديد (مقفول)${val.ok ? "" : ` — ناقص: ${val.errors.map((e) => e.error).join(" · ")}`}`.slice(0, 500));
    cache.clear();
    return c.json({ ok: true, id: `auto-${row.id}`, errors: val.errors });
  });
  app.put("/api/cms/automations/custom/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(String(c.req.param("id")).replace(/^auto-/, ""));
    const cur = await store.getFlow(id);
    if (!cur || cur.archived) return c.json({ ok: false, error: "not_found" }, 404);
    const b = await c.req.json().catch(() => ({}));
    const val = await validateFor(c, b.def ?? cur.def);
    if (cur.active && !val.ok) return c.json({ ok: false, error: "invalid", errors: val.errors, message: "الفلو شغّال — صلّح الغلطات الأول أو اقفله" }, 400);
    if (cur.active && !(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "تعديل فلو شغّال للمالك بس — اقفله الأول أو اطلب من المالك" }, 403);
    const patch = { def: val.def };
    if (b.name) patch.name = String(b.name).trim().slice(0, 80);
    if (b.icon) patch.icon = String(b.icon).slice(0, 8);
    /* المحفّز اتغيّر في فلو شغّال ⇒ نقطة بداية جديدة (مفيش إرسال جماعي مفاجئ) */
    if (cur.active && JSON.stringify(cur.def?.trigger) !== JSON.stringify(val.def.trigger)) Object.assign(patch, { baseline_at: null, last_slot: null, last_event_at: null, activated_at: now().toISOString() });
    await store.updateFlow(id, patch);
    await note(c, `⚡ [auto-${id}] «${patch.name || cur.name}»: الخطوات اتعدّلت`);
    cache.clear();
    return c.json({ ok: true, errors: val.errors });
  });
  app.delete("/api/cms/automations/custom/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(String(c.req.param("id")).replace(/^auto-/, ""));
    const cur = await store.getFlow(id);
    if (!cur) return c.json({ ok: false, error: "not_found" }, 404);
    await store.updateFlow(id, { active: false, archived: true });      // أرشفة (الأرقام والسجل بيفضلوا)
    await note(c, `⚡ [auto-${id}] «${cur.name}»: اتشال (أرشيف)`);
    cache.clear();
    return c.json({ ok: true });
  });
  /* حجم الجمهور التقريبي قبل التشغيل (الشريحة دلوقتي) — قراية بس */
  app.post("/api/cms/automations/custom/preview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const val = await validateFor(c, b.def);
    let segmentSize = null;
    const seg = val.def.trigger.segment;
    if (seg) { try { segmentSize = (await cms()?.segmentPhones?.(seg))?.length ?? null; } catch { /* */ } }
    return c.json({ ok: true, valid: val.ok, errors: val.errors, def: val.def, segmentSize, next: af.nextScheduleTimes(val.def.trigger, now(), 5),
      note: val.def.trigger.type === "segment_entry" ? "أول تشغيل = نقطة بداية: الموجودين في الشريحة دلوقتي مش هيتبعتلهم" : null });
  });
  app.post("/api/cms/automations/from-template", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const g = GALLERY.find((x) => x.id === b?.template);
    if (!g) return c.json({ ok: false, error: "not_found", message: "القالب مش موجود" }, 404);
    if (g.kind === "classic") {
      const r = await inner(c, "POST", "/api/cms/flows", { name: g.cms.name, segment: g.cms.segment, channel: g.cms.channel, message: g.cms.message, offer: g.cms.offer, holdout_pct: g.cms.holdout_pct });
      cache.clear();
      if (!r.ok) return c.json({ ok: false, error: r.json?.error || "save_failed", message: `أتمتة الشرائح رفضت: ${r.json?.error || r.status}` }, r.status >= 400 && r.status < 500 ? r.status : 502);
      await note(c, `⚡ [cmsflow-${r.json?.flow?.id}] «${g.cms.name}»: اتعملت من المعرض (مقفولة)`);
      return c.json({ ok: true, id: `cmsflow-${r.json?.flow?.id}` });
    }
    const name = String(b?.name || g.name).slice(0, 80);
    const val = await validateFor(c, g.def);
    const row = await store.createFlow({ name, icon: g.icon, def: val.def, template: g.id, createdBy: await who(c) });
    await note(c, `⚡ [auto-${row.id}] «${name}»: من القالب «${g.name}» (مقفول)`);
    cache.clear();
    return c.json({ ok: true, id: `auto-${row.id}`, errors: val.errors });
  });

  /* ── المحرّك: بيعدّي على نفس المرسلين والحراس ── */
  let _engine = null;
  function engine() {
    if (_engine) return _engine;
    const api = cms();
    const quietUntil = async (channel, s, t) => {
      if (channel === "wa_template" || channel === "wa_text") {
        const open = isRestaurantOpenAt(t, s);
        if (open === true) return null;
        if (open === false) return nextSendOpenAt(t, s) || new Date(t.getTime() + 3600_000);
      }
      if (!smsRules.inQuietFor(s, t)) return null;
      const q = smsRules.quietOf(s);
      const r = new Date(t.getTime() + 3 * 3600_000);
      let end = Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate(), q.end) - 3 * 3600_000;
      if (end <= t.getTime()) end += 86400_000;
      return new Date(end + 5 * 60_000);
    };
    _engine = deps.engine || af.makeEngine({
      store, now, getSettings: async () => (await getSettingsData()) || {},
      segmentPhones: async (seg) => (await api?.segmentPhones?.(seg)) || [],
      eventsSince: async (type, since) => {
        const paid = paidOf("o");
        const first = type === "first_order" ? `AND NOT EXISTS (SELECT 1 FROM shop_orders p WHERE p.phone_norm = o.phone_norm AND p.created_at < o.created_at AND ${paidOf("p")})` : "";
        const r = await pool.query(`SELECT o.phone_norm AS pn, o.created_at AS at, o.order_no AS ref FROM shop_orders o
            WHERE o.phone_norm IS NOT NULL AND ${paid} AND o.created_at > $1 ${first} ORDER BY o.created_at LIMIT 500`, [since]);
        return r.rows.map((x) => ({ pn: x.pn, at: new Date(x.at).toISOString(), ref: x.ref }));
      },
      profiles: async (pns) => (await api?.autoProfiles?.(pns)) || new Map(),
      guard: async (channel, pn) => {
        if (channel === "staff_alert") return { ok: true };
        if (channel === "wa_template" || channel === "wa_text") return { ok: true };      // guardSend جوّه المرسل (إيقاف/موافقة/سقف العميل/هدوء الدفعات)
        const g = await api?.autoGuard?.(channel, [pn]);
        if (!g) return { ok: false, reason: "guard_unavailable" };
        if (g.ok.has(pn)) return { ok: true };
        if (g.retry.has(pn)) return { ok: false, reason: "daily_cap", retry: true };
        return { ok: false, reason: Object.keys(g.skipped || {})[0] || "guard" };
      },
      quietUntil,
      send: {
        push: async (pn, p, meta) => { const ok = await deps.notify?.()?.sendToAudience?.({ phoneNorm: pn, title: p.title, body: p.body, url: p.url || undefined, stage: meta?.test ? "test" : "automation" }); if (ok && !meta?.test) await api?.autoLogSend?.(meta.flowId, pn); return { ok: Boolean(ok), error: ok ? null : "no_push" }; },
        sms: async (pn, p, meta) => { const r = await api?.waFallbackSms?.({ phoneNorm: pn, text: p.text, ref: `auto:${meta.flowId}:${meta.stepId}${meta?.test ? ":test" : ""}` }); if (r?.ok && !meta?.test) await api?.autoLogSend?.(meta.flowId, pn); return r?.ok ? { ok: true } : { ok: false, error: r?.skipped || r?.error || "sms_failed" }; },
        wa_template: async (pn, p, meta) => { const wa = deps.wa?.(); if (!wa?.sendTemplate) return { ok: false, error: "wa_unavailable" }; const r = await wa.sendTemplate({ phoneNorm: pn, template: p.template, params: { body: p.params || [] }, source: "automation", proactive: true, ...(meta?.test ? { test: true } : {}) }); return r?.ok ? { ok: true } : { ok: false, error: r?.skipped || r?.error || "wa_failed" }; },
        wa_text: async (pn, p, meta) => { const wa = deps.wa?.(); if (!wa?.sendFreeform) return { ok: false, error: "wa_unavailable" }; const r = await wa.sendFreeform({ phoneNorm: pn, payload: { type: "text", text: { body: p.text } }, preview: p.text, source: "automation", proactive: true, ...(meta?.test ? { test: true } : {}) }); return r?.ok ? { ok: true } : { ok: false, error: r?.skipped || r?.error || "wa_failed" }; },
        staff_alert: async (pn, p) => { const st = deps.staff?.(); if (!st?.critical) return { ok: false, error: "staff_unavailable" }; await st.critical(() => `${p.text} (…${String(pn).slice(-4)})`, "automation"); return { ok: true }; },
      },
      ordered: async (pn, a, b2) => {
        const paid = paidOf("o");
        const r = await pool.query(`SELECT count(*)::int AS n, COALESCE(sum(o.total),0)::float AS revenue FROM shop_orders o WHERE o.phone_norm=$1 AND ${paid} AND o.created_at >= $2 AND o.created_at <= $3`, [pn, a, b2]);
        return r.rows[0] || { n: 0, revenue: 0 };
      },
      replied: async (pn, since) => (await pool.query("SELECT 1 FROM wa_messages WHERE direction='in' AND phone_norm=$1 AND created_at > $2 LIMIT 1", [pn, since]).catch(() => ({ rowCount: 0 }))).rowCount > 0,
    });
    return _engine;
  }
  if (!deps.noTimer && !process.env.NODE_TEST_CONTEXT && process.env.AUTOFLOWS_ENGINE !== "0") {
    const t = setInterval(() => engine().tick("cron").catch((e) => console.error("[auto] tick:", e.message)), 10 * 60_000);
    t.unref?.();
    console.log("[auto] مركز الأتمتة: المحرّك كل ١٠ دقايق (الفلوهات الجديدة المشغّلة بس)");
  }
  return { engine, collect, store };
}
