/* ═══════════════════════════════════════════════════════════════════════════
   👥 تواصل الفريق على واتساب (ST1 — ١٢/١٠، طلبات عمر بنصها):
     ١) «خلي التواصل مع الفريق يكون عن طريق الواتس»
     ٢) «خلي الموظفين دايما يضغطوا زرار عشان رسايلهم تكون مجانية… يتبعتلهم حر دايما قبل ال٢٠ ساعة ما يعدوا زرار يضغطوا عليه»
     ٣) «دايما عايز في حاجات غريبة تتبعت للمدير وللملاك»
     ٤) رد «أسرارنا» يبقى سطر مهني + رسالة للملاك والمدير بالمحادثة (في الحر)

   اللي في الملف ده:
     • دليل الفريق (settings.waTeam.members: رقم + اسم + دور cashier / manager / owner) وتوزيع المواضيع على الأدوار
       (routing): handover = كل التحويلات · urgent = التحويلات العاجلة بس · odd = «حاجات غريبة» · digest = الملخص اليومي.
     • الإرسال لموظف واحد (sendToStaff) — بالترتيب: رسالة حرة لو نافذة الـ٢٤ ساعة بتاعته مفتوحة (ببلاش) ⇒ قالب فريق UTILITY
       معتمد لو مقفولة ⇒ SMS كآخر حل (ومتسجّل إنه SMS). **كل** إرسال واتساب من هنا بيعدّي من حارس whatsapp.js
       (sendFreeform / sendStaffTemplate ⇒ guardSend ⇒ deliver). مفيش نداء Graph هنا. ومفيش أي إرسال لعميل من الملف ده:
       المستلم لازم يكون في دليل الفريق (والحارس بيتأكد بنفسه للقوالب: not_staff).
     • حارس النافذة (keeper): لكل موظف، عند الساعة ٢٠ من آخر رسالة منه ⇒ رسالة حرة بزر واحد «✅ جدّد التنبيهات» (الضغطة رسالة واردة ⇒
       النافذة بتتجدد). لو النافذة قفلت ⇒ قالب التجديد مرة واحدة وبعدها نستنى ضغطته. ساعات الهدوء (٠٢:٠٠–١٠:٠٠ الرياض افتراضياً): لو
       الساعة ٢٠ هتيجي جوّه الهدوء، التجديد بيتبعت قبل بداية الهدوء.
     • «حاجات غريبة» (odd): لكل نوع مفتاح، سقف في الساعة، ووضع ملخص (digest) بيجمّع بدل ما يبعت واحدة واحدة. الرسالة فيها مقتطف
       آخر ٦ رسايل (نص العميل مقنّع بـmaskText، والرقم آخر ٤ أرقام بس) ورابط المحادثة في اللوحة.
     • أرقام الفريق مش عملاء: الوارد منهم بيتمسك هنا (inbound) قبل البوت — ضغطة الزر وكام أمر (حالة / مساعدة / تنبيهات / ملخص)، وأي
       حاجة تانية بتتسجّل وتعدّي في صمت (مفيش ترحيب ولا بيع ولا تحويل عن نفسهم).

   الجداول: wa_team_state (حالة حارس النافذة لكل رقم) · wa_team_log (كل محاولة إرسال: القناة والنتيجة) · wa_team_odd (طابور الحاجات الغريبة).
   المسارات:
     GET  /api/cms/wabot/team            الإعدادات + حالة نافذة كل موظف + القوالب + العدّادات (الأرقام كاملة للمالك بس)
     PUT  /api/cms/wabot/team            حفظ الإعدادات (المالك بس)
     POST /api/cms/wabot/team/test       {phone} رسالة تجربة لموظف **من الدليل بس** (المالك بس)
     GET  /api/portal/wa/team-status     حالة نوافذ الفريق للبورتال (كاشير / مدير) — من غير أرقام
═══════════════════════════════════════════════════════════════════════════ */
import { staffPhones, fitOneSms, staffConfig } from "./staffalerts.js";
import { maskText } from "./wabotllm.js";

export const ROLES = Object.freeze(["cashier", "manager", "owner"]);
export const ROLE_AR = Object.freeze({ cashier: "كاشير", manager: "مدير", owner: "مالك" });
export const TOPICS = Object.freeze(["handover", "urgent", "odd", "digest"]);
export const TOPIC_AR = Object.freeze({ handover: "كل التحويلات لموظف", urgent: "التحويلات العاجلة بس", odd: "حاجات غريبة", digest: "الملخص اليومي" });
export const INBOX_URL = "https://freshcuts-invite.o2m8.me/#store/wa/inbox";
export const PORTAL_URL = "https://freshcuts-invite.o2m8.me/portal/";
export const RENEW_ID = "team:renew";
export const RENEW_TITLE = "✅ جدّد التنبيهات";            // زر الرسالة الحرة (≤٢٠ حرف)
export const RENEW_TITLE_TPL = "جدّد التنبيهات";           // زر القالب: ميتا بترفض الإيموجي في أزرار القوالب
export const TPL_RENEW = "fc_staff_alerts_renew";
export const TPL_NOTICE = "fc_staff_team_notice";
export const TPL_HANDOFF = "fc_staff_wa_handoff";          // قالب قديم في الكتالوج (سبب + ملخص) — بديل للتحويلات لو الجديد لسه مااتعتمدش

/* أنواع «الحاجات الغريبة» — كل نوع مفتاح لوحده (settings.waTeam.odd.kinds) */
export const ODD_KINDS = Object.freeze({
  secret: "سؤال عن وصفة / مقادير / مورّد",
  non_customer: "رسالة شكلها مش من عميل (مورّد / طالب شغل)",
  loop_guard: "حلقة رسايل آلية — البوت اتكتم",
  media_flood: "سيل صور وملفات — البوت اتكتم",
  auto_inbound: "رد آلي من نشاط تجاري تاني",
  complaint: "شكوى",
  payment_problem: "مشكلة دفع / موقع",
  repeated_card: "البوت كرر نفس الرد والعميل لسه بيسأل",
  unsupported_opener: "رسالة مش مدعومة فتحت محادثة",
  customer_stopped: "عميل وقّف الرسايل",
  assist_refused: "رد للمساعد اترفض قبل ما يتبعت",
  budget_cap: "سقف المصروف / السقف اليومي اتوصل له",
  send_failures: "رسايل ورا بعض فشلت في الإرسال",
});
export const ODD_KEYS = Object.keys(ODD_KINDS);
/* ST2 — أسماء الأفعال (نفس الكلام في البورتال واللوحة ورسايل وأزرار واتساب الفريق) ونتايج قفل المحادثة */
export const ACTIONS = Object.freeze({ take: "استلم المحادثة", release: "رجّعها للبوت", done: "خلصت — اقفل", transfer: "حوّل للمدير" });
export const OUTCOMES = Object.freeze([
  { id: "ordered", label: "تم الطلب", hint: "العميل طلب أو هيطلب من الرابط — مفيش حاجة تانية مطلوبة" },
  { id: "answered", label: "استفسار واترد عليه", hint: "سأل واتجاوب عليه" },
  { id: "complaint_solved", label: "شكوى اتحلت", hint: "الشكوى اتحلت والعميل عرف الحل" },
  { id: "follow_up", label: "محتاج متابعة", hint: "لسه فيه حاجة مطلوبة للعميل — اكتبها في الملاحظة" },
  { id: "not_customer", label: "مش عميل", hint: "مورّد / طالب شغل / رقم غلط" },
]);
export const OUTCOME_IDS = OUTCOMES.map((o) => o.id);

export const DEFAULTS = Object.freeze({
  enabled: true,                 // تنبيهات الفريق على واتساب (مقفول ⇒ SMS زي الأول بالظبط)
  routing: Object.freeze({ cashier: ["handover"], manager: ["handover", "odd"], owner: ["urgent", "odd", "digest"] }),
  smsFallback: true,             // تحويل ماقدرش يوصل واتساب (نافذة مقفولة ومفيش قالب معتمد / فشل) ⇒ SMS
  templatesApproved: [],         // أسماء قوالب المالك أكّد إنها معتمدة عند ميتا (لو حدث الاعتماد مااتسجّلش عندنا)
  staffAsTesters: false,         // true ⇒ رقم فريق موجود في أرقام التجربة بيفضل البوت يرد عليه كعميل تجربة (الأزرار والأوامر شغّالة برضه)
  keeper: Object.freeze({ enabled: true, renewAtHour: 20, quietFrom: "02:00", quietTo: "10:00", leadMin: 15, smsNudge: true }),
  odd: Object.freeze({ enabled: true, perHour: 12, digest: false, digestEveryMin: 30, repeatMin: 30, excerpt: 6, smsFallback: false, failStreak: 3, failWindowMin: 15 }),
  daily: Object.freeze({ enabled: true, at: "11:00" }),
  /* ST2 — سلّم التصعيد، قفل المحادثة بنتيجة، وتحويل الكاشير للمدير (waflow.js) */
  ladder: Object.freeze({ enabled: true, managerAfterMin: 5, ownersAfterMin: 10 }),
  close: Object.freeze({ requireOutcome: true, remindAfterMin: 20 }),
  transfer: Object.freeze({ enabled: true }),
});
export const LIMITS = Object.freeze({
  members: 30, name: 40,
  "keeper.renewAtHour": [12, 23], "keeper.leadMin": [5, 60],
  "ladder.managerAfterMin": [1, 60], "ladder.ownersAfterMin": [1, 120], "close.remindAfterMin": [0, 240],
  "odd.perHour": [1, 60], "odd.digestEveryMin": [5, 240], "odd.repeatMin": [5, 720], "odd.excerpt": [0, 10], "odd.failStreak": [2, 20], "odd.failWindowMin": [5, 120],
});

const H = 3600_000;
const clip = (v, n) => String(v ?? "").slice(0, n);
const last4 = (p) => `…${String(p || "").slice(-4)}`;
const normPh = (p) => staffPhones([p])[0] || "";
const hhmmOk = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));
const minOf = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };
const num = (v, [lo, hi], def) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : def; };
/* دقيقة اليوم بتوقيت الرياض (UTC+3 ثابت) */
export const riyadhMin = (d) => { const t = new Date(d).getTime() + 3 * H; return Math.floor((((t % (24 * H)) + 24 * H) % (24 * H)) / 60_000); };
export const riyadhHHMM = (d) => { const m = riyadhMin(d); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
export const riyadhDay = (d) => new Date(new Date(d).getTime() + 3 * H).toISOString().slice(0, 10);

/* ── الإعدادات: settings.waTeam ⇒ شكل ثابت بحدود ────────────────────────────
   members مش مكتوبة خالص ⇒ دليل مؤقت من أرقام تنبيهات البوت (waBot.alertPhones وإلا delivery.alertPhones) بدور «كاشير»
   (= كل التحويلات، زي ما كانوا بياخدوها SMS) ومتعلّم fallback — لحد ما الدليل يتكتب بالأدوار. */
export function teamConfig(settings) {
  const x = (settings && settings.waTeam && typeof settings.waTeam === "object") ? settings.waTeam : {};
  const seen = new Set(), members = [];
  let fallback = false;
  if (Array.isArray(x.members)) {
    for (const m of x.members.slice(0, LIMITS.members)) {
      const phone = normPh(m && m.phone);
      if (!phone || seen.has(phone) || !ROLES.includes(m.role)) continue;
      seen.add(phone);
      members.push({ phone, name: clip(String(m.name || "").trim(), LIMITS.name), role: m.role, active: m.active !== false });
    }
  } else {
    fallback = true;
    const bot = staffPhones(settings && settings.waBot && settings.waBot.alertPhones);
    for (const phone of (bot.length ? bot : staffConfig(settings).alertPhones).slice(0, LIMITS.members)) members.push({ phone, name: "", role: "cashier", active: true });
  }
  const routing = {};
  for (const r of ROLES) {
    const v = x.routing && Array.isArray(x.routing[r]) ? x.routing[r] : DEFAULTS.routing[r];
    routing[r] = [...new Set(v.filter((t) => TOPICS.includes(t)))];
  }
  const k = x.keeper && typeof x.keeper === "object" ? x.keeper : {}, o = x.odd && typeof x.odd === "object" ? x.odd : {}, d = x.daily && typeof x.daily === "object" ? x.daily : {};
  const la = x.ladder && typeof x.ladder === "object" ? x.ladder : {}, cl = x.close && typeof x.close === "object" ? x.close : {}, tr = x.transfer && typeof x.transfer === "object" ? x.transfer : {};
  const kinds = {};
  for (const key of ODD_KEYS) kinds[key] = !(o.kinds && o.kinds[key] === false);
  return {
    enabled: x.enabled !== false, members, fallback, routing,
    smsFallback: x.smsFallback !== false,
    templatesApproved: [...new Set((Array.isArray(x.templatesApproved) ? x.templatesApproved : []).map(String).filter((n) => /^fc_staff_[a-z0-9_]{1,60}$/.test(n)))].slice(0, 20),
    staffAsTesters: x.staffAsTesters === true,
    keeper: { enabled: k.enabled !== false, renewAtHour: num(k.renewAtHour, LIMITS["keeper.renewAtHour"], DEFAULTS.keeper.renewAtHour),
      quietFrom: hhmmOk(k.quietFrom) ? k.quietFrom : DEFAULTS.keeper.quietFrom, quietTo: hhmmOk(k.quietTo) ? k.quietTo : DEFAULTS.keeper.quietTo,
      leadMin: num(k.leadMin, LIMITS["keeper.leadMin"], DEFAULTS.keeper.leadMin), smsNudge: k.smsNudge !== false },
    odd: { enabled: o.enabled !== false, perHour: num(o.perHour, LIMITS["odd.perHour"], DEFAULTS.odd.perHour), digest: o.digest === true,
      digestEveryMin: num(o.digestEveryMin, LIMITS["odd.digestEveryMin"], DEFAULTS.odd.digestEveryMin), repeatMin: num(o.repeatMin, LIMITS["odd.repeatMin"], DEFAULTS.odd.repeatMin),
      excerpt: num(o.excerpt, LIMITS["odd.excerpt"], DEFAULTS.odd.excerpt), smsFallback: o.smsFallback === true,
      failStreak: num(o.failStreak, LIMITS["odd.failStreak"], DEFAULTS.odd.failStreak), failWindowMin: num(o.failWindowMin, LIMITS["odd.failWindowMin"], DEFAULTS.odd.failWindowMin), kinds },
    daily: { enabled: d.enabled !== false, at: hhmmOk(d.at) ? d.at : DEFAULTS.daily.at },
    ladder: { enabled: la.enabled !== false, managerAfterMin: num(la.managerAfterMin, LIMITS["ladder.managerAfterMin"], DEFAULTS.ladder.managerAfterMin), ownersAfterMin: num(la.ownersAfterMin, LIMITS["ladder.ownersAfterMin"], DEFAULTS.ladder.ownersAfterMin) },
    close: { requireOutcome: cl.requireOutcome !== false, remindAfterMin: num(cl.remindAfterMin, LIMITS["close.remindAfterMin"], DEFAULTS.close.remindAfterMin) },
    transfer: { enabled: tr.enabled !== false },
  };
}
/* دور الرقم في دليل الفريق (الأعضاء الشغّالين بس) أو null. الدليل المؤقت (fallback) بيتحسب برضه: الأرقام دي أصلاً «مش عملاء» عند البوت. */
export function staffRoleOf(settings, phone) {
  const p = normPh(phone); if (!p) return null;
  const m = teamConfig(settings).members.find((x) => x.phone === p && x.active);
  return m ? m.role : null;
}
export function recipientsFor(cfg, topics) {
  const want = Array.isArray(topics) ? topics : [topics];
  return cfg.members.filter((m) => m.active && (cfg.routing[m.role] || []).some((t) => want.includes(t)));
}

/* جسم الحفظ ⇒ { ok, value } أو { ok:false, errors[] }. اللي مش مبعوت بيفضل على القديم. */
export function configFromBody(b, prev = {}) {
  const src = b && typeof b === "object" ? b : {}, errors = [];
  const out = { ...(prev && typeof prev === "object" ? prev : {}) };
  for (const k of ["enabled", "smsFallback", "staffAsTesters"]) if (k in src) { if (typeof src[k] === "boolean") out[k] = src[k]; else errors.push(`${k}: true أو false`); }
  if ("members" in src) {
    if (!Array.isArray(src.members) || src.members.length > LIMITS.members) errors.push(`members: قايمة لحد ${LIMITS.members} عضو`);
    else {
      const seen = new Set(), list = [];
      for (const m of src.members) {
        const phone = normPh(m && m.phone);
        if (!phone) { errors.push("members: جوال سعودي 05XXXXXXXX لكل عضو"); break; }
        if (seen.has(phone)) { errors.push(`members: الرقم ${last4(phone)} مكرر`); break; }
        if (!ROLES.includes(m.role)) { errors.push(`members: الدور cashier أو manager أو owner (${last4(phone)})`); break; }
        seen.add(phone);
        list.push({ phone, name: clip(String(m.name || "").trim(), LIMITS.name), role: m.role, active: m.active !== false });
      }
      if (!errors.length) out.members = list;
    }
  }
  if ("routing" in src) {
    const r = src.routing && typeof src.routing === "object" ? src.routing : null, next = { ...(out.routing || {}) };
    if (!r) errors.push("routing: كائن { cashier, manager, owner }");
    else for (const role of Object.keys(r)) {
      if (!ROLES.includes(role) || !Array.isArray(r[role]) || r[role].some((t) => !TOPICS.includes(t))) { errors.push(`routing.${role}: مواضيع من ${TOPICS.join(" / ")}`); continue; }
      next[role] = [...new Set(r[role])];
    }
    out.routing = next;
  }
  if ("templatesApproved" in src) {
    if (!Array.isArray(src.templatesApproved) || src.templatesApproved.some((n) => !/^fc_staff_[a-z0-9_]{1,60}$/.test(String(n)))) errors.push("templatesApproved: أسماء قوالب فريق fc_staff_…");
    else out.templatesApproved = [...new Set(src.templatesApproved.map(String))].slice(0, 20);
  }
  const group = (name, bools, nums, times) => {
    if (!(name in src)) return;
    const g = src[name] && typeof src[name] === "object" ? src[name] : null;
    if (!g) { errors.push(`${name}: كائن`); return; }
    const next = { ...(out[name] && typeof out[name] === "object" ? out[name] : {}) };
    for (const k of bools) if (k in g) { if (typeof g[k] === "boolean") next[k] = g[k]; else errors.push(`${name}.${k}: true أو false`); }
    for (const k of nums) if (k in g) { const [lo, hi] = LIMITS[`${name}.${k}`]; const n = Number(g[k]); if (Number.isFinite(n) && n >= lo && n <= hi) next[k] = Math.round(n); else errors.push(`${name}.${k}: من ${lo} لـ${hi}`); }
    for (const k of times) if (k in g) { if (hhmmOk(g[k])) next[k] = g[k]; else errors.push(`${name}.${k}: وقت بصيغة HH:MM`); }
    if (name === "odd" && "kinds" in g) {
      const kk = g.kinds && typeof g.kinds === "object" ? g.kinds : null;
      if (!kk || Object.keys(kk).some((x) => !ODD_KEYS.includes(x) || typeof kk[x] !== "boolean")) errors.push(`odd.kinds: مفاتيح من ${ODD_KEYS.join(" / ")} بقيمة true أو false`);
      else next.kinds = { ...(next.kinds || {}), ...kk };
    }
    out[name] = next;
  };
  group("keeper", ["enabled", "smsNudge"], ["renewAtHour", "leadMin"], ["quietFrom", "quietTo"]);
  group("odd", ["enabled", "digest", "smsFallback"], ["perHour", "digestEveryMin", "repeatMin", "excerpt", "failStreak", "failWindowMin"], []);
  group("daily", ["enabled"], [], ["at"]);
  group("ladder", ["enabled"], ["managerAfterMin", "ownersAfterMin"], []);
  group("close", ["requireOutcome"], ["remindAfterMin"], []);
  group("transfer", ["enabled"], [], []);
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

/* ── نافذة الـ٢٤ ساعة وحارسها (صافي) ─────────────────────────────────────── */
export function windowState(lastInAt, now) {
  const li = lastInAt ? new Date(lastInAt).getTime() : NaN, t = new Date(now).getTime();
  if (!Number.isFinite(li)) return { open: false, lastInAt: null, until: null, closedSince: null, minutesLeft: 0 };
  const until = li + 24 * H;
  return t < until ? { open: true, lastInAt: new Date(li).toISOString(), until: new Date(until).toISOString(), closedSince: null, minutesLeft: Math.floor((until - t) / 60_000) }
    : { open: false, lastInAt: new Date(li).toISOString(), until: null, closedSince: new Date(until).toISOString(), minutesLeft: 0 };
}
/* اللحظة دي جوّه ساعات الهدوء؟ ⇒ بداية فترة الهدوء اللي هي فيها (ms) أو null. from = to ⇒ مفيش هدوء. */
export function quietStartOf(ms, from, to) {
  const f = minOf(from), t = minOf(to); if (f === t) return null;
  const m = riyadhMin(ms), inside = f < t ? (m >= f && m < t) : (m >= f || m < t);
  if (!inside) return null;
  return ms - (((m - f) + 1440) % 1440) * 60_000 - (ms % 60_000);
}
/* قرار حارس النافذة لموظف واحد ⇒ { action: "none" | "free" | "closed", why, dueAt? }.
   state: { freeNudgeAt, closedNudgeAt } (آخر مرة اتبعت له كل نوع). free = رسالة حرة بالزر · closed = قالب التجديد (مرة واحدة لكل قفلة). */
export function keeperPlan({ now, lastInAt, state = {}, keeper }) {
  const none = (why, dueAt = null) => ({ action: "none", why, ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}) });
  if (!keeper || !keeper.enabled) return none("off");
  const t = new Date(now).getTime(), li = lastInAt ? new Date(lastInAt).getTime() : NaN;
  const ms = (v) => (v ? new Date(v).getTime() : NaN);
  const quietNow = quietStartOf(t, keeper.quietFrom, keeper.quietTo) !== null;
  if (Number.isFinite(li) && t - li < 24 * H) {
    if (Number.isFinite(ms(state.freeNudgeAt)) && ms(state.freeNudgeAt) >= li) return none("already_nudged");
    let due = li + keeper.renewAtHour * H;
    const qs = quietStartOf(due, keeper.quietFrom, keeper.quietTo);
    if (qs !== null) due = Math.max(li, qs - keeper.leadMin * 60_000);      // الساعة ٢٠ جوّه الهدوء ⇒ قبل بداية الهدوء
    if (t < due) return none("not_due", due);
    if (quietNow) return none("quiet");
    return { action: "free", why: "renew_due", dueAt: new Date(due).toISOString() };
  }
  const closedNudge = ms(state.closedNudgeAt);
  if (Number.isFinite(closedNudge) && (!Number.isFinite(li) || closedNudge >= li)) return none("waiting_tap");
  if (quietNow) return none("quiet");
  return { action: "closed", why: Number.isFinite(li) ? "window_closed" : "never_wrote" };
}

/* ── نصوص رسايل الفريق (مصري) ─────────────────────────────────────────────── */
const STAGE_HEAD = {
  new: (u) => (u ? "🚨 تحويل عاجل لموظف" : "💬 تحويل لموظف"),
  reminder: (u, w) => `🔔 تذكير${u ? " عاجل" : ""}: العميل مستني${w ? ` من ${w} دقيقة` : ""} ومحدش رد`,
  reopened: (u) => `♻️ ${u ? "عاجل — " : ""}التحويل اتقفل بـ«تم» من غير رد للعميل`,
};
export function handoverText({ phone, reasonAr, urgent = false, orderNo = null, stage = "new", waitedMin = null, lastText = null }) {
  const head = (STAGE_HEAD[stage] || STAGE_HEAD.new)(urgent, waitedMin);
  return [`${head} — ${reasonAr || "تحويل"}`, `العميل: ${last4(phone)}${orderNo ? ` · طلب ${orderNo}` : ""}`,
    lastText ? `آخر رسالة منه: «${clip(lastText, 200)}»` : null, `رد عليه من البورتال: ${PORTAL_URL}`].filter(Boolean).join("\n").slice(0, 1000);
}
export function excerptLines(rows) {
  return (rows || []).map((r) => `${r.direction === "in" ? "‹ العميل" : "› إحنا"}: ${clip(maskText(r.body) || "[من غير نص]", 140)}`);
}
export function oddText({ kind, phone = null, detail = null, tried = null, excerpt = [] }) {
  const lines = [`👀 حاجة غريبة — ${ODD_KINDS[kind] || kind}`];
  if (phone) lines.push(`العميل: ${last4(phone)}`);
  if (detail) lines.push(clip(detail, 200));
  if (tried) lines.push(`المساعد كان هيقول: «${clip(tried, 300)}»`);
  if (excerpt.length) lines.push("آخر الرسايل:", ...excerpt);
  if (phone) lines.push(`المحادثة: ${INBOX_URL}`);
  return lines.join("\n").slice(0, 1000);
}
export function oddDigestText(rows, { held = false } = {}) {
  const head = held ? `👀 ${rows.length} حاجة غريبة اتأجّلت بسبب سقف الساعة` : `👀 ملخص الحاجات الغريبة (${rows.length})`;
  const body = rows.slice(0, 12).map((r) => `• ${ODD_KINDS[r.kind] || r.kind}${r.phone_norm ? ` — ${last4(r.phone_norm)}` : ""}${r.at ? ` · ${riyadhHHMM(r.at)}` : ""}`);
  if (rows.length > 12) body.push(`… و${rows.length - 12} كمان`);
  return [head, ...body, `التفاصيل: ${INBOX_URL}`].join("\n").slice(0, 1000);
}
export const oddSummary = ({ kind, phone }) => clip(`${ODD_KINDS[kind] || kind}${phone ? ` — عميل ${last4(phone)}` : ""}`, 120);
export function keeperFreeText({ minutesLeft }) {
  const h = Math.max(1, Math.round(minutesLeft / 60));
  return `⏰ تنبيهات واتساب المجانية هتقف كمان ${h === 1 ? "ساعة" : h === 2 ? "ساعتين" : `${h} ساعات`}.\nاضغط الزر تحت عشان التنبيهات تفضل توصلك هنا ببلاش.`;
}
export const renewedText = ({ name, until }) => `✅ تمام${name ? ` يا ${name}` : ""} — التنبيهات هتوصلك هنا ببلاش لحد بكرة ${riyadhHHMM(until)}.`;
export function keeperSms(lang = "en") {
  return fitOneSms(lang === "ar" ? "فريش كاتس: اكتب «تنبيهات» على واتساب المطعم عشان التنبيهات توصلك"
    : "Fresh Cuts: your WhatsApp alerts are paused. Send the word ALERTS to the restaurant WhatsApp number to turn them back on (free).");
}
export const HELP_TEXT = ["أوامر الفريق (اكتبها هنا):", "• حالة — نافذة التنبيهات بتاعتك والمواضيع اللي بتوصلك", "• تنبيهات — تجديد التنبيهات المجانية (زي الزر)", "• ملخص — ملخص آخر ٢٤ ساعة (مدير / مالك)", "• مساعدة — القايمة دي"].join("\n");
export function dailyText({ handovers = 0, urgent = 0, odd = [], bySms = 0, closed = [] }) {
  const lines = ["🗒 ملخص واتساب — آخر ٢٤ ساعة", `تحويلات لموظف: ${handovers}${urgent ? ` (منها ${urgent} عاجل)` : ""}`];
  const total = odd.reduce((a, r) => a + Number(r.n || 0), 0);
  lines.push(`حاجات غريبة: ${total}`);
  for (const r of odd.slice(0, 8)) lines.push(`• ${ODD_KINDS[r.kind] || r.kind}: ${r.n}`);
  if (bySms) lines.push(`تنبيهات راحت SMS (النافذة كانت مقفولة): ${bySms}`);
  if (closed.length) lines.push(`نافذتهم مقفولة دلوقتي: ${closed.join("، ")}`);
  lines.push(`اللوحة: ${INBOX_URL}`);
  return lines.join("\n").slice(0, 1000);
}

/* أوامر الفريق المكتوبة (بعد تنضيف بسيط) */
const cmdNorm = (t) => String(t || "").replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
export function staffCommand(ev) {
  if (ev && ev.interactiveId && String(ev.interactiveId) === RENEW_ID) return "renew";
  const n = cmdNorm(ev && ev.text);
  if (!n) return null;
  if (/^(جدد التنبيهات|تنبيهات|التنبيهات|جدد|تجديد|renew alerts|alerts|renew)$/.test(n)) return "renew";
  if (/^(حاله|الحاله|حالتي|status)$/.test(n)) return "status";
  if (/^(مساعده|اوامر|الاوامر|help)$/.test(n)) return "help";
  if (/^(ملخص|الملخص|digest|summary)$/.test(n)) return "digest";
  return null;
}
/* «مش عميل» بحذر: طالب شغل أو عرض من مورّد/شركة. جملة صريحة بس — كلمة «وظيفة» لوحدها في سؤال مش كفاية للمورّد، وسؤال العميل «عندكم توصيل؟» مايتمسكش. */
const JOB_RE = /(سيرتي الذاتيه|السيره الذاتيه|ارفقت (لكم )?(ال)?سيره|ابحث عن (عمل|وظيفه)|ابي وظيفه|ابغي وظيفه|ابغا وظيفه|عايز اشتغل عندكم|ابي اشتغل عندكم|ابغي اشتغل عندكم|هل (يوجد|عندكم|لديكم) (وظائف|وظايف|شواغر|وظيفه)|تقديم علي وظيفه|looking for a job|job vacancy|my (cv|resume)\b)/;
const SUPPLIER_RE = /(نحن (شركه|مؤسسه|مصنع|وكاله)|معكم (شركه|مؤسسه|مصنع|وكاله)|نقدم لكم (خدمات|عروض|اسعار)|نوفر لكم|عرض سعر|عروض اسعار للمطاعم|مورد (لحوم|دواجن|خضار|فحم|عبوات|تغليف)|مندوب مبيعات|نود التعاون معكم|we are a (company|supplier|agency)|our company (offers|provides)|business proposal)/;
export function nonCustomerKind(text) {
  const n = cmdNorm(text);
  if (!n || [...n].length < 12) return null;
  if (JOB_RE.test(n)) return "job_seeker";
  if (SUPPLIER_RE.test(n)) return "supplier";
  return null;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS wa_team_state (
    phone_norm TEXT PRIMARY KEY, free_nudge_at TIMESTAMPTZ, closed_nudge_at TIMESTAMPTZ, closed_nudge_via TEXT, renewed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS wa_team_log (
    id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), phone_norm TEXT NOT NULL, role TEXT, topic TEXT NOT NULL, kind TEXT,
    via TEXT NOT NULL, ok BOOLEAN NOT NULL DEFAULT FALSE, error TEXT, ref4 TEXT, urgent BOOLEAN NOT NULL DEFAULT FALSE);
  CREATE INDEX IF NOT EXISTS wa_team_log_at_idx ON wa_team_log(at DESC);
  CREATE TABLE IF NOT EXISTS wa_team_odd (
    id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), kind TEXT NOT NULL, phone_norm TEXT, detail TEXT, tried TEXT,
    status TEXT NOT NULL DEFAULT 'pending', sent_at TIMESTAMPTZ);
  CREATE INDEX IF NOT EXISTS wa_team_odd_at_idx ON wa_team_odd(at DESC);
`;

/* ═══ التشغيل ═════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const isOwner = ctx.isOwner || (async () => true);
  const wa = deps.wa || null;
  const sendSms = deps.sendSms || null;
  const clock = deps.now || (() => new Date());
  const log = deps.log || console;
  const q = async (sql, p = []) => { try { return (await pool.query(sql, p)).rows || []; } catch (e) { log.error("[wa-team] db:", e.message); return null; } };
  const ready = pool.query(DDL).then(() => pool.query("DELETE FROM wa_team_log WHERE at < NOW() - INTERVAL '90 days'").catch(() => {}))
    .then(() => pool.query("DELETE FROM wa_team_odd WHERE at < NOW() - INTERVAL '90 days'").catch(() => {})).then(() => true)
    .catch((e) => { log.error("[wa-team] schema:", e.message); return false; });
  const settingsNow = async () => { try { return (await getSettingsData()) || {}; } catch { return null; } };
  const flowApi = () => { try { return (typeof deps.flow === "function" ? deps.flow() : deps.flow) || null; } catch { return null; } };      // ST2: waflow.js

  const lastInOf = async (phone) => {
    const r = await q(`SELECT max(created_at) AS at FROM wa_messages WHERE phone_norm=$1 AND direction='in' AND COALESCE(source,'api') <> 'history'`, [phone]);
    return r && r[0] && r[0].at ? new Date(r[0].at).toISOString() : null;
  };
  const stateOf = async (phone) => { const r = await q("SELECT free_nudge_at, closed_nudge_at, closed_nudge_via, renewed_at FROM wa_team_state WHERE phone_norm=$1", [phone]); return (r && r[0]) || {}; };
  /* القالب معتمد؟ آخر حدث اعتماد من ميتا لنسخته العربي (wa_template_events) أو المالك أكّده في الإعدادات. مانعرفش ⇒ مش معتمد (مفيش نداء على الأعمى). */
  async function approved(cfg, name) {
    if (cfg.templatesApproved.includes(name)) return "owner";
    const r = await q("SELECT event FROM wa_template_events WHERE name=$1 AND COALESCE(language,'ar') LIKE 'ar%' ORDER BY at DESC, id DESC LIMIT 1", [name]);
    return r && r[0] && String(r[0].event || "").toUpperCase() === "APPROVED" ? "meta" : null;
  }
  const record = (m, x) => q("INSERT INTO wa_team_log(phone_norm, role, topic, kind, via, ok, error, ref4, urgent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [m.phone, m.role || null, clip(x.topic, 20), x.kind ? clip(x.kind, 40) : null, x.via, x.ok === true, x.error ? clip(x.error, 120) : null, x.ref4 || null, x.urgent === true]);
  /* ST2: أزرار إضافية قبل زر التجديد (لحد ٣ أزرار في الرسالة)، أو قايمة اختيارات (نتيجة القفل) */
  const freePayload = (body, button = true, extra = null, list = null) => {
    if (list && Array.isArray(list.rows) && list.rows.length) return { type: "interactive", interactive: { type: "list", body: { text: clip(body, 1024) },
      action: { button: clip(list.button, 20), sections: [{ title: clip(list.button, 24), rows: list.rows.slice(0, 10).map((r) => ({ id: clip(r.id, 200), title: clip(r.title, 24) })) }] } } };
    const btns = [...(Array.isArray(extra) ? extra : []).map((b) => ({ type: "reply", reply: { id: clip(b.id, 256), title: clip(b.title, 20) } })), ...(button ? [{ type: "reply", reply: { id: RENEW_ID, title: RENEW_TITLE } }] : [])].slice(0, 3);
    return btns.length ? { type: "interactive", interactive: { type: "button", body: { text: clip(body, 1024) }, action: { buttons: btns } } }
      : { type: "text", text: { body: clip(body, 4096), preview_url: false } };
  };

  /* إرسال لموظف واحد. msg: { topic, kind, body, button?, templates?: [{ name, data }], sms?: string|null, ref4?, urgent? }
     ⇒ { ok, via: "wa_free" | "wa_template" | "sms" | "none", error? }. عمرها ما بترمي، وكل محاولة بتتسجّل في wa_team_log. */
  async function sendToStaff(cfg, member, msg) {
    const m = { phone: normPh(member && member.phone), role: member && member.role };
    const meta = { topic: msg.topic, kind: msg.kind || null, ref4: msg.ref4 || null, urgent: msg.urgent === true };
    const done = async (via, ok, error = null) => { await record(m, { ...meta, via, ok, error }); return { ok, via, ...(error ? { error } : {}) }; };
    if (!m.phone || !cfg.members.some((x) => x.phone === m.phone && x.active)) return { ok: false, via: "none", error: "not_staff" };      // مش في الدليل ⇒ ولا محاولة
    let why = "wa_off";
    if (cfg.enabled && wa && typeof wa.sendFreeform === "function") {
      await ready;
      const win = windowState(await lastInOf(m.phone), clock());
      why = "window_closed";
      if (win.open) {
        const rich = freePayload(msg.body, msg.button !== false, msg.buttons || null, msg.list || null);
        let r = await wa.sendFreeform({ phoneNorm: m.phone, payload: rich, source: "team", preview: clip(msg.body, 500) });
        if (!r.ok && !r.skipped && rich.type === "interactive") r = await wa.sendFreeform({ phoneNorm: m.phone, payload: freePayload(msg.body, false), source: "team", preview: clip(msg.body, 500) });
        if (r.ok) return done("wa_free", true);
        why = r.skipped || r.error || "send_failed";
      }
      /* النافذة مقفولة (أو الحر اترفض): قالب فريق معتمد — أول واحد معتمد من القايمة */
      if (typeof wa.sendStaffTemplate === "function" && ["window_closed", "WA_131047"].includes(String(why))) {
        for (const t of msg.templates || []) {
          if (!(await approved(cfg, t.name))) continue;
          const r = await wa.sendStaffTemplate({ phoneNorm: m.phone, template: t.name, data: t.data || {}, lang: "ar" });
          if (r.ok) return done("wa_template", true);
          why = `template:${r.skipped || r.error || "send_failed"}`;
          break;
        }
      }
    }
    if (msg.sms && sendSms) {
      try { const r = await sendSms({ phoneNorm: m.phone, body: fitOneSms(msg.sms), kind: "staff", ref: msg.smsRef || `wabot ${msg.kind || msg.topic}` }); return done("sms", !(r && r.suppressed), r && r.suppressed ? `suppressed after ${why}` : `fallback after ${why}`); }
      catch (e) { log.error(`[wa-team] sms → ${last4(m.phone)} failed:`, e.message); return done("sms", false, `sms_failed after ${why}`); }
    }
    return done("none", false, why);
  }
  const fanOut = async (cfg, members, build) => {
    const out = { sent: 0, wa: 0, sms: 0, failed: 0, to: members.length };
    for (const m of members) { const r = await sendToStaff(cfg, m, build(m)); if (r.ok) { out.sent++; if (r.via === "sms") out.sms++; else out.wa++; } else out.failed++; }
    return out;
  };
  const lastCustomerText = async (phone) => { const r = await q("SELECT body FROM wa_messages WHERE phone_norm=$1 AND direction='in' ORDER BY created_at DESC LIMIT 1", [phone]); return r && r[0] ? maskText(r[0].body) : null; };
  const excerptOf = async (phone, n) => {
    if (!phone || !(n > 0)) return [];
    const r = await q("SELECT direction, body FROM wa_messages WHERE phone_norm=$1 AND COALESCE(source,'api') <> 'history' ORDER BY created_at DESC, id DESC LIMIT $2", [phone, n]);
    return excerptLines((r || []).reverse());
  };

  /* ── ١) تحويل لموظف (جديد / تذكير / اتفتح تاني) ───────────────────────────
     ⇒ null لو واتساب الفريق مقفول أو مفيش مستلمين (المنادي يكمل بالـSMS القديم) · وإلا { sent, wa, sms, failed, to }. */
  async function handover({ settings, phone, reason, reasonAr = null, urgent = false, orderNo = null, stage = "new", waitedMin = null, sms = null }) {
    const cfg = teamConfig(settings || (await settingsNow()) || {});
    if (!cfg.enabled) return null;
    /* ST2: سلّم التصعيد شغّال ⇒ waflow هو اللي بيقرر مين يتبلّغ دلوقتي (الكاشير أولاً) وبيصعّد بعدين */
    { const fl = flowApi(); if (fl && cfg.ladder.enabled && typeof fl.onHandover === "function") return fl.onHandover({ cfg, phone, reason, reasonAr, urgent, orderNo, stage, waitedMin, sms }); }
    const to = recipientsFor(cfg, urgent ? ["handover", "urgent"] : ["handover"]);
    if (!to.length) return null;
    const body = handoverText({ phone, reasonAr: reasonAr || reason, urgent, orderNo, stage, waitedMin, lastText: await lastCustomerText(phone) });
    const summary = clip(`عميل ${last4(phone)} محتاج موظف (${reasonAr || reason})${stage === "reminder" ? " — تذكير" : ""}`, 120);
    return fanOut(cfg, to, () => ({ topic: urgent ? "urgent" : "handover", kind: reason, body, ref4: String(phone || "").slice(-4), urgent,
      templates: [{ name: TPL_NOTICE, data: { notice: { text: summary } } }, { name: TPL_HANDOFF, data: { handoff: { reasonText: reasonAr || reason, summary: `عميل ${last4(phone)}${orderNo ? ` طلب ${orderNo}` : ""}` } } }],
      sms: cfg.smsFallback ? sms : null, smsRef: `wabot ${reason}` }));
  }

  /* ── ٣) حاجات غريبة ─────────────────────────────────────────────────────────
     ⇒ "off" | "kind_off" | "repeat" | "queued" (ملخص) | "held" (سقف الساعة) | "sent" | "failed" | "no_recipients". عمرها ما بترمي. */
  async function odd({ kind, phone = null, detail = null, tried = null, settings = null, repeatMin = null } = {}) {
    try {
      if (!ODD_KEYS.includes(kind)) return "kind_off";
      const cfg = teamConfig(settings || (await settingsNow()) || {});
      if (!cfg.enabled || !cfg.odd.enabled) return "off";
      if (!cfg.odd.kinds[kind]) return "kind_off";
      const p = phone ? normPh(phone) : null;
      if (p && cfg.members.some((m) => m.phone === p)) return "off";      // موظف مش «عميل غريب»
      await ready;
      const now = clock();
      const rep = await q(`SELECT 1 FROM wa_team_odd WHERE kind=$1 AND COALESCE(phone_norm,'') = $2 AND at > $3 LIMIT 1`, [kind, p || "", new Date(now.getTime() - Math.max(cfg.odd.repeatMin, Math.min(Number(repeatMin) || 0, 1440)) * 60_000).toISOString()]);
      if (rep === null) return "failed";
      if (rep.length) return "repeat";
      const ins = await q("INSERT INTO wa_team_odd(at, kind, phone_norm, detail, tried, status) VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id", [now.toISOString(), kind, p, detail ? clip(maskText(detail), 200) : null, tried ? clip(tried, 300) : null]);
      if (!ins || !ins.length) return "failed";
      const id = ins[0].id;
      if (cfg.odd.digest) return "queued";
      const n = await q("SELECT count(*)::int AS n FROM wa_team_odd WHERE status='sent' AND sent_at > $1", [new Date(now.getTime() - H).toISOString()]);
      if (n === null || Number(n[0] && n[0].n) >= cfg.odd.perHour) { await q("UPDATE wa_team_odd SET status='held' WHERE id=$1", [id]); return "held"; }
      const to = recipientsFor(cfg, "odd");
      if (!to.length) { await q("UPDATE wa_team_odd SET status='no_recipients' WHERE id=$1", [id]); return "no_recipients"; }
      const row = { kind, phone: p, detail: detail ? clip(maskText(detail), 200) : null, tried: tried ? clip(tried, 300) : null };
      const body = oddText({ ...row, excerpt: await excerptOf(p, cfg.odd.excerpt) });
      const r = await fanOut(cfg, to, () => ({ topic: "odd", kind, body, ref4: p ? p.slice(-4) : null, templates: [{ name: TPL_NOTICE, data: { notice: { text: oddSummary(row) } } }],
        sms: cfg.odd.smsFallback ? `Fresh Cuts WhatsApp: ${kind.replace(/_/g, " ")}${p ? ` (customer ${last4(p).slice(1)})` : ""}. Open the dashboard inbox.` : null, smsRef: `wabot odd_${kind}` }));
      await q("UPDATE wa_team_odd SET status=$2, sent_at=$3 WHERE id=$1", [id, r.sent ? "sent" : "failed", now.toISOString()]);
      return r.sent ? "sent" : "failed";
    } catch (e) { log.error("[wa-team] odd:", e.message); return "failed"; }
  }
  /* الملخص: وضع digest كل digestEveryMin، واللي اتأجّل بالسقف أول ما السقف يفك — رسالة واحدة تجمعهم (وبتتحسب واحدة في السقف). */
  let digestAt = -1e15;
  async function flushOdd(cfg, now) {
    const want = cfg.odd.digest ? ["pending", "held"] : ["held"];
    if (cfg.odd.digest && now.getTime() - digestAt < cfg.odd.digestEveryMin * 60_000 && now.getTime() >= digestAt) return 0;
    const rows = await q("SELECT id, at, kind, phone_norm, status FROM wa_team_odd WHERE status = ANY($1::text[]) AND at > $2 ORDER BY at LIMIT 40", [want, new Date(now.getTime() - 24 * H).toISOString()]);
    if (!rows || !rows.length) { if (cfg.odd.digest) digestAt = now.getTime(); return 0; }
    const n = await q("SELECT count(*)::int AS n FROM wa_team_odd WHERE status='sent' AND sent_at > $1", [new Date(now.getTime() - H).toISOString()]);
    if (n === null || Number(n[0] && n[0].n) >= cfg.odd.perHour) return 0;
    const ids = rows.map((r) => r.id);
    const claim = await q("UPDATE wa_team_odd SET status='sending' WHERE id = ANY($1::bigint[]) AND status = ANY($2::text[]) RETURNING id", [ids, want]);
    if (!claim || !claim.length) return 0;
    digestAt = now.getTime();
    const to = recipientsFor(cfg, "odd");
    const body = oddDigestText(rows, { held: !cfg.odd.digest });
    const r = to.length ? await fanOut(cfg, to, () => ({ topic: "odd", kind: "digest", body, templates: [{ name: TPL_NOTICE, data: { notice: { text: `${rows.length} حاجة غريبة في محادثات واتساب` } } }], sms: null })) : { sent: 0 };
    /* صف واحد بس بيتحسب «sent» في سقف الساعة؛ الباقي digest */
    await q("UPDATE wa_team_odd SET status = CASE WHEN id=$2 THEN $3 ELSE 'digest' END, sent_at=$4 WHERE id = ANY($1::bigint[])", [ids, ids[0], r.sent ? "sent" : "failed", now.toISOString()]);
    return rows.length;
  }

  /* ── ٢) حارس النافذة ─────────────────────────────────────────────────────── */
  async function keeperFor(cfg, m, now, sc) {
    const lastIn = await lastInOf(m.phone), st = await stateOf(m.phone);
    const plan = keeperPlan({ now, lastInAt: lastIn, state: { freeNudgeAt: st.free_nudge_at, closedNudgeAt: st.closed_nudge_at }, keeper: cfg.keeper });
    if (plan.action === "none") return plan;
    /* الحجز قبل الإرسال: لو السيرفر وقع في النص، مفيش رسالة تانية (الأمان قبل الاكتمال) */
    const col = plan.action === "free" ? "free_nudge_at" : "closed_nudge_at";
    const claim = await q(`INSERT INTO wa_team_state(phone_norm, ${col}, updated_at) VALUES ($1,$2,NOW())
                           ON CONFLICT (phone_norm) DO UPDATE SET ${col}=$2, updated_at=NOW() RETURNING phone_norm`, [m.phone, now.toISOString()]);
    if (!claim || !claim.length) return { action: "none", why: "state_db" };
    if (plan.action === "free") {
      const win = windowState(lastIn, now);
      const r = await sendToStaff(cfg, m, { topic: "keeper", kind: "renew_free", body: keeperFreeText({ minutesLeft: win.minutesLeft }), templates: [], sms: null });
      return { ...plan, sent: r };
    }
    const r = await sendToStaff(cfg, m, { topic: "keeper", kind: "renew_closed", body: "", templates: [{ name: TPL_RENEW, data: {} }], sms: cfg.keeper.smsNudge ? keeperSms(sc.lang) : null, smsRef: "wabot team_renew" });
    await q("UPDATE wa_team_state SET closed_nudge_via=$2 WHERE phone_norm=$1", [m.phone, r.via]);
    return { ...plan, sent: r };
  }
  async function dailyData(cfg, now) {
    const since = new Date(now.getTime() - 24 * H).toISOString();
    const ho = await q(`SELECT count(DISTINCT (ref4, kind, date_trunc('minute', at)))::int AS n, count(DISTINCT (ref4, kind, date_trunc('minute', at))) FILTER (WHERE urgent)::int AS u,
                               count(*) FILTER (WHERE via='sms' AND ok)::int AS sms FROM wa_team_log WHERE topic IN ('handover','urgent') AND at > $1`, [since]);
    const od = await q("SELECT kind, count(*)::int AS n FROM wa_team_odd WHERE at > $1 GROUP BY 1 ORDER BY 2 DESC", [since]);
    const closed = [];
    for (const m of cfg.members.filter((x) => x.active)) if (!windowState(await lastInOf(m.phone), now).open) closed.push(m.name || last4(m.phone));
    return { handovers: Number(ho && ho[0] && ho[0].n) || 0, urgent: Number(ho && ho[0] && ho[0].u) || 0, bySms: Number(ho && ho[0] && ho[0].sms) || 0, odd: od || [], closed };
  }
  async function dailyDigest(cfg, now, { only = null } = {}) {
    const to = only ? [only] : recipientsFor(cfg, "digest");
    if (!to.length) return { sent: 0, to: 0 };
    const d = await dailyData(cfg, now), body = dailyText(d);
    const total = d.odd.reduce((a, r) => a + Number(r.n || 0), 0);
    return fanOut(cfg, to, () => ({ topic: "digest", kind: "daily", body, templates: [{ name: TPL_NOTICE, data: { notice: { text: `ملخص آخر ٢٤ ساعة: ${d.handovers} تحويل لموظف و${total} حاجة غريبة` } } }], sms: null }));
  }
  /* دورة كل دقيقة: حارس النافذة لكل عضو، ملخص الحاجات الغريبة، سلسلة فشل الإرسال، والملخص اليومي. عمرها ما بترمي. */
  let ticking = false;
  async function tick() {
    if (ticking) return { skipped: "busy" };
    ticking = true;
    const out = { keeper: [], odd: 0, daily: null };
    try {
      await ready;
      const settings = await settingsNow();
      if (!settings) return { skipped: "settings_unreadable" };
      const cfg = teamConfig(settings), now = clock(), sc = staffConfig(settings);
      if (!cfg.enabled) return { skipped: "off" };
      if (cfg.keeper.enabled) for (const m of cfg.members.filter((x) => x.active)) {
        try { const p = await keeperFor(cfg, m, now, sc); if (p.action !== "none") out.keeper.push({ to: last4(m.phone), action: p.action, via: p.sent && p.sent.via, ok: p.sent && p.sent.ok }); }
        catch (e) { log.error("[wa-team] keeper:", e.message); }
      }
      if (cfg.odd.enabled) {
        if (cfg.odd.kinds.send_failures) {
          const f = await q("SELECT count(*)::int AS n FROM wa_bot_log WHERE decision='failed' AND at > $1", [new Date(now.getTime() - cfg.odd.failWindowMin * 60_000).toISOString()]);
          if (f && Number(f[0] && f[0].n) >= cfg.odd.failStreak) await odd({ kind: "send_failures", detail: `${f[0].n} رد فشل إرساله في آخر ${cfg.odd.failWindowMin} دقيقة`, settings });
        }
        out.odd = await flushOdd(cfg, now);
      }
      if (cfg.daily.enabled && riyadhMin(now) >= minOf(cfg.daily.at) && riyadhMin(now) < minOf(cfg.daily.at) + 30) {
        const key = "_daily", day = riyadhDay(now);
        const claim = await q(`INSERT INTO wa_team_state(phone_norm, closed_nudge_via, updated_at) VALUES ($1,$2,NOW())
                               ON CONFLICT (phone_norm) DO UPDATE SET closed_nudge_via=$2, updated_at=NOW() WHERE wa_team_state.closed_nudge_via IS DISTINCT FROM $2 RETURNING phone_norm`, [key, day]);
        if (claim && claim.length) out.daily = await dailyDigest(cfg, now);
      }
      return out;
    } catch (e) { log.error("[wa-team] tick:", e.message); return out; }
    finally { ticking = false; }
  }
  const timer = deps.noTimer ? null : setInterval(() => { tick().catch(() => {}); }, 60_000);
  if (timer && typeof timer.unref === "function") timer.unref();

  /* ── الوارد من رقم فريق ─────────────────────────────────────────────────────
     ⇒ false: مش رقم فريق (أو رقم تجربة والمالك سايبه يجرّب، والرسالة مش أمر) ⇒ البوت يكمل عادي.
     ⇒ true: اتمسكت هنا — البوت والمساعد والرد الآلي القديم مايشوفوهاش. */
  async function inbound(ev, settings = null) {
    try {
      if (!ev || ev.isEcho) return false;
      const s = settings || (await settingsNow());
      if (!s) return false;
      const cfg = teamConfig(s), phone = normPh(ev.phone || ev.phoneNorm);
      const m = cfg.members.find((x) => x.phone === phone && x.active);
      if (!m) return false;
      /* ST2: أزرار المحادثة («استلم المحادثة / رجّعها للبوت / خلصت — اقفل / حوّل للمدير»)، اختيار نتيجة القفل، وملاحظة التحويل المكتوبة */
      { const fl = flowApi(); if (fl && typeof fl.staffInbound === "function") { let took = false; try { took = (await fl.staffInbound(ev, m, cfg)) === true; } catch (e) { log.error("[wa-team] flow inbound:", e.message); } if (took) return true; } }
      const cmd = staffCommand(ev);
      const tester = cfg.staffAsTesters && staffPhones(s.waBot && s.waBot.testPhones).includes(phone);
      if (!cmd) return !tester;
      await ready;
      const now = clock();
      const say = (body, button = false) => sendToStaff(cfg, m, { topic: "reply", kind: cmd, body, button, templates: [], sms: null });
      if (cmd === "renew") {
        await q(`INSERT INTO wa_team_state(phone_norm, renewed_at, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (phone_norm) DO UPDATE SET renewed_at=$2, updated_at=NOW()`, [phone, now.toISOString()]);
        await say(renewedText({ name: m.name, until: new Date(now.getTime() + 24 * H) }));
      } else if (cmd === "status") {
        const topics = (cfg.routing[m.role] || []).map((t) => TOPIC_AR[t]).join("، ") || "ولا موضوع";
        await say(`👤 ${m.name || last4(phone)} — ${ROLE_AR[m.role]}\nبيوصلك: ${topics}\nالتنبيهات المجانية شغّالة لحد ${riyadhHHMM(new Date(now.getTime() + 24 * H))} بكرة.`, true);
      } else if (cmd === "help") await say(HELP_TEXT, true);
      else if (cmd === "digest") {
        if (m.role === "cashier") await say("الملخص للمدير والملاك بس.");
        else await dailyDigest(cfg, now, { only: m });
      }
      return true;
    } catch (e) { log.error("[wa-team] inbound:", e.message); return true; }      // رقم فريق + عطل ⇒ برضه مايتعاملش كعميل
  }

  /* ── الحالة (اللوحة والبورتال) ───────────────────────────────────────────── */
  async function status({ full = false } = {}) {
    await ready;
    const settings = (await settingsNow()) || {}, cfg = teamConfig(settings), now = clock();
    const tests = staffPhones(settings.waBot && settings.waBot.testPhones);
    const members = [];
    for (const m of cfg.members) {
      const lastIn = await lastInOf(m.phone), st = await stateOf(m.phone), win = windowState(lastIn, now);
      const plan = keeperPlan({ now, lastInAt: lastIn, state: { freeNudgeAt: st.free_nudge_at, closedNudgeAt: st.closed_nudge_at }, keeper: cfg.keeper });
      const la = await q("SELECT at, topic, kind, via, ok FROM wa_team_log WHERE phone_norm=$1 ORDER BY at DESC, id DESC LIMIT 1", [m.phone]);
      members.push({ ...(full ? { phone: `0${m.phone}` } : {}), last4: m.phone.slice(-4), name: m.name || null, role: m.role, roleAr: ROLE_AR[m.role], active: m.active, topics: cfg.routing[m.role] || [],
        window: { open: win.open, until: win.until, closedSince: win.closedSince, lastInAt: win.lastInAt, minutesLeft: win.minutesLeft },
        keeper: { next: plan.action, why: plan.why, dueAt: plan.dueAt || null, freeNudgeAt: st.free_nudge_at || null, closedNudgeAt: st.closed_nudge_at || null, closedNudgeVia: st.closed_nudge_via || null },
        testPhone: tests.includes(m.phone), lastAlert: la && la[0] ? la[0] : null });
    }
    return { cfg, members, now: now.toISOString() };
  }

  if (app && typeof app.get === "function") {
    app.get("/api/cms/wabot/team", async (c) => {
      const err = await requireAdmin(c); if (err) return err;
      try {
        const owner = Boolean(await isOwner(c));
        const st = await status({ full: owner }), cfg = st.cfg, now = clock();
        const templates = {};
        for (const n of [TPL_RENEW, TPL_NOTICE, TPL_HANDOFF]) templates[n] = { approved: Boolean(await approved(cfg, n)), source: await approved(cfg, n) };
        const hour = new Date(now.getTime() - H).toISOString(), day = new Date(now.getTime() - 24 * H).toISOString();
        const oc = await q(`SELECT count(*) FILTER (WHERE status='sent' AND sent_at > $1)::int AS sent_hour, count(*) FILTER (WHERE status='pending')::int AS pending, count(*) FILTER (WHERE status='held')::int AS held FROM wa_team_odd WHERE at > $2`, [hour, day]);
        const byKind = await q("SELECT kind, count(*)::int AS n FROM wa_team_odd WHERE at > $1 GROUP BY 1 ORDER BY 2 DESC", [day]);
        const via = await q("SELECT via, count(*)::int AS n, count(*) FILTER (WHERE ok)::int AS ok FROM wa_team_log WHERE at > $1 GROUP BY 1", [day]);
        const recent = await q("SELECT at, right(phone_norm, 4) AS to4, role, topic, kind, via, ok, error, ref4, urgent FROM wa_team_log ORDER BY at DESC, id DESC LIMIT 40", []);
        return c.json({ ok: true, now: st.now, owner, config: { ...cfg, members: undefined }, fallbackDirectory: cfg.fallback, members: st.members, templates,
          odd: { sentLastHour: Number(oc && oc[0] && oc[0].sent_hour) || 0, cap: cfg.odd.perHour, pending: Number(oc && oc[0] && oc[0].pending) || 0, held: Number(oc && oc[0] && oc[0].held) || 0, byKind24h: byKind || [] },
          sends24h: via || [], recent: recent || [],
          schema: { roles: ROLES.map((id) => ({ id, label: ROLE_AR[id] })), topics: TOPICS.map((id) => ({ id, label: TOPIC_AR[id] })), oddKinds: ODD_KEYS.map((id) => ({ id, label: ODD_KINDS[id] })), limits: LIMITS, defaults: DEFAULTS, renewButton: RENEW_TITLE,
            actions: Object.entries(ACTIONS).map(([id, label]) => ({ id, label })), outcomes: OUTCOMES.map((o) => ({ id: o.id, label: o.label, hint: o.hint })) } });
      } catch (e) { log.error("[wa-team] status:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
    });
    app.put("/api/cms/wabot/team", async (c) => {
      const err = await requireAdmin(c); if (err) return err;
      if (!(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "إعدادات تواصل الفريق للمالك بس" }, 403);
      let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
      const settings = await settingsNow();
      if (!settings) return c.json({ ok: false, error: "settings_unreadable" }, 503);
      const r = configFromBody(b, settings.waTeam);
      if (!r.ok) return c.json({ ok: false, error: "invalid", errors: r.errors }, 400);
      await pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waTeam}', $1::jsonb, true), updated_at=NOW() WHERE id=1`, [JSON.stringify(r.value)]);
      const cfg = teamConfig({ ...settings, waTeam: r.value });
      return c.json({ ok: true, config: { ...cfg, members: undefined }, members: cfg.members.map((m) => ({ phone: `0${m.phone}`, name: m.name || null, role: m.role, active: m.active })) });
    });
    app.post("/api/cms/wabot/team/test", async (c) => {
      const err = await requireAdmin(c); if (err) return err;
      if (!(await isOwner(c))) return c.json({ ok: false, error: "owner_only" }, 403);
      let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
      const cfg = teamConfig((await settingsNow()) || {}), phone = normPh(b && b.phone);
      const m = cfg.members.find((x) => x.phone === phone && x.active);
      if (!m) return c.json({ ok: false, error: "not_staff", message: "الرقم مش في دليل الفريق" }, 400);
      const r = await sendToStaff(cfg, m, { topic: "test", kind: "test", body: "🧪 رسالة تجربة من نظام تنبيهات فريش كاتس — لو وصلتك، التنبيهات شغّالة على واتساب.", templates: [{ name: TPL_NOTICE, data: { notice: { text: "رسالة تجربة لتنبيهات الفريق" } } }], sms: null });
      return c.json({ ok: r.ok, via: r.via, error: r.error || null });
    });
    if (deps.requirePortal) app.get("/api/portal/wa/team-status", async (c) => {
      const a = await deps.requirePortal(c); if (a.res) return a.res;
      if (!["cashier", "manager"].includes(a.user && a.user.role)) return c.json({ ok: false, error: "forbidden" }, 403);
      try {
        const st = await status({ full: false });
        return c.json({ ok: true, now: st.now, enabled: st.cfg.enabled, renewButton: RENEW_TITLE,
          members: st.members.filter((m) => m.active).map((m) => ({ last4: m.last4, name: m.name, role: m.role, roleAr: m.roleAr, window: m.window })) });
      } catch (e) { log.error("[wa-team] portal status:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
    });
  }

  return { ready, handover, odd, inbound, tick, status, sendToStaff, fanOut, lastCustomerText, dailyDigest, flushOdd, stop: () => { if (timer) clearInterval(timer); } };
}
