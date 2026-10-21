/* ═══════════════════════════════════════════════════════════════════════════
   📇 قايمتين أرقام بسبب لكل رقم (SX1 — ١٥/١٠)

   الحادثة (١٥/١٠ ١٨:٣٧): عميل 0568•••14 كتب «السلام عليكم» ثم «عندي ملاحظات» والبوت سكت
   (wa_bot_log: silent / never_reply / staff). السبب: رقمه في settings.cms.campaigns.excludePhones — قايمة
   اتعملت ١٧/٩ عشان «مايوصلهمش حملات» (فيها الـ١١ سفير بتوع برنامج الدعوات بالظبط)، بس الكود كان بيقراها
   «موظفين» في كل حتة: smsrules.staffPhoneSet ⇒ cms_contacts.is_staff ⇒ البوت (autoNeverMap من ١٢/١٠) مابيردش.
   مفيش شاشة للقايمة دي ومفيش سبب متسجّل لأي رقم فيها.

   الحل: قايمتين صريحتين، كل رقم فيهم معاه سبب ومين ضافه وإمتى (settings.cms.phoneLists — «cms» ملك السيرفر،
   الـPUT الكامل للإعدادات مابيلمسوش):
     staffPhones   «موظفين / فريق»: البوت والمساعد ساكتين، برا كل الحملات والتسويق ورفع الإعلانات، ومش بيتحسبوا عملاء.
     noAdsPhones   «مستثنين من الإعلانات بس»: برا الحملات/التسويق/رفع الإعلانات — بس البوت والمساعد بيردّوا عادي،
                   ورسايل الطلبات والتقييم عادي، وبيتحسبوا عملاء.
     reviewPhones  «مستني قرار المالك»: رقم من القايمة القديمة عنده طلبات موقع مدفوعة أو محادثات واتساب ⇒ شكله عميل، فمايتحطّش
                   في «موظفين» لوحده. لحد ما المالك يقرر: البوت والمساعد بيردّوا عليه عادي (ده بالظبط اللي كان ناقص 0568•••14)،
                   وبيفضل برا الحملات والتسويق (القايمة القديمة كانت «مايوصلهمش حملات»)، وبيتحسب عميل — يعني زي «مستثنين من
                   الإعلانات بس» بالظبط، وده المقترح الأول في قراره.

   مين بيقرا إيه (مصدر واحد):
     teamPhones(settings)         = الفريق: أرقام تنبيهات الطلبات + دليل الفريق (waTeam) + staffPhones
                                    (+ القايمة القديمة لو الترحيل لسه ماحصلش) — «مش عميل».
     noMarketingPhones(settings)  = teamPhones + noAdsPhones + reviewPhones — «مايوصلوش تسويق ولا يترفعوا لمنصات الإعلانات».
     silentMap(settings)          = اللي البوت ساكت عليهم بسبب القايمة (staff_list) = staffPhones بس — **عمرها ما فيها noAds
                                    ولا المستنيين قرار**.

   شبكة الأمان (staffSilent): رقم البوت ساكت عليه بسبب قايمة «موظفين / فريق» (مش عضو في دليل الفريق) كتب ومحدش رد خلال afterMin
   دقيقة ⇒ تحويل عادي على البورتال والصندوق «رقم في قايمة الموظفين كتب ومحدش رد» (wabotrun.js sweeps / staff_silent).

   الفحص اليومي (check): أرقام قايمة الموظفين اللي بتتصرف زي عملاء (طلب موقع مدفوع برقمهم، أو محادثة فيها نية عميل)
   بعد ما اتضافوا (أو بعد آخر «تمام، موظف فعلاً») ⇒ صف واحد في اليوم في cms_phone_list_checks، بيظهر في «الفريق
   والتنبيهات» وسطر واحد في الملخص اليومي للملّاك. مفيش رسالة لكل رقم.

   المسارات (المالك بس):
     GET  /api/cms/phone-lists               القوايم + الأرقام الضمنية (دليل الفريق/التنبيهات) + الدليل لكل رقم + الإعدادات + آخر فحص + السجل
     POST /api/cms/phone-lists/entry         { list: staff|noAds, phone, name?, reason, note? } — إضافة أو نقل (السبب إجباري)
     POST /api/cms/phone-lists/remove        { phone } — يشيله من كل القوايم (يرجع عميل عادي)
     POST /api/cms/phone-lists/decide        { phone, to: staff|noAds|none, reason? } — قرار على رقم مستني مراجعة
     POST /api/cms/phone-lists/flag-ok       { phone } — «تمام، موظف فعلاً» على رقم طلع في الفحص اليومي
     PUT  /api/cms/phone-lists/settings      { staffSilent: { enabled, afterMin }, check: { enabled, at } }
     POST /api/cms/phone-lists/check         شغّل الفحص دلوقتي
     GET  /api/cms/phone-lists/flags         آخر فحص (لكارت «الفريق والتنبيهات»)
═══════════════════════════════════════════════════════════════════════════ */

export const LIST_IDS = Object.freeze(["staff", "noAds"]);
export const LIST_KEY = Object.freeze({ staff: "staffPhones", noAds: "noAdsPhones", review: "reviewPhones" });

/* الأسباب — legacy للترحيل بس (مايتختارش من الشاشة) */
export const REASONS = Object.freeze([
  { id: "employee", label: "موظف" },
  { id: "owner", label: "مالك" },
  { id: "family", label: "عائلة / أصحاب المحل" },
  { id: "ads_request", label: "عميل طلب مايوصلوش إعلانات" },
  { id: "test", label: "رقم تجربة" },
  { id: "ambassador", label: "سفير (برنامج الدعوات)" },
]);
export const LEGACY_REASON = Object.freeze({ id: "legacy", label: "من قايمة الاستبعاد القديمة — السبب مش متسجّل" });
export const REASON_IDS = REASONS.map((r) => r.id);
export const reasonLabel = (id) => (REASONS.find((r) => r.id === id) || (id === LEGACY_REASON.id ? LEGACY_REASON : null) || { label: String(id || "—") }).label;
/* السبب ده مكانه «مستثنين من الإعلانات بس» بس: عميل — البوت لازم يرد عليه (ده بالظبط اللي سكّت البوت على 0568•••14) */
export const NO_ADS_ONLY_REASONS = Object.freeze(["ads_request"]);
export const DEFAULT_REASON = Object.freeze({ staff: "employee", noAds: "ads_request" });

export const LISTS_AR = Object.freeze({
  staff: {
    label: "موظفين / فريق",
    effects: [
      "البوت والمساعد مابيردّوش عليه على واتساب",
      "لو كتب ومحدش من الفريق رد خلال الدقايق اللي تحت ⇒ تحويل عادي على البورتال والصندوق",
      "مابيوصلوش أي حملة أو رسالة تسويق (SMS / واتساب / إشعار / استرجاع السلة / الولاء / الأتمتة)، ومابيترفعش لمنصات الإعلانات",
      "مابيتحسبش عميل في الأرقام والتقارير وملف العملاء",
      "رسايل طلباته (تأكيد / تتبع) بتوصله عادي، بس مابيتطلبش منه تقييم",
    ],
  },
  noAds: {
    label: "مستثنين من الإعلانات بس",
    effects: [
      "البوت والمساعد بيردّوا عليه عادي",
      "رسايل طلباته وطلب التقييم بعد الطلب بتوصله عادي",
      "مابيوصلوش أي حملة أو رسالة تسويق (SMS / واتساب / إشعار / استرجاع السلة / الولاء / الأتمتة)، ومابيترفعش لمنصات الإعلانات",
      "بيتحسب عميل عادي في الأرقام والتقارير",
    ],
  },
  review: {
    label: "مستني قرارك",
    effects: [
      "كان في قايمة الاستبعاد القديمة وعنده طلبات من الموقع أو محادثات واتساب — شكله عميل، فماتحطّش في «موظفين» لوحده",
      "لحد ما تقرر: البوت والمساعد بيردّوا عليه عادي، ورسايل طلباته عادي",
      "ولحد ما تقرر برضه: مابيوصلوش حملات ولا تسويق (زي ما كان — القايمة القديمة كانت لاستبعاد الحملات)",
    ],
  },
});

export const DEFAULTS = Object.freeze({
  staffSilent: Object.freeze({ enabled: true, afterMin: 5 }),
  check: Object.freeze({ enabled: true, at: "11:30" }),
});
export const LIMITS = Object.freeze({ afterMin: [1, 60], name: 40, note: 120, entries: 300 });

/* نوايا العميل في سجل البوت (wa_bot_log.reply_key) — للفحص اليومي ودليل المراجعة. «سلام / شكراً / تمام / مش مفهوم» مش نية عميل. */
export const CUSTOMER_KEYS = Object.freeze(["cats", "cat", "best", "boxes", "box", "tier", "packs", "offers", "order", "delivery", "delivery_time", "eta", "hours", "hoursloc",
  "location", "payment", "status", "complaint", "problem", "change", "human", "item", "items", "reorder", "weight", "dishfact", "faq", "area", "pickup",
  "review_note", "review_ok", "main", "menu", "custom_offer", "spicy", "notmenu"]);

export const normPhone = (p) => {
  const d = String(p == null ? "" : typeof p === "object" ? p.phone || p.mobile || "" : p).replace(/\D/g, "").replace(/^00/, "").replace(/^966/, "").replace(/^0/, "");
  return /^5\d{8}$/.test(d) ? d : null;
};
import { reviewPhoneOf } from "./appreview.js";      // AR1: رقم مراجع Apple/Google برا التسويق

const listOfRaw = (v) => (Array.isArray(v) ? v : String(v || "").split(/[,\s،;]+/));
const clip = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : null; };
export const mask = (pn) => (pn ? `05${String(pn).slice(1, 2)}•••${String(pn).slice(-2)}` : "");
export const last4 = (pn) => `…${String(pn || "").slice(-4)}`;

const hhmmOk = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));

/* صف واحد ⇒ شكل ثابت. reason مش معروف ⇒ legacy (مانخترعش سبب). */
export function entryOf(raw, fallbackReason = LEGACY_REASON.id) {
  const phone = normPhone(raw);
  if (!phone) return null;
  const o = raw && typeof raw === "object" ? raw : {};
  const reason = REASON_IDS.includes(o.reason) || o.reason === LEGACY_REASON.id ? o.reason : fallbackReason;
  const e = { phone, name: clip(o.name, LIMITS.name), reason, note: clip(o.note, LIMITS.note), added_by: clip(o.added_by, 60) || null, added_at: iso(o.added_at), source: clip(o.source, 20) || null };
  if (o.ok_at) e.ok_at = iso(o.ok_at);
  if (o.evidence && typeof o.evidence === "object") e.evidence = o.evidence;
  if (o.suggest && LIST_IDS.concat(["none"]).includes(o.suggest)) e.suggest = o.suggest;
  return e;
}

/* settings ⇒ { migrated, staff[], noAds[], review[], cfg } — رقم واحد في قايمة واحدة بس (الأولوية: staff ثم review ثم noAds) */
export function listsOf(settings) {
  const x = settings && settings.cms && settings.cms.phoneLists && typeof settings.cms.phoneLists === "object" ? settings.cms.phoneLists : {};
  const seen = new Set();
  const take = (arr) => {
    const out = [];
    for (const r of Array.isArray(arr) ? arr.slice(0, LIMITS.entries) : []) {
      const e = entryOf(r); if (!e || seen.has(e.phone)) continue;
      seen.add(e.phone); out.push(e);
    }
    return out;
  };
  const staff = take(x.staffPhones), review = take(x.reviewPhones), noAds = take(x.noAdsPhones);
  return { migrated: Boolean(x.migratedAt), migratedAt: x.migratedAt || null, migratedFrom: Number(x.migratedFrom) || 0, staff, noAds, review, cfg: cfgOf(x) };
}
export function cfgOf(x = {}) {
  const ss = x.staffSilent && typeof x.staffSilent === "object" ? x.staffSilent : {}, ck = x.check && typeof x.check === "object" ? x.check : {};
  const n = Number(ss.afterMin);
  return {
    staffSilent: { enabled: ss.enabled !== false, afterMin: Number.isFinite(n) && n >= LIMITS.afterMin[0] && n <= LIMITS.afterMin[1] ? Math.round(n) : DEFAULTS.staffSilent.afterMin },
    check: { enabled: ck.enabled !== false, at: hhmmOk(ck.at) ? ck.at : DEFAULTS.check.at },
  };
}

/* دليل الفريق (settings.waTeam.members) — نفس قاعدة wateam.teamConfig: الأعضاء الشغّالين بدور معروف، ولو الدليل لسه مااتكتبش ⇒ أرقام تنبيهات البوت */
const TEAM_ROLES = ["cashier", "manager", "owner", "social"];      // WT2: + سوشيال ميديا (مهام يدوية)
const TEAM_ROLE_AR = { cashier: "كاشير", manager: "مدير", owner: "مالك", social: "سوشيال ميديا" };
export const teamRoleAr = (r) => TEAM_ROLE_AR[r] || "كاشير";
export function teamMembers(settings) {
  const t = settings && settings.waTeam && typeof settings.waTeam === "object" ? settings.waTeam : {};
  if (Array.isArray(t.members)) {
    const out = [], seen = new Set();
    for (const m of t.members) {
      const phone = normPhone(m && m.phone);
      if (!phone || seen.has(phone) || !TEAM_ROLES.includes(m.role) || m.active === false) continue;
      seen.add(phone); out.push({ phone, name: clip(m.name, LIMITS.name), role: m.role });
    }
    return out;
  }
  const bot = listOfRaw(settings && settings.waBot && settings.waBot.alertPhones).map(normPhone).filter(Boolean);
  return [...new Set(bot)].map((phone) => ({ phone, name: "", role: "cashier", fallback: true }));
}
/* أرقام تنبيهات الطلبات (settings.delivery) — دي أرقام الإدارة من الأول */
export function alertPhones(settings) {
  const d = (settings && settings.delivery) || {};
  return [...new Set([...listOfRaw(d.alertPhones), ...listOfRaw(d.newOrderPhones)].map(normPhone).filter(Boolean))];
}
/* القايمة القديمة (settings.cms.campaigns.excludePhones) — بتتقري بس لحد ما الترحيل يحصل */
export function legacyPhones(settings) {
  const c = settings && settings.cms && settings.cms.campaigns ? settings.cms.campaigns : {};
  return [...new Set(listOfRaw(c.excludePhones).map(normPhone).filter(Boolean))];
}

export function teamPhones(settings = {}) {
  const s = settings || {}, L = listsOf(s), out = new Set();
  for (const p of alertPhones(s)) out.add(p);
  for (const m of teamMembers(s)) out.add(m.phone);
  for (const e of L.staff) out.add(e.phone);
  if (!L.migrated) for (const p of legacyPhones(s)) out.add(p);
  return out;
}
export function noAdsPhones(settings = {}) {
  return new Set(listsOf(settings || {}).noAds.map((e) => e.phone));
}
export function noMarketingPhones(settings = {}) {
  const out = teamPhones(settings);
  for (const p of noAdsPhones(settings)) out.add(p);
  for (const e of listsOf(settings || {}).review) out.add(e.phone);      // مستني قرار المالك: برا التسويق زي ما كان لحد القرار
  const rv = reviewPhoneOf(settings || {}); if (rv) out.add(rv);          // AR1: رقم مراجع المتجر — حتى بعد قفل الميزة
  return out;
}
/* البوت ساكت بسبب القايمة: phone ⇒ "staff_list" — قايمة «موظفين / فريق» بس. المستنيين قرار المالك والمستثنين من الإعلانات البوت بيرد عليهم.
   دليل الفريق وأرقام التنبيهات ليهم أسبابهم في wabotrun (staff / alert_phone). */
export function silentMap(settings = {}) {
  const s = settings || {}, L = listsOf(s), m = new Map();
  for (const e of L.staff) m.set(e.phone, "staff_list");
  if (!L.migrated) for (const p of legacyPhones(s)) if (!m.has(p)) m.set(p, "staff_list");
  return m;
}
export const SILENT_WHY = Object.freeze(["staff_list"]);
export const SILENT_WHY_AR = Object.freeze({ staff_list: "رقم موظف — البوت ساكت" });
/* الرقم ده فين؟ ⇒ { list: staff|noAds|review|team|alert|null, entry, member } */
export function whereIs(settings, phone) {
  const pn = normPhone(phone); if (!pn) return { list: null };
  const L = listsOf(settings || {});
  for (const k of ["staff", "review", "noAds"]) { const e = L[k].find((x) => x.phone === pn); if (e) return { list: k, entry: e }; }
  const mem = teamMembers(settings || {}).find((x) => x.phone === pn);
  if (mem) return { list: "team", member: mem };
  if (alertPhones(settings || {}).includes(pn)) return { list: "alert" };
  if (!L.migrated && legacyPhones(settings || {}).includes(pn)) return { list: "legacy" };
  return { list: null };
}

/* ── الترحيل (مرة واحدة) ──────────────────────────────────────────────────────
   legacy = أرقام excludePhones · team = دليل الفريق · ambassadors = أرقام السفراء · evidence: Map(pn ⇒ { web, chats, intent, pos, name, webAt, chatAt }) أو null (القراية فشلت)
   ⇒ { staff, review }:
     • عضو في دليل الفريق ⇒ staff بسبب دوره (مالك ⇒ owner، غير كده employee)
     • رقم تنبيهات الطلبات (إعدادات التوصيل) ⇒ staff «موظف» (أرقام الإدارة من الأول — البوت أصلاً ساكت عليها alert_phone)
     • عنده طلب موقع مدفوع أو محادثة واتساب ⇒ review (شكله عميل: البوت بيرد عليه وبرا التسويق لحد قرار المالك — مايتحطّش «موظف» لوحده)
     • الدليل مش مقروء ⇒ review (مانعرفش ⇒ المالك يقرر، والبوت بيرد لحد ما يقرر)
     • غير كده ⇒ staff بسببه الحقيقي: سفير لو في قايمة السفراء، وإلا legacy («السبب مش متسجّل») */
export function planMigration({ legacy = [], team = [], alerts = [], ambassadors = new Set(), names = new Map(), evidence = null, who = "ترحيل تلقائي (SX1)", now = new Date() } = {}) {
  const at = new Date(now).toISOString(), staff = [], review = [];
  const byTeam = new Map(team.map((m) => [m.phone, m])), alertSet = new Set(alerts.map(normPhone).filter(Boolean));
  for (const raw of legacy) {
    const phone = normPhone(raw); if (!phone) continue;
    const mem = byTeam.get(phone), amb = ambassadors.has(phone);
    const name = clip((mem && mem.name) || names.get(phone) || (evidence && evidence.get(phone) && evidence.get(phone).name) || "", LIMITS.name);
    const base = { phone, name, added_by: who, added_at: at, source: "migration" };
    if (mem) { staff.push({ ...base, reason: mem.role === "owner" ? "owner" : "employee", note: `في دليل الفريق (${teamRoleAr(mem.role)})` }); continue; }
    if (alertSet.has(phone)) { staff.push({ ...base, reason: "employee", note: "رقم تنبيهات الطلبات (إعدادات التوصيل)" }); continue; }
    const ev = evidence ? evidence.get(phone) || { web: 0, chats: 0, intent: 0 } : null;
    const reason = amb ? "ambassador" : LEGACY_REASON.id;
    if (!ev) { review.push({ ...base, reason, note: "مقدرناش نقرا طلباته ومحادثاته وقت الترحيل", evidence: null, suggest: "none" }); continue; }
    if ((Number(ev.web) || 0) > 0 || (Number(ev.chats) || 0) > 0) {
      review.push({ ...base, reason, note: amb ? "سفير في برنامج الدعوات — بس عنده طلبات/محادثات زي العميل" : "عنده طلبات/محادثات زي العميل", evidence: evidenceView(ev), suggest: "noAds" });
      continue;
    }
    staff.push({ ...base, reason, note: amb ? "سفير في برنامج الدعوات (اتنقل من قايمة استبعاد الحملات ١٧/٩)" : "اتنقل من قايمة استبعاد الحملات القديمة" });
  }
  return { staff, review };
}
export const evidenceView = (ev) => (ev ? { web: Number(ev.web) || 0, chats: Number(ev.chats) || 0, intent: Number(ev.intent) || 0, pos: Number(ev.pos) || 0,
  webAt: iso(ev.webAt), chatAt: iso(ev.chatAt) } : null);

/* ── التعديلات (صافية) ──────────────────────────────────────────────────────
   كل عملية ⇒ { ok, next, change } أو { ok:false, error, message }. next = phoneLists الجديدة (القديمة مابتتغيّرش). */
const stripFrom = (x, pn) => {
  const out = { ...x };
  let from = null;
  for (const k of ["staff", "review", "noAds"]) {
    const key = LIST_KEY[k], arr = Array.isArray(out[key]) ? out[key] : [];
    if (arr.some((r) => normPhone(r) === pn)) { from = from || k; out[key] = arr.filter((r) => normPhone(r) !== pn); }
  }
  return { out, from };
};
export function addEntry(cur, body, { who, now = new Date(), settings = {} } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const bad = (error, message) => ({ ok: false, error, message });
  if (!LIST_IDS.includes(b.list)) return bad("bad_list", "اختار القايمة: «موظفين / فريق» أو «مستثنين من الإعلانات بس»");
  const pn = normPhone(b.phone);
  if (!pn) return bad("bad_phone", "اكتب جوال سعودي 05XXXXXXXX");
  const reason = String(b.reason || "");
  if (!reason) return bad("reason_required", "لازم تختار السبب — من غير سبب الرقم مش هيتضاف");
  if (!REASON_IDS.includes(reason)) return bad("bad_reason", "السبب مش من القايمة");
  if (b.list === "staff" && NO_ADS_ONLY_REASONS.includes(reason)) return bad("reason_wrong_list", "«عميل طلب مايوصلوش إعلانات» مكانه «مستثنين من الإعلانات بس» — ده عميل والبوت لازم يرد عليه");
  const mem = teamMembers(settings).find((m) => m.phone === pn);
  if (mem && b.list === "noAds") return bad("team_member", `الرقم ده في دليل الفريق (${teamRoleAr(mem.role)}) — البوت أصلاً مابيردش عليه. شيله من الدليل الأول لو عايزه عميل`);
  const x = cur && typeof cur === "object" ? cur : {};
  const { out, from } = stripFrom(x, pn);
  const prev = from ? listsOf({ cms: { phoneLists: x } })[from].find((e) => e.phone === pn) : null;
  const e = { phone: pn, name: clip(b.name, LIMITS.name) || (prev && prev.name) || "", reason, note: clip(b.note, LIMITS.note), added_by: clip(who, 60) || "المالك", added_at: new Date(now).toISOString(), source: "dashboard" };
  const key = LIST_KEY[b.list], arr = Array.isArray(out[key]) ? out[key] : [];
  if (arr.length >= LIMITS.entries) return bad("too_many", `القايمة وصلت ${LIMITS.entries} رقم`);
  out[key] = [...arr, e];
  return { ok: true, next: out, entry: e, change: { action: !from ? "add" : from === "review" ? "decide" : from === b.list ? "update" : "move", phone: pn, from, to: b.list, reason, note: e.note || null } };
}
export function removeEntry(cur, phone) {
  const pn = normPhone(phone);
  if (!pn) return { ok: false, error: "bad_phone", message: "اكتب جوال سعودي 05XXXXXXXX" };
  const { out, from } = stripFrom(cur && typeof cur === "object" ? cur : {}, pn);
  if (!from) return { ok: false, error: "not_listed", message: "الرقم ده مش في أي قايمة" };
  return { ok: true, next: out, change: { action: from === "review" ? "decide" : "remove", phone: pn, from, to: null, reason: null, note: null } };
}
export function decideEntry(cur, body, opts = {}) {
  const b = body && typeof body === "object" ? body : {};
  const pn = normPhone(b.phone);
  if (!pn) return { ok: false, error: "bad_phone", message: "اكتب جوال سعودي 05XXXXXXXX" };
  const L = listsOf({ cms: { phoneLists: cur || {} } });
  const e = L.review.find((x) => x.phone === pn);
  if (!e) return { ok: false, error: "not_in_review", message: "الرقم ده مش مستني قرار" };
  if (b.to === "none") return removeEntry(cur, pn);
  if (!LIST_IDS.includes(b.to)) return { ok: false, error: "bad_list", message: "اختار: موظف / مستثنى من الإعلانات بس / عميل عادي" };
  const reason = b.reason || (b.to === "noAds" ? "ads_request" : e.reason !== LEGACY_REASON.id ? e.reason : "");
  return addEntry(cur, { list: b.to, phone: pn, name: b.name || e.name, reason, note: b.note || e.note }, opts);
}
export function flagOk(cur, phone, { now = new Date() } = {}) {
  const pn = normPhone(phone);
  const x = { ...(cur && typeof cur === "object" ? cur : {}) };
  const arr = Array.isArray(x.staffPhones) ? x.staffPhones : [];
  if (!pn || !arr.some((r) => normPhone(r) === pn)) return { ok: false, error: "not_staff", message: "الرقم ده مش في قايمة الموظفين" };
  x.staffPhones = arr.map((r) => (normPhone(r) === pn ? { ...(typeof r === "object" ? r : { phone: pn }), ok_at: new Date(now).toISOString() } : r));
  return { ok: true, next: x, change: { action: "flag_ok", phone: pn, from: "staff", to: "staff", reason: null, note: null } };
}
export function settingsFromBody(cur, body) {
  const b = body && typeof body === "object" ? body : {}, errors = [];
  const x = { ...(cur && typeof cur === "object" ? cur : {}) };
  if ("staffSilent" in b) {
    const g = b.staffSilent && typeof b.staffSilent === "object" ? b.staffSilent : null;
    if (!g) errors.push("staffSilent: كائن");
    else {
      const next = { ...(x.staffSilent || {}) };
      if ("enabled" in g) { if (typeof g.enabled === "boolean") next.enabled = g.enabled; else errors.push("staffSilent.enabled: true أو false"); }
      if ("afterMin" in g) { const n = Number(g.afterMin); if (Number.isFinite(n) && n >= LIMITS.afterMin[0] && n <= LIMITS.afterMin[1]) next.afterMin = Math.round(n); else errors.push(`staffSilent.afterMin: من ${LIMITS.afterMin[0]} لـ${LIMITS.afterMin[1]} دقيقة`); }
      x.staffSilent = next;
    }
  }
  if ("check" in b) {
    const g = b.check && typeof b.check === "object" ? b.check : null;
    if (!g) errors.push("check: كائن");
    else {
      const next = { ...(x.check || {}) };
      if ("enabled" in g) { if (typeof g.enabled === "boolean") next.enabled = g.enabled; else errors.push("check.enabled: true أو false"); }
      if ("at" in g) { if (hhmmOk(g.at)) next.at = g.at; else errors.push("check.at: وقت بصيغة HH:MM"); }
      x.check = next;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, next: x };
}

/* ── الفحص اليومي (صافي) ────────────────────────────────────────────────────
   rows = أرقام قايمة الموظفين (مش أعضاء دليل الفريق، ومش «رقم تجربة») + الدليل من تاريخ إضافتها أو آخر «تمام» ⇒ اللي بيتصرف زي عميل */
export function flagsOf(settings, evidence) {
  const L = listsOf(settings || {}), team = new Set(teamMembers(settings || {}).map((m) => m.phone));
  const out = [];
  for (const e of L.staff) {
    if (team.has(e.phone) || e.reason === "test") continue;
    const ev = evidence && evidence.get(e.phone);
    if (!ev) continue;
    const web = Number(ev.web) || 0, intent = Number(ev.intent) || 0;
    if (web <= 0 && intent <= 0) continue;
    out.push({ phone: e.phone, name: e.name || ev.name || "", reason: e.reason, web, intent, webAt: iso(ev.webAt), chatAt: iso(ev.chatAt),
      why: [web > 0 ? `${web} طلب موقع مدفوع برقمه` : null, intent > 0 ? `${intent} رسالة فيها نية عميل (طلب / منيو / شكوى…)` : null].filter(Boolean).join("، ") });
  }
  return out;
}
export const sinceOf = (e) => { const a = Date.parse(e.added_at || ""), o = Date.parse(e.ok_at || ""); const m = Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(o) ? o : 0); return new Date(m || 0).toISOString(); };

/* الدليل لكل رقم (كل الأوقات لو since = 1970): طلبات الموقع المدفوعة برقمه (مش تجربة ولا كوبون المالك)، الرسايل الواردة، الرسايل اللي فيها نية عميل، وطلبات نقطة البيع.
   $1 الأرقام · $2 «من» لكل رقم · $3 كوبونات المالك · $4 نوايا العميل */
export const PAID_WEB = "o.status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')";
export const EVIDENCE_SQL = `/*pl:evidence*/ SELECT p.pn,
    (SELECT count(*) FROM shop_orders o WHERE o.phone_norm = p.pn AND ${PAID_WEB} AND NOT COALESCE(o.is_test,false) AND upper(COALESCE(o.coupon,'')) <> ALL($3::text[]) AND o.created_at >= p.since)::int AS web,
    (SELECT max(o.created_at) FROM shop_orders o WHERE o.phone_norm = p.pn AND ${PAID_WEB} AND NOT COALESCE(o.is_test,false) AND upper(COALESCE(o.coupon,'')) <> ALL($3::text[]) AND o.created_at >= p.since) AS web_at,
    (SELECT count(*) FROM wa_messages m WHERE m.phone_norm = p.pn AND m.direction = 'in' AND COALESCE(m.source,'api') <> 'history' AND m.created_at >= p.since)::int AS chats,
    (SELECT max(m.created_at) FROM wa_messages m WHERE m.phone_norm = p.pn AND m.direction = 'in' AND COALESCE(m.source,'api') <> 'history' AND m.created_at >= p.since) AS chat_at,
    (SELECT count(*) FROM wa_bot_log l WHERE l.phone_norm = p.pn AND l.reply_key = ANY($4::text[]) AND l.at >= p.since)::int AS intent,
    (SELECT c.orders FROM cms_contacts c WHERE c.phone_norm = p.pn) AS pos,
    (SELECT c.name FROM cms_contacts c WHERE c.phone_norm = p.pn) AS name
  FROM unnest($1::text[], $2::timestamptz[]) AS p(pn, since)`;

const DDL = `
  CREATE TABLE IF NOT EXISTS cms_phone_list_log (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    who TEXT,
    action TEXT NOT NULL,
    phone_norm TEXT NOT NULL,
    from_list TEXT,
    to_list TEXT,
    reason TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS cms_phone_list_log_at_idx ON cms_phone_list_log(at DESC);
  CREATE TABLE IF NOT EXISTS cms_phone_list_checks (
    day DATE PRIMARY KEY,
    ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    trigger TEXT,
    flagged INT NOT NULL DEFAULT 0,
    rows JSONB
  );
`;
const riyadhDay = (d) => new Date(new Date(d).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
const riyadhMin = (d) => { const t = new Date(d).getTime() + 3 * 3600_000; return Math.floor((((t % 86400_000) + 86400_000) % 86400_000) / 60_000); };
/* اليوم التشغيلي بيبدأ ٤ الفجر (bizday.js) — الفحص مرة واحدة في اليوم ده */
const bizDayOf = (d) => riyadhDay(new Date(new Date(d).getTime() - 4 * 3600_000));

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const isOwner = ctx.isOwner || (async () => true);
  const clock = deps.now || (() => new Date());
  const log = deps.log || console;
  const OWNER_COUPONS = deps.ownerCoupons || ["OMAR-9X4T"];
  const q = async (sql, p = []) => { try { return (await pool.query(sql, p)).rows || []; } catch (e) { log.error("[phone-lists] db:", e.message); return null; } };
  const ready = pool.query(DDL).then(() => true).catch((e) => { log.error("[phone-lists] schema:", e.message); return false; });
  const settingsNow = async () => { try { return (await getSettingsData()) || {}; } catch { return null; } };
  const actor = async (c) => { try { const u = deps.whoami ? await deps.whoami(c) : null; return clip((u && (u.name || u.username)) || "المالك", 60); } catch { return "المالك"; } };
  const bad = (c, error, message, status = 400) => c.json({ ok: false, error, message }, status);

  async function evidenceFor(pairs) {
    if (!pairs.length) return new Map();
    const r = await q(EVIDENCE_SQL, [pairs.map((x) => x[0]), pairs.map((x) => x[1]), OWNER_COUPONS, CUSTOMER_KEYS]);
    if (r === null) return null;
    return new Map(r.map((x) => [x.pn, { web: x.web, webAt: x.web_at, chats: x.chats, chatAt: x.chat_at, intent: x.intent, pos: x.pos == null ? null : Number(x.pos), name: x.name || "" }]));
  }
  /* is_staff في ملف العملاء = الفريق بس (مش المستثنين من الإعلانات) — فوراً بعد أي تعديل، من غير مااستنى دورة الـ٣٠ دقيقة */
  async function syncStaffFlags(settings) {
    const staff = [...teamPhones(settings)];
    return q(`UPDATE cms_contacts SET is_staff = (phone_norm = ANY($1::text[])) WHERE is_staff IS DISTINCT FROM (phone_norm = ANY($1::text[]))`, [staff]);
  }
  /* كتابة phoneLists كلها جوّه transaction (قفل الصف) — fn(cur) ⇒ { ok, next, change } */
  async function mutate(fn, who) {
    const client = await pool.connect();
    let res = null;
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT data FROM settings WHERE id=1 FOR UPDATE")).rows[0];
      const data = (row && row.data) || {};
      const cur = data.cms && data.cms.phoneLists && typeof data.cms.phoneLists === "object" ? data.cms.phoneLists : {};
      res = fn(cur, data);
      if (!res || !res.ok) { await client.query("ROLLBACK"); return res; }
      await client.query(`UPDATE settings SET data = jsonb_set(CASE WHEN data ? 'cms' THEN data ELSE jsonb_set(data,'{cms}','{}'::jsonb,true) END, '{cms,phoneLists}', $1::jsonb, true), updated_at = NOW() WHERE id=1`, [JSON.stringify(res.next)]);
      if (res.change) {
        const ch = res.change;
        await client.query("INSERT INTO cms_phone_list_log(who, action, phone_norm, from_list, to_list, reason, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [who || null, ch.action, ch.phone, ch.from || null, ch.to || null, ch.reason || null, ch.note || null]);
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
    finally { client.release(); }
    const s = await settingsNow();
    if (s) await syncStaffFlags(s);
    return res;
  }

  /* ── الترحيل: مرة واحدة، أول إقلاع بعد النزول. الشرط في نفس الـUPDATE (migratedAt مش موجود) ⇒ حاوية واحدة بس بتكتب وقت التبديل. ── */
  async function migrate({ now = clock() } = {}) {
    await ready;
    const s = await settingsNow(); if (!s) return { skipped: "settings_unreadable" };
    if (listsOf(s).migrated) return { skipped: "already" };
    const legacy = legacyPhones(s);
    let evidence = null, ambassadors = new Set(), names = new Map();
    if (legacy.length) {
      evidence = await evidenceFor(legacy.map((p) => [p, "1970-01-01T00:00:00Z"]));
      const a = await q("SELECT phone_norm, name FROM ambassadors WHERE COALESCE(phone_norm,'') <> ''", []);
      for (const r of a || []) { const p = normPhone(r.phone_norm); if (p) { ambassadors.add(p); if (r.name) names.set(p, r.name); } }
    }
    const plan = planMigration({ legacy, team: teamMembers(s), alerts: alertPhones(s), ambassadors, names, evidence, now });
    const cur = (s.cms && s.cms.phoneLists) || {};
    const next = { ...cur, staffPhones: [...(Array.isArray(cur.staffPhones) ? cur.staffPhones : []), ...plan.staff], reviewPhones: [...(Array.isArray(cur.reviewPhones) ? cur.reviewPhones : []), ...plan.review],
      noAdsPhones: Array.isArray(cur.noAdsPhones) ? cur.noAdsPhones : [], migratedAt: new Date(now).toISOString(), migratedFrom: legacy.length };
    const r = await pool.query(`UPDATE settings SET data = jsonb_set(CASE WHEN data ? 'cms' THEN data ELSE jsonb_set(data,'{cms}','{}'::jsonb,true) END, '{cms,phoneLists}', $1::jsonb, true), updated_at = NOW()
                                 WHERE id=1 AND (data #> '{cms,phoneLists,migratedAt}') IS NULL`, [JSON.stringify(next)]).catch((e) => { log.error("[phone-lists] migrate:", e.message); return null; });
    if (!r || !r.rowCount) return { skipped: r ? "raced" : "write_failed" };
    for (const e of plan.staff) await q("INSERT INTO cms_phone_list_log(who, action, phone_norm, from_list, to_list, reason, note) VALUES ($1,'migrate',$2,'legacy','staff',$3,$4)", [e.added_by, e.phone, e.reason, e.note || null]);
    for (const e of plan.review) await q("INSERT INTO cms_phone_list_log(who, action, phone_norm, from_list, to_list, reason, note) VALUES ($1,'migrate',$2,'legacy','review',$3,$4)", [e.added_by, e.phone, e.reason, e.note || null]);
    const s2 = await settingsNow(); if (s2) await syncStaffFlags(s2);
    log.log(`[phone-lists] migrated ${legacy.length}: staff ${plan.staff.length}, review ${plan.review.length}`);
    return { migrated: legacy.length, staff: plan.staff.length, review: plan.review.length };
  }

  /* ── الفحص اليومي ── */
  async function runCheck({ trigger = "cron", now = clock() } = {}) {
    await ready;
    const s = await settingsNow(); if (!s) return { skipped: "settings_unreadable" };
    const L = listsOf(s);
    const pairs = L.staff.map((e) => [e.phone, sinceOf(e)]);
    const ev = await evidenceFor(pairs);
    if (ev === null) return { skipped: "evidence_unreadable" };
    const rows = flagsOf(s, ev);
    const day = bizDayOf(now);
    await q(`INSERT INTO cms_phone_list_checks(day, ran_at, trigger, flagged, rows) VALUES ($1::date, $2::timestamptz, $3, $4, $5::jsonb)
             ON CONFLICT (day) DO UPDATE SET ran_at = EXCLUDED.ran_at, trigger = EXCLUDED.trigger, flagged = EXCLUDED.flagged, rows = EXCLUDED.rows`,
      [day, new Date(now).toISOString(), clip(trigger, 20), rows.length, JSON.stringify(rows)]);
    return { day, flagged: rows.length, rows };
  }
  async function lastCheck() {
    const r = await q("SELECT day, ran_at, trigger, flagged, rows FROM cms_phone_list_checks ORDER BY day DESC LIMIT 1", []);
    if (!r || !r[0]) return null;
    const x = r[0];
    return { day: x.day instanceof Date ? x.day.toISOString().slice(0, 10) : String(x.day).slice(0, 10), ranAt: iso(x.ran_at), trigger: x.trigger, flagged: Number(x.flagged) || 0, rows: Array.isArray(x.rows) ? x.rows : [] };
  }
  /* الأرقام اللي لسه في الفحص (اتشالت أو اتعلّمت «تمام» بعده ⇒ مابتتعدّش) */
  function liveFlags(s, chk) {
    if (!chk) return [];
    const L = listsOf(s || {}), byPn = new Map(L.staff.map((e) => [e.phone, e]));
    return chk.rows.filter((r) => { const e = byPn.get(r.phone); if (!e) return false; return !(e.ok_at && Date.parse(e.ok_at) > Date.parse(chk.ranAt || 0)); });
  }
  async function tick() {
    const s = await settingsNow(); if (!s) return null;
    const cfg = listsOf(s).cfg, now = clock();
    if (!cfg.check.enabled) return null;
    const [h, m] = cfg.check.at.split(":").map(Number);
    if (riyadhMin(now) < h * 60 + m && riyadhMin(now) >= 4 * 60) return null;      // قبل الميعاد (بعد ٤ الفجر)
    const day = bizDayOf(now);
    const had = await q("SELECT 1 FROM cms_phone_list_checks WHERE day = $1::date", [day]);
    if (had === null || had.length) return null;
    return runCheck({ trigger: "cron", now });
  }

  async function view(owner) {
    const s = (await settingsNow()) || {};
    const L = listsOf(s), team = teamMembers(s), alerts = alertPhones(s);
    const all = [...L.staff, ...L.review, ...L.noAds];
    const ev = await evidenceFor(all.map((e) => [e.phone, "1970-01-01T00:00:00Z"]));
    const roleOf = new Map(team.map((m) => [m.phone, m.role]));
    const out = (e, list) => ({ ...e, phone: owner ? `0${e.phone}` : mask(e.phone), last4: e.phone.slice(-4), list, reasonAr: reasonLabel(e.reason),
      evidence: ev ? evidenceView(ev.get(e.phone)) : (e.evidence || null), ...(roleOf.has(e.phone) ? { team: roleOf.get(e.phone) } : {}) });
    const chk = await lastCheck();
    const lg = await q("SELECT at, who, action, phone_norm, from_list, to_list, reason, note FROM cms_phone_list_log ORDER BY at DESC, id DESC LIMIT 40", []);
    const listed = new Set(all.map((e) => e.phone));
    return {
      ok: true, owner: Boolean(owner), migrated: L.migrated, migratedAt: L.migratedAt, migratedFrom: L.migratedFrom,
      lists: { staff: L.staff.map((e) => out(e, "staff")), noAds: L.noAds.map((e) => out(e, "noAds")), review: L.review.map((e) => out(e, "review")) },
      implicit: [
        ...team.filter((m) => !listed.has(m.phone)).map((m) => ({ phone: owner ? `0${m.phone}` : mask(m.phone), last4: m.phone.slice(-4), name: m.name, source: "team", role: m.role,
          why: m.fallback ? "من أرقام تنبيهات البوت (دليل الفريق لسه مااتكتبش)" : `في دليل الفريق (${teamRoleAr(m.role)})` })),
        ...alerts.filter((p) => !listed.has(p) && !team.some((m) => m.phone === p)).map((p) => ({ phone: owner ? `0${p}` : mask(p), last4: p.slice(-4), name: "", source: "alert", why: "رقم تنبيهات الطلبات (إعدادات التوصيل)" })),
      ],
      legacyLeft: L.migrated ? 0 : legacyPhones(s).length,
      reasons: REASONS, defaults: DEFAULT_REASON, noAdsOnly: NO_ADS_ONLY_REASONS, lists_ar: LISTS_AR, cfg: L.cfg, limits: { afterMin: LIMITS.afterMin, name: LIMITS.name, note: LIMITS.note },
      check: chk ? { ...chk, rows: liveFlags(s, chk).map((r) => ({ ...r, phone: owner ? `0${r.phone}` : mask(r.phone), last4: r.phone.slice(-4), reasonAr: reasonLabel(r.reason) })) } : null,
      log: (lg || []).map((r) => ({ at: iso(r.at), who: r.who, action: r.action, phone: owner ? `0${r.phone_norm}` : mask(r.phone_norm), last4: String(r.phone_norm).slice(-4), from: r.from_list, to: r.to_list, reason: r.reason, reasonAr: r.reason ? reasonLabel(r.reason) : null, note: r.note })),
    };
  }

  const ownerOnly = async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return bad(c, "owner_only", "قوايم الأرقام للمالك بس", 403);
    return null;
  };
  const body = async (c) => { try { return (await c.req.json()) || {}; } catch { return null; } };
  const write = async (c, fn) => {
    const no = await ownerOnly(c); if (no) return no;
    const b = await body(c); if (!b) return bad(c, "bad_json", "البيانات مش صحيحة");
    const who = await actor(c);
    let r;
    try { r = await mutate((cur, data) => fn(cur, b, { who, now: clock(), settings: data }), who); }
    catch (e) { log.error("[phone-lists] write:", e.message); return bad(c, "write_failed", "ماتحفظش — جرّب تاني", 500); }
    if (!r || !r.ok) return c.json({ ok: false, error: (r && r.error) || "invalid", message: (r && r.message) || null, errors: (r && r.errors) || undefined }, 400);
    return c.json({ ...(await view(true)), change: r.change || null });
  };

  app.get("/api/cms/phone-lists", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    try { return c.json(await view(Boolean(await isOwner(c)))); } catch (e) { log.error("[phone-lists] view:", e.message); return bad(c, "unavailable", "تعذر تحميل القوايم", 500); }
  });
  app.post("/api/cms/phone-lists/entry", (c) => write(c, (cur, b, o) => addEntry(cur, b, o)));
  app.post("/api/cms/phone-lists/remove", (c) => write(c, (cur, b) => removeEntry(cur, b.phone)));
  app.post("/api/cms/phone-lists/decide", (c) => write(c, (cur, b, o) => decideEntry(cur, b, o)));
  app.post("/api/cms/phone-lists/flag-ok", (c) => write(c, (cur, b, o) => flagOk(cur, b.phone, o)));
  app.put("/api/cms/phone-lists/settings", (c) => write(c, (cur, b) => { const r = settingsFromBody(cur, b); return r.ok ? { ok: true, next: r.next, change: null } : { ok: false, error: "invalid", errors: r.errors, message: r.errors.join(" · ") }; }));
  app.post("/api/cms/phone-lists/check", async (c) => {
    const no = await ownerOnly(c); if (no) return no;
    const r = await runCheck({ trigger: "manual" });
    if (r.skipped) return bad(c, r.skipped, "الفحص ماشتغلش — القاعدة مش مقروءة", 503);
    return c.json(await view(true));
  });
  app.get("/api/cms/phone-lists/flags", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const owner = Boolean(await isOwner(c));
    const s = (await settingsNow()) || {}, chk = await lastCheck(), rows = liveFlags(s, chk);
    return c.json({ ok: true, day: chk ? chk.day : null, ranAt: chk ? chk.ranAt : null, flagged: rows.length, review: listsOf(s).review.length,
      rows: rows.map((r) => ({ ...r, phone: owner ? `0${r.phone}` : mask(r.phone), last4: r.phone.slice(-4), reasonAr: reasonLabel(r.reason) })) });
  });

  if (deps.autostart !== false) {
    setTimeout(() => migrate().catch((e) => log.error("[phone-lists] migrate:", e.message)), 30_000).unref?.();
    setInterval(() => tick().catch((e) => log.error("[phone-lists] check:", e.message)), 10 * 60_000).unref?.();
  }
  /* للملخص اليومي (wateam.js) ولأي موديول تاني */
  async function flagCount() { const s = await settingsNow(); const chk = await lastCheck(); return { flagged: liveFlags(s || {}, chk).length, review: listsOf(s || {}).review.length }; }
  return { migrate, runCheck, tick, view, flagCount, ready, syncStaffFlags };
}
