/* ═══════════════════════════════════════════════════════════════════════════
   sendhours.js — إرسال واتساب الآلي مربوط بمواعيد المطعم (عمر ١٨/١٠/٢٠٢٦)

   عمر بنصّه: «ارسال الواتس كله اعترضت — المطعم شغال طول اليوم، كل الرسايل المربوطة إن المطعم مفتوح تتبعت عادي في وقتها».
   قبل كده كل مسار واتساب آلي كان ليه ساعات ثابتة بتاعته: الإرسال الآلي ١٣→٢٢، حارس النافذة هدوء ٠٢→١١، التقييم ٢٣:٣٠→١١:٣٠،
   متابعة اللي ردّ ١٢→١:٣٠، التذكير ٠٢→١٢ … فرسايل العشا وآخر الليل (وقت الذروة الحقيقي) كانت بتتأجّل للصبح أو تتلغي.

   القاعدة الجديدة (مصدر واحد): الرسالة الآلية تتبعت **لما المطعم مفتوح** حسب settings.hours (نفس مواعيد المتجر «مقفول / نبّهني لما نفتح»
   ونافذة الإعلانات — carts.isOpenNow بيراعي وردية بعد نص الليل)، وبتقف قبل القفل بـ stopBeforeCloseMin (افتراضي ٣٠ دقيقة).
     • الإعداد: settings.waSendHours = { enabled (افتراضي مفتوح), stopBeforeCloseMin (٠–١٨٠) } — من اللوحة («الإرسال مرتبط بمواعيد المطعم»)، المالك بس.
     • مقفول، أو مواعيد المطعم مش متعرّفة في الإعدادات ⇒ كل مسار بيرجع لساعاته القديمة زي ما هي (isRestaurantOpenAt ⇒ null).
     • القواعد اللي لكل رسالة لسه شغّالة فوقه: السقوف، قواعد الدفعات CJ1a، custCap7d، الفاصل، الإيقاف، الفرامل.
     • مش هنا عن قصد: رسايل حالة الطلب، الـOTP، والرد على كلام العميل — دول فوريين دايماً. وقنوات الـSMS/الإشعارات ليها ساعات الهدوء بتاعتها.
═══════════════════════════════════════════════════════════════════════════ */
import { isOpenNow } from "./carts.js";

export const SEND_HOURS_DEFAULTS = Object.freeze({ enabled: true, stopBeforeCloseMin: 30 });
export const SEND_HOURS_LIMITS = Object.freeze({ stopBeforeCloseMin: [0, 180] });
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/* المواعيد متعرّفة فعلاً؟ (isOpenNow بيرجع «مفتوح» لو مش متعرّفة — هنا ده معناه «ارجع للساعات القديمة» مش «ابعت ٢٤ ساعة») */
export function hoursKnown(hours) {
  if (!hours || typeof hours !== "object" || hours.enabled === false || !hours.days || typeof hours.days !== "object") return false;
  return DAYS.some((d) => { const x = hours.days[d]; return x && !x.closed && HHMM_RE.test(String(x.open || "")) && HHMM_RE.test(String(x.close || "")); });
}

/* settings ⇒ { enabled, stopBeforeCloseMin, hours, active } — active = الإعداد مفتوح والمواعيد متعرّفة */
export function sendHoursCfg(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const x = s.waSendHours && typeof s.waSendHours === "object" && !Array.isArray(s.waSendHours) ? s.waSendHours : {};
  const n = Number(x.stopBeforeCloseMin);
  const [lo, hi] = SEND_HOURS_LIMITS.stopBeforeCloseMin;
  const stop = x.stopBeforeCloseMin !== "" && x.stopBeforeCloseMin !== null && x.stopBeforeCloseMin !== undefined && Number.isFinite(n)
    ? Math.min(hi, Math.max(lo, Math.round(n))) : SEND_HOURS_DEFAULTS.stopBeforeCloseMin;
  const enabled = x.enabled !== false;
  const hours = s.hours || null;
  return { enabled, stopBeforeCloseMin: stop, hours, active: enabled && hoursKnown(hours) };
}
const cfgOf = (x) => (x && typeof x === "object" && "active" in x && "stopBeforeCloseMin" in x ? x : sendHoursCfg(x));

/* الشرط الواحد: مفتوح دلوقتي **وكمان** بعد stopBeforeCloseMin (يعني مش في آخر نص ساعة قبل القفل).
   ⇒ true | false، أو null = الإعداد مقفول / المواعيد مش متعرّفة (المنادي يرجع لساعاته القديمة). */
export function isRestaurantOpenAt(now, settingsOrCfg) {
  const c = cfgOf(settingsOrCfg);
  if (!c.active) return null;
  const t = new Date(now instanceof Date ? now.getTime() : Number(now) || Date.parse(now));
  if (!Number.isFinite(t.getTime())) return false;
  if (!isOpenNow(c.hours, t)) return false;
  return c.stopBeforeCloseMin > 0 ? isOpenNow(c.hours, new Date(t.getTime() + c.stopBeforeCloseMin * 60_000)) : true;
}

/* بوابة لمسار عنده ساعات قديمة: الإعداد شغّال ⇒ مواعيد المطعم؛ غير كده ⇒ legacy() (ساعات المسار القديمة زي ما هي). */
export function sendAllowed(now, settingsOrCfg, legacy) {
  const r = isRestaurantOpenAt(now, settingsOrCfg);
  if (r === null) return typeof legacy === "function" ? Boolean(legacy(now)) : true;
  return r;
}

/* أول لحظة مسموحة من دلوقتي (خطوات ٥ دقايق، لحد ٨ أيام) ⇒ Date، أو null لو الإعداد مش شغّال / مفيش فتح خالص. لو مسموح دلوقتي ⇒ دلوقتي. */
export function nextSendOpenAt(now, settingsOrCfg, { stepMin = 5, maxDays = 8 } = {}) {
  const c = cfgOf(settingsOrCfg);
  if (!c.active) return null;
  const t0 = now instanceof Date ? now.getTime() : Number(now) || Date.parse(now);
  if (!Number.isFinite(t0)) return null;
  if (isRestaurantOpenAt(t0, c)) return new Date(t0);
  const step = Math.max(1, stepMin) * 60_000;
  let t = Math.ceil(t0 / step) * step;
  for (const end = t0 + maxDays * 86400_000; t <= end; t += step) {
    if (isRestaurantOpenAt(t, c)) {
      /* دقّة الدقيقة: نرجع لورا لحد أول دقيقة مسموحة جوّه الخطوة (الفتح ١٣:٠٧ ⇒ ١٣:٠٧ مش ١٣:١٠) */
      let m = t;
      while (m - 60_000 > t0 && isRestaurantOpenAt(m - 60_000, c)) m -= 60_000;
      return new Date(m);
    }
  }
  return null;
}

/* من جسم اللوحة ⇒ { ok, value } أو { ok:false, errors } (دمج مع المتخزّن) */
export function sendHoursFromBody(b, prev) {
  const errors = [];
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, errors: ["waSendHours: كائن"] };
  const out = { ...SEND_HOURS_DEFAULTS, ...((prev && typeof prev === "object" && !Array.isArray(prev)) ? prev : {}) };
  for (const [k, v] of Object.entries(b)) {
    if (k === "enabled") { if (typeof v === "boolean") out.enabled = v; else errors.push("enabled: مفتوح/مقفول"); }
    else if (k === "stopBeforeCloseMin") {
      const n = Number(v), [lo, hi] = SEND_HOURS_LIMITS.stopBeforeCloseMin;
      if (v === "" || v === null || !Number.isFinite(n) || n < lo || n > hi) errors.push(`stopBeforeCloseMin: ${lo}–${hi}`); else out.stopBeforeCloseMin = Math.round(n);
    } else errors.push(`${k}: إعداد مش معروف`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { enabled: out.enabled !== false, stopBeforeCloseMin: out.stopBeforeCloseMin } };
}

/* المسارات اللي بقت مربوطة بالبوابة دي (للوحة والتقرير) — نفس الترتيب اللي في الكود */
export const SEND_HOURS_PATHS = Object.freeze([
  { id: "campaigns", ar: "حملات واتساب (Cloud + واتساب ويب) والإرسال على عادة العميل", was: "ساعات الإرسال ١٣:٠٠–٢٢:٠٠ (waSender.startHour/endHour)" },
  { id: "reviews", ar: "طلب التقييم على واتساب (كل أنواع الطلبات)", was: "هدوء ٢٣:٣٠–١١:٣٠ والتأجيل لـ١:٠٠ الضهر (waBot.reviewFlow)" },
  { id: "window_keep", ar: "رسالة قبل قفل نافذة الـ٢٤ ساعة", was: "هدوء ٠٢:٠٠–١١:٠٠ (waBot.windowKeeperQuiet*)" },
  { id: "reply_followup", ar: "متابعة اللي ردّ على حملة وماطلبش", was: "الساعات المسموحة ١٢:٠٠–١:٣٠ (waBot.replyFollowUpFrom/To)" },
  { id: "assist_reminder", ar: "تذكير المساعد اللي العميل طلبه", was: "هدوء ٠٢:٠٠–١٢:٠٠ + المطعم مفتوح (assist.reminderQuiet*)" },
  { id: "ka2", ar: "رسالة ما بعد طلب كيتا (KA2)", was: "جديدة — من غير نافذة خاصة" },
]);
export const SEND_HOURS_KEPT = Object.freeze([
  { id: "order_status", ar: "تحديثات حالة الطلب ورسايل الطلب (استلمنا / مع المندوب / وصل / جاهز)", why: "فورية دايماً — العميل مستنيها" },
  { id: "otp", ar: "كود التحقق (OTP)", why: "العميل طالبه دلوقتي" },
  { id: "replies", ar: "رد البوت والمساعد والموظف على كلام العميل", why: "رد على رسالة العميل" },
  { id: "staff", ar: "قوالب الفريق والمندوب الخارجي ونافذة الفريق", why: "مش عملاء" },
  { id: "sms_push", ar: "حملات وأتمتة الـSMS والإشعارات، SMS بديل التقييم", why: "قنوات تانية ليها ساعات الهدوء بتاعتها (cms.campaigns.quietStart/End)" },
]);

/* للوحة: الحالة الحالية */
export function sendHoursView(settings, now = new Date()) {
  const c = sendHoursCfg(settings);
  const open = c.active ? isOpenNow(c.hours, now) : null;
  const allowed = isRestaurantOpenAt(now, c);
  const next = c.active && !allowed ? nextSendOpenAt(now, c) : null;
  return { enabled: c.enabled, stopBeforeCloseMin: c.stopBeforeCloseMin, hoursKnown: hoursKnown(c.hours), active: c.active,
    openNow: open, sendNow: allowed, nextSendAt: next ? next.toISOString() : null, paths: SEND_HOURS_PATHS, kept: SEND_HOURS_KEPT, defaults: SEND_HOURS_DEFAULTS, limits: SEND_HOURS_LIMITS };
}

/* GET /api/cms/wa-send-hours (أي أدمن يشوف) · PUT (المالك بس) — settings.waSendHours بـjsonb_set (مسار ملك السيرفر) + سطر في سجل النشاط */
export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, isOwner, auditNote } = ctx;
  app.get("/api/cms/wa-send-hours", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, ...sendHoursView(await getSettingsData()) });
  });
  app.put("/api/cms/wa-send-hours", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "المالك بس" }, 403);
    const b = await c.req.json().catch(() => null);
    const s = await getSettingsData();
    const r = sendHoursFromBody(b, s && s.waSendHours);
    if (!r.ok) return c.json({ ok: false, error: r.errors.join(" · ") }, 400);
    await pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waSendHours}', $1::jsonb, true) WHERE id=1`, [JSON.stringify(r.value)]);
    await auditNote?.(c, `واتساب: الإرسال مرتبط بمواعيد المطعم ${r.value.enabled ? "مفتوح" : "مقفول"} · يقف قبل القفل بـ${r.value.stopBeforeCloseMin} د`);
    return c.json({ ok: true, ...sendHoursView({ ...(s || {}), waSendHours: r.value }) });
  });
}
