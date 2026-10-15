/* ═══════════════════════════════════════════════════════════════════════════
   🤖 مُرسل واتساب الآلي (واتساب ويب عن طريق إضافة كروم) — ٢٦/٩

   طلب عمر: «اعمل لي اعدادات كاملة للواتس اب اليدوي وخليه يربط مع كروم عشان
   يعمل اتمتة بشكل ذكي للارسال عن طريق الواتساب ويب زي sender … باعدادات كاملة
   وفلاتر كاملة، مع اعتبار ان … بحد ١ رسالة كل ٣ ايام فقط من خلال الاتمتة».

   ── الشكل ──────────────────────────────────────────────────────────────────
   اللوحة بتعمل «حملة» من شريحة (نفس شرايح الواتساب اليدوي outreach.js) +
   فلاتر ⇒ طابور wa_send_queue. إضافة كروم على web.whatsapp.com بتسأل السيرفر
   «الرسالة الجاية إيه؟» (/api/wa-sender/agent/next) — السيرفر هو اللي بيقرّر
   الإيقاع كله، والإضافة بتنفّذ بس. فلو الإضافة اتقفلت أو اتلخبطت، الحدود فاضلة.

   ── الحدود (كلها في السيرفر، مش في الإضافة) ─────────────────────────────
   • رقم واحد = رسالة واحدة كل ٣ أيام على الأقل (قاعدة عمر). بتتحسب من
     wa_contact_log: الآلي + اللي اتفتح من الشاشة اليدوية. مابتقلّش عن ٣ أبداً.
   • سقف يومي، وساعات إرسال (الرياض)، وفاصل عشوائي بين كل رسالتين، واستراحة
     بعد كل دفعة. الأرقام دي بتقلّل احتمال إن واتساب يحظر الرقم.
   • مستبعدين دايماً: اللي عامل إلغاء اشتراك، أرقام الفريق، اللي طلب أونلاين
     في آخر X أيام، واللي عنده طلب مفتوح دلوقتي.
   • ٣ فشل ورا بعض ⇒ الإيقاف أوتوماتيك (غالباً واتساب ويب اتقفل أو اتغيّر).

   ── الإضافة ────────────────────────────────────────────────────────────────
   التوثيق بتوكن جهاز (بيتولّد من اللوحة، بيتخزّن sha256 بس). الإضافة مابتشوفش
   غير رسالة واحدة في المرة.

   ── قناة Cloud API (٢٨/٩ — Coexistence) ───────────────────────────────────
   الحملة بتختار قناتها: wa_web (الإضافة، زي الأول) أو wa_cloud (قالب معتمد من
   ميتا بصورة وزرار، السيرفر بيبعته بنفسه — مفيش إضافة). نفس الطابور ونفس
   الاستبعادات (إيقاف/فريق/٣ أيام مشتركة مع SMS/طلب قريب/طلب مفتوح/holdout)،
   وحدود Cloud لوحدها (settings.waCloud: يومي/ساعة/حد الـ٢٥٠ عميل في ٢٤ ساعة
   للبزنس غير الموثّق مع حجز لتحديثات الطلب). الحالات (وصلت/اتقرت/فشلت) بتيجي
   من الويب هوك وبتحدّث صف الطابور، والفشل بكود ميتا بيتحوّل لسبب، واختياري
   قناة بديلة للحملة (واتساب ويب أو SMS). الردود و«إيقاف» بتيجي من الويب هوك
   لنفس تبويب الردود.
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import { staffPhoneSet, holdoutSet, holdoutCount, normLocal } from "./smsrules.js";
import { linkTarget, linkTargetPath, LINK_TARGET_TYPES } from "./cmslinks.js";
import {
  TEMPLATE_VARS, renderTemplate, templateProblem, recipientLink, effectiveDailyCap, isOptOutText,
  creditOrders, dropPosMirrors, summarizeResults,
} from "./wamsg.js";
import { shopPaidSql, appOnlyPhonesSql } from "./identity.js";
import { staffConfig, fitOneSms } from "./staffalerts.js";
import { brakeWarn, lowReadCheck, qualityVerdict, qualityEventRow, warmupAdvance, warmupView, warmupStart, warmupClean, riyadhDay, custCapOf, custCapReason,
  CLOUD_MIN_GAP_DAYS, META_CAPPED_CODE, qualityAlertText, warnAlertText } from "./waquality.js";
import { nextStatus, TEMPLATES } from "./whatsapp.js";
import { cloudCfg, cloudPacing, classifyError, fallbackFor, campaignParams, cloudJobProblem, defaultChannel,
  CAMPAIGN_TEMPLATES, campaignTemplateNames, campaignSpec, brakeCheck, campaignCost, mediaProblem, MEDIA_LIMITS, CLOUD_KEYS, CLOUD_CEILINGS, CLOUD_DEFAULTS,
  retryDecision, reasonText, reasonRows, retryStats, brakeWindow, brakeView } from "./wacloud.js";
import { waRatesOf } from "./waaicost.js";
import { FAV_PICK, FAV_AUDIENCE, FAV_DEFAULT_FILTERS, FAV_HOLD, favJobProblem, lineProblem } from "./wafavpick.js";
import { PROFILE_ALL, PROFILE_TOKENS, PROFILE_TOKEN_KEYS, profileTokensIn, tokensOf, exampleProfileValues } from "./custprofile.js";

export const MIN_GAP_DAYS = 3;
export const DEFAULTS = {
  enabled: false,           // المفتاح الرئيسي — مقفول لحد ما المالك يفتحه
  gapDays: 3,               // رقم واحد كل كام يوم (مابيقلّش عن ٣)
  dailyCap: 40,             // أقصى رسايل في اليوم
  hourCap: 15,              // أقصى رسايل في الساعة
  minDelaySec: 60,          // الفاصل العشوائي بين رسالتين
  maxDelaySec: 150,
  batchSize: 10,            // بعد كل كام رسالة…
  batchPauseMin: 12,        // …استراحة كام دقيقة
  startHour: 13,            // ساعات الإرسال (الرياض)
  endHour: 22,
  days: ["sat", "sun", "mon", "tue", "wed", "thu", "fri"],
  skipOnlineWithinDays: 3,  // طلب أونلاين قريب = مانضايقوش
  skipOpenOrder: true,
  // قرار عمر ٢٦/٩: سطر الإيقاف الافتراضي — والردود بتتسجّل (agent/reply)
  footer: "لو ما تبي رسايلنا ردّ بكلمة: إيقاف",
  failStop: 3,              // فشل ورا بعض ⇒ إيقاف
  // تجميع تدريجي اختياري (الخط مستقر ومشغول ⇒ مقفول افتراضياً)
  warmup: { enabled: false, from: 10, step: 5, startedAt: null },
};
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };

export function senderCfg(settings) {
  const x = { ...DEFAULTS, ...(((settings || {}).waSender) || {}) };
  const minD = clampN(x.minDelaySec, 20, 1800, DEFAULTS.minDelaySec);
  return {
    enabled: x.enabled === true,
    gapDays: clampN(x.gapDays, MIN_GAP_DAYS, 60, 3),
    dailyCap: clampN(x.dailyCap, 1, 300, 40),
    hourCap: clampN(x.hourCap, 1, 100, 15),
    minDelaySec: minD,
    maxDelaySec: Math.max(minD, clampN(x.maxDelaySec, 20, 3600, DEFAULTS.maxDelaySec)),
    batchSize: clampN(x.batchSize, 1, 200, 10),
    batchPauseMin: clampN(x.batchPauseMin, 0, 240, 12),
    startHour: clampN(x.startHour, 0, 23, 13),
    endHour: clampN(x.endHour, 1, 24, 22),
    days: Array.isArray(x.days) ? x.days.filter((d) => DAYS.includes(d)) : DEFAULTS.days,
    skipOnlineWithinDays: clampN(x.skipOnlineWithinDays, 0, 60, 3),
    skipOpenOrder: x.skipOpenOrder !== false,
    footer: String(x.footer ?? DEFAULTS.footer).slice(0, 200),
    failStop: clampN(x.failStop, 1, 20, 3),
    warmup: warmupCfg(x.warmup),
    agentHash: x.agentHash || null,
  };
}
function warmupCfg(w) {
  const o = w && typeof w === "object" ? w : {};
  return { enabled: o.enabled === true, from: clampN(o.from, 1, 300, 10), step: clampN(o.step, 1, 100, 5),
    startedAt: o.startedAt && Number.isFinite(Date.parse(o.startedAt)) ? String(o.startedAt) : null };
}

const riyadh = (now) => new Date(new Date(now).toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
export function inWindow(cfg, now = Date.now()) {
  const r = riyadh(now);
  if (!cfg.days.includes(DAYS[r.getDay()])) return false;
  const h = r.getHours();
  return cfg.endHour > cfg.startHour ? h >= cfg.startHour && h < cfg.endHour : h >= cfg.startHour || h < cfg.endHour;
}

/* القرار: نبعت دلوقتي ولا نستنى كام ثانية؟ (دالة صافية — متجرّبة) */
export function pacing(cfg, st, now = Date.now(), rnd = Math.random) {
  if (!cfg.enabled) return { wait: null, reason: "disabled" };
  if (!inWindow(cfg, now)) return { wait: 600, reason: "outside_hours" };
  if (st.today >= effectiveDailyCap(cfg, now)) return { wait: 1800, reason: cfg.warmup?.enabled ? "warmup_cap" : "daily_cap" };
  if (st.lastHour >= cfg.hourCap) return { wait: 300, reason: "hour_cap" };
  if (st.failStreak >= cfg.failStop) return { wait: null, reason: "fail_stop" };
  if (st.lastSentAt) {
    const since = (now - new Date(st.lastSentAt).getTime()) / 1000;
    const pause = cfg.batchPauseMin > 0 && st.sinceBreak >= cfg.batchSize ? cfg.batchPauseMin * 60 : 0;
    const gap = pause || (st.nextGapSec || cfg.minDelaySec);
    if (since < gap) return { wait: Math.ceil(gap - since), reason: pause ? "batch_pause" : "delay" };
  }
  const nextGapSec = Math.round(cfg.minDelaySec + rnd() * (cfg.maxDelaySec - cfg.minDelaySec));
  return { wait: 0, nextGapSec };
}

/* ── SX2 (١٥/١٠ — أ): ميعاد بدء الحملة ─────────────────────────────────────
   «YYYY-MM-DDTHH:mm» = بتوقيت الرياض (اللي خانة الوقت في اللوحة بتبعته، مهما كانت ساعة الجهاز)، أو ISO بمنطقة زمنية صريحة.
   السعودية مافيهاش توقيت صيفي ⇒ +03:00 ثابتة. لازم يكون بعد دلوقتي ولحد START_MAX_DAYS يوم. فاضي = مفيش ميعاد. (دالة صافية) */
export const START_MAX_DAYS = 14;
export const riyadhClock = (t) => new Date(new Date(t).getTime() + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
export function parseStartAt(v, now = Date.now()) {
  if (v === null || v === undefined || String(v).trim() === "") return { at: null };
  const s = String(v).trim();
  let t = NaN;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(s)) t = Date.parse(`${s.replace(" ", "T")}${s.length === 16 ? ":00" : ""}+03:00`);
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) t = Date.parse(s);
  if (!Number.isFinite(t)) return { error: ["bad_start_at", "ميعاد البدء مش مفهوم — اختار اليوم والساعة"] };
  t = Math.floor(t / 60000) * 60000;
  if (t <= now) return { error: ["start_at_past", "ميعاد البدء لازم يكون بعد دلوقتي"] };
  if (t > now + START_MAX_DAYS * 86400e3) return { error: ["start_at_far", `ميعاد البدء لازم يكون خلال ${START_MAX_DAYS} يوم`] };
  return { at: new Date(t).toISOString(), riyadh: riyadhClock(t) };
}
/* تنبيه المالك لما البدء المجدول مايحصلش أو الحملة تقف بسبب الوسيط (SMS واحد — fitOneSms بيقصّه) */
export function startAlertText(kind, { name = "", detail = "", lateMin = 0 } = {}, lang = "ar") {
  const n = String(name || "").slice(0, 40);
  if (lang === "ar") {
    if (kind === "late") return `فريش كاتس: حملة واتساب «${n}» مابدأتش لوحدها — فات ميعادها بـ${lateMin} دقيقة (السيرفر كان واقف). ابدأها من اللوحة لو لسه عايزها.`;
    if (kind === "media_pause") return `فريش كاتس: حملة واتساب «${n}» وقفت — ${detail}. راجع اللوحة.`;
    return `فريش كاتس: حملة واتساب «${n}» مابدأتش في ميعادها — ${detail}. راجع اللوحة.`;
  }
  if (kind === "late") return `Fresh Cuts: WhatsApp campaign "${n}" did not auto-start - its start time passed ${lateMin} min ago (server was down). Start it from the dashboard if still wanted.`;
  if (kind === "media_pause") return `Fresh Cuts: WhatsApp campaign "${n}" paused - its image/video stopped opening. Check the dashboard.`;
  return `Fresh Cuts: WhatsApp campaign "${n}" did not start on schedule - its image/video check failed. Check the dashboard.`;
}

export const withFooter = (msg, footer) => (footer ? `${msg}\n\n${footer}` : msg);
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

/* ── إدخال «حملة جديدة» (دالة صافية — متجرّبة) ─────────────────────────
   template  نص الحملة (فاضي = القالب العام)، {name} إجباري
   link      {slug?, target_type, target_id, coupon} — رابط متتبّع بيتعمل تلقائي
   holdoutPct ٠–٥٠٪ مجموعة محجوزة للمقارنة (مابيتبعتلهاش)
   imageUrl  صورة عرض (https من دوميناتنا بس)
   offer     {oneTime, percent, freeDelivery, validDays, minTotal} — كوبون مرة واحدة لكل عميل */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export function imageUrlOk(u, hosts) {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" && (hosts || []).includes(x.hostname.toLowerCase());
  } catch { return false; }
}
export function jobInput(b = {}, { hosts = [] } = {}) {
  const errs = [];
  const template = String(b.template || "").trim().slice(0, 1200);
  const tp = templateProblem(template);
  if (tp) errs.push(tp === "name_required" ? ["name_required", "النص لازم يحتوي على {name} — من غير الاسم بتبقى رسالة جماعية"]
    : tp.startsWith("unknown_var") ? ["unknown_var", `متغير مش معروف: {${tp.split(":")[1]}}`] : ["too_long", "النص طويل"]);
  const L = b.link && typeof b.link === "object" ? b.link : {};
  const slug = String(L.slug || "").trim().toLowerCase();
  if (slug && !SLUG_RE.test(slug)) errs.push(["bad_slug", "اسم الرابط: حروف إنجليزي صغيرة وأرقام وشرطة بس"]);
  /* LK1 (١٣/١٠): أنواع الهدف من cmslinks.js (نفس محرر الروابط: + box / gather / cart). نوع مش معروف = خطأ صريح — كان بيتخزّن
     «home» في صمت، فأزرار حملة البوكسات فتحت الصفحة الرئيسية. من غير نوع خالص = الرئيسية (زي الأول). */
  const lt = linkTarget(L.target_type, L.target_id);
  const target_type = lt.ok ? lt.target_type : "home", target_id = lt.ok ? lt.target_id : null;
  if (!lt.ok) errs.push(lt.error === "bad_target" ? ["bad_target", `نوع الرابط «${lt.type}» مش معروف — الأنواع: ${LINK_TARGET_TYPES.join(" / ")}`]
    : lt.error === "bad_cart_code" ? ["bad_cart_code", "كود السلة الجاهزة مش صح"] : ["target_missing", "اختار العرض/الصنف/التجميعة/البوكس اللي الرابط يفتحه"]);
  const staticCoupon = String(L.coupon || "").trim().toUpperCase().slice(0, 40) || null;
  const holdoutPct = Math.min(50, Math.max(0, Math.round(Number(b.holdoutPct) || 0)));
  const imageUrl = String(b.imageUrl || "").trim() || null;
  if (imageUrl && !imageUrlOk(imageUrl, hosts)) errs.push(["bad_image", "رابط الصورة لازم يبقى https من صورنا المرفوعة"]);
  /* حملات واتساب (١٣/١٠): فيديو الهيدر — نفس القاعدة: https من مخزن الوسائط بتاعنا بس */
  const videoUrl = String(b.videoUrl || "").trim() || null;
  if (videoUrl && !imageUrlOk(videoUrl, hosts)) errs.push(["bad_video", "رابط الفيديو لازم يبقى https من الفيديوهات المرفوعة عندنا"]);
  const capRaw = b.spendCapSar === "" || b.spendCapSar == null ? null : Number(b.spendCapSar);
  if (capRaw != null && !(Number.isFinite(capRaw) && capRaw > 0 && capRaw <= 100000)) errs.push(["bad_spend_cap", "سقف صرف الحملة: رقم أكبر من صفر"]);
  const spendCapSar = capRaw != null && Number.isFinite(capRaw) && capRaw > 0 ? Math.round(capRaw * 100) / 100 : null;
  const O = b.offer && typeof b.offer === "object" ? b.offer : {};
  let offer = null;
  if (O.oneTime === true) {
    const percent = Math.min(50, Math.max(0, Math.round(Number(O.percent) || 0)));
    const freeDelivery = O.freeDelivery === true;
    if (!percent && !freeDelivery) errs.push(["offer_empty", "الكوبون لازم يبقى خصم أو توصيل مجاني"]);
    offer = { oneTime: true, percent, freeDelivery, validDays: Math.min(30, Math.max(1, Math.round(Number(O.validDays) || 7))),
      minTotal: Math.max(0, Number(O.minTotal) || 0) };
    if (staticCoupon) errs.push(["two_coupons", "اختار: كوبون ثابت على الرابط أو كوبون مرة واحدة لكل عميل — مش الاتنين"]);
  }
  /* القناة (٢٨/٩): wa_web = الإضافة · wa_cloud = قالب معتمد من السيرفر */
  const channel = b.channel === "wa_cloud" ? "wa_cloud" : "wa_web";
  const fallback = ["none", "wa_web", "sms"].includes(b.fallback) ? b.fallback : "none";
  /* FD1 (١٤/١٠): شريحة «طبقك المفضل» = قيم القالب لكل مستلم (perRecipient)، من غير كوبون، ومن غير قناة بديلة (نص الواتساب ويب/SMS
     مايعرفش العرض بتاع كل عميل). القيم على مستوى الحملة بتتجاهل. perRecipient مايتبعتش من بره من غير الشريحة دي. */
  const favAud = Boolean(b.filters && typeof b.filters === "object" && b.filters.audience === FAV_PICK);
  let cloudTemplate = null, cloudVars = null, profileVars = false;
  if (channel === "wa_cloud") {
    cloudTemplate = String(b.cloudTemplate || "").trim();
    const cv = b.cloudVars && typeof b.cloudVars === "object" ? b.cloudVars : {};
    const values = {};
    for (const [k, v] of Object.entries(cv.values && typeof cv.values === "object" ? cv.values : {})) {
      if (/^[a-zA-Z][a-zA-Z0-9_.]{0,60}$/.test(k)) values[k] = String(v ?? "").replace(/\r/g, "").trim().slice(0, 400);
    }
    cloudVars = favAud ? { offer: "", perRecipient: true }
      : { offer: String(cv.offer || "").replace(/\r/g, "").trim().slice(0, 400), ...(Object.keys(values).length ? { values } : {}) };
    /* CP1 (١٥/١٠): قيم من ملف العميل جوّه خانات قالب كتالوج ({fav_dish} …) ⇒ الحملة بقيم لكل مستلم (profileVars) — custprofile.js بيحسبها
       وقت التجهيز، واللي قيمته ناقصة بيطلع من الحملة. متغيّر مش معروف أو قالب قديم (سطر العرض) = خطأ صريح، مش أقواس توصل لعميل. */
    if (!favAud) {
      const toks = profileTokensIn(values);
      const unknown = toks.find((t) => !PROFILE_TOKEN_KEYS.includes(t));
      const spec = campaignSpec(cloudTemplate);
      if (profileTokensIn({ offer: cloudVars.offer }).some((t) => PROFILE_TOKEN_KEYS.includes(t))) errs.push(["profile_vars_catalog", "قيم ملف العميل ({fav_dish}…) بتشتغل في خانات قوالب الكتالوج بس، مش في «سطر العرض»"]);
      else if (unknown) errs.push(["unknown_var", `متغير مش معروف: {${unknown}} — المتاح: ${PROFILE_TOKEN_KEYS.map((k) => `{${k}}`).join(" ")}`]);
      else if (toks.length && (!spec || spec.kind !== "catalog")) errs.push(["profile_vars_catalog", "قيم ملف العميل بتشتغل مع قوالب الكتالوج بس"]);
      else if (toks.length) { cloudVars.profileVars = true; profileVars = true; }
    }
    const p = cloudJobProblem({ cloudTemplate, cloudVars, imageUrl, videoUrl, offer, link: { coupon: staticCoupon } });
    if (p) errs.push(p);
  }
  if (favAud) { const fp = favJobProblem({ channel, cloudTemplate, offer, coupon: staticCoupon }); if (fp) errs.push(fp); }
  return { errs, template, link: { slug: slug || null, target_type, target_id, coupon: staticCoupon }, holdoutPct, imageUrl, videoUrl, offer,
    channel, cloudTemplate, cloudVars, fallback: channel === "wa_cloud" && !favAud && !profileVars ? fallback : "none", spendCapSar: channel === "wa_cloud" ? spendCapSar : null, perRecipient: favAud, profileVars };
}
/* CP1: أقصى طول لكل خانة في القالب (للتحقق من النص بعد قيم العميل) */
const fieldMaxOf = (input) => { const sp = input && input.cloudTemplate ? campaignSpec(input.cloudTemplate) : null; return sp ? Object.fromEntries((sp.fields || []).map((f) => [f.key, f.max || 200])) : null; };
const profileBuildOpts = (input) => (input && input.profileVars ? { profileValues: (input.cloudVars && input.cloudVars.values) || {}, fieldMax: fieldMaxOf(input) } : {});

/* كود الرابط لكل مستلم + كود الكوبون (من غير حروف متشابهة) */
const B36 = "abcdefghijklmnopqrstuvwxyz0123456789";
const CPN = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const randFrom = (abc, n) => { const b = crypto.randomBytes(n); let o = ""; for (let i = 0; i < n; i++) o += abc[b[i] % abc.length]; return o; };
export const newLinkCode = () => randFrom(B36, 6);
export const newCouponCode = (jobId) => `W${jobId}${randFrom(CPN, 5)}`;

/* الرسالة لمستلم واحد: متغيرات الصف + الرابط/الكوبون بتوعه */
export function messageFor(row, { template, footer, host, slug, code, coupon, couponDays }) {
  const vars = { ...(row.vars || {}), link: recipientLink(host, slug, code), coupon: coupon || "",
    coupon_days: coupon && couponDays ? String(couponDays) : "" };
  const body = template ? renderTemplate(template, vars) : row.message;
  return withFooter(body, footer);
}


export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const outreach = deps.outreach || null;          // { AUDIENCES, audienceRows, cfg }
  const cmsApi = () => (typeof deps.cms === "function" ? deps.cms() : deps.cms) || null;   // شرايح لوحة المتجر
  const favApi = () => { try { return (typeof deps.fav === "function" ? deps.fav() : deps.fav) || null; } catch { return null; } };   // FD1: «طبقك المفضل» (wafavpick.js)
  const profApi = () => { try { return (typeof deps.profile === "function" ? deps.profile() : deps.profile) || null; } catch { return null; } };   // CP1: ملف العميل المصنّف (custprofile.js)
  const now = deps.now || (() => Date.now());
  const J = (v) => JSON.stringify(v);
  const bad = (c, error, message, status = 400) => c.json({ ok: false, error, message }, status);
  const STORE = () => (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
  const API_BASE = () => String(process.env.CONTENT_PUBLIC_BASE || process.env.COOLIFY_URL || "https://freshcuts-api.o2m8.me")
    .split(",")[0].trim().replace(/\/+$/, "");
  const imageHosts = () => [...new Set([API_BASE(), STORE(), "https://freshcuts-api.o2m8.me", "https://freshcuts.sa", "https://www.freshcuts.sa"]
    .map((u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } }).filter(Boolean))];
  const ATTR_DAYS = 7;
  const WEB_ORDERERS = "web_orderers";
  const doFetch = deps.fetch || globalThis.fetch;
  /* سعر الرسالة التسويقية من بطاقة الأسعار المخزّنة عند البوت (settings.waBot.waRates) — مفيش سعر في الملف ده */
  const rateOf = (s) => { const r = waRatesOf(((s || {}).waBot || {}).waRates); return { rateSar: Number(r.marketing) || 0, rateDate: r.date || null }; };
  const ownerOnly = (c) => c.json({ ok: false, error: "owner_only", message: "الخطوة دي للمالك بس" }, 403);
  /* صف الحملة اللي الدورة/التكملة/الإعادة محتاجينه (نفس الاستعلام في كل مكان) */
  const JOB_SQL = "SELECT id, cloud_template, cloud_vars, image_url, video_url, link_slug, offer, fallback, spend_cap_sar, rate_sar, brake_ack_at, status, name FROM wa_send_jobs WHERE id=$1";
  /* الوسيط (صورة/فيديو) قبل الإرسال: نوعه وحجمه بحدود ميتا — بنسأل الرابط (HEAD) من غير ما ننزّل الملف */
  /* SX2: مهلة لكل طلب فحص — رابط معلّق مايوقّفش الدورة ولا البدء المجدول */
  const fetchOpts = (o = {}) => { try { return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { ...o, signal: AbortSignal.timeout(15000) } : o; } catch { return o; } };
  async function checkMedia(kind, url) {
    if (!url) return null;
    try {
      const r = await doFetch(url, fetchOpts({ method: "HEAD" }));
      if (!r.ok) return ["media_unreachable", `الرابط مابيفتحش (HTTP ${r.status})`];
      let mime = r.headers?.get?.("content-type"), bytes = r.headers?.get?.("content-length");
      if (!(Number(bytes) > 0)) {
        /* السيرفر مارجّعش الحجم في HEAD: ننزّل الملف (من دوميناتنا بس — الرابط اتفحص في jobInput) ونقيسه */
        const g = await doFetch(url, fetchOpts());
        if (!g.ok) return ["media_unreachable", `الرابط مابيفتحش (HTTP ${g.status})`];
        mime = g.headers?.get?.("content-type") || mime;
        bytes = (await g.arrayBuffer()).byteLength;
      }
      return mediaProblem(kind, { mime, bytes });
    } catch { return ["media_unreachable", "ماقدرناش نوصل لرابط الوسيط"]; }
  }
  async function mediaErr(input) {
    const spec = campaignSpec(input.cloudTemplate);
    if (!spec || !spec.header) return null;
    return checkMedia(spec.header, spec.header === "video" ? input.videoUrl : input.imageUrl);
  }
  /* SX2 (ج): فحص وسيط حملة متخزّنة (صف wa_send_jobs) قبل ما تبدأ / تكمّل / تتعاد رسايلها. null = تمام أو القالب من غير وسيط.
     cacheMs: نتيجة فحص نفس الرابط من قريب تتستعمل (الدورة بتعيد الفحص كل دقيقة بالكتير، مش مع كل رسالة). */
  const mediaCache = new Map();
  async function jobMediaErr(job, { cacheMs = 0, cacheFail = false } = {}) {
    if (!job || (job.channel && job.channel !== "wa_cloud")) return null;
    const spec = campaignSpec(job.cloud_template);
    if (!spec || !spec.header) return null;
    const url = spec.header === "video" ? job.video_url : job.image_url;
    if (!url) return ["media_missing", spec.header === "video" ? "القالب بفيديو بس مفيش فيديو متحدد للحملة" : "القالب بصورة بس مفيش صورة متحددة للحملة"];
    const hit = cacheMs > 0 ? mediaCache.get(url) : null;
    if (hit && now() - hit.at < cacheMs && (!hit.problem || cacheFail)) return hit.problem;      // نقطة البدء: النجاح بس بيتخزّن (المالك صلّح ⇒ يجرّب على طول)
    const problem = await checkMedia(spec.header, url);
    mediaCache.set(url, { at: now(), problem });
    if (mediaCache.size > 200) mediaCache.delete(mediaCache.keys().next().value);
    return problem;
  }
  const whoOf = async (c) => {
    try {
      const t = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
      const u = t.startsWith("cms:") && deps.sessionUser ? await deps.sessionUser(t) : null;
      return (u && u.name) || "المالك";
    } catch { return "المالك"; }
  };
  /* SEC: نفس تعريف «المالك» في wacloud.js — توكن الأدمن الأساسي أو مستخدم لوحة دوره owner. أي خطأ = مش مالك. */
  const isOwner = async (c) => {
    try {
      const t = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
      const u = t.startsWith("cms:") && deps.sessionUser ? await deps.sessionUser(t) : null;
      return !u || u.role === "owner";
    } catch { return false; }
  };

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_contact_log (
        id BIGSERIAL PRIMARY KEY,
        phone_norm TEXT NOT NULL,
        channel TEXT NOT NULL,          -- auto | manual
        job_id BIGINT, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), by TEXT
      );
      CREATE INDEX IF NOT EXISTS wa_contact_log_pn_idx ON wa_contact_log(phone_norm, at DESC);
      CREATE TABLE IF NOT EXISTS wa_send_jobs (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',   -- running | paused | done | cancelled
        filters JSONB NOT NULL DEFAULT '{}'::jsonb,
        template TEXT,
        total INT NOT NULL DEFAULT 0,
        created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS wa_send_queue (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT NOT NULL,
        phone_norm TEXT NOT NULL,
        name TEXT, message TEXT NOT NULL, score INT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',   -- pending | sending | sent | failed | skipped | holdout
        reason TEXT, attempts INT NOT NULL DEFAULT 0,
        claimed_at TIMESTAMPTZ, sent_at TIMESTAMPTZ,
        UNIQUE(job_id, phone_norm)
      );
      CREATE INDEX IF NOT EXISTS wa_send_queue_pending_idx ON wa_send_queue(status, job_id, score DESC);
      CREATE TABLE IF NOT EXISTS wa_sender_state (
        id INT PRIMARY KEY DEFAULT 1,
        last_sent_at TIMESTAMPTZ, next_gap_sec INT, since_break INT NOT NULL DEFAULT 0,
        fail_streak INT NOT NULL DEFAULT 0, last_seen_at TIMESTAMPTZ, agent JSONB,
        stopped_reason TEXT
      );
      INSERT INTO wa_sender_state(id) VALUES (1) ON CONFLICT DO NOTHING;
      -- مرحلة ٠ (٢٦/٩): رابط متتبّع + holdout + صورة + كوبون مرة واحدة لكل حملة
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS link_slug TEXT;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS holdout_pct INT NOT NULL DEFAULT 0;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS offer JSONB;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS audience_label TEXT;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS link_code TEXT;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS coupon TEXT;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS clicks INT NOT NULL DEFAULT 0;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS optout_at TIMESTAMPTZ;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS media TEXT;      -- image | text
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS note TEXT;       -- ليه الصورة ماراحتش مثلاً
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS vars JSONB;      -- متغيرات العميل (لإعادة كتابة الرسالة)
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS edited_by TEXT;  -- اتعدّلت يدوي من اللوحة
      CREATE INDEX IF NOT EXISTS wa_send_queue_link_idx ON wa_send_queue(link_code) WHERE link_code IS NOT NULL;
      CREATE INDEX IF NOT EXISTS wa_send_queue_pn_idx ON wa_send_queue(phone_norm, sent_at DESC);
      -- ردود العملاء اللي الإضافة بتقراها من واتساب ويب
      CREATE TABLE IF NOT EXISTS wa_replies (
        id BIGSERIAL PRIMARY KEY,
        phone_norm TEXT NOT NULL,
        text TEXT NOT NULL,
        ext_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'chat',    -- chat | list
        job_id BIGINT, queue_id BIGINT,
        is_optout BOOLEAN NOT NULL DEFAULT FALSE,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(phone_norm, ext_id)
      );
      CREATE INDEX IF NOT EXISTS wa_replies_pn_idx ON wa_replies(phone_norm, at DESC);
      -- أرقام مش على واتساب — مابتدخلش أي حملة تانية
      -- قناة Cloud API (٢٨/٩)
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'wa_web';   -- wa_web | wa_cloud
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS cloud_template TEXT;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS cloud_vars JSONB;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS fallback TEXT NOT NULL DEFAULT 'none';   -- none | wa_web | sms
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS channel TEXT;          -- القناة اللي اتبعت/هيتبعت بيها فعلاً
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS wamid TEXT;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS cloud_status TEXT;     -- accepted | sent | delivered | read | failed
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS error_code INT;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS fallback_from TEXT;
      -- حملات واتساب (١٣/١٠): فيديو الهيدر، سقف صرف للحملة، سبب الوقوف الآلي، وسعر الرسالة وقت الإنشاء
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS video_url TEXT;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS spend_cap_sar NUMERIC;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS stop_reason TEXT;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS rate_sar NUMERIC;    -- «wa_cloud:<سبب>» لو اتحوّلت لقناة تانية
      CREATE INDEX IF NOT EXISTS wa_send_queue_wamid_idx ON wa_send_queue(wamid) WHERE wamid IS NOT NULL;
      INSERT INTO wa_sender_state(id) VALUES (2) ON CONFLICT DO NOTHING;      -- حالة قناة Cloud لوحدها
      -- QP1 (١٣/١٠): حماية الجودة — حالة سلّم التسخين وآخر حد/جودة شفناهم (صف ٢)، تحذير الحملة، «كمّل» المالك، وعدد أرقام التطبيقات اللي اتأكد عليها
      ALTER TABLE wa_sender_state ADD COLUMN IF NOT EXISTS warmup JSONB;
      ALTER TABLE wa_sender_state ADD COLUMN IF NOT EXISTS quality JSONB;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS warn_at TIMESTAMPTZ;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS brake_ack_at TIMESTAMPTZ;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS app_only INT;
      CREATE TABLE IF NOT EXISTS wa_quality_events (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        kind TEXT NOT NULL,              -- phone | template | account
        event TEXT, state TEXT, name TEXT, language TEXT, tier TEXT
      );
      CREATE TABLE IF NOT EXISTS wa_invalid_numbers (
        phone_norm TEXT PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        job_id BIGINT,
        hits INT NOT NULL DEFAULT 1
      );
      -- SX2 (١٥/١٠): البدء المجدول من السيرفر نفسه (مش cron بره) + إعادة تلقائية مرة واحدة للفشل المؤقت من ميتا
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;     -- حملة موقوفة بتبدأ لوحدها في الميعاد ده
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS start_by TEXT;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS start_error TEXT;        -- آخر بدء مجدول ماحصلش ليه (فحص الوسيط / فات الميعاد)
      CREATE INDEX IF NOT EXISTS wa_send_jobs_start_idx ON wa_send_jobs(start_at) WHERE start_at IS NOT NULL;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ;    -- فشل مؤقت ⇒ هيتعاد في الميعاد ده
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS retried_at TIMESTAMPTZ;  -- اتعاد فعلاً (مرة واحدة بس)
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS first_error_code INT;   -- كود فشل المحاولة الأولى
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS first_wamid TEXT;       -- wamid المحاولة الأولى (عشان نتأكد إنها ماوصلتش قبل الإعادة)
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS tried_at TIMESTAMPTZ;   -- (ج) آخر محاولة على Cloud — نافذة الفرامل بتعدّ من بعد آخر «كمّل» بيه
      CREATE INDEX IF NOT EXISTS wa_send_queue_retry_idx ON wa_send_queue(retry_at) WHERE retry_at IS NOT NULL;
    `);
  }
  const schemaReady = ensureSchema().catch((e) => console.error("[wasender] schema:", e.message));

  /* الحالة لكل قناة: wa_web (صف ١، الإضافة) و wa_cloud (صف ٢). العدّ بالقناة
     اللي الصف اتبعت بيها فعلاً (الصفوف القديمة من غير قناة = wa_web). */
  async function stateNow(channel = "wa_web") {
    const sid = channel === "wa_cloud" ? 2 : 1;
    const s = (await pool.query("SELECT * FROM wa_sender_state WHERE id=$1", [sid])).rows[0] || {};
    const c = (await pool.query(
      `SELECT count(*) FILTER (WHERE (sent_at AT TIME ZONE 'Asia/Riyadh')::date = (NOW() AT TIME ZONE 'Asia/Riyadh')::date)::int AS today,
              count(*) FILTER (WHERE sent_at > NOW() - INTERVAL '1 hour')::int AS last_hour
         FROM wa_send_queue WHERE status='sent' AND sent_at > NOW() - INTERVAL '2 days' AND COALESCE(channel,'wa_web') = $1`, [channel])).rows[0] || {};
    const out = { lastSentAt: s.last_sent_at, nextGapSec: s.next_gap_sec, sinceBreak: s.since_break || 0,
      failStreak: s.fail_streak || 0, lastSeenAt: s.last_seen_at, agent: s.agent, stoppedReason: s.stopped_reason,
      today: c.today || 0, lastHour: c.last_hour || 0 };
    if (channel === "wa_cloud") {
      out.warmup = warmupClean(s.warmup);                                             // QP1
      out.quality = s.quality && typeof s.quality === "object" ? s.quality : {};
      /* حد ميتا للبزنس غير الموثّق = عملاء مختلفين بدأنا معاهم بقالب في ٢٤ ساعة —
         الحملات وتحديثات الطلبات مع بعض (wa_messages فيها الاتنين). */
      out.uniq24h = await pool.query(
        `SELECT count(DISTINCT phone_norm)::int AS n FROM wa_messages
          WHERE direction='out' AND template IS NOT NULL AND COALESCE(status,'') <> 'failed' AND created_at > NOW() - INTERVAL '24 hours'`)
        .then((r) => r.rows[0]?.n || 0).catch(() => 0);
    }
    return out;
  }

  /* الأرقام اللي اتكلّمت في آخر gapDays — واتساب (آلي/يدوي) + رسايل SMS التسويقية
     (حملات، أتمتة، استرجاع السلة). عمر: العميل مايتضربش واتساب وSMS في نفس الفاصل.
     بترجع Map(رقم → «wa» | «sms»). جدول ناقص (قاعدة جديدة) = نكمّل بالموجود. */
  async function recentMap(pns, gapDays, { waGapDays = null } = {}) {
    const out = new Map();
    if (!pns.length) return out;
    const iv = String(gapDays);
    const run = async (ch, sql, days = iv) => {
      try { for (const r of (await pool.query(sql, [pns, days])).rows) if (!out.has(r.pn)) out.set(r.pn, ch); }
      catch (e) { if (e && e.code !== "42P01") throw e; }
    };
    /* QP1: على قناة Cloud الفاصل بين رسالتين واتساب ٧ أيام (waGapDays)؛ فاصل الـSMS تحت زي ما هو */
    await run("wa", `SELECT DISTINCT phone_norm pn FROM wa_contact_log WHERE phone_norm = ANY($1::text[]) AND at > NOW() - ($2 || ' days')::interval`, String(Math.max(Number(waGapDays) || 0, Number(gapDays) || 0)));
    /* SMS الدعائي لحاجبين الإعلانات عمره ما وصل (smsblock.js — قرار عمر ٢٦/٩:
       الحجب غلطة مزوّد مش العميل) ⇒ مايتحسبش «اتكلّم». أول قراية حيّة: ٢٢٦ من
       ٤٨٦ حاجب كانوا هيتشالوا من الواتساب بسبب رسايل ماوصلتهمش. */
    const notBlocked = await pool.query("SELECT 1 FROM sms_ad_blocked LIMIT 1").then(() => true).catch(() => false)
      ? "AND phone_norm NOT IN (SELECT phone_norm FROM sms_ad_blocked)" : "";
    await run("sms", `SELECT DISTINCT phone_norm pn FROM cms_campaign_sends WHERE status='sent' AND phone_norm = ANY($1::text[]) AND created_at > NOW() - ($2 || ' days')::interval ${notBlocked}`);
    await run("sms", `SELECT DISTINCT phone_norm pn FROM cms_flow_log WHERE phone_norm = ANY($1::text[]) AND sent_at > NOW() - ($2 || ' days')::interval ${notBlocked}`);
    await run("sms", `SELECT DISTINCT phone_norm pn FROM sms_log WHERE kind='cart_recovery' AND status='sent' AND phone_norm = ANY($1::text[]) AND at > NOW() - ($2 || ' days')::interval ${notBlocked}`);
    return out;
  }
  async function recentSet(pns, gapDays) { return new Set((await recentMap(pns, gapDays)).keys()); }
  async function invalidSet(pns) {
    if (!pns.length) return new Set();
    const r = await pool.query("SELECT phone_norm FROM wa_invalid_numbers WHERE phone_norm = ANY($1::text[])", [pns]);
    return new Set(r.rows.map((x) => x.phone_norm));
  }
  async function blockedSets(pns, cfg) {
    const out = { onlineRecent: new Set(), openOrder: new Set() };
    if (!pns.length) return out;
    if (cfg.skipOnlineWithinDays > 0) {
      const r = await pool.query(
        `SELECT DISTINCT phone_norm FROM shop_orders WHERE phone_norm = ANY($1::text[]) AND created_at > NOW() - ($2 || ' days')::interval
           AND status NOT IN ('pending_payment','expired')`, [pns, String(cfg.skipOnlineWithinDays)]);
      out.onlineRecent = new Set(r.rows.map((x) => x.phone_norm));
    }
    if (cfg.skipOpenOrder) {
      const r = await pool.query(
        `SELECT DISTINCT phone_norm FROM shop_orders WHERE phone_norm = ANY($1::text[])
           AND status IN ('pos_created','accepted','courier_requested','courier_assigned','on_the_way','courier_cancelled')`, [pns]);
      out.openOrder = new Set(r.rows.map((x) => x.phone_norm));
    }
    return out;
  }

  /* الفلاتر فوق الشريحة: {audience, minOrders, maxOrders, minSpend, minDaysSince,
     maxDaysSince, maxWebOrders, requireName, onlyAdBlocked, excludeAdBlocked, limit} */
  function applyFilters(rows, f = {}) {
    const n = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    return rows.filter((r) =>
      (n(f.minOrders) == null || r.orders >= n(f.minOrders)) &&
      (n(f.maxOrders) == null || r.orders <= n(f.maxOrders)) &&
      (n(f.minSpend) == null || r.spend >= n(f.minSpend)) &&
      (n(f.minDaysSince) == null || (r.daysAgo ?? 9999) >= n(f.minDaysSince)) &&
      (n(f.maxDaysSince) == null || (r.daysAgo ?? 9999) <= n(f.maxDaysSince)) &&
      (n(f.maxWebOrders) == null || (r.webOrders || 0) <= n(f.maxWebOrders)) &&
      (!f.requireName || Boolean(r.name)) &&
      (!f.onlyAdBlocked || r.adBlocked) &&
      (!f.excludeAdBlocked || !r.adBlocked));
  }

  /* الشرايح: شرايح الواتساب اليدوي (outreach) + كل شرايح لوحة المتجر (cms)
     بـ«segment:<id>» — نفس تعريف الشريحة في الحملات والأتمتة. */
  async function audienceList() {
    const out = outreach ? Object.entries(outreach.AUDIENCES).map(([id, a]) => ({ id, ...a, group: "wa" })) : [];
    out.push({ id: WEB_ORDERERS, label: "طلبوا من الموقع", hint: "كل اللي دفع طلب من الموقع ولو مرة واحدة", group: "wa" });
    if (favApi()) out.push({ id: FAV_PICK, ...FAV_AUDIENCE, group: "wa", cloudOnly: true, defaults: FAV_DEFAULT_FILTERS });
    if (profApi()) out.push({ id: PROFILE_ALL, label: "👥 كل العملاء — بفلاتر ملف العميل", hint: "كل اللي طلب مننا ولو مرة. ضيّقها بفلاتر «ملف العميل» (القيمة، أكله المفضّل، آخر الليل، الفاتورة الكبيرة…)", group: "wa", profile: true });
    const cms = cmsApi();
    if (cms && typeof cms.segmentList === "function") {
      for (const s of cms.segmentList()) out.push({ id: `segment:${s.id}`, label: `${s.icon || ""} ${s.label}`.trim(), hint: s.hint, group: "cms" });
    }
    return out;
  }
  async function resolveAudience(aud) {
    if (aud === FAV_PICK) return favApi() ? { aud, segmentPhones: null, fav: true } : null;
    if (aud === PROFILE_ALL) {
      const P = profApi();
      if (!P) return null;
      try { return { aud, segmentPhones: new Set(await P.phones()), profileAll: true }; } catch { return null; }
    }
    if (aud === WEB_ORDERERS) {
      const r = await pool.query(`SELECT DISTINCT so.phone_norm FROM shop_orders so WHERE ${shopPaidSql("so")} AND so.phone_norm IS NOT NULL`).catch(() => null);
      return r ? { aud, segmentPhones: new Set(r.rows.map((x) => x.phone_norm)) } : null;
    }
    if (typeof aud === "string" && aud.startsWith("segment:")) {
      const cms = cmsApi();
      const id = aud.slice(8);
      if (!cms || typeof cms.segmentPhones !== "function") return null;
      const phones = await cms.segmentPhones(id);
      return phones ? { aud, segmentPhones: new Set(phones) } : null;
    }
    return outreach && outreach.AUDIENCES[aud] ? { aud, segmentPhones: null } : null;
  }

  /* QP1 — قناة Cloud: عدد القوالب التسويقية اللي اتقبلت لكل رقم (٧ / ٣٠ يوم) من wa_messages — حملات وأتمتة مع بعض.
     نفس العدّ اللي الحارس (whatsapp.js guardSend) بيرفض بيه وقت الإرسال؛ هنا عشان عدد المعاينة يطلع مظبوط. */
  async function marketingCounts(pns) {
    const out = new Map();
    if (!pns.length) return out;
    /* فشل العدّ هنا مايوقّعش المعاينة: الحارس بيعدّ تاني لكل رقم وقت الإرسال، ولو ماقدرش بيرفض (marketing_cap_unreadable) */
    let r; try { r = await pool.query(
      `SELECT phone_norm AS pn, count(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS d7, count(*)::int AS d30
         FROM wa_messages WHERE phone_norm = ANY($1::text[]) AND direction='out' AND template IS NOT NULL
          AND (category='MARKETING' OR source='campaign') AND COALESCE(status,'') NOT IN ('failed','skipped')
          AND created_at > NOW() - INTERVAL '30 days' GROUP BY 1`, [pns]); }
    catch (e) { console.error("[wasender] marketing counts:", e.message); return out; }
    for (const x of r.rows || []) out.set(x.pn, { d7: x.d7 || 0, d30: x.d30 || 0 });
    return out;
  }
  /* QP1: أرقام «تطبيق توصيل بس» في قايمة (identity.js). بترجع Set، أو null لو ماقدرناش نقرا (⇒ الحملة ماتبدأش). */
  async function appOnlySet(pns) {
    if (!pns.length) return new Set();
    try { return new Set(((await pool.query(appOnlyPhonesSql("$1"), [pns])).rows || []).map((x) => x.pn)); }
    catch (e) { console.error("[wasender] app-only:", e.message); return null; }
  }
  const APP_ONLY_LABEL = "أرقام من تطبيقات التوصيل — لم يعطونا رقمهم مباشرة";

  /* TS1 (١٤/١٠): القالب في الكتالوج لازم يطابق النسخة اللي عند ميتا قبل ما حملة تستعمله (زر اتشال/نص اتغيّر والتعديل لسه مااتراجعش ⇒ العميل يشوف
     النسخة القديمة أو الإرسال يفشل). «differs» بيمنع البدء؛ «unknown» (ميتا مش مقروءة) مابيمنعش — بوابة الجودة بتوقف الإرسال ساعتها أصلاً. */
  const SYNC_AR = { differs: "القالب عند ميتا لسه بالنسخة القديمة (التعديل ماتراجعش) — الحملة ماتبدأش بيه لحد ما ميتا تعتمد النسخة الجديدة",
    missing: "القالب ده مش موجود عند ميتا بالعربي — قدّمه الأول", unknown: "ماقدرناش نقارن القالب بنسخة ميتا دلوقتي",
    review: "القالب عند ميتا تحت المراجعة (مش معتمد دلوقتي) — الحملة ماتبدأش بيه لحد ما يتعتمد" };
  /* بعد تعديل قالب معتمد ميتا بترجّعه للمراجعة: نصه بقى زي الكتالوج بس حالته مش APPROVED ⇒ الإرسال بيه يفشل ويوقّف القناة. يتمنع زي «differs». */
  const syncBlock = (ts) => (ts.state === "differs" ? "template_differs" : ts.state === "same" && ts.status && ts.status !== "APPROVED" ? "template_not_approved" : null);
  async function tplSync(name) {
    const cl = cloudApi();
    if (!name || !cl || typeof cl.templateSync !== "function") return { state: "unknown", status: null, diffs: [], message: SYNC_AR.unknown };
    let r; try { r = await cl.templateSync(name, "ar"); } catch { r = { state: "unknown", status: null, diffs: [] }; }
    const out = { state: r.state, status: r.status || null, diffs: r.diffs || [] };
    return { ...out, message: syncBlock(out) === "template_not_approved" ? SYNC_AR.review : SYNC_AR[r.state] || null };
  }

  async function build(filters, s, { channel = "wa_web", profileValues = null, fieldMax = null } = {}) {
    if (!outreach) throw new Error("outreach_missing");
    const cloud = channel === "wa_cloud";
    const cfg = senderCfg(s);
    const A = (await resolveAudience(filters.audience)) || { aud: "never_online", segmentPhones: null };
    /* FD1: «طبقك المفضل» مايرجعش لشريحة تانية في صمت لو مش متوصّلة (العروض محسوبة لكل عميل) */
    if (filters.audience === FAV_PICK && !A.fav) throw Object.assign(new Error("شريحة «طبقك المفضل» مش متاحة دلوقتي"), { code: "fav_unavailable", status: 503 });
    /* CP1: نفس الكلام لـ«كل العملاء — بفلاتر ملف العميل» */
    if (filters.audience === PROFILE_ALL && !A.profileAll) throw Object.assign(new Error("ملف العميل مش متاح دلوقتي — جرّب بعد شوية"), { code: "profile_unavailable", status: 503 });
    const minLast = Number(filters.minLastOrder) > 0 ? Number(filters.minLastOrder) : 0;
    /* الفاصل الافتراضي للشريحة دي (٥–٩٠ يوم) لو الحملة مابعتتش فلتر */
    const blank = (v) => v === undefined || v === null || v === "";
    const F = A.fav ? { ...filters, ...Object.fromEntries(Object.entries(FAV_DEFAULT_FILTERS).filter(([k]) => blank(filters[k]))) } : filters;
    let all;
    if (A.fav) {
      /* الفاصل بيتبعت للشريحة: اللي برّاه مابيتحسبلوش عرض ولا سعر توصيل أصلاً (نفس شرط applyFilters تحت) */
      try { all = await favApi().audienceRows({ minDaysSince: F.minDaysSince, maxDaysSince: F.maxDaysSince }); }
      catch (e) { if (e && e.code === "FAV_CATALOG") throw Object.assign(new Error(`المنيو أو البوكسات مش متاحة دلوقتي (${String(e.message).replace(/^fav_pick: /, "")}) — جرّب بعد شوية`), { code: "fav_catalog", status: 503 }); throw e; }
    } else all = await outreach.audienceRows(A.aud, { canSee: true, minLastOrder: minLast, segmentPhones: A.segmentPhones });
    // مفيش ولا طلب ≥ الحد (بيشتري مية/بيبسي بس) ⇒ مالوش رسالة تفكّره بأكلة
    const smallOnly = all.filter((r) => r.noMeaningfulOrder).length;
    let filtered = applyFilters(all.filter((r) => !r.noMeaningfulOrder), F);
    /* CP1 (١٥/١٠): فلتر «ملف العميل» فوق الشريحة (filters.profile — custprofile.js normalizeProfileFilter/matchProfile، نفس عدّاد بنّاء الجمهور).
       اللي مالوش ملف لسه بيطلع وبيتعدّ لوحده (missing). */
    const pfRaw = F && F.profile;
    const hasPf = Boolean(pfRaw && typeof pfRaw === "object" && !Array.isArray(pfRaw) && Object.keys(pfRaw).length);
    let prof = null, profMap = null;
    if (hasPf || profileValues) {
      const P = profApi();
      if (!P) throw Object.assign(new Error("ملف العميل مش متاح دلوقتي — جرّب بعد شوية"), { code: "profile_unavailable", status: 503 });
      const nf = P.normalizeFilter(hasPf ? pfRaw : {});
      if (!nf.ok) throw Object.assign(new Error(nf.error[1]), { code: nf.error[0], status: 422 });
      profMap = await P.profilesFor(filtered.map((r) => r.pn));
      if (hasPf) {
        let missing = 0, notMatched = 0;
        const T = now();
        filtered = filtered.filter((r) => { const p = profMap.get(r.pn); if (!p) { missing++; return false; } if (!P.match(p, nf.filter, T)) { notMatched++; return false; } return true; });
        prof = { filter: nf.filter, missing, notMatched, matched: filtered.length };
      }
    }
    const pns = filtered.map((r) => r.pn);
    const staff = staffPhoneSet(s);
    const recent = await recentMap(pns, cfg.gapDays, cloud ? { waGapDays: CLOUD_MIN_GAP_DAYS } : {});
    const invalid = await invalidSet(pns);
    const blk = await blockedSets(pns, cfg);
    const cap = custCapOf(s), mk = cloud ? await marketingCounts(pns) : new Map();
    const qr = (await pool.query(
      `SELECT q.phone_norm, bool_or(q.status = 'holdout') AS held FROM wa_send_queue q JOIN wa_send_jobs j ON j.id=q.job_id
        WHERE q.phone_norm = ANY($1::text[])
          AND ((q.status IN ('pending','sending') AND j.status IN ('running','paused'))
            -- SX2: مستني إعادة تلقائية = لسه في طابور حملته
            OR (q.status = 'failed' AND q.retry_at IS NOT NULL AND j.status IN ('running','paused'))
            -- المحجوزين لسه في نافذة القياس (٧ أيام): مانبعتلهمش من حملة تانية وإلا المقارنة تبوظ
            OR (q.status = 'holdout' AND j.created_at > NOW() - make_interval(days => $2::int + 7)))
        GROUP BY 1`, [pns, ATTR_DAYS])).rows;
    const queued = new Map(qr.map((x) => [x.phone_norm, x.held]));
    const excluded = { staff: 0, recent: 0, recentSms: 0, invalid: 0, onlineRecent: 0, openOrder: 0, queued: 0, heldOut: 0, ...(cloud ? { waCap: 0 } : {}) };
    const ok = [];
    for (const r of filtered) {
      if (staff.has(r.pn)) { excluded.staff++; continue; }
      if (invalid.has(r.pn)) { excluded.invalid++; continue; }
      if (recent.has(r.pn)) { excluded[recent.get(r.pn) === "sms" ? "recentSms" : "recent"]++; continue; }
      if (blk.onlineRecent.has(r.pn)) { excluded.onlineRecent++; continue; }
      if (blk.openOrder.has(r.pn)) { excluded.openOrder++; continue; }
      if (queued.has(r.pn)) { excluded[queued.get(r.pn) ? "heldOut" : "queued"]++; continue; }
      if (cloud && custCapReason(mk.get(r.pn), cap)) { excluded.waCap++; continue; }      // QP1: سقف العميل ١/٧ أيام و٣/٣٠ يوم
      ok.push(r);
    }
    /* CP1: قيم الرسالة لكل مستلم من ملفه ({fav_dish} …). اللي قيمته ناقصة (مالوش طبق مفضّل، مفيش بوكس شغّال فيه طبقه…) بيطلع هنا —
       قبل «أقصى عدد»، فالحملة بتتملي بالمؤهلين — وعمره ما بيوصله نص عام. vars.prof = اللي لازم يتراجع وقت الإرسال (البوكس/FIRST/الولاء). */
    let okList = ok;
    if (profileValues) {
      const P = profApi();
      const needBox = Object.values(profileValues).some((v) => /\{fav_box\}/.test(String(v)));
      const tctx = await P.tokenContext({ needBox, fieldMax });
      const why = {};
      okList = [];
      for (const r of ok) {
        const res = P.resolveValues(profileValues, profMap.get(r.pn) || null, tctx);
        if (!res.ok) { excluded.profileValue = (excluded.profileValue || 0) + 1; const k = String(res.why).split(":").slice(0, 2).join(":"); why[k] = (why[k] || 0) + 1; continue; }
        okList.push({ ...r, vars: { ...(r.vars || {}), cloud: { values: res.values }, prof: res.uses || {} } });
      }
      prof = { ...(prof || {}), values: { tokens: [...new Set(Object.values(profileValues).flatMap((v) => tokensOf(v)))], missing: why,
        catalog: needBox ? Boolean(tctx.live) : null } };
    }
    const limit = Math.min(1000, Math.max(1, Number(filters.limit) || 100));
    excluded.smallOnly = smallOnly;
    excluded.smallSkipped = okList.filter((r) => r.skippedSmall > 0).length;   // اترجعنا لطلب أقدم
    const C = typeof outreach.cfg === "function" ? await outreach.cfg() : { template: "" };
    const picked = okList.slice(0, limit);
    /* QP1: كام رقم في اللي هيتبعتلهم جاي من تطبيق توصيل بس — المالك لازم يأكد العدد ده قبل البدء (قناة Cloud) */
    let appOnly = null;
    if (cloud) { const set = await appOnlySet(picked.map((x) => x.pn)); appOnly = set ? { count: set.size, label: APP_ONLY_LABEL, needsConfirm: set.size > 0 } : { count: null, label: APP_ONLY_LABEL, needsConfirm: true, error: "unreadable" }; }
    return { audience: A.aud, inAudience: all.length, afterFilters: filtered.length, excluded, eligible: okList.length,
      picked, cfg, globalTemplate: C.template, appOnly, ...(A.fav ? { fav: { filters: { minDaysSince: F.minDaysSince, maxDaysSince: F.maxDaysSince }, stats: all.stats || null, digest: favDigest(picked) } } : {}),
      ...(prof ? { profile: prof } : {}) };
  }
  /* FD1 (مراجعة ١٤/١٠): بصمة الرسايل نفسها (الرقم + العنوان + السطر لكل مستلم، بالترتيب). المعاينة بترجّعها والبدء بيقارنها (confirmDigest):
     confirmCount بيقارن العدد بس — لكن العروض بتتحسب تاني وقت البدء، فممكن نفس العدد بعملاء/أسعار/سطور توصيل غير اللي المالك قراها. */
  const favDigest = (picked) => sha(picked.map((x) => { const v = (x.vars && x.vars.cloud && x.vars.cloud.values) || {}; return `${x.pn}|${v["offer.title"] || ""}|${v["offer.line"] || ""}`; }).join("|~|")).slice(0, 16);
  /* FD1: build بيرمي برسالة وحالة (شريحة «طبقك المفضل» مش متاحة / المنيو واقع) ⇒ رد واضح بدل 500 */
  async function buildOr(c, filters, s, opts) {
    try { return { r: await build(filters, s, opts) }; }
    catch (e) { if (e && e.status) return { res: bad(c, e.code || "build_failed", e.message, e.status) }; throw e; }
  }

  // ── اللوحة ──────────────────────────────────────────────────────────────
  app.get("/api/cms/wa-sender", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await getSettingsData();
    const cfg = senderCfg(s);
    const st = await stateNow();
    const jobs = (await pool.query(
      `SELECT j.*, count(q.*) FILTER (WHERE q.status='sent')::int AS sent,
              count(q.*) FILTER (WHERE q.status='failed' AND q.retry_at IS NULL)::int AS failed,
              count(q.*) FILTER (WHERE q.status='failed' AND q.retry_at IS NOT NULL)::int AS retry_wait,
              count(q.*) FILTER (WHERE q.retried_at IS NOT NULL)::int AS retried,
              count(q.*) FILTER (WHERE q.retried_at IS NOT NULL AND q.status='sent' AND COALESCE(q.cloud_status,'') <> 'failed')::int AS retry_ok,
              count(q.*) FILTER (WHERE q.status='failed' AND q.error_code = ${META_CAPPED_CODE})::int AS meta_capped,
              count(q.*) FILTER (WHERE q.status='skipped')::int AS skipped,
              count(q.*) FILTER (WHERE q.status='holdout')::int AS holdout,
              count(q.*) FILTER (WHERE q.status IN ('pending','sending'))::int AS pending,
              count(q.*) FILTER (WHERE q.replied_at IS NOT NULL)::int AS replied,
              count(q.*) FILTER (WHERE q.optout_at IS NOT NULL)::int AS optouts,
              count(q.*) FILTER (WHERE q.clicks > 0)::int AS clickers,
              COALESCE(sum(q.clicks), 0)::int AS recipient_clicks,
              count(q.*) FILTER (WHERE q.cloud_status IN ('delivered','read'))::int AS delivered,
              count(q.*) FILTER (WHERE q.cloud_status = 'read')::int AS read_n,
              count(q.*) FILTER (WHERE q.channel = 'wa_cloud' AND q.status IN ('sent','failed'))::int AS cloud_sent,
              (SELECT l.clicks FROM cms_links l WHERE l.slug = j.link_slug) AS link_clicks
         FROM wa_send_jobs j LEFT JOIN wa_send_queue q ON q.job_id=j.id
        GROUP BY j.id ORDER BY j.id DESC LIMIT 30`)).rows;
    const extra = (await pool.query(
      `SELECT (SELECT count(*)::int FROM wa_invalid_numbers) AS invalid,
              (SELECT count(*)::int FROM wa_replies WHERE at > NOW() - INTERVAL '7 days') AS replies7,
              (SELECT count(*)::int FROM wa_replies WHERE is_optout AND at > NOW() - INTERVAL '7 days') AS optouts7`)).rows[0];
    const C = outreach && typeof outreach.cfg === "function" ? await outreach.cfg() : { template: "", site: "freshcuts.sa" };
    const { agentHash, ...pub } = cfg;
    const cloud = await cloudInfo(s, cfg);
    return c.json({ ok: true, cfg: pub, agentPaired: Boolean(agentHash), state: st, cloud,
      pace: pacing(cfg, st, now(), () => 0), inWindow: inWindow(cfg, now()),
      effectiveDailyCap: effectiveDailyCap(cfg, now()),
      audiences: await audienceList(),
      jobs: jobs.map((j) => ({ ...j, id: Number(j.id), start_at_riyadh: j.start_at ? riyadhClock(j.start_at) : null })), minGapDays: MIN_GAP_DAYS, startMaxDays: START_MAX_DAYS,
      templateVars: TEMPLATE_VARS, defaultTemplate: C.template, linkHost: STORE().replace(/^https?:\/\//, ""),
      profileTokens: profApi() ? PROFILE_TOKENS : [],      // CP1: قيم ملف العميل اللي تتكتب في خانات قوالب الكتالوج
      invalidCount: extra.invalid, replies7: extra.replies7, optouts7: extra.optouts7 });
  });

  // اختيارات «الرابط يفتح إيه» + صور العروض — قوايم صغيرة للفورم
  app.get("/api/cms/wa-sender/options", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const safe = (p) => p.then((r) => r.rows).catch(() => []);
    const [offers, cols, media] = await Promise.all([
      safe(pool.query("SELECT id, title FROM offer_registry WHERE enabled ORDER BY updated_at DESC LIMIT 30")),
      safe(pool.query("SELECT id::text AS id, name AS title FROM cms_collections WHERE active ORDER BY sort, id LIMIT 30")),
      safe(pool.query(`SELECT id, filename, mime, created_at FROM content_media WHERE mime LIKE 'image/%'
                        ORDER BY created_at DESC LIMIT 24`)),
    ]);
    const base = API_BASE();
    return c.json({ ok: true, offers, collections: cols,
      images: media.map((m) => ({ id: m.id, name: m.filename, url: `${base}/api/content/media/${m.id}${/jpe?g/i.test(m.mime) ? ".jpg" : ""}` })) });
  });

  app.post("/api/cms/wa-sender/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const s = await getSettingsData();
    const cur = (s.waSender && typeof s.waSender === "object") ? s.waSender : {};
    const allowed = ["enabled", "gapDays", "dailyCap", "hourCap", "minDelaySec", "maxDelaySec", "batchSize", "batchPauseMin",
      "startHour", "endHour", "days", "skipOnlineWithinDays", "skipOpenOrder", "footer", "failStop", "warmup"];
    const next = { ...cur };
    for (const k of allowed) if (b[k] !== undefined) next[k] = b[k];
    if (Number(next.gapDays) < MIN_GAP_DAYS) next.gapDays = MIN_GAP_DAYS;
    // التجميع: أول ما يتفعّل بيبدأ العدّ من النهاردة؛ لما يتقفل بيتنسي
    if (b.warmup !== undefined) {
      const w = warmupCfg(b.warmup), was = warmupCfg(cur.warmup);
      w.startedAt = w.enabled ? (was.enabled && was.startedAt ? was.startedAt : new Date(now()).toISOString()) : null;
      next.warmup = w;
    }
    const clean = senderCfg({ waSender: next });
    const { agentHash, ...store } = clean;
    await pool.query(
      `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waSender}', $1::jsonb, true) WHERE id=1`,
      [J({ ...store, agentHash: cur.agentHash || null })]);
    if (b.enabled === true) await pool.query("UPDATE wa_sender_state SET fail_streak=0, stopped_reason=NULL WHERE id=1");
    return c.json({ ok: true, cfg: store });
  });

  // توكن الإضافة: بيتعرض مرة واحدة
  app.post("/api/cms/wa-sender/pair", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const token = "wa_" + crypto.randomBytes(24).toString("base64url");
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN COALESCE(data,'{}'::jsonb) ? 'waSender' THEN data ELSE jsonb_set(COALESCE(data,'{}'::jsonb),'{waSender}','{}'::jsonb,true) END,
         '{waSender,agentHash}', $1::jsonb, true) WHERE id=1`, [J(sha(token))]);
    return c.json({ ok: true, token });
  });

  const tplOf = (r, input) => input.template || r.globalTemplate || "";

  app.post("/api/cms/wa-sender/preview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const input = jobInput(b, { hosts: imageHosts() });
    const s = await getSettingsData();
    const bo = await buildOr(c, b.filters || {}, s, { channel: input.channel, ...profileBuildOpts(input) });
    if (bo.res) return bo.res;
    const r = bo.r;
    const tpl = tplOf(r, input);
    // العينة: أول ٥ + مثال واحد اترجعنا فيه لطلب أقدم (عشان المالك يشوف الفلتر شغّال)
    const pick = r.picked.slice(0, 5);
    const ex = r.picked.find((x) => x.skippedSmall > 0);
    if (ex && !pick.includes(ex)) pick.push(ex);
    /* FD1: «طبقك المفضل» — كل رسالة مختلفة: أول ٨ + أول مثال من كل نوع (بوكس فيه طبقه / من نوعه / باقة / طبقه نفسه) × كل حالة توصيل */
    if (r.fav) {
      for (const x of r.picked.slice(0, 8)) if (!pick.includes(x)) pick.push(x);
      const seen = new Set(pick.map((x) => x.favView && `${x.favView.kind}:${x.favView.catOnly}:${x.favView.delivery}:${x.favView.via}`));
      for (const x of r.picked) { const k = x.favView && `${x.favView.kind}:${x.favView.catOnly}:${x.favView.delivery}:${x.favView.via}`; if (k && !seen.has(k) && pick.length < 16) { seen.add(k); pick.push(x); } }
    }
    const slug = input.link.slug || "w…";
    const couponEx = input.offer ? "W…" : input.link.coupon;
    const host = STORE();
    const sample = pick.map((x) => ({ name: x.name, phone: `${x.pn.slice(0, 3)}••••${x.pn.slice(-2)}`,
      orders: x.orders, spend: x.spend, daysAgo: x.daysAgo, lastTotal: x.lastTotal, skippedSmall: x.skippedSmall || 0,
      vars: { ...x.vars, link: recipientLink(host, slug, "xxxxxx"), coupon: couponEx || "", coupon_days: input.offer ? String(input.offer.validDays) : "" },
      message: messageFor(x, { template: tpl, footer: r.cfg.footer, host, slug, code: "xxxxxx", coupon: couponEx, couponDays: input.offer?.validDays }),
      ...(x.favView ? { fav: x.favView } : {}),
      ...(input.channel === "wa_cloud" && TEMPLATES[input.cloudTemplate] ? { cloud: cloudSample(input, x, slug, couponEx) } : {}) }));
    const hold = holdoutCount(r.picked.length, input.holdoutPct);      // LK1: العدد بالظبط (مش تقدير) — نفس اللي البدء هيحجزه
    let days = Math.ceil((r.picked.length - hold) / Math.max(1, effectiveDailyCap(r.cfg, now())));
    let cloudExtra = {};
    if (input.channel === "wa_cloud") {
      /* العدد بالظبط بعد الاستبعادات والمجموعة المحجوزة × سعر الرسالة التسويقية = التكلفة؛ والسعة: السقف اليومي، سقف الصرف، حد ميتا */
      const cc = cloudCfg(s), { rateSar, rateDate } = rateOf(s), st = await stateNow("wa_cloud").catch(() => ({}));
      const messages = r.picked.length - hold;
      const perDayMoney = rateSar > 0 ? Math.floor(cc.spendDaySar / rateSar + 1e-9) : cc.dailyCap;
      const wv = warmupView(st.warmup, cc.warmup, { today: riyadhDay(now()), dailyCap: cc.dailyCap });      // QP1: سقف سلّم التسخين النهارده
      const perDay = Math.max(0, Math.min(cc.dailyCap, wv.cap, perDayMoney, cc.tierLimit - cc.reserveUtility));
      days = perDay > 0 ? Math.ceil(messages / perDay) : null;
      const capped = input.spendCapSar != null && rateSar > 0 ? Math.min(messages, Math.floor(input.spendCapSar / rateSar + 1e-9)) : messages;
      cloudExtra = { cost: { messages, rateSar: rateSar || null, rateDate, sar: campaignCost(messages, rateSar), spendCapSar: input.spendCapSar, willSendUnderCap: capped, sarUnderCap: campaignCost(capped, rateSar) },
        capacity: { perDay, dailyCap: cc.dailyCap, spendDaySar: cc.spendDaySar, tierLimit: cc.tierLimit, reserveUtility: cc.reserveUtility, sentToday: st.today || 0, uniq24h: st.uniq24h || 0,
          brake: { minSends: cc.brakeMinSends, stopPct: cc.brakeStopPct, failPct: cc.brakeFailPct, warnPct: cc.brakeWarnPct,
            lowRead: { minDelivered: cc.lowReadMinDelivered, hours: cc.lowReadHours, pct: cc.lowReadPct } },
          warmup: wv, custCap: { d7: cc.custCap7d, d30: cc.custCap30d, gapDays: Math.max(CLOUD_MIN_GAP_DAYS, r.cfg.gapDays) } },
        appOnly: r.appOnly, templateSync: await tplSync(input.cloudTemplate),
        spec: campaignSpec(input.cloudTemplate), gate: wa ? await wa.gate() : "disabled", enabled: cc.enabled };
    }
    /* LK1: الزر هيفتح إيه — النوع والهدف وشكل رابط الهبوط، عشان المالك يشوفه قبل البدء */
    const linkView = { slug: input.link.slug || null, targetType: input.link.target_type, targetId: input.link.target_id,
      url: recipientLink(host, slug, "xxxxxx"), opens: `${host}${linkTargetPath(input.link)}`, coupon: input.link.coupon || null,
      /* RF1: القالب فيه زر رابط أصلاً؟ إطارات «الرد أولاً» مافيهاش — الرابط بيتعمل للحملة بس مش بيظهر للعميل */
      button: input.channel === "wa_cloud" ? Boolean(campaignSpec(input.cloudTemplate) && campaignSpec(input.cloudTemplate).button) : true };
    return c.json({ ok: true, ...cloudExtra, link: linkView, audience: r.audience, inAudience: r.inAudience, afterFilters: r.afterFilters,
      excluded: r.excluded, eligible: r.eligible, willQueue: r.picked.length, holdoutEst: hold, estDays: days, sample,
      /* FD1: كل رسالة هتتبعت ({{1}} و{{2}} لكل مستلم) — المالك يراجعهم كلهم قبل البدء. الجوال مخفي. */
      ...(r.fav ? { fav: r.fav, perRecipient: input.perRecipient === true, texts: r.picked.map((x) => ({ phone: `${x.pn.slice(0, 3)}••••${x.pn.slice(-2)}`, name: x.name || null,
        title: (x.vars && x.vars.cloud && x.vars.cloud.values && x.vars.cloud.values["offer.title"]) || null, line: (x.vars && x.vars.cloud && x.vars.cloud.values && x.vars.cloud.values["offer.line"]) || null, ...(x.favView ? { fav: x.favView } : {}) })) } : {}),
      /* CP1: فلتر ملف العميل (اتطابق/اتشال/مالوش ملف) + قيم الرسالة لكل مستلم (مين طلع وليه) */
      ...(r.profile ? { profile: r.profile } : {}), profileVars: input.profileVars === true,
      customTemplate: Boolean(input.template), template: tpl, footer: r.cfg.footer, channel: input.channel,
      problems: [...input.errs.map(([error, message]) => ({ error, message })),
        ...(cloudExtra.templateSync && syncBlock(cloudExtra.templateSync) ? [{ error: syncBlock(cloudExtra.templateSync), message: cloudExtra.templateSync.message }] : [])] });
  });

  app.post("/api/cms/wa-sender/jobs", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const input = jobInput(b, { hosts: imageHosts() });
    /* حملة واتساب بتتبعت من السيرفر لعملاء حقيقيين وبفلوس: البدء للمالك بس (التسويق يجهّز ويعاين) */
    if (input.channel === "wa_cloud" && !(await isOwner(c))) return ownerOnly(c);
    if (input.errs.length) return bad(c, input.errs[0][0], input.errs[0][1], 422);
    /* SX2 (أ): startAt ⇒ الحملة بتتحفظ موقوفة والسيرفر نفسه بيبدأها في الميعاد (startDueJobs) — مفيش cron بره */
    const sched = parseStartAt(b.startAt, now());
    if (sched.error) return bad(c, sched.error[0], sched.error[1], 422);
    if (input.channel === "wa_cloud") { const mp = await mediaErr(input); if (mp) return bad(c, mp[0], mp[1], 422); }
    if (input.channel === "wa_cloud") {      // TS1: نسخة ميتا لسه مختلفة عن الكتالوج ⇒ مفيش بدء
      const ts = await tplSync(input.cloudTemplate);
      if (syncBlock(ts)) return c.json({ ok: false, error: syncBlock(ts), message: ts.message, templateSync: ts }, 409);
    }
    if (input.link.coupon) {
      const ok = (await pool.query("SELECT 1 FROM shop_coupons WHERE upper(code)=$1 AND active", [input.link.coupon])).rowCount;
      if (!ok) return bad(c, "coupon_invalid", `الكوبون ${input.link.coupon} مش موجود أو مقفول`, 422);
    }
    if (input.link.slug) {
      const taken = (await pool.query("SELECT 1 FROM cms_links WHERE slug=$1", [input.link.slug])).rowCount;
      if (taken) return bad(c, "slug_taken", "اسم الرابط ده مستخدم — اختار اسم تاني أو سيبه فاضي", 409);
    }
    const s = await getSettingsData();
    const bo = await buildOr(c, b.filters || {}, s, { channel: input.channel, ...profileBuildOpts(input) });
    if (bo.res) return bo.res;
    const r = bo.r;
    if (!r.picked.length) return bad(c, "empty", "مفيش حد مؤهل بالفلاتر دي");
    if (b.confirmCount != null && Number(b.confirmCount) !== r.picked.length) {
      return bad(c, "count_changed", `العدد اتغيّر (${r.picked.length}) — اعمل معاينة تاني`, 409);
    }
    /* FD1: «طبقك المفضل» — الرسايل اللي هتتحط في الطابور لازم تبقى نفس اللي اتقرت في المعاينة بالظبط (لو المعاينة بعتت بصمتها) */
    /* مراجعة FD1 ٣: البصمة **لازمة** — من غيرها البدء مش مربوط بالرسايل اللي اتقرت (اللوحة بتعرض رسالة واحدة بس ومابتبعتش البصمة).
       البدء بيتعمل من start.py (بيقرا كل الرسايل وبيبعت confirmDigest) لحد ما اللوحة تعرضهم كلهم. */
    if (r.fav && (b.confirmDigest == null || String(b.confirmDigest).trim() === "")) {
      return bad(c, "digest_required", "حملة «طبقك المفضل»: كل عميل له رسالة بسعره وتوصيله — البدء محتاج بصمة المعاينة (fav.digest) بعد قراءة كل الرسايل، مش من الزرار ده", 409);
    }
    if (r.fav && String(b.confirmDigest) !== r.fav.digest) {
      return bad(c, "offers_changed", "رسايل الحملة اتغيّرت من وقت المعاينة (سعر، توصيل، أو عملاء) — اعمل معاينة تاني واقراها قبل البدء", 409);
    }
    /* QP1 (M7-7): أرقام جاية من تطبيقات التوصيل بس ⇒ تأكيد صريح من المالك بالعدد نفسه. ماقدرناش نعدّ ⇒ مانبدأش. */
    if (input.channel === "wa_cloud") {
      const ao = r.appOnly || { count: null };
      if (ao.count == null) return c.json({ ok: false, error: "app_only_unreadable", message: "ماقدرناش نعرف كام رقم جاي من تطبيقات التوصيل — جرّب تاني بعد شوية", appOnly: ao }, 409);
      if (ao.count > 0 && Number(b.confirmAppOnly) !== ao.count) {
        return c.json({ ok: false, error: "app_only_confirm_required", appOnly: ao,
          message: `في الحملة ${ao.count} رقم «${APP_ONLY_LABEL}». أكّد العدد ده عشان تبدأ` }, 409);
      }
    }
    const by = await whoOf(c);
    const name = String(b.name || "").trim().slice(0, 80) || `حملة ${new Date(now()).toISOString().slice(0, 10)}`;
    const aud = (await audienceList()).find((a) => a.id === r.audience);
    const tpl = tplOf(r, input);
    const host = STORE();
    const client = await pool.connect();
    let jobId, slug, holdN = 0;
    try {
      await client.query("BEGIN");
      jobId = Number((await client.query(
        `INSERT INTO wa_send_jobs(name, filters, total, created_by, template, holdout_pct, image_url, offer, audience_label,
                                  channel, cloud_template, cloud_vars, fallback, video_url, spend_cap_sar, rate_sar, app_only, status, start_at, start_by, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, CASE WHEN $18 = 'running' THEN NOW() ELSE NULL END) RETURNING id`,
        [name, J(b.filters || {}), r.picked.length, by, input.template || null, input.holdoutPct, input.imageUrl,
          input.offer ? J(input.offer) : null, aud ? aud.label : r.audience,
          input.channel, input.cloudTemplate, input.cloudVars ? J(input.cloudVars) : null, input.fallback,
          input.videoUrl, input.spendCapSar, input.channel === "wa_cloud" ? (rateOf(s).rateSar || null) : null,
          input.channel === "wa_cloud" && r.appOnly ? r.appOnly.count : null,
          sched.at ? "paused" : "running", sched.at, sched.at ? by : null])).rows[0].id);
      /* الرابط المتتبّع: /l/<slug> (utm_source=whatsapp, utm_campaign=wa-<id>) —
         وكل عميل بياخد /l/<slug>-<code> عشان نعرف مين ضغط (cms.js resolve). */
      slug = input.link.slug || `w${jobId}`;
      await client.query(
        `INSERT INTO cms_links(slug, label, target_type, target_id, coupon, utm_source, utm_medium, utm_campaign, active, created_by)
         VALUES ($1,$2,$3,$4,$5,'whatsapp','message',$6,true,$7)`,
        [slug, `واتساب: ${name}`.slice(0, 80), input.link.target_type, input.link.target_id, input.link.coupon, `wa-${jobId}`, by]);
      await client.query("UPDATE wa_send_jobs SET link_slug=$2 WHERE id=$1", [jobId, slug]);
      const codes = new Set();
      /* LK1: المحجوزين بالعدد (round(n × النسبة)) مش «عملة» لكل رقم — حملة صغيرة كانت بتطلع ٠ أو ٢٣٪ بدل ١٠٪ */
      const held = holdoutSet(`wa${jobId}`, r.picked.map((x) => x.pn), input.holdoutPct);
      for (const x of r.picked) {
        const hold = held.has(String(x.pn));
        let code; do { code = newLinkCode(); } while (codes.has(code)); codes.add(code);
        let coupon = input.link.coupon || null;
        if (input.offer && !hold) {
          /* كوبون مرة واحدة ومقفول على جوال العميل. بيتعمل مقفول (active=false)
             وبيتفتح لحظة ما الرسالة تتبعت فعلاً — اللي ماتبعتلوش كوبونه مايشتغلش. */
          for (let k = 0; k < 4; k++) {
            const cc = newCouponCode(jobId);
            const ins = await client.query(
              `INSERT INTO shop_coupons(code, percent, active, min_total, max_uses, expires_at, note, once_per_customer, free_delivery, phone_norm)
               VALUES ($1,$2,false,$3,1,NULL,$4,true,$5,$6) ON CONFLICT (code) DO NOTHING RETURNING code`,
              [cc, input.offer.percent, input.offer.minTotal, `واتساب #${jobId} — ${x.pn.slice(-4)}`, input.offer.freeDelivery, x.pn]);
            if (ins.rowCount) { coupon = cc; break; }
          }
        }
        /* FD1: حملة قيمها لكل مستلم ⇒ نص الصف = نص قالب واتساب نفسه بقيم العميل ده (اللي هيتبعت فعلاً) — للوحة والسجل */
        const msg = input.perRecipient || input.profileVars ? (cloudText(input, x, slug, code) || "-") : messageFor(x, { template: tpl, footer: r.cfg.footer, host, slug, code, coupon, couponDays: input.offer?.validDays });
        if (hold) holdN++;
        await client.query(
          `INSERT INTO wa_send_queue(job_id, phone_norm, name, message, score, status, reason, link_code, coupon, vars)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [jobId, x.pn, x.name, msg, x.score || 0, hold ? "holdout" : "pending", hold ? "holdout" : null, code, hold ? null : coupon, J(x.vars || {})]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (String(e.message).includes("cms_links_slug_key") || String(e.message).includes("duplicate key")) {
        return bad(c, "slug_taken", "اسم الرابط اتاخد — جرّب تاني", 409);
      }
      throw e;
    } finally { client.release(); }
    return c.json({ ok: true, jobId, total: r.picked.length, holdout: holdN, slug, link: recipientLink(host, slug, null), channel: input.channel,
      target: { type: input.link.target_type, id: input.link.target_id, opens: `${host}${linkTargetPath(input.link)}` },
      status: sched.at ? "paused" : "running", startAt: sched.at || null, startAtRiyadh: sched.riyadh || null });
  });

  /* ── التحكم في الطابور وهو شغّال (طلب عمر ٢٦/٩) ────────────────────────
     كل التعديلات فورية في السيرفر ومابتلمسش غير صفوف status='pending'؛ الإضافة
     بتاخد الرسالة من السيرفر لحظة الإرسال، فالتعديل بيسري من الرسالة الجاية. */
  const MAX_MSG = 1500;
  app.post("/api/cms/wa-sender/items/:id/edit", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const msg = String(b.message || "").replace(/\r\n/g, "\n").trim();
    if (!msg) return bad(c, "empty", "الرسالة فاضية");
    if (msg.length > MAX_MSG) return bad(c, "too_long", `الرسالة أطول من ${MAX_MSG} حرف`);
    if (/\{\w+\}/.test(msg)) return bad(c, "raw_only", "التعديل الفردي نص نهائي — من غير متغيرات زي {name}");
    /* مراجعة FD1 ٣: رسالة «طبقك المفضل» بتتبعت من قيم القالب المحسوبة للعميل (vars.cloud)، مش من النص ده — تعديله كان بيغيّر اللي بيتعرض بس */
    const jr = (await pool.query("SELECT j.cloud_vars FROM wa_send_queue q JOIN wa_send_jobs j ON j.id = q.job_id WHERE q.id=$1", [Number(c.req.param("id"))])).rows[0];
    if (jr && jr.cloud_vars && (jr.cloud_vars.perRecipient === true || jr.cloud_vars.profileVars === true)) return bad(c, "per_recipient", "رسايل الحملة دي محسوبة لكل عميل (العرض والسعر والتوصيل) — الرسالة مابتتعدّلش من هنا؛ شيلها من الطابور لو مش عايزها تتبعت", 409);
    const r = await pool.query(
      "UPDATE wa_send_queue SET message=$2, edited_by=$3 WHERE id=$1 AND status='pending' RETURNING id",
      [Number(c.req.param("id")), msg, await whoOf(c)]);
    if (!r.rowCount) return bad(c, "not_pending", "الرسالة دي مابقتش في الطابور (اتبعتت أو اتشالت)", 409);
    return c.json({ ok: true });
  });
  app.post("/api/cms/wa-sender/items/:id/remove", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query(
      "UPDATE wa_send_queue SET status='skipped', reason='removed_by_owner', edited_by=$2 WHERE id=$1 AND status='pending' RETURNING id",
      [Number(c.req.param("id")), await whoOf(c)]);
    if (!r.rowCount) return bad(c, "not_pending", "الرسالة دي مابقتش في الطابور", 409);
    return c.json({ ok: true });
  });
  /* إيقاف/تشغيل كل الحملات مرة واحدة */
  app.post("/api/cms/wa-sender/all/:action", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const a = c.req.param("action");
    const [from, to] = a === "pause" ? ["running", "paused"] : a === "resume" ? ["paused", "running"] : [null, null];
    if (!from) return bad(c, "bad_action", "أمر مش معروف");
    /* تكملة حملات Cloud (بتبعت من السيرفر) للمالك بس — غير المالك بيكمّل حملات واتساب ويب بس. الإيقاف لأي حد. */
    const owner = to === "running" ? await isOwner(c) : true;
    /* SX2 (ج): حملة Cloud صورتها/الفيديو بتاعها مابيفتحش مابتكمّلش — بتفضل موقوفة وسببها راجع في الرد */
    const refused = [];
    if (to === "running" && owner) {
      const pj = (await pool.query(`SELECT id, name, channel, cloud_template, image_url, video_url FROM wa_send_jobs WHERE status='paused' AND channel='wa_cloud'`).catch(() => ({ rows: [] }))).rows || [];
      for (const j of pj) { const mp = await jobMediaErr(j, { cacheMs: 30_000 }); if (mp) refused.push({ id: Number(j.id), name: j.name, error: mp[0], message: mp[1] }); }
    }
    const r = await pool.query(`UPDATE wa_send_jobs SET status=$2, stop_reason = CASE WHEN $2='running' THEN NULL ELSE stop_reason END,
                                        brake_ack_at = CASE WHEN $2='running' THEN NOW() ELSE brake_ack_at END,
                                        start_at = CASE WHEN $2='running' THEN NULL ELSE start_at END,
                                        started_at = CASE WHEN $2='running' THEN COALESCE(started_at, NOW()) ELSE started_at END
                                 WHERE status=$1 AND ($3::boolean OR COALESCE(channel,'wa_web') <> 'wa_cloud') AND NOT (id = ANY($4::bigint[])) RETURNING id`,
      [from, to, owner, refused.map((x) => x.id)]);
    return c.json({ ok: true, changed: r.rowCount, ...(refused.length ? { refused } : {}) });
  });

  /* ── SX2 (أ): جدولة البدء/التكملة — لحملة واحدة أو لموجة كاملة مرة واحدة ──────────────────────────────
     startAt فاضي/null = شيل الميعاد. الحملة لازم تكون موقوفة. حملة Cloud: المالك بس (زي التكملة)، ووسيطها بيتفحص دلوقتي
     (عشان المشكلة تبان من بدري) وتاني لحظة البدء. البدء نفسه بيعمله السيرفر (startDueJobs) — مش cron ولا جلسة حد. */
  async function scheduleJobs(c, idsRaw, startAtRaw) {
    const ids = [...new Set((Array.isArray(idsRaw) ? idsRaw : []).map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 50);
    if (!ids.length) return bad(c, "no_jobs", "اختار حملة واحدة على الأقل");
    const sched = parseStartAt(startAtRaw, now());
    if (sched.error) return bad(c, sched.error[0], sched.error[1], 422);
    const jobs = (await pool.query(`SELECT id, name, status, channel, cloud_template, image_url, video_url, start_at FROM wa_send_jobs WHERE id = ANY($1::bigint[])`, [ids])).rows || [];
    if (jobs.some((j) => j.channel === "wa_cloud") && !(await isOwner(c))) return ownerOnly(c);
    const by = await whoOf(c);
    const skipped = [];
    for (const id of ids) if (!jobs.some((j) => Number(j.id) === id)) skipped.push({ id, error: "not_found", message: "الحملة مش موجودة" });
    if (!sched.at) {
      const r = await pool.query("UPDATE wa_send_jobs SET start_at=NULL, start_error=NULL WHERE id = ANY($1::bigint[]) AND start_at IS NOT NULL RETURNING id", [ids]);
      return c.json({ ok: true, startAt: null, cleared: (r.rows || []).map((x) => Number(x.id)), skipped });
    }
    const ok = [];
    for (const j of jobs) {
      if (j.status !== "paused") { skipped.push({ id: Number(j.id), name: j.name, error: `status_${j.status}`, message: j.status === "running" ? "الحملة شغّالة أصلاً" : "الحملة خلصت أو اتلغت" }); continue; }
      const mp = await jobMediaErr(j, { cacheMs: 30_000 });
      if (mp) { skipped.push({ id: Number(j.id), name: j.name, error: mp[0], message: `ماتجدولتش: ${mp[1]}` }); continue; }
      ok.push(Number(j.id));
    }
    const r = ok.length ? await pool.query(
      "UPDATE wa_send_jobs SET start_at=$2, start_by=$3, start_error=NULL WHERE id = ANY($1::bigint[]) AND status='paused' RETURNING id", [ok, sched.at, by]) : { rows: [] };
    const scheduled = (r.rows || []).map((x) => Number(x.id));
    if (!scheduled.length) return c.json({ ok: false, error: (skipped[0] && skipped[0].error) || "nothing_scheduled", message: (skipped[0] && skipped[0].message) || "مفيش حملة اتجدولت", skipped }, 409);
    return c.json({ ok: true, startAt: sched.at, startAtRiyadh: sched.riyadh, scheduled, skipped });
  }
  app.post("/api/cms/wa-sender/schedule", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    return scheduleJobs(c, b.jobIds, b.startAt);
  });
  /* نص جديد لكل اللي لسه في الطابور: نفس المتغيرات (المتخزّنة مع كل صف)، ونفس
     رابط وكوبون كل عميل. الصفوف القديمة من غير متغيرات بنعيد حسابها من الشريحة. */
  async function retemplate(c, jobId) {
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const tpl = String(b.template || "").trim();
    const tp = templateProblem(tpl);
    if (!tpl || tp) return bad(c, tp || "empty", tp === "name_required" ? "النص لازم يحتوي على {name}" : tp ? "في متغير مش معروف أو النص طويل" : "النص فاضي", 422);
    const job = (await pool.query("SELECT * FROM wa_send_jobs WHERE id=$1", [jobId])).rows[0];
    if (!job || ["done", "cancelled"].includes(job.status)) return bad(c, "not_found", "الحملة خلصت أو مش موجودة", 404);
    /* FD1: رسايل «طبقك المفضل» محسوبة لكل عميل من قالب واتساب — مفيش نص حملة يتغيّر من هنا */
    if (job.cloud_vars && (job.cloud_vars.perRecipient === true || job.cloud_vars.profileVars === true)) return bad(c, "per_recipient", "رسايل الحملة دي محسوبة لكل عميل (العرض والسعر والتوصيل) — النص مايتغيّرش من هنا", 409);
    const rows = (await pool.query("SELECT id, phone_norm, vars, link_code, coupon FROM wa_send_queue WHERE job_id=$1 AND status='pending'", [jobId])).rows;
    const missing = rows.filter((x) => !x.vars || !Object.keys(x.vars).length);
    let fresh = new Map();
    if (missing.length && outreach) {
      const f = job.filters || {};
      const A = (await resolveAudience(f.audience)) || { aud: f.audience || "never_online", segmentPhones: null };
      const all = await outreach.audienceRows(A.aud, { canSee: true, minLastOrder: Number(f.minLastOrder) || 0, segmentPhones: A.segmentPhones });
      fresh = new Map(all.map((x) => [x.pn, x.vars]));
    }
    const cfg = senderCfg(await getSettingsData());
    const host = STORE(), by = await whoOf(c);
    let done = 0, noVars = 0;
    for (const x of rows) {
      const vars = (x.vars && Object.keys(x.vars).length) ? x.vars : fresh.get(x.phone_norm);
      if (!vars) { noVars++; continue; }
      // حملة قديمة من غير رابط متتبّع: {link} بيبقى فاضي بدل رابط غلط
      const msg = messageFor({ vars }, { template: tpl, footer: cfg.footer, host, slug: job.link_slug || "", code: x.link_code,
        coupon: x.coupon, couponDays: job.offer?.validDays });
      const final = job.link_slug ? msg : msg.replace(/\S*\/l\/(-\S*)?(?=\s|$)/g, "").replace(/[ 	]{2,}/g, " ");
      const u = await pool.query("UPDATE wa_send_queue SET message=$2, vars=$3, edited_by=$4 WHERE id=$1 AND status='pending'", [x.id, final, J(vars), by]);
      done += u.rowCount;
    }
    await pool.query("UPDATE wa_send_jobs SET template=$2 WHERE id=$1", [jobId, tpl]);
    return c.json({ ok: true, updated: done, noVars });
  }

  app.post("/api/cms/wa-sender/jobs/:id/:action", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id")), action = c.req.param("action");
    if (action === "retemplate") return retemplate(c, id);
    if (action === "schedule") {      // SX2: {startAt} — فاضي = شيل الميعاد
      let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
      return scheduleJobs(c, [id], b.startAt);
    }
    const to = { pause: "paused", resume: "running", cancel: "cancelled" }[action];
    if (!to) return bad(c, "bad_action", "أمر مش معروف");
    if (to === "running") {
      const ch = (await pool.query("SELECT channel FROM wa_send_jobs WHERE id=$1", [id])).rows[0];
      if (ch && ch.channel === "wa_cloud" && !(await isOwner(c))) return ownerOnly(c);
      /* SX2 (ج): قبل ما حملة Cloud بصورة/فيديو تكمّل — السيرفر بيفتح الرابط بنفسه. مابيفتحش ⇒ مفيش تكملة وسبب واضح */
      if (ch && ch.channel === "wa_cloud") {
        const job = (await pool.query(JOB_SQL, [id])).rows[0];
        const mp = job ? await jobMediaErr(job) : null;
        if (mp) return bad(c, mp[0], `الحملة ماكمّلتش: ${mp[1]}`, 422);
      }
    }
    const r = await pool.query(
      `UPDATE wa_send_jobs SET status=$2, finished_at = CASE WHEN $2='cancelled' THEN NOW() ELSE finished_at END,
              stop_reason = CASE WHEN $2='running' THEN NULL ELSE stop_reason END,
              brake_ack_at = CASE WHEN $2='running' THEN NOW() ELSE brake_ack_at END,
              start_at = CASE WHEN $2 IN ('running','cancelled') THEN NULL ELSE start_at END,
              started_at = CASE WHEN $2='running' THEN COALESCE(started_at, NOW()) ELSE started_at END
        WHERE id=$1 AND status NOT IN ('done','cancelled') RETURNING id`, [id, to]);
    if (!r.rowCount) return bad(c, "not_found", "الحملة خلصت أو مش موجودة", 404);
    if (to === "cancelled") {
      await pool.query("UPDATE wa_send_queue SET status='skipped', reason='cancelled' WHERE job_id=$1 AND status='pending'", [id]);
      await pool.query("UPDATE wa_send_queue SET retry_at=NULL WHERE job_id=$1 AND retry_at IS NOT NULL", [id]);      // SX2: الإلغاء = مفيش إعادة
    }
    return c.json({ ok: true });
  });

  app.get("/api/cms/wa-sender/jobs/:id/items", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const canSee = typeof ctx.canSeePhones === "function" ? await ctx.canSeePhones(c) : false;
    const r = await pool.query(
      `SELECT q.id, q.phone_norm, q.name, q.status, q.reason, q.attempts, q.sent_at, q.message, q.clicks, q.replied_at,
              q.optout_at, q.media, q.note, q.coupon, q.edited_by, q.channel, q.cloud_status, q.error_code,
              q.delivered_at, q.read_at, q.fallback_from, q.retry_at, q.retried_at, q.first_error_code,
              (SELECT w.text FROM wa_replies w WHERE w.phone_norm = q.phone_norm AND w.at >= q.sent_at
                ORDER BY w.at DESC LIMIT 1) AS reply
         FROM wa_send_queue q WHERE q.job_id=$1
          AND ($2::text = '' OR q.name ILIKE '%' || $2 || '%' OR q.phone_norm LIKE '%' || $2)
          AND ($3::text = '' OR q.status = $3)
        ORDER BY (q.status='pending') DESC, (q.status='holdout'), q.sent_at DESC NULLS LAST, q.score DESC LIMIT 500`,
      [Number(c.req.param("id")), String(c.req.query("q") || "").trim().replace(/[%_\\]/g, "").slice(0, 40),
        ["pending", "sent", "failed", "skipped", "holdout"].includes(c.req.query("status")) ? c.req.query("status") : ""]);
    /* SX2 (د): سبب كل صف بالعربي (فشل / اتخطّى / مستني إعادة) */
    return c.json({ ok: true, items: r.rows.map((x) => ({ ...x, id: Number(x.id),
      reason_ar: x.status === "failed" || x.status === "skipped" || (x.status === "pending" && x.reason) ? reasonText(x.reason) : null,
      retry_ar: x.status === "failed" && x.retry_at ? `هتتعاد لوحدها ${riyadhClock(x.retry_at).slice(11)} (فشل مؤقت)` : x.retried_at ? `اتعادت ${riyadhClock(x.retried_at).slice(11)} بعد ${reasonText(classifyError(x.first_error_code).reason)}` : null,
      phone_norm: canSee ? x.phone_norm : `${x.phone_norm.slice(0, 3)}••••${x.phone_norm.slice(-2)}` })) });
  });

  /* ── إيقاف (من رد العميل أو زرار «طلب إيقاف») ─────────────────────────
     بيكتب في نفس cms_contacts اللي كل القنوات بتحترمه (SMS + واتساب + إشعارات)،
     وبيشيل الرقم من أي طابور واتساب لسه مابعتش. */
  async function optOut(pn, source, reason, actor) {
    await pool.query(
      `INSERT INTO cms_contacts(phone_norm, optout_code)
       VALUES ($1, substr(md5(random()::text || $1 || clock_timestamp()::text), 1, 10))
       ON CONFLICT (phone_norm) DO NOTHING`, [pn]);
    const r = await pool.query(
      `UPDATE cms_contacts SET opted_out_at = COALESCE(opted_out_at, NOW()),
              optout_source = CASE WHEN opted_out_at IS NULL THEN $2 ELSE optout_source END,
              optout_reason = CASE WHEN opted_out_at IS NULL THEN $3 ELSE optout_reason END,
              optout_by = CASE WHEN opted_out_at IS NULL THEN $4 ELSE optout_by END
        WHERE phone_norm=$1 RETURNING phone_norm`, [pn, source, String(reason || "").slice(0, 200), actor || null]);
    await pool.query("INSERT INTO cms_optout_log(phone_norm, action, source, reason, actor) VALUES ($1,'optout',$2,$3,$4)",
      [pn, source, String(reason || "").slice(0, 200), actor || null]).catch(() => {});
    await pool.query("UPDATE wa_send_queue SET status='skipped', reason='opted_out' WHERE phone_norm=$1 AND status='pending'", [pn]);
    await pool.query(
      `UPDATE wa_send_queue SET optout_at = COALESCE(optout_at, NOW())
        WHERE id = (SELECT id FROM wa_send_queue WHERE phone_norm=$1 AND status='sent' ORDER BY sent_at DESC LIMIT 1)`, [pn]);
    return r.rowCount > 0;
  }

  app.post("/api/cms/wa-sender/items/:id/optout", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const q = (await pool.query("SELECT phone_norm FROM wa_send_queue WHERE id=$1", [Number(c.req.param("id"))])).rows[0];
    if (!q) return bad(c, "not_found", "مش موجود", 404);
    const by = await whoOf(c);
    await optOut(q.phone_norm, "wa_manual", "طلب إيقاف على واتساب (من اللوحة)", by);
    await pool.query("UPDATE wa_send_queue SET optout_at = COALESCE(optout_at, NOW()) WHERE id=$1", [Number(c.req.param("id"))]);
    return c.json({ ok: true });
  });

  /* ── نتيجة الحملة ────────────────────────────────────────────────────
     «اتحوّل» = طلب خلال ٧ أيام من الرسالة، بالجوال: الموقع (shop_orders
     المدفوعة) + نقطة البيع (ts_orders عبر order_sources/ts_customers).
     التطبيقات (كيتا/هنقر…) بتتعرض لوحدها — مش هدفنا. كل طلب بيتحسب مرة
     واحدة لآخر رسالة واتساب قبله (أي حملة أو يدوي). المحجوزين (holdout)
     بيبدأ عدّهم من أول رسالة في الحملة. */
  app.get("/api/cms/wa-sender/jobs/:id/results", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const job = (await pool.query("SELECT * FROM wa_send_jobs WHERE id=$1", [Number(c.req.param("id"))])).rows[0];
    if (!job) return bad(c, "not_found", "مش موجودة", 404);
    const jobId = Number(job.id);
    const sNow = await getSettingsData().catch(() => ({}));
    const rows = (await pool.query(
      `SELECT phone_norm pn, status, reason, sent_at, clicks, replied_at, optout_at, media, coupon, channel, cloud_status, error_code, fallback_from,
              retry_at, retried_at, first_error_code, note, tried_at, claimed_at
         FROM wa_send_queue WHERE job_id=$1`, [jobId])).rows;
    const sent = rows.filter((x) => x.status === "sent");
    const hold = rows.filter((x) => x.status === "holdout");
    const count = (f) => rows.filter(f).length;
    const t0h = sent.length ? new Date(Math.min(...sent.map((x) => new Date(x.sent_at).getTime()))) : new Date(job.created_at);
    const pns = [...new Set([...sent, ...hold].map((x) => x.pn))];
    const linkRow = job.link_slug ? (await pool.query("SELECT clicks FROM cms_links WHERE slug=$1", [job.link_slug])).rows[0] : null;
    const base = { ok: true, id: jobId, name: job.name, status: job.status, slug: job.link_slug, windowDays: ATTR_DAYS,
      sent: sent.length, holdout: hold.length, failed: count((x) => x.status === "failed" && !x.retry_at),
      invalid: count((x) => x.reason === "invalid_number"), skipped: count((x) => x.status === "skipped"),
      pending: count((x) => ["pending", "sending"].includes(x.status)),
      replies: count((x) => x.replied_at), optouts: count((x) => x.optout_at),
      clicks: linkRow ? Number(linkRow.clicks) : null, clickers: count((x) => Number(x.clicks) > 0),
      /* RF1 (١٤/١٠) — الضغطات بصدق: زر القالب بيفتح رابط **العميل نفسه** (‎/l/<slug>-<code>‎)، فضغطة المستلم بتتسجّل على صفّه.
         recipientClicks = مجموع ضغطات المستلمين · otherClicks = ضغطات على الرابط العام من غير كود (تجربة المالك، مشاركة، فتح يدوي) — مش مستلمين.
         (جلب المعاينة والزواحف — واتساب/ميتا — مابيتعدّوش أصلاً: botfilter.js.) linkButton=false ⇒ القالب مافيهوش زر رابط («الرد أولاً»). */
      recipientClicks: rows.reduce((a, x) => a + (Number(x.clicks) || 0), 0),
      otherClicks: linkRow ? Math.max(0, Number(linkRow.clicks) - rows.reduce((a, x) => a + (Number(x.clicks) || 0), 0)) : null,
      linkButton: job.channel === "wa_cloud" ? Boolean(campaignSpec(job.cloud_template) && campaignSpec(job.cloud_template).button) : true,
      images: count((x) => x.media === "image"), imageFallbacks: count((x) => x.status === "sent" && x.media === "text" && job.image_url),
      channel: job.channel || "wa_web", cloudTemplate: job.cloud_template || null, fallback: job.fallback || "none",
      cloud: cloudStats(rows), stopReason: job.stop_reason || null, spendCapSar: job.spend_cap_sar != null ? Number(job.spend_cap_sar) : null,
      videos: count((x) => x.media === "video"),
      /* SX2 (ب، د): الإعادة التلقائية بتتعدّ لوحدها (retried / retry_ok …)، وأسباب الفشل والتخطّي بالعربي، وميعاد البدء */
      retry: retryStats(rows), retried: rows.filter((x) => x.retried_at).length, retry_ok: retryStats(rows).ok,
      reasons: reasonRows(rows),
      startAt: job.start_at || null, startAtRiyadh: job.start_at ? riyadhClock(job.start_at) : null, startedAt: job.started_at || null, startError: job.start_error || null,
      /* SX2 (ج): الفرامل من بعد آخر «كمّل»/بدء (نفس أرقام الدورة) — اللوحة بتقول النسبة الحالية وبتتحسب من إمتى */
      brake: job.channel === "wa_cloud" ? { ...brakeView(brakeWindow(rows, job.brake_ack_at || null), cloudCfg(sNow)), sinceRiyadh: job.brake_ack_at ? riyadhClock(job.brake_ack_at) : null } : null,
      /* التكلفة = الرسايل اللي ميتا قبلتها على قناة Cloud × سعر الرسالة وقت إنشاء الحملة (تقدير — الفاتورة من ميتا) */
      cost: job.channel === "wa_cloud" ? (() => { const n = count((x) => x.channel === "wa_cloud" && x.status === "sent"); const rate = Number(job.rate_sar) > 0 ? Number(job.rate_sar) : rateOf(sNow).rateSar;
        return { messages: n, rateSar: rate || null, sar: campaignCost(n, rate) }; })() : null };
    if (!pns.length) return c.json({ ...base, direct: null, apps: null, web: null, pos: null });
    const from = new Date(Math.min(t0h.getTime(), ...sent.map((x) => new Date(x.sent_at).getTime())));
    const to = new Date(Math.max(t0h.getTime(), ...sent.map((x) => new Date(x.sent_at).getTime())) + ATTR_DAYS * 86400000);
    const [sends, web, pos, cpn] = await Promise.all([
      pool.query(`SELECT phone_norm pn, at, job_id FROM wa_contact_log WHERE phone_norm = ANY($1::text[]) AND at > $2::timestamptz - INTERVAL '8 days' AND at <= $3`,
        [pns, from, to]),
      pool.query(`SELECT 'web:' || so.order_no AS key, so.phone_norm pn, so.created_at at, so.total, so.coupon, so.attribution->>'fc_link' AS fc_link
                    FROM shop_orders so WHERE so.phone_norm = ANY($1::text[]) AND ${shopPaidSql("so")}
                     AND so.created_at >= $2 AND so.created_at <= $3`, [pns, from, to]),
      pool.query(`SELECT 'pos:' || o.order_id AS key, COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) pn, o.order_date at, o.total,
                         btrim(COALESCE(s.source_note,'')) AS note, o.order_type
                    FROM ts_orders o
                    LEFT JOIN order_sources s ON s.order_id = o.order_id
                    LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
                   WHERE (s.phone_norm = ANY($1::text[]) OR tc.phone_norm = ANY($1::text[]))
                     AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%' AND o.order_type NOT ILIKE '%parked%'))
                     AND o.order_date >= $2 AND o.order_date <= $3`, [pns, from, to]),
      // الكوبون بتاع الحملة استخدمه نفس المستلم بعد رسالته (الكوبون الثابت زي FIRST مابيتحسبش لغيره)
      pool.query(`SELECT count(DISTINCT so.order_no)::int n, COALESCE(sum(so.total),0)::float rev
                    FROM wa_send_queue q JOIN shop_orders so ON upper(so.coupon) = upper(q.coupon) AND so.phone_norm = q.phone_norm
                     AND so.created_at >= q.sent_at AND ${shopPaidSql("so")}
                   WHERE q.job_id=$1 AND q.status='sent' AND q.coupon IS NOT NULL`, [jobId]),
    ]);
    const webO = web.rows.map((o) => ({ ...o, channel: "web" }));
    // مرايا طلبات الموقع في نقطة البيع (ملاحظة W…) أو نفس الإجمالي في نفس الوقت ⇒ مش طلب تاني
    const posO = dropPosMirrors(pos.rows.filter((o) => !/^W\d+/.test(o.note)), webO)
      .map((o) => ({ ...o, channel: o.note || /^external$/i.test(String(o.order_type || "")) ? "app" : "pos" }));
    const allOrders = [...webO, ...posO];
    const credit = creditOrders(sends.rows.map((x) => ({ pn: x.pn, at: x.at, jobId: x.job_id == null ? null : Number(x.job_id) })), allOrders, ATTR_DAYS);
    const mine = allOrders.filter((o) => credit.get(o.key)?.jobId === jobId);
    const holdSet = new Set(hold.map((x) => x.pn));
    const holdOrders = allOrders.filter((o) => holdSet.has(o.pn) && !credit.has(o.key)
      && new Date(o.at) >= t0h && new Date(o.at) - t0h <= ATTR_DAYS * 86400000);
    const direct = summarizeResults({ sentN: sent.length, holdN: hold.length,
      sentOrders: mine.filter((o) => o.channel !== "app"), holdOrders: holdOrders.filter((o) => o.channel !== "app") });
    const sum = (l) => ({ orders: l.length, revenue: Math.round(l.reduce((s, o) => s + (Number(o.total) || 0), 0)), people: new Set(l.map((o) => o.pn)).size });
    return c.json({ ...base,
      direct, web: sum(mine.filter((o) => o.channel === "web")), pos: sum(mine.filter((o) => o.channel === "pos")),
      apps: sum(mine.filter((o) => o.channel === "app")), holdoutApps: sum(holdOrders.filter((o) => o.channel === "app")),
      viaLink: sum(mine.filter((o) => o.channel === "web" && o.fc_link === job.link_slug)),
      coupons: { redeemed: cpn.rows[0].n, revenue: Math.round(cpn.rows[0].rev) },
      holdoutStart: t0h });
  });

  // الشاشة اليدوية: «افتح واتساب» بيتسجّل هنا عشان قاعدة الـ٣ أيام تشمله
  app.post("/api/cms/outreach/opened", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const pn = String(b.phone || "").replace(/\D/g, "").replace(/^(966|0)/, "");
    if (!/^5\d{8}$/.test(pn)) return bad(c, "invalid_phone", "رقم غلط");
    await pool.query("INSERT INTO wa_contact_log(phone_norm, channel, by) VALUES ($1,'manual',$2)", [pn, await whoOf(c)]);
    return c.json({ ok: true });
  });
  app.post("/api/cms/outreach/recent", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const pns = (Array.isArray(b.phones) ? b.phones : []).map((x) => String(x).replace(/\D/g, "").replace(/^(966|0)/, "")).filter((x) => /^5\d{8}$/.test(x)).slice(0, 500);
    if (!pns.length) return c.json({ ok: true, recent: {} });
    const r = await pool.query(
      `SELECT phone_norm, max(at) AS at FROM wa_contact_log WHERE phone_norm = ANY($1::text[]) AND at > NOW() - INTERVAL '30 days' GROUP BY 1`, [pns]);
    return c.json({ ok: true, recent: Object.fromEntries(r.rows.map((x) => [x.phone_norm, x.at])) });
  });

  /* ── مشترك بين القناتين ─────────────────────────────────────────────── */
  // ليه مانبعتش للرقم ده دلوقتي؟ (null = ابعت) — نفس الترتيب في القناتين
  async function skipReason(pn, cfg, staff, { cloud = false } = {}) {
    const oo = (await pool.query("SELECT 1 FROM cms_contacts WHERE phone_norm=$1 AND opted_out_at IS NOT NULL", [pn])).rowCount;
    if (oo) return "opted_out";
    if (staff.has(pn)) return "staff";
    if ((await invalidSet([pn])).size) return "invalid_number";
    const rec = await recentMap([pn], cfg.gapDays, cloud ? { waGapDays: CLOUD_MIN_GAP_DAYS } : {});
    if (rec.size) return rec.get(pn) === "sms" ? "gap_sms" : (cloud ? "gap_7d" : "gap_3d");
    const blk = await blockedSets([pn], cfg);
    if (blk.onlineRecent.size) return "ordered_online";
    if (blk.openOrder.size) return "open_order";
    return null;
  }

  /* اتبعتت: الصف + سجل التواصل (قاعدة الـ٣ أيام) + حالة القناة + فتح الكوبون */
  async function markSent(q, { media = null, note = null, channel = "wa_web", wamid = null, batchSize = 10 } = {}) {
    await pool.query(
      `UPDATE wa_send_queue SET status='sent', sent_at=NOW(), reason=NULL, media=$2, note=$3, channel=$4,
              wamid=COALESCE($5, wamid), cloud_status = CASE WHEN $5::text IS NULL THEN cloud_status ELSE 'accepted' END
        WHERE id=$1`, [q.id, media, note, channel, wamid]);
    await pool.query("INSERT INTO wa_contact_log(phone_norm, channel, job_id, by) VALUES ($1,'auto',$2,$3)",
      [q.phone_norm, q.job_id, channel === "wa_cloud" ? "cloud" : null]);
    await pool.query(
      `UPDATE wa_sender_state SET last_sent_at=NOW(), fail_streak=0,
              since_break = CASE WHEN since_break >= $1 THEN 1 ELSE since_break + 1 END WHERE id=$2`,
      [batchSize, channel === "wa_cloud" ? 2 : 1]);
    await activateCoupon(q);
  }
  // الكوبون مرة واحدة بيتفتح دلوقتي بس، وصلاحيته من يوم الإرسال
  async function activateCoupon(q) {
    if (!q.coupon) return;
    const job = (await pool.query("SELECT offer FROM wa_send_jobs WHERE id=$1", [q.job_id])).rows[0] || {};
    const days = Number(job.offer?.validDays) || 0;
    if (job.offer?.oneTime && days) {
      await pool.query(
        `UPDATE shop_coupons SET active=true, expires_at = CURRENT_DATE + $3::int
          WHERE code=$1 AND phone_norm=$2 AND NOT active AND used_count=0`, [q.coupon, q.phone_norm, days]).catch(() => {});
    }
  }

  /* ── قناة Cloud API ─────────────────────────────────────────────────────
     الدورة: كل WA_CLOUD_TICK_SEC (١٥ث) — قفل Postgres استشاري عشان وقت
     النشر (الكونتينرين شغّالين دقيقة) مايبعتوش مع بعض. */
  const wa = deps.wa || null;
  const cloudApi = () => (typeof deps.cloud === "function" ? deps.cloud() : deps.cloud) || null;

  function cloudText(input, x, slug, code) {
    try { return campaignParams(input.cloudTemplate, { vars: x.vars, name: x.name, link_code: code, coupon: null },
      { link_slug: slug, image_url: input.imageUrl, video_url: input.videoUrl, cloud_vars: input.cloudVars }).text || null; } catch { return null; }
  }
  function cloudSample(input, x, slug, couponEx) {
    try {
      const { text } = campaignParams(input.cloudTemplate, { vars: x.vars, name: x.name, link_code: "xxxxxx", coupon: couponEx || "W…" },
        { link_slug: slug, image_url: input.imageUrl, cloud_vars: input.cloudVars });
      return { template: input.cloudTemplate, text, footer: TEMPLATES[input.cloudTemplate].components.find((c) => c.type === "FOOTER")?.text || "",
        buttons: (TEMPLATES[input.cloudTemplate].components.find((c) => c.type === "BUTTONS")?.buttons || []).map((b) => b.text) };
    } catch { return null; }
  }

  async function cloudInfo(s, cfg) {
    const cc = cloudCfg(s);
    const st = await stateNow("wa_cloud").catch(() => ({}));
    const gate = wa ? await wa.gate() : "disabled";
    const cl = cloudApi();
    const phone = cl && !gate ? await cl.phoneInfo().catch(() => null) : null;
    /* حالة القوالب عند ميتا بتتقري حتى والإرسال مقفول (قراءة بس) — عشان الحملة تتجهّز وتتعاين قبل فتح المفتاح */
    const tpl = cl ? await cl.templateInfo().catch(() => null) : null;
    const approved = new Map(((tpl && tpl.list) || []).map((t) => [t.name, t.status]));
    const { configId, ...pubCfg } = cc;
    /* QP1: سلّم التسخين وحالة بوابة الجودة للوحة (قراءة بس — الدورة هي اللي بتقرر وبتحفظ) */
    const wv = warmupView(st.warmup, cc.warmup, { today: riyadhDay(now()), dailyCap: cc.dailyCap });
    const qs = st.quality || {};
    return { cfg: pubCfg, state: { today: st.today || 0, lastHour: st.lastHour || 0, uniq24h: st.uniq24h || 0, stoppedReason: st.stoppedReason || null },
      warmup: wv, effectiveDailyCap: wv.cap,
      qualityGate: { last: lastQuality, stoppedByQuality: /^quality_/.test(String(st.stoppedReason || "")), lastStop: qs.lastStop || null,
        seen: { tier: qs.tier || null, portfolio: qs.portfolio || null, at: qs.at || null }, allowUnknown: cc.allowUnknownQuality, maxAgeMin: cc.qualityMaxAgeMin, ownerResumeOnly: true },
      custCap: { d7: cc.custCap7d, d30: cc.custCap30d, gapDays: Math.max(CLOUD_MIN_GAP_DAYS, cfg.gapDays) },
      pace: cloudPacing(cc, { ...st, warmCap: wv.cap }, inWindow(cfg, now())), gate: gate || null, phoneStatus: phone?.status || null,
      quality: phone?.quality || null, tier: phone?.tier || null,
      defaultChannel: defaultChannel({ gate, phoneStatus: phone?.status }),
      defaults: (({ configId: _c, ...d }) => d)(CLOUD_DEFAULTS),
      rate: rateOf(s), spentTodaySar: campaignCost(st.today || 0, rateOf(s).rateSar), mediaLimits: MEDIA_LIMITS, ceilingKeys: CLOUD_CEILINGS,
      testPhones: wa && typeof wa.testPhones === "function" ? await wa.testPhones().catch(() => []) : [],
      templates: campaignTemplateNames().map((n) => { const sp = campaignSpec(n); const legacy = TEMPLATES[n].campaign;
        return { name: n, label: sp.label, needs: [...(legacy ? legacy.needs || [] : []), ...(sp.header && !(legacy && (legacy.needs || []).includes(sp.header)) ? [sp.header] : []), ...(sp.needsCoupon && !(legacy && (legacy.needs || []).includes("coupon")) ? ["coupon"] : [])],
          status: approved.get(n) || (tpl && tpl.ok ? "NOT_SUBMITTED" : null), body: sp.body, footer: sp.footer, header: sp.header, button: sp.button, buttonText: sp.buttonText,
          fields: sp.fields, auto: sp.auto, held: sp.held === true, kind: sp.kind }; }) };      // CP1: kind = catalog ⇒ خاناته تقبل قيم ملف العميل
  }

  function cloudStats(rows) {
    const cl = rows.filter((x) => x.channel === "wa_cloud" && ["sent", "failed"].includes(x.status) || (x.fallback_from && String(x.fallback_from).startsWith("wa_cloud")));
    if (!cl.length) return null;
    const accepted = cl.filter((x) => x.cloud_status && x.cloud_status !== "failed" || x.status === "sent" && x.channel === "wa_cloud").length;
    const delivered = cl.filter((x) => ["delivered", "read"].includes(x.cloud_status)).length;
    const read = cl.filter((x) => x.cloud_status === "read").length;
    /* QP1: اللي ميتا حدّته (131049) بيتعدّ لوحده — مش «فشل» */
    /* SX2: الفاشل اللي مستني إعادة تلقائية مش «فشل» لسه — بيتعدّ لوحده (retryWaiting) */
    const waiting = (x) => x.status === "failed" && Boolean(x.retry_at);
    const isFail = (x) => (x.cloud_status === "failed" || (x.status === "failed" && x.channel === "wa_cloud")) && !waiting(x);
    const metaCapped = cl.filter((x) => isFail(x) && Number(x.error_code) === META_CAPPED_CODE).length;
    const failed = cl.filter(isFail).length - metaCapped;
    const reasons = {};
    for (const x of cl) if ((x.cloud_status === "failed" || x.status === "failed") && !waiting(x)) { const k = x.reason || "failed"; reasons[k] = (reasons[k] || 0) + 1; }
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    return { attempted: cl.length, accepted, delivered, read, failed, metaCapped, reasons, retryWaiting: cl.filter(waiting).length,
      reasonsAr: Object.fromEntries(Object.keys(reasons).map((k) => [k, reasonText(k)])),
      deliveredRate: pct(delivered, cl.length), readRate: pct(read, delivered),
      fellBack: cl.filter((x) => x.fallback_from).length };
  }

  /* عدّادات الحملة (على قناة Cloud): اتبعت / فشل / «إيقاف» */
  /* QP1: failed من غير اللي ميتا حدّته (131049 ⇒ capped)؛ ووصلت/اتقرت/أول إرسال من بعد آخر «كمّل» من المالك (ackAt) لفرملة القراءة */
  async function jobCounts(jobId, ackAt = null) {
    const r = (await pool.query(
      `SELECT count(*) FILTER (WHERE status='sent' AND COALESCE(cloud_status,'') <> 'failed')::int AS sent,
              count(*) FILTER (WHERE (status='failed' OR cloud_status='failed') AND COALESCE(error_code,0) <> ${META_CAPPED_CODE} AND retry_at IS NULL)::int AS failed,
              count(*) FILTER (WHERE (status='failed' OR cloud_status='failed') AND error_code = ${META_CAPPED_CODE})::int AS capped,
              count(*) FILTER (WHERE optout_at IS NOT NULL)::int AS stopped,
              count(*) FILTER (WHERE cloud_status IN ('delivered','read') AND ($2::timestamptz IS NULL OR sent_at > $2))::int AS delivered,
              count(*) FILTER (WHERE cloud_status = 'read' AND ($2::timestamptz IS NULL OR sent_at > $2))::int AS read_n,
              min(sent_at) FILTER (WHERE status='sent' AND ($2::timestamptz IS NULL OR sent_at > $2)) AS first_sent,
              -- SX2 (ج): نافذة الفرامل = المحاولات من بعد آخر «كمّل» (نفس brakeWindow في wacloud.js)
              count(*) FILTER (WHERE status='sent' AND COALESCE(cloud_status,'') <> 'failed'
                                 AND ($2::timestamptz IS NULL OR COALESCE(tried_at, claimed_at) > $2))::int AS b_sent,
              count(*) FILTER (WHERE (status='failed' OR cloud_status='failed') AND COALESCE(error_code,0) <> ${META_CAPPED_CODE} AND retry_at IS NULL
                                 AND ($2::timestamptz IS NULL OR COALESCE(tried_at, claimed_at) > $2))::int AS b_failed,
              count(*) FILTER (WHERE optout_at IS NOT NULL AND ($2::timestamptz IS NULL OR COALESCE(tried_at, claimed_at) > $2))::int AS b_stopped
         FROM wa_send_queue WHERE job_id=$1 AND (channel='wa_cloud' OR fallback_from LIKE 'wa_cloud%')`, [jobId, ackAt || null])).rows[0] || {};
    const sent = r.sent || 0, failed = r.failed || 0, stopped = r.stopped || 0;
    const num = (v, d) => (v === undefined || v === null ? d : Number(v) || 0);
    return { sent, failed, capped: r.capped || 0, stopped, delivered: r.delivered || 0, read: r.read_n || 0, firstSentAt: r.first_sent || null,
      /* الفرامل (نسبة الفشل ونسبة «إيقاف») بتتحسب من النافذة دي بس — «كمّل» بعد فرملة مابتوقّفش الحملة تاني على طول بسبب الفشل القديم.
         sent التراكمي فاضل لسقف صرف الحملة (الفلوس اتصرفت فعلاً). */
      brake: { since: ackAt || null, sent: num(r.b_sent, sent), failed: num(r.b_failed, failed), stopped: num(r.b_stopped, stopped) } };
  }
  const pauseJob = (jobId, reason) => pool.query("UPDATE wa_send_jobs SET status='paused', stop_reason=$2 WHERE id=$1 AND status='running'", [jobId, String(reason).slice(0, 80)]);
  /* الفرامل وسقف صرف الحملة. بترجع سبب الوقوف (والحملة اتوقفت) أو null. */
  async function jobBrake(job, cc, rateSar, flags = null) {
    const n = await jobCounts(job.id, job.brake_ack_at || null);
    const nb = { ...n, ...n.brake };      // SX2 (ج): الفرامل والتحذير من بعد آخر «كمّل» بس
    const b = brakeCheck(nb, cc) || lowReadCheck(n, cc, now());      // QP1: + فرملة القراءة الضعيفة
    if (b) { const why = `${b.reason}:${b.pct}`; await pauseJob(job.id, why); return why; }
    /* QP1: منطقة التحذير (١٪): الحملة تكمّل بنص السرعة، والمالك ياخد تنبيه واحد للحملة */
    const w = brakeWarn(nb, cc);
    if (w && flags) {
      flags.warn = true;
      const first = await pool.query("UPDATE wa_send_jobs SET warn_at=NOW() WHERE id=$1 AND warn_at IS NULL RETURNING id", [job.id]).catch(() => ({ rowCount: 0 }));
      if (first.rowCount) await alertOwner((lang) => warnAlertText(w.pct, lang), `wa-campaign-warn ${job.id}`, { kind: "campaign_warn", jobId: Number(job.id), pct: w.pct, limit: w.limit });
    }
    const rate = Number(job.rate_sar) > 0 ? Number(job.rate_sar) : rateSar;
    if (job.spend_cap_sar != null && rate > 0 && (n.sent + 1) * rate > Number(job.spend_cap_sar) + 1e-9) { await pauseJob(job.id, "campaign_spend_cap"); return "campaign_spend_cap"; }
    return null;
  }

  async function sendCloudRow(q, job, cfg, staff, cc = null) {
    const why = await skipReason(q.phone_norm, cfg, staff, { cloud: true });
    if (why) { await pool.query("UPDATE wa_send_queue SET status='skipped', reason=$2 WHERE id=$1", [q.id, why]); return { skipped: why }; }
    /* FD1: حملة قيمها لكل مستلم (السعر والتوصيل في الرسالة) ⇒ نفس العرض بيتحسب تاني من البيانات الحيّة الحين، ولازم يطلع نفس النص بالحرف.
       اتغيّر (سعر / خلص / اتشال / رسم التوصيل / FIRST) أو العميل طلب من ساعتها أو ماقدرناش نتأكد ⇒ الصف يتخطّى بسببه. مفيش سعر قديم يوصل لعميل. */
    if (job.cloud_vars && job.cloud_vars.perRecipient === true) {
      const fav = favApi();
      let fw = "offer_unverified";
      if (fav && typeof fav.recheck === "function") { try { fw = await fav.recheck(q); } catch (e) { console.error("[wasender] fav recheck:", e.message); fw = "offer_check_failed"; } }
      /* مراجعة FD1 ٣: التوصيل (أو الاستلام لسطر «تستلمه من فرعنا») موقوف من البوابة الحين ⇒ الصف يرجع للطابور والدورة تقف — بيتبعت لما الخدمة ترجع،
         مش «والتوصيل لعنوانك …» وصفحة الدفع رافضة التوصيل */
      if (fw && FAV_HOLD.includes(fw)) { await pool.query("UPDATE wa_send_queue SET status='pending', attempts=GREATEST(attempts-1,0) WHERE id=$1", [q.id]); return { halt: fw }; }
      if (fw) { await pool.query("UPDATE wa_send_queue SET status='skipped', reason=$2 WHERE id=$1", [q.id, String(fw).slice(0, 60)]); return { skipped: fw }; }
    }
    /* CP1: قيم ملف العميل اللي ممكن تتغيّر بعد التجهيز (البوكس اتوقف، FIRST اتستخدم، رصيد الولاء اتحرّك) بتتراجع الحين — اتغيّرت أو
       ماقدرناش نتأكد ⇒ الصف يتخطّى بسببها. صف مافيهوش حاجة متغيّرة (الاسم/الطبق/النوع) بيكمّل من غير استعلام. */
    if (job.cloud_vars && job.cloud_vars.profileVars === true) {
      const u = (q.vars && q.vars.prof) || {};
      const volatile = Boolean(u.box || u.firstHint || u.loy != null);
      const P = profApi();
      let why = null;
      if (volatile) {
        if (P && typeof P.recheckRow === "function") { try { why = await P.recheckRow(q); } catch { why = "profile_unverified"; } }
        else why = "profile_unverified";
      }
      if (why) { await pool.query("UPDATE wa_send_queue SET status='skipped', reason=$2 WHERE id=$1", [q.id, String(why).slice(0, 60)]); return { skipped: why }; }
    }
    let built;
    try { built = campaignParams(job.cloud_template, q, job); }
    catch { await pool.query("UPDATE wa_send_queue SET status='failed', reason='bad_template' WHERE id=$1", [q.id]); return { stop: "bad_template" }; }
    /* SEC (١٢/١٠): كان requireOptIn:false (المستبعد = اللي قال «إيقاف» بس). الحملة = تسويق ⇒ لازم موافقة تسويق صريحة
       (wa_optins.marketing) ومش موقوف — الحارس المركزي بيفرضها مهما كانت فئة القالب (source:"campaign"). */
    const r = await wa.sendTemplate({ phoneNorm: q.phone_norm, template: job.cloud_template, params: built.params,
      requireOptIn: true, source: "campaign", body: built.text });
    if (r.ok) {
      const hdrFmt = TEMPLATES[job.cloud_template]?.components.find((c) => c.type === "HEADER")?.format;
      await markSent(q, { channel: "wa_cloud", wamid: r.wamid, media: hdrFmt === "VIDEO" && job.video_url ? "video" : hdrFmt === "IMAGE" && job.image_url ? "image" : "text" });
      return { sent: true, wamid: r.wamid };
    }
    if (r.skipped) {
      if (r.skipped === "invalid_phone") { await pool.query("UPDATE wa_send_queue SET status='skipped', reason='invalid_number' WHERE id=$1", [q.id]); return { skipped: "invalid_number" }; }
      // ١٢/١٠: متغيّر ناقص في القالب لهذا العميل (مثلاً مافيش «آخر طبق») ⇒ الصف ده يتخطّى بسببه، والباقي يكمل — مانبعتش نص ناقص ومانوقفش الحملة
      if (r.skipped === "missing_param") { await pool.query("UPDATE wa_send_queue SET status='skipped', reason='missing_param' WHERE id=$1", [q.id]); return { skipped: "missing_param" }; }
      // SEC: العميل مش موافق على التسويق / موقوف ⇒ الصف ده يتخطّى بسببه والباقي يكمل (مش قفل قناة)
      if (r.skipped === "no_optin" || r.skipped === "opted_out") { await pool.query("UPDATE wa_send_queue SET status='skipped', reason=$2 WHERE id=$1", [q.id, r.skipped]); return { skipped: r.skipped }; }
      // QP1: العميل وصل سقفه (قالب تسويقي واحد في ٧ أيام / ٣ في ٣٠ يوم — من أي حملة أو أتمتة) ⇒ الصف يتخطّى والباقي يكمل
      if (r.skipped === "marketing_cap_7d" || r.skipped === "marketing_cap_30d") { await pool.query("UPDATE wa_send_queue SET status='skipped', reason=$2 WHERE id=$1", [q.id, r.skipped]); return { skipped: r.skipped }; }
      // البوابة اتقفلت في النص ⇒ يرجع للطابور ونقف الدورة
      await pool.query("UPDATE wa_send_queue SET status='pending', attempts=GREATEST(attempts-1,0) WHERE id=$1", [q.id]);
      return { halt: r.skipped };
    }
    const cls = classifyError(r.code);
    if (cls.retry && (q.attempts || 1) < 3) {
      await pool.query("UPDATE wa_send_queue SET status='pending', reason=$2, error_code=$3 WHERE id=$1", [q.id, cls.reason, cls.code]);
      return { halt: cls.reason };
    }
    /* SX2 (ب): غلطة مؤقتة من ميتا وقت الإرسال (ميتا رفضت بكود ⇒ الرسالة ماتبعتتش أكيد) ⇒ إعادة واحدة بعد retryDelayMin */
    if (cc && retryDecision({ cls, row: q, cc, jobStatus: job.status }).retry) {
      const at = await scheduleRetry(q, job, cls, cc, { sync: true });
      return { failed: cls.reason, retryAt: at };
    }
    await cloudFailed(q, job, cls, { sync: true });
    if (cls.transient) suspectMedia(job, q.job_id);
    if (cls.media && q.retried_at) await mediaPause(job, ["media_error", "ميتا لسه مش قادرة تنزّل الصورة/الفيديو حتى بعد الإعادة"]);
    if (cls.stop) {
      await pool.query("UPDATE wa_sender_state SET stopped_reason=$1, fail_streak=fail_streak+1 WHERE id=2", [cls.reason]);
      return { stop: cls.reason };
    }
    return { failed: cls.reason };
  }

  /* فشل رسالة Cloud (من الإرسال نفسه أو من الويب هوك بعدين). مابتتحسبش
     «اتكلّم» (إلا لو الـSMS البديل اتبعت)، والكوبون بيتقفل تاني لو ماتستخدمش. */
  async function cloudFailed(q, job, cls, { sync = false } = {}) {
    await pool.query(
      "UPDATE wa_send_queue SET status='failed', reason=$2, error_code=$3, cloud_status='failed' WHERE id=$1",
      [q.id, cls.reason, cls.code]);
    if (!sync) {
      await pool.query("DELETE FROM wa_contact_log WHERE phone_norm=$1 AND job_id=$2 AND by='cloud'", [q.phone_norm, q.job_id]);
      if (q.coupon) {
        await pool.query("UPDATE shop_coupons SET active=false WHERE code=$1 AND phone_norm=$2 AND used_count=0", [q.coupon, q.phone_norm]).catch(() => {});
      }
    }
    if (cls.invalid) {
      await pool.query(
        `INSERT INTO wa_invalid_numbers(phone_norm, job_id) VALUES ($1,$2)
         ON CONFLICT (phone_norm) DO UPDATE SET hits = wa_invalid_numbers.hits + 1, at = NOW(), job_id = EXCLUDED.job_id`,
        [q.phone_norm, q.job_id]);
    }
    if (cls.optout) await optOut(q.phone_norm, "whatsapp_meta", "وقّف رسايل التسويق من واتساب نفسه (131050)", "ميتا");
    /* QP1: 131049 (ميتا حدّت تسويق العميل ده) من غير SMS بديل إلا لو المالك فعّل waCloud.cappedFallbackSms */
    const fb = fallbackFor(cls, job.fallback, { cappedSms: cls.capped ? cloudCfg(await getSettingsData().catch(() => ({}))).cappedFallbackSms : false });
    if (fb === "wa_web") {
      await pool.query(
        `UPDATE wa_send_queue SET status='pending', channel='wa_web', reason=NULL, fallback_from=$2, claimed_at=NULL
          WHERE id=$1 AND status='failed'`, [q.id, `wa_cloud:${cls.reason}`]);
      return "wa_web";
    }
    if (fb === "sms") {
      const cms = cmsApi();
      if (!cms || typeof cms.waFallbackSms !== "function") return null;
      const r = await cms.waFallbackSms({ phoneNorm: q.phone_norm, text: stripFooter(q.message || "", [DEFAULTS.footer, senderCfg(await getSettingsData().catch(() => ({}))).footer]), ref: `wa${q.job_id}:${q.id}` }).catch((e) => ({ ok: false, error: e.message }));
      await pool.query("UPDATE wa_send_queue SET note=$2, fallback_from=$3 WHERE id=$1",
        [q.id, r.ok ? "sms_fallback" : `sms_fallback_failed:${String(r.skipped || r.error || "").slice(0, 40)}`, `wa_cloud:${cls.reason}`]);
      if (r.ok) await pool.query("INSERT INTO wa_contact_log(phone_norm, channel, job_id, by) VALUES ($1,'auto',$2,'sms_fallback')", [q.phone_norm, q.job_id]);
      return r.ok ? "sms" : null;
    }
    return null;
  }
  // نص الـSMS البديل = نفس رسالة الحملة من غير سطر إيقاف الواتساب (الـSMS ليه سطر إيقافه)
  const stripFooter = (m, footers = [DEFAULTS.footer]) => {
    let t = String(m || "").trimEnd();
    for (const f of footers) if (f && t.endsWith(f)) t = t.slice(0, -f.length).trimEnd();
    return t;
  };

  /* ══ SX2 (١٥/١٠ — ب): إعادة تلقائية مرة واحدة للفشل المؤقت ═══════════════════════════════════════════════
     الصف بيفضل «فشل» وعليه retry_at: اللوحة بتعدّه «مستني إعادة» (مش فشل)، والفرامل مابتحسبوش لحد ما الإعادة تفشل هي كمان.
     في الميعاد الدورة بتاخده قبل الصفوف الجديدة، وبتتأكد: (١) الرسالة الأولى ماوصلتش فعلاً (حالة الـwamid الأول في wa_messages —
     وصلت ⇒ مفيش إعادة والصف يرجع «اتبعتت»)، (٢) وسيط الحملة بيفتح من السيرفر، وبعدين بتبعته — مرة واحدة بس (retried_at).
     إعادة ماتبعتتش خلال retryMaxHours من ميعادها (ساعات الإرسال خلصت / القناة اتقفلت) بتتلغي: رسالة حملة مابتوصلش اليوم اللي بعده. */
  const mediaSuspect = new Set();     // حملات بصورة/فيديو جالها فشل مؤقت ⇒ قبل رسالتها الجاية: فحص الوسيط
  const mediaHold = new Map();        // jobId ⇒ أول مرة الفحص فشل (لو فضل فاشل retryDelayMin ⇒ الحملة تقف)
  async function scheduleRetry(q, job, cls, cc, { sync = false } = {}) {
    const at = new Date(now() + cc.retryDelayMin * 60000).toISOString();
    await pool.query("UPDATE wa_send_queue SET status='failed', reason=$2, error_code=$3, cloud_status='failed', retry_at=$4::timestamptz WHERE id=$1",
      [q.id, cls.reason, cls.code, at]);
    if (!sync) {      // فشل جه من الويب هوك بعد ما اتعلّمت «اتبعتت»: سجل التواصل والكوبون يرجعوا لحد ما الإعادة تنجح
      await pool.query("DELETE FROM wa_contact_log WHERE phone_norm=$1 AND job_id=$2 AND by='cloud'", [q.phone_norm, q.job_id]);
      if (q.coupon) await pool.query("UPDATE shop_coupons SET active=false WHERE code=$1 AND phone_norm=$2 AND used_count=0", [q.coupon, q.phone_norm]).catch(() => {});
      /* الحملة ممكن تكون اتعلّمت «خلصت» قبل ما الفشل يوصل ⇒ ترجع «شغّالة» لحد ما الإعادة تخلص (الإلغاء بس هو اللي بيمنع) */
      await pool.query("UPDATE wa_send_jobs SET status='running', finished_at=NULL WHERE id=$1 AND status='done'", [q.job_id]).catch(() => {});
    }
    suspectMedia(job, q.job_id);
    return at;
  }
  function suspectMedia(job, jobId) {
    const spec = campaignSpec(job && job.cloud_template);
    if (spec && spec.header) mediaSuspect.add(Number(jobId || (job && job.id)));
  }
  /* الرسالة وصلت فعلاً بعد ما اتسجّل فشلها (ميتا بعتت «وصلت» بعد «فشلت»، أو الـwamid الأول طلع واصل وقت الإعادة) ⇒ «اتبعتت» من غير إعادة */
  async function restoreDelivered(q, cs, wamid = null, { undoRetry = false } = {}) {
    const r = await pool.query(
      `UPDATE wa_send_queue SET status='sent', channel='wa_cloud', reason=NULL, error_code=NULL, retry_at=NULL, claimed_at=NULL,
              retried_at = CASE WHEN $4::boolean THEN NULL ELSE retried_at END,
              cloud_status=$2, wamid=COALESCE($3, wamid), note = CASE WHEN note LIKE 'sms_fallback%' THEN note ELSE 'delivered_after_failure' END
        WHERE id=$1 AND status IN ('failed','sending','pending') RETURNING id`, [q.id, cs, wamid, undoRetry]);
    if (!r.rowCount) return false;
    await pool.query("INSERT INTO wa_contact_log(phone_norm, channel, job_id, by) VALUES ($1,'auto',$2,'cloud')", [q.phone_norm, q.job_id]);
    await activateCoupon(q);
    return true;
  }
  /* صف إعادة اتاخد بس مانفعش يتبعت دلوقتي (الوسيط مابيفتحش / ماقدرناش نتأكد) ⇒ يرجع «فشل — مستني إعادة» من غير ما الإعادة تتحسب */
  async function unclaimRetry(q, retryAt) {
    await pool.query(
      `UPDATE wa_send_queue SET status='failed', cloud_status='failed', retried_at=NULL, retry_at=$2::timestamptz, error_code=COALESCE(first_error_code, error_code),
              reason=$3, attempts=GREATEST(attempts-1,0) WHERE id=$1`,
      [q.id, retryAt, classifyError(q.first_error_code).reason]);
  }
  /* الحملة تقف بسبب وسيطها (مش هتتصلّح لوحدها): مرة واحدة + تنبيه للمالك */
  async function mediaPause(job, mp) {
    const id = Number(job && job.id);
    if (!id) return false;
    mediaHold.delete(id); mediaSuspect.delete(id);
    const r = await pauseJob(id, `media:${mp[0]}`).catch(() => ({ rowCount: 0 }));
    if (r && r.rowCount) await alertOwner((lang) => startAlertText("media_pause", { name: job.name || `#${id}`, detail: mp[1] }, lang), `wa-campaign-media ${id}`, { kind: "campaign_media", jobId: id, error: mp[0] });
    return Boolean(r && r.rowCount);
  }
  /* قبل رسالة لحملة وسيطها اتشك فيه (أو قبل أي إعادة): الوسيط بيفتح؟ null = ابعت. فاشل ⇒ مانبعتش؛ ولو فضل فاشل retryDelayMin ⇒ الحملة تقف */
  async function mediaGate(job, cc) {
    const id = Number(job.id);
    const mp = await jobMediaErr(job, { cacheMs: 60_000, cacheFail: true });
    if (!mp) { mediaHold.delete(id); mediaSuspect.delete(id); return null; }
    mediaSuspect.add(id);      // لحد ما يفتح: ولا رسالة جديدة للحملة دي كمان
    if (!mediaHold.has(id)) mediaHold.set(id, now());
    if (now() - mediaHold.get(id) >= cc.retryDelayMin * 60000) await mediaPause(job, mp);
    return mp;
  }
  /* الإعادة اللي جه ميعادها (الأقدم الأول) — نفس شروط الصف العادي: الحملة شغّالة، والقناة Cloud */
  async function claimRetry(cc) {
    return (await pool.query(
      `UPDATE wa_send_queue AS r SET status='sending', claimed_at=NOW(), attempts=r.attempts+1, retry_at=NULL, retried_at=NOW(), tried_at=NOW(),
              first_error_code=COALESCE(r.first_error_code, r.error_code), first_wamid=COALESCE(r.first_wamid, r.wamid),
              cloud_status=NULL, error_code=NULL, reason=NULL
        WHERE r.id = (SELECT q.id FROM wa_send_queue q JOIN wa_send_jobs j ON j.id=q.job_id
                       WHERE q.status='failed' AND q.retry_at IS NOT NULL AND q.retried_at IS NULL
                         AND q.retry_at <= $1::timestamptz AND q.retry_at > $1::timestamptz - make_interval(hours => $2::int)
                         AND j.status='running' AND COALESCE(q.channel, j.channel, 'wa_web') = 'wa_cloud'
                       ORDER BY q.retry_at, q.id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING r.id, r.job_id, r.phone_norm, r.message, r.name, r.vars, r.link_code, r.coupon, r.attempts, r.retried_at, r.first_wamid, r.first_error_code`,
      [new Date(now()).toISOString(), cc.retryMaxHours])).rows[0] || null;
  }
  /* إعادات فات ميعادها بأكتر من retryMaxHours (القناة مقفولة / بره ساعات الإرسال) ⇒ تتلغي: الصف يفضل «فشل» بسببه الأصلي */
  async function expireRetries(cc) {
    /* المالك قفل الإعادة التلقائية ⇒ اللي كان مستني إعادة مابيتعادش (بيفضل «فشل» بسببه) */
    if (!cc.retryTransient) {
      const off = await pool.query("UPDATE wa_send_queue SET retry_at=NULL, note='retry_off' WHERE status='failed' AND retry_at IS NOT NULL AND retried_at IS NULL RETURNING id");
      return off.rowCount || 0;
    }
    const r = await pool.query(
      `UPDATE wa_send_queue SET retry_at=NULL, note='retry_expired' WHERE status='failed' AND retry_at IS NOT NULL AND retried_at IS NULL
          AND retry_at <= $1::timestamptz - make_interval(hours => $2::int) RETURNING id`, [new Date(now()).toISOString(), cc.retryMaxHours]);
    return r.rowCount || 0;
  }
  /* الرسالة الأولى وصلت؟ (حالة الـwamid الأول في wa_messages — الويب هوك بيحدّثها حتى لو «وصلت» جت بعد «فشلت»).
     بترجع الحالة لو وصلت/اتقرت، null لو لأ، أو «unknown» لو ماقدرناش نقرا (⇒ مانعيدش دلوقتي). */
  async function firstDelivered(q) {
    if (!q.first_wamid) return null;
    try {
      const m = (await pool.query("SELECT status FROM wa_messages WHERE wamid=$1 LIMIT 1", [q.first_wamid])).rows[0];
      return m && ["delivered", "read"].includes(String(m.status)) ? String(m.status) : null;
    } catch { return "unknown"; }
  }
  /* صف علق في «بيتبعت» أكتر من ١٠ دقايق (ريستارت في نص الإرسال) بس ميتا كانت قبلت رسالته (wa_messages فيها قالب الحملة لنفس الرقم
     من وقت ما الصف اتاخد) ⇒ اتبعتت فعلاً: «اتبعتت» بدل ما يرجع للطابور ويتبعت تاني. */
  async function recoverStuck() {
    const r = await pool.query(
      `WITH s AS (
         SELECT q.id, m.wamid, m.status AS mstatus, m.created_at
           FROM wa_send_queue q JOIN wa_send_jobs j ON j.id = q.job_id
           JOIN LATERAL (SELECT wamid, status, created_at FROM wa_messages m
                          WHERE m.phone_norm = q.phone_norm AND m.direction = 'out' AND m.source = 'campaign' AND m.template = j.cloud_template
                            AND m.wamid IS NOT NULL AND m.created_at >= q.claimed_at - INTERVAL '1 minute' AND COALESCE(m.status,'') NOT IN ('failed','skipped')
                          ORDER BY m.created_at LIMIT 1) m ON true
          WHERE q.status = 'sending' AND q.channel = 'wa_cloud' AND q.claimed_at < NOW() - INTERVAL '10 minutes')
       UPDATE wa_send_queue q SET status='sent', sent_at=COALESCE(q.sent_at, s.created_at), wamid=s.wamid, reason=NULL, note='recovered_after_restart',
              cloud_status = CASE WHEN s.mstatus IN ('sent','delivered','read') THEN s.mstatus ELSE 'accepted' END
         FROM s WHERE q.id = s.id RETURNING q.id, q.phone_norm, q.job_id, q.coupon`);
    for (const x of r.rows || []) {
      await pool.query("INSERT INTO wa_contact_log(phone_norm, channel, job_id, by) VALUES ($1,'auto',$2,'cloud')", [x.phone_norm, x.job_id]);
      await activateCoupon(x);
    }
    return r.rowCount || 0;
  }

  /* ══ SX2 (١٥/١٠ — أ): البدء المجدول — السيرفر نفسه بيبدأ الحملة في ميعادها ═══════════════════════════════════════
     حادثة ١٥/١٠: مواعيد البدء/التكملة كانت بتتعمل من cron بره (جلسة المشغّل) ومااشتغلش ⇒ الموجة طلعت متأخرة ساعة.
     حملة موقوفة عليها start_at ⇒ أول دورة بعد الميعاد بتشغّلها. الشرط «start_at <= دلوقتي» (مش «= الدقيقة دي») فالريستارت مابيفوّتهاش،
     وبتتنادى أول ما السيرفر يقوم. فات الميعاد بأكتر من startLateMaxMin (السيرفر كان واقف) ⇒ مابتبدأش لوحدها: موقوفة بسبب واضح + تنبيه.
     حملة Cloud بصورة/فيديو: الوسيط بيتفحص من السيرفر لحظتها — مابيفتحش ⇒ مفيش بدء وسبب بالعربي + تنبيه. التحديث مشروط
     (status='paused' AND start_at <= دلوقتي) فكونتينرين وقت النشر مابيبدأوهاش مرتين ولا بيبعتوا التنبيه مرتين. */
  let scheduling = false;
  async function startDueJobs() {
    if (scheduling) return { busy: true };
    scheduling = true;
    const out = { started: [], refused: [], late: [] };
    try {
      await schemaReady;
      const T = new Date(now()).toISOString();
      const due = (await pool.query(
        `SELECT id, name, channel, cloud_template, image_url, video_url, start_at FROM wa_send_jobs
          WHERE status='paused' AND start_at IS NOT NULL AND start_at <= $1::timestamptz ORDER BY start_at, id LIMIT 50`, [T])).rows || [];
      if (!due.length) return out;
      const cc = cloudCfg(await getSettingsData().catch(() => ({})));
      const refuse = (j, why, stop) => pool.query(
        `UPDATE wa_send_jobs SET start_at=NULL, start_error=$3, stop_reason=$4 WHERE id=$1 AND status='paused' AND start_at IS NOT NULL AND start_at <= $2::timestamptz RETURNING id`,
        [j.id, T, String(why).slice(0, 300), String(stop).slice(0, 80)]);
      for (const j of due) {
        const id = Number(j.id), name = j.name || `#${id}`;
        const lateMin = Math.floor((now() - new Date(j.start_at).getTime()) / 60000);
        if (lateMin > cc.startLateMaxMin) {
          const r = await refuse(j, `فات ميعاد البدء بـ${lateMin} دقيقة (السيرفر كان واقف) — مابدأتش لوحدها`, `start_late:${lateMin}`);
          if (r.rowCount) { out.late.push(id); await alertOwner((lang) => startAlertText("late", { name, lateMin }, lang), `wa-campaign-late ${id}`, { kind: "campaign_start_late", jobId: id, lateMin }); }
          continue;
        }
        const mp = j.channel === "wa_cloud" ? await jobMediaErr(j, { cacheMs: 30_000 }) : null;
        if (mp) {
          const r = await refuse(j, `مابدأتش: ${mp[1]}`, `preflight:${mp[0]}`);
          if (r.rowCount) { out.refused.push({ id, error: mp[0] }); await alertOwner((lang) => startAlertText("refused", { name, detail: mp[1] }, lang), `wa-campaign-preflight ${id}`, { kind: "campaign_preflight", jobId: id, error: mp[0] }); }
          continue;
        }
        const r = await pool.query(
          `UPDATE wa_send_jobs SET status='running', started_at=COALESCE(started_at, NOW()), start_at=NULL, start_error=NULL, stop_reason=NULL, brake_ack_at=NOW()
            WHERE id=$1 AND status='paused' AND start_at IS NOT NULL AND start_at <= $2::timestamptz RETURNING id`, [id, T]);
        if (r.rowCount) out.started.push(id);
      }
      return out;
    } catch (e) {
      console.error("[wasender] scheduled start:", e.message);
      return { ...out, error: e.message };
    } finally { scheduling = false; }
  }

  /* ══ QP1: حماية الجودة ══════════════════════════════════════════════════════════════════════════════
     تنبيه المالك: SMS واحد لأرقام تنبيهات الإدارة (delivery.alertPhones — نفس قايمة التنبيهات الحرجة) + حدث «wa_quality»
     للبورتال/اللوحة. من غير أرقام عملاء. عمره ما بيرمي. */
  async function alertOwner(textOf, tag, event) {
    let sms = 0;
    try {
      const sc = staffConfig(await getSettingsData());
      if (typeof deps.sendSms === "function") {
        for (const p of sc.alertPhones) {
          try { const r = await deps.sendSms({ phoneNorm: p, body: fitOneSms(textOf(sc.lang)), kind: "staff", ref: tag }); if (!(r && r.suppressed)) sms++; }
          catch (e) { console.error(`[wasender] ${tag}: alert sms failed:`, e.message); }
        }
      }
    } catch (e) { console.error(`[wasender] ${tag}: alert:`, e.message); }
    try { if (typeof deps.broadcast === "function") deps.broadcast("wa_quality", { ...event, at: new Date(now()).toISOString() }); } catch { /* الحدث مايوقّفش حاجة */ }
    return sms;
  }
  let lastQuality = null;                 // آخر حكم للبوابة — للعرض في اللوحة (cloudInfo)
  const saveQuality = (q) => pool.query("UPDATE wa_sender_state SET quality=$1::jsonb WHERE id=2", [J(q)]);
  /* أحداث الجودة/الحساب من الويب هوك (whatsapp.js ⇒ on("quality")) بتتخزّن؛ الدورة الجاية هي اللي بتوقّف. */
  async function onQualityEvent(ev) {
    const row = qualityEventRow(ev);
    if (!row) return;
    await schemaReady;
    await pool.query("INSERT INTO wa_quality_events(kind, event, state, name, language, tier) VALUES ($1,$2,$3,$4,$5,$6)",
      [row.kind, row.event, row.state, row.name, row.language, row.tier]);
  }
  /* البوابة: بتتنادى كل دورة فيها حملة Cloud شغّالة، قبل أي إرسال.
     ok ⇒ نكمّل · hold ⇒ ماقدرناش نقرا الجودة: مفيش تسويق الدورة دي (من غير إيقاف دائم) · stop ⇒ كل حملات Cloud تقف،
     stopped_reason = quality_<الحالة>، وتنبيه واحد للمالك. الرجوع من مسار المالك بس (تشغيل القناة + تكملة الحملة). */
  async function qualityGate(cc, st, running) {
    const qs = st.quality && typeof st.quality === "object" ? st.quality : {};
    const fin = (v) => { lastQuality = { ...v, at: new Date(now()).toISOString() }; return v; };
    let events = [];
    try {
      events = (await pool.query(
        `SELECT id, kind, event, state, name, language, tier FROM wa_quality_events
          WHERE id > $1 AND at > NOW() - INTERVAL '7 days' ORDER BY id LIMIT 500`, [Number(qs.lastEventId) || 0])).rows || [];
    } catch (e) { return fin({ ok: false, hold: true, reason: "quality_unreadable", detail: "events_not_read" }); }
    const cl = cloudApi();
    if (!cl || typeof cl.phoneInfo !== "function") return fin({ ok: false, hold: true, reason: "quality_unreadable", detail: "no_reader" });
    const maxAgeMs = cc.qualityMaxAgeMin * 60_000;
    /* بعد إيقاف جودة والمالك رجّع القناة: قراءة جديدة من ميتا مش من الكاش */
    const afterResume = Boolean(qs.lastStop && !qs.lastStop.resumedAt);
    let phone = null, tpl = null;
    try {
      phone = await cl.phoneInfo(afterResume ? { fresh: true } : {});
      if (phone && phone.ok && !(now() - Date.parse(phone.checkedAt || 0) <= maxAgeMs)) phone = await cl.phoneInfo({ fresh: true });
      tpl = typeof cl.templateInfo === "function" ? await cl.templateInfo(afterResume ? { fresh: true } : {}) : null;
    } catch (e) { return fin({ ok: false, hold: true, reason: "quality_unreadable", detail: String(e.message || e).slice(0, 60) }); }
    const names = [...new Set(running.map((j) => j.cloud_template).filter(Boolean))];
    const tplQuality = Boolean(tpl && tpl.ok && tpl.qualityRead !== false);      // حالات القوالب اتقرت بس جودتها لأ ⇒ برضه «مش مقروءة»
    const v = qualityVerdict({ phone, prev: { tier: qs.tier || null, portfolio: qs.portfolio || null }, events, running: names,
      templates: (tpl && tpl.list) || [], tplOk: tplQuality, allowUnknown: cc.allowUnknownQuality, maxAgeMs, now: now() });
    if (v.hold && v.detail === "templates_not_read" && tpl && tpl.ok) v.detail = "template_quality_not_read";
    const lastEventId = events.length ? Number(events[events.length - 1].id) : Number(qs.lastEventId) || 0;
    const seen = phone && phone.ok ? { tier: phone.tier || qs.tier || null, portfolio: (phone.portfolio && phone.portfolio.ok && phone.portfolio.limit) || qs.portfolio || null } : { tier: qs.tier || null, portfolio: qs.portfolio || null };
    if (v.ok) {
      const next = { ...qs, ...seen, quality: v.state, lastEventId, at: new Date(now()).toISOString(), ...(afterResume ? { lastStop: { ...qs.lastStop, resumedAt: new Date(now()).toISOString() } } : {}) };
      if (next.tier !== qs.tier || next.portfolio !== qs.portfolio || next.lastEventId !== qs.lastEventId || next.quality !== qs.quality || afterResume) await saveQuality(next);
      return fin(v);
    }
    if (v.hold) return fin(v);
    /* إيقاف: القناة + كل الحملات الشغّالة. الحد الجديد بيتسجّل (عشان النزول مايتحسبش تاني بعد ما المالك يرجّع)، والأحداث بتتعلّم «اتعالجت». */
    const first = (await pool.query("UPDATE wa_sender_state SET stopped_reason=$1 WHERE id=2 AND stopped_reason IS NULL RETURNING id", [v.reason])).rowCount > 0;
    const paused = (await pool.query("UPDATE wa_send_jobs SET status='paused', stop_reason=$1 WHERE status='running' AND channel='wa_cloud' RETURNING id", [v.reason])).rowCount || 0;
    await saveQuality({ ...qs, ...seen, quality: phone && phone.ok ? String(phone.quality || "").toUpperCase() || null : qs.quality || null, lastEventId,
      at: new Date(now()).toISOString(), lastStop: { reason: v.reason, detail: v.detail || null, at: new Date(now()).toISOString(), paused } });
    if (first) await alertOwner((lang) => qualityAlertText(v.reason, v.detail, lang), `wa-quality ${v.reason}`, { kind: "quality_stop", reason: v.reason, detail: v.detail || null, paused });
    return fin({ ...v, paused });
  }
  /* رسايل الدرجة الحالية من سلّم التسخين (من يوم since بتوقيت الرياض): اتبعت / «إيقاف» */
  async function stepStats(since) {
    const r = (await pool.query(
      `SELECT count(*)::int AS sent, count(*) FILTER (WHERE optout_at IS NOT NULL)::int AS stopped FROM wa_send_queue
        WHERE channel='wa_cloud' AND status='sent' AND sent_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Riyadh')`, [since])).rows[0] || {};
    return { sent: r.sent || 0, stopped: r.stopped || 0 };
  }
  const saveWarmup = (w) => pool.query("UPDATE wa_sender_state SET warmup=$1::jsonb WHERE id=2", [J(w)]);

  /* RF1 (١٤/١٠): صف الطابور بيتحدّث من الويب هوك بالـwamid — بس الـwamid بيتكتب على الصف **بعد** ما الإرسال يرجع، فحالة توصل في اللحظة دي
     بتتسجّل في wa_messages وماتلاقيش صف الطابور. التسوية دي بتنقل الحالة الأحدث (وصلت / اتقرت) من wa_messages لصف الطابور بنفس الـwamid،
     للأمام بس (عمرها ما بترجّع حالة)، وبتملا delivered_at / read_at الناقصين. بتشتغل كل ١٠ دقايق مع الدورة، ومتاحة كدالة للتسوية اليدوية. */
  async function reconcileStatuses({ days = 7 } = {}) {
    const r = await pool.query(
      `UPDATE wa_send_queue q
          SET cloud_status = m.status,
              delivered_at = COALESCE(q.delivered_at, m.updated_at),
              read_at = CASE WHEN m.status = 'read' THEN COALESCE(q.read_at, m.updated_at) ELSE q.read_at END
         FROM wa_messages m
        WHERE m.wamid = q.wamid AND q.wamid IS NOT NULL AND q.channel = 'wa_cloud' AND q.status = 'sent'
          AND q.sent_at > NOW() - make_interval(days => $1::int)
          AND m.status IN ('delivered','read')
          AND (CASE m.status WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 END)
            > (CASE COALESCE(q.cloud_status,'accepted') WHEN 'accepted' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 9 END)
        RETURNING q.id`, [Math.max(1, Math.min(60, Math.round(Number(days) || 7)))]);
    return r.rowCount || 0;
  }
  let lastReconcile = 0;

  let ticking = false;
  async function cloudTick() {
    if (!wa || ticking) return { reason: "busy_or_no_wa" };
    ticking = true;
    let client = null, locked = false;
    try {
      await schemaReady;
      const s = await getSettingsData();
      const cc = cloudCfg(s);
      if (!cc.enabled) return { reason: "disabled" };
      const g = await wa.gate();
      if (g) return { reason: g };
      if (deps.lock !== false && typeof pool.connect === "function") {
        client = await pool.connect();
        locked = (await client.query("SELECT pg_try_advisory_lock(771001) AS ok")).rows[0]?.ok === true;
        if (!locked) return { reason: "locked" };
      }
      const cfg = senderCfg(s);
      if (now() - lastReconcile > 10 * 60_000) { lastReconcile = now(); await reconcileStatuses().catch((e) => console.error("[wasender] reconcile:", e.message)); }      // RF1
      const st = await stateNow("wa_cloud");
      const { rateSar } = rateOf(s);
      st.rateSar = rateSar;
      const running = (await pool.query("SELECT id, spend_cap_sar, rate_sar, cloud_template, brake_ack_at FROM wa_send_jobs WHERE status='running' AND channel='wa_cloud'")).rows || [];
      /* QP1 — بوابة الجودة قبل أي حاجة تانية (حتى بره ساعات الإرسال: الإيقاف مايستناش). مفيش حملة شغّالة = مفيش حاجة نحميها. */
      let quality = null;
      if (running.length && !st.stoppedReason) {
        quality = await qualityGate(cc, st, running);
        if (!quality.ok) return { reason: quality.reason, detail: quality.detail || null, ...(quality.stop ? { stopped: true, paused: quality.paused || 0 } : { held: true }) };
      }
      /* «إيقاف» بييجي بعد التسليم: نراجع فرامل كل حملة شغّالة قبل ما نبعت أي حاجة في الدورة دي (QP1: + القراءة الضعيفة + التحذير) */
      const flags = { warn: false };
      for (const j of running) await jobBrake(j, cc, rateSar, flags);
      /* QP1 — سلّم التسخين: لو مدة الدرجة خلصت نحاول نطلع درجة (نسبة «إيقاف» الدرجة < الحد + الجودة GREEN)، وسقف النهارده = سقف الدرجة */
      const today = riyadhDay(now());
      let warm = st.warmup;
      if (warm && quality) {
        const adv = warmupAdvance(warm, cc.warmup, { today, stats: await stepStats(warm.since), quality: quality.state });
        if (adv.changed) { warm = adv.state; await saveWarmup(warm); }
      }
      const wv = warmupView(warm, cc.warmup, { today, dailyCap: cc.dailyCap });
      st.warmCap = wv.cap; st.halve = flags.warn;
      const p = cloudPacing(cc, st, inWindow(cfg, now()));
      if (!p.allow) return { reason: p.reason, ...(p.reason === "warmup_cap" ? { warmup: { step: wv.step, cap: wv.cap, refused: wv.refused } } : {}) };
      const staff = staffPhoneSet(s);
      const out = { sent: 0, skipped: 0, failed: 0, ...(flags.warn ? { halved: true } : {}) };
      /* SX2: اللي علق في «بيتبعت» بس ميتا كانت قبلته = اتبعت فعلاً (مفيش إرسال تاني) — قبل ما الباقي يرجع للطابور */
      await recoverStuck().catch((e) => console.error("[wasender] recover stuck:", e.message));
      // «فشلت بسبب مؤقت» ترجع — الصفوف اللي علقت في sending أكتر من ١٠ دقايق
      await pool.query(`UPDATE wa_send_queue SET status='pending' WHERE status='sending' AND channel='wa_cloud' AND claimed_at < NOW() - INTERVAL '10 minutes' AND attempts < 3`);
      await expireRetries(cc).catch((e) => console.error("[wasender] expire retries:", e.message));      // SX2
      const later = () => new Date(now() + cc.retryDelayMin * 60000).toISOString();
      for (let i = 0, budget = p.allow, tries = 0; budget > 0 && tries < p.allow * 4; i++, tries++) {
        /* SX2 (ب): الإعادات اللي جه ميعادها الأول (استنّت retryDelayMin)، وبعدين الصفوف الجديدة */
        let q = cc.retryTransient ? await claimRetry(cc).catch((e) => { console.error("[wasender] claim retry:", e.message); return null; }) : null;
        const isRetry = Boolean(q);
        if (!q) q = (await pool.query(
          `UPDATE wa_send_queue SET status='sending', claimed_at=NOW(), attempts=attempts+1, channel='wa_cloud', tried_at=NOW()
            WHERE id = (SELECT q.id FROM wa_send_queue q JOIN wa_send_jobs j ON j.id=q.job_id
                         WHERE q.status='pending' AND j.status='running'
                           AND COALESCE(q.channel, j.channel, 'wa_web') = 'wa_cloud'
                         ORDER BY j.id, q.score DESC, q.id LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING id, job_id, phone_norm, message, name, vars, link_code, coupon, attempts, retried_at, first_wamid, first_error_code`)).rows[0];
        if (!q) {
          /* SX2: حملة لسه فيها صفوف مستنية إعادة مابتخلصش */
          await pool.query(`UPDATE wa_send_jobs j SET status='done', finished_at=NOW() WHERE status='running' AND channel='wa_cloud'
                             AND NOT EXISTS (SELECT 1 FROM wa_send_queue q WHERE q.job_id=j.id AND (q.status IN ('pending','sending') OR (q.status='failed' AND q.retry_at IS NOT NULL)))`);
          out.reason = "queue_empty";
          break;
        }
        const job = (await pool.query(JOB_SQL, [q.job_id])).rows[0];
        if (isRetry) {
          /* مفيش رسالة مكررة: الأولى طلعت واصلة ⇒ الصف «اتبعتت» من غير إعادة؛ ماقدرناش نتأكد ⇒ تستنى */
          const fd = await firstDelivered(q);
          if (fd === "unknown") { await unclaimRetry(q, later()); out.reason = "retry_unverified"; break; }
          if (fd) { await restoreDelivered(q, fd, q.first_wamid, { undoRetry: true }); out.deliveredLate = (out.deliveredLate || 0) + 1; continue; }
        }
        /* SX2 (ج): قبل الإعادة، أو قبل أي رسالة لحملة وسيطها اتشك فيه (فشل مؤقت): الوسيط لازم يفتح من السيرفر */
        if (isRetry || mediaSuspect.has(Number(q.job_id))) {
          const mp = await mediaGate(job || { id: q.job_id }, cc);
          if (mp) {
            if (isRetry) await unclaimRetry(q, later());
            else await pool.query("UPDATE wa_send_queue SET status='pending', attempts=GREATEST(attempts-1,0) WHERE id=$1", [q.id]);
            out.reason = "media_unreachable"; out.media = mp[0];
            break;
          }
        }
        /* سقف صرف الحملة قبل الإرسال: لو الرسالة دي هتعدّيه، الصف يرجع للطابور والحملة تقف */
        const pre = await jobBrake(job, cc, rateSar);
        if (pre) {
          if (isRetry) await unclaimRetry(q, new Date(now()).toISOString());
          else await pool.query("UPDATE wa_send_queue SET status='pending', attempts=GREATEST(attempts-1,0) WHERE id=$1", [q.id]);
          out.braked = pre; continue;
        }
        const r = await sendCloudRow(q, job, cfg, staff, cc);
        if (r.sent) {
          out.sent++; budget--;
          if (isRetry) out.retried = (out.retried || 0) + 1;
          if (!warm) { warm = warmupStart(today); await saveWarmup(warm); }      // QP1: أول رسالة حملة على Cloud = يوم ١ في السلّم
        }
        else if (r.skipped) {
          out.skipped++;
          if (isRetry) await pool.query("UPDATE wa_send_queue SET retried_at=NULL WHERE id=$1 AND status='skipped'", [q.id]);      // SX2: اتخطّى وقت الإعادة ⇒ ماتعادش فعلاً
        }
        else if (r.failed) { out.failed++; budget--; if (r.retryAt) out.retryLater = (out.retryLater || 0) + 1; }
        if (r.sent || r.failed) { const post = await jobBrake(job, cc, rateSar); if (post) out.braked = post; }
        if (r.halt || r.stop) { out.reason = r.halt || r.stop; if (r.stop) out.stopped = true; break; }
      }
      return out;
    } catch (e) {
      console.error("[wasender] cloud tick:", e.message);
      return { error: e.message };
    } finally {
      if (client) { if (locked) await client.query("SELECT pg_advisory_unlock(771001)").catch(() => {}); client.release(); }
      ticking = false;
    }
  }

  /* حالات رسايل الحملة من الويب هوك (whatsapp.js ⇒ on("status")) */
  async function onCloudStatus(s) {
    if (!s?.wamid) return;
    const q = (await pool.query(
      `SELECT id, job_id, phone_norm, status, cloud_status, channel, coupon, message FROM wa_send_queue WHERE wamid=$1 LIMIT 1`, [s.wamid])).rows[0];
    if (!q) return;
    const next = nextStatus(q.cloud_status, s.status);
    await pool.query(
      `UPDATE wa_send_queue SET cloud_status=$2,
              delivered_at = CASE WHEN $2 IN ('delivered','read') THEN COALESCE(delivered_at, COALESCE($3::timestamptz, NOW())) ELSE delivered_at END,
              read_at = CASE WHEN $2 = 'read' THEN COALESCE(read_at, COALESCE($3::timestamptz, NOW())) ELSE read_at END
        WHERE id=$1`, [q.id, next, s.at || null]);
    /* SX2: «وصلت» بعد ما فشلها اتسجّل ⇒ اتبعتت فعلاً — الإعادة المستنية (أو رجوعها لواتساب ويب) بتتلغي: مفيش رسالة مكررة */
    if (["delivered", "read"].includes(next) && (q.status === "failed" || q.status === "pending")) {
      const x = q.status === "pending" ? ((await pool.query("SELECT fallback_from FROM wa_send_queue WHERE id=$1", [q.id])).rows[0] || {}) : {};
      if (q.status === "failed" || String(x.fallback_from || "").startsWith("wa_cloud")) { await restoreDelivered(q, next); return; }
    }
    if (next === "failed" && q.status === "sent" && q.channel === "wa_cloud") {
      const job = (await pool.query("SELECT id, fallback FROM wa_send_jobs WHERE id=$1", [q.job_id])).rows[0] || {};
      const cls = classifyError(s.code);
      /* SX2 (ب): فشل مؤقت جه من الويب هوك (زي 131000 وميتا بتنزّل صورة الهيدر والسيرفر بيعمل ريستارت) ⇒ إعادة واحدة بعد retryDelayMin */
      if (cls.transient) {
        q.retried_at = ((await pool.query("SELECT retried_at FROM wa_send_queue WHERE id=$1", [q.id])).rows[0] || {}).retried_at || null;
        const full = (await pool.query(JOB_SQL, [q.job_id])).rows[0] || null;
        const cc = cloudCfg(await getSettingsData().catch(() => ({})));
        if (full && retryDecision({ cls, row: q, cc, jobStatus: full.status }).retry) { await scheduleRetry(q, full, cls, cc); return; }
        await cloudFailed(q, job, cls);
        if (full) suspectMedia(full);
        if (full && cls.media && q.retried_at) await mediaPause(full, ["media_error", "ميتا لسه مش قادرة تنزّل الصورة/الفيديو حتى بعد الإعادة"]);
        return;
      }
      await cloudFailed(q, job, cls);
    }
  }

  /* رد العميل على Cloud (whatsapp.js ⇒ on("inbound")): نفس جدول الردود ونفس الإيقاف */
  async function onCloudInbound(m) {
    if (m?.isEcho) return;                 // رسالة الكاشير من الموبايل مش رد عميل
    const pn = m?.phoneNorm;
    if (!pn || !/^5\d{8}$/.test(pn)) return;
    const text = String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 1000);
    const opt = m.intent === "stop" || isOptOutText(text);
    const last = (await pool.query(
      `SELECT id, job_id FROM wa_send_queue WHERE phone_norm=$1 AND status='sent' AND sent_at > NOW() - INTERVAL '30 days'
        ORDER BY sent_at DESC LIMIT 1`, [pn])).rows[0];
    // نفس الرد ممكن يوصل من الإضافة (واتساب ويب) ومن الويب هوك — مرة واحدة بس
    const dup = last && text ? (await pool.query(
      "SELECT 1 FROM wa_replies WHERE phone_norm=$1 AND text=$2 AND at > NOW() - INTERVAL '1 day' LIMIT 1", [pn, text])).rowCount : 0;
    if (last && text && !dup) {
      const ins = await pool.query(
        `INSERT INTO wa_replies(phone_norm, text, ext_id, source, job_id, queue_id, is_optout)
         VALUES ($1,$2,$3,'cloud',$4,$5,$6) ON CONFLICT (phone_norm, ext_id) DO NOTHING RETURNING id`,
        [pn, text, String(m.wamid || "").slice(0, 200) || `h:${sha(text).slice(0, 20)}`, last.job_id, last.id, opt]);
      if (ins.rowCount) await pool.query("UPDATE wa_send_queue SET replied_at = COALESCE(replied_at, NOW()) WHERE id=$1", [last.id]);
    }
    if (opt) await optOut(pn, "wa_cloud", text || "إيقاف", "واتساب");
  }

  if (wa && typeof wa.on === "function") {
    wa.on("status", onCloudStatus);
    wa.on("inbound", onCloudInbound);
    wa.on("quality", (ev) => onQualityEvent(ev));      // QP1
  }
  if (deps.cloudLoop !== false) {
    const sec = Math.max(5, Number(process.env.WA_CLOUD_TICK_SEC) || 15);
    /* SX2 (أ): البدء المجدول قبل دورة الإرسال (فنفس الدورة تبعت أول رسايل الحملة اللي بدأت) — وكمان أول ما السيرفر يقوم، فالريستارت مابيفوّتش ميعاد */
    schemaReady.then(() => startDueJobs()).catch(() => {});
    const t = setInterval(() => { startDueJobs().catch(() => {}).then(() => (wa ? cloudTick() : null)).catch(() => {}); }, sec * 1000);
    t.unref?.();
  }

  /* إرسال تجربة: نفس قالب ومحتوى الحملة اللي في المعاينة، لرقم من أرقام التجربة بس (الحارس بيرفض أي رقم تاني)، ومن غير
     ما يتعمل حملة ولا يتحسب في عدّادها. الرابط في التجربة = رابط الحملة لو اسمه موجود، وإلا الصفحة الرئيسية للمتجر مش هتتفتح
     بالاسم ده — فبنبعت اسم رابط موجود (cms_links) أو بنرفض. للمالك بس. */
  app.post("/api/cms/wa-sender/cloud/test", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return ownerOnly(c);
    if (!wa) return bad(c, "disabled", "واتساب مش متاح", 503);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const input = jobInput({ ...b, channel: "wa_cloud" }, { hosts: imageHosts() });
    const errs = input.errs.filter(([e]) => !["name_required"].includes(e));
    if (errs.length) return bad(c, errs[0][0], errs[0][1], 422);
    const mp = await mediaErr(input); if (mp) return bad(c, mp[0], mp[1], 422);
    const pn = normLocal(b.phone);
    const tests = typeof wa.testPhones === "function" ? await wa.testPhones().catch(() => []) : [];
    if (!pn || !tests.includes(pn)) return bad(c, "not_in_allow_list", "الرقم لازم يكون من أرقام التجربة في اللوحة", 422);
    const spec = campaignSpec(input.cloudTemplate);
    let slug = "";
    if (spec.button === "link") {
      slug = String(b.testLinkSlug || input.link.slug || "").trim().toLowerCase();
      const okSlug = slug && SLUG_RE.test(slug) ? (await pool.query("SELECT 1 FROM cms_links WHERE slug=$1 AND active", [slug])).rowCount : 0;
      if (!okSlug) return bad(c, "test_link_required", "زر القالب بيفتح رابط متتبّع: اختار رابط حملة موجود للتجربة (رابط الحملة نفسها بيتعمل وقت البدء)", 422);
    }
    const coupon = spec.needsCoupon ? String(b.testCoupon || input.link.coupon || "").trim().toUpperCase().slice(0, 40) : "";
    if (spec.needsCoupon && !coupon) return bad(c, "test_coupon_required", "القالب فيه كود: اكتب كود موجود للتجربة", 422);
    /* FD1: حملة «طبقك المفضل» — القيم لكل عميل؛ التجربة بتاخد سطر عميل من المعاينة بالظبط (testValues {title, line}) لرقم تجربة بس */
    let tvars = {};
    if (input.perRecipient) {
      const tv = b.testValues && typeof b.testValues === "object" ? b.testValues : {};
      const title = String(tv.title || "").trim(), line = String(tv.line || "").trim();
      if (!title || !line || lineProblem(title, line)) return bad(c, "test_values_required", "حملة «طبقك المفضل»: ابعت testValues {title, line} من عينة المعاينة (سطر واحد لكل واحد، من غير «:»)", 422);
      tvars = { cloud: { values: { "offer.title": title, "offer.line": line } } };
    }
    /* CP1: حملة بقيم من ملف العميل — التجربة بقيم المثال ({fav_dish} = «كريب زنجر سوبريم» …)، لرقم تجربة بس */
    if (input.profileVars) tvars = { cloud: { values: exampleProfileValues((input.cloudVars && input.cloudVars.values) || {}) } };
    let built;
    try { built = campaignParams(input.cloudTemplate, { name: String(b.testName || "تجربة").slice(0, 30), vars: tvars, link_code: "", coupon },
      { link_slug: slug, image_url: input.imageUrl, video_url: input.videoUrl, cloud_vars: input.cloudVars }); }
    catch { return bad(c, "bad_template", "القالب مش معروف", 422); }
    const r = await wa.sendTemplate({ phoneNorm: pn, template: input.cloudTemplate, params: built.params, source: "campaign", body: built.text, test: true });
    if (r.ok) return c.json({ ok: true, wamid: r.wamid, to: `0${pn}`, template: input.cloudTemplate, text: built.text, by: await whoOf(c) });
    return c.json({ ok: false, error: r.skipped || r.error || "send_failed", gate: r.skipped || null, detail: r.detail || r.message || null }, 409);
  });

  // نشغّل/نوقّف قناة Cloud من شاشة الإرسال الآلي (نفس settings.waCloud)
  app.post("/api/cms/wa-sender/cloud", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    /* SEC (١٢/١٠): المسار ده كان بأي أدمن (دور التسويق يقدر يشغّل قناة Cloud ويرفع السقوف) وهو بيكتب نفس settings.waCloud
       اللي مسار المالك (POST /api/cms/wa-cloud/settings) بيحميه. دلوقتي: غير المالك يقدر **يوقّف** بس. */
    const keys = CLOUD_KEYS.filter((k) => b[k] !== undefined);
    const onlyOff = keys.length === 1 && keys[0] === "enabled" && b.enabled === false;
    if (!onlyOff && !(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "تشغيل القناة وتعديل السقوف للمالك بس" }, 403);
    const s = await getSettingsData();
    const cur = (s.waCloud && typeof s.waCloud === "object") ? s.waCloud : {};
    const next = { ...cur };
    for (const k of CLOUD_KEYS) if (b[k] !== undefined) next[k] = b[k];
    const clean = cloudCfg({ waCloud: next });
    await pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waCloud}', $1::jsonb, true) WHERE id=1`, [J(clean)]);
    if (b.enabled === true) await pool.query("UPDATE wa_sender_state SET stopped_reason=NULL, fail_streak=0 WHERE id=2");
    const { configId, ...pub } = clean;
    return c.json({ ok: true, cfg: pub });
  });

  // ── الإضافة (توكن جهاز، مش جلسة لوحة) ─────────────────────────────────
  async function agentAuth(c) {
    const t = (c.req.header("x-agent-token") || "").trim();
    if (!t) return null;
    const cfg = senderCfg(await getSettingsData());
    if (!cfg.agentHash || sha(t) !== cfg.agentHash) return null;
    return cfg;
  }

  app.post("/api/wa-sender/agent/next", async (c) => {
    const cfg = await agentAuth(c);
    if (!cfg) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {}; try { b = await c.req.json(); } catch {}
    await pool.query("UPDATE wa_sender_state SET last_seen_at=NOW(), agent=$1::jsonb WHERE id=1",
      [J({ version: String(b.version || "").slice(0, 20), waReady: b.waReady === true, ua: String(c.req.header("user-agent") || "").slice(0, 120) })]);
    // رسايل «بتتبعت» من أكتر من ١٠ دقايق = الإضافة وقعت ⇒ ترجع للطابور
    await pool.query(`UPDATE wa_send_queue SET status='pending' WHERE status='sending' AND claimed_at < NOW() - INTERVAL '10 minutes' AND attempts < 2`);
    await pool.query(`UPDATE wa_send_queue SET status='failed', reason='stuck' WHERE status='sending' AND claimed_at < NOW() - INTERVAL '10 minutes'`);
    if (b.waReady === false) return c.json({ ok: true, wait: 60, reason: "wa_not_ready" });
    const st = await stateNow("wa_web");
    const p = pacing(cfg, st, now());
    if (p.reason === "fail_stop") await pool.query("UPDATE wa_sender_state SET stopped_reason='fail_stop' WHERE id=1");
    if (p.wait !== 0) return c.json({ ok: true, wait: p.wait, reason: p.reason });
    const s = await getSettingsData();
    const staff = staffPhoneSet(s);
    // بنجرّب لحد ٥ مرشّحين — اللي يقع في قاعدة الـ٣ أيام أو اتغيّر حاله بيتعلّم skipped
    for (let i = 0; i < 5; i++) {
      const q = (await pool.query(
        `UPDATE wa_send_queue SET status='sending', claimed_at=NOW(), attempts=attempts+1, channel='wa_web'
          WHERE id = (SELECT q.id FROM wa_send_queue q JOIN wa_send_jobs j ON j.id=q.job_id
                       WHERE q.status='pending' AND j.status='running'
                         AND COALESCE(q.channel, j.channel, 'wa_web') = 'wa_web'
                       ORDER BY j.id, q.score DESC, q.id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING id, job_id, phone_norm, message`)).rows[0];
      if (!q) {
        await pool.query(`UPDATE wa_send_jobs j SET status='done', finished_at=NOW() WHERE status='running'
                           AND NOT EXISTS (SELECT 1 FROM wa_send_queue q WHERE q.job_id=j.id AND (q.status IN ('pending','sending') OR (q.status='failed' AND q.retry_at IS NOT NULL)))`);
        return c.json({ ok: true, wait: 300, reason: "queue_empty" });
      }
      const why = await skipReason(q.phone_norm, cfg, staff);
      if (why) { await pool.query("UPDATE wa_send_queue SET status='skipped', reason=$2 WHERE id=$1", [q.id, why]); continue; }
      await pool.query("UPDATE wa_sender_state SET next_gap_sec=$1 WHERE id=1", [p.nextGapSec]);
      const job = (await pool.query("SELECT image_url FROM wa_send_jobs WHERE id=$1", [q.job_id])).rows[0] || {};
      return c.json({ ok: true, wait: 0, item: { id: Number(q.id), phone: `966${q.phone_norm}`, text: q.message,
        ...(job.image_url ? { image: job.image_url } : {}) } });
    }
    return c.json({ ok: true, wait: 30, reason: "skipped_batch" });
  });

  app.post("/api/wa-sender/agent/result", async (c) => {
    const cfg = await agentAuth(c);
    if (!cfg) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const id = Number(b.id);
    const q = (await pool.query("SELECT id, job_id, phone_norm, status, coupon FROM wa_send_queue WHERE id=$1", [id])).rows[0];
    if (!q) return bad(c, "not_found", "مش موجودة", 404);
    if (q.status !== "sending") return c.json({ ok: true, already: true });
    const media = ["image", "text"].includes(b.media) ? b.media : null;
    const note = b.note ? String(b.note).slice(0, 80) : null;
    if (b.ok === true) {
      await markSent(q, { media, note, channel: "wa_web", batchSize: cfg.batchSize });
    } else {
      const reason = String(b.reason || "failed").slice(0, 60);
      // رقم مش على واتساب = مش غلطة الإضافة، مابيعدّش في «فشل ورا بعض» — وبيتحفظ عشان مايدخلش حملة تانية
      const notOnWa = reason === "invalid_number";
      await pool.query("UPDATE wa_send_queue SET status='failed', reason=$2, note=$3 WHERE id=$1", [id, reason, note]);
      if (notOnWa) {
        await pool.query(
          `INSERT INTO wa_invalid_numbers(phone_norm, job_id) VALUES ($1,$2)
           ON CONFLICT (phone_norm) DO UPDATE SET hits = wa_invalid_numbers.hits + 1, at = NOW(), job_id = EXCLUDED.job_id`,
          [q.phone_norm, q.job_id]);
      }
      await pool.query(
        `UPDATE wa_sender_state SET last_sent_at=NOW(), fail_streak = CASE WHEN $1 THEN fail_streak ELSE fail_streak+1 END WHERE id=1`, [notOnWa]);
    }
    return c.json({ ok: true });
  });

  /* ردود العملاء: الإضافة بتقرا الفقاعات الجاية (.message-in) في المحادثة اللي
     لسه باعتين فيها، أو معاينة المحادثات اللي فيها رسايل ماتقرتش. بنقبل بس
     من رقم بعتناله آلي في آخر ٣٠ يوم — محادثات المحل التانية مابتتسجّلش. */
  app.post("/api/wa-sender/agent/reply", async (c) => {
    const cfg = await agentAuth(c);
    if (!cfg) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const pn = normLocal(b.phone);
    const text = String(b.text || "").replace(/\s+/g, " ").trim().slice(0, 1000);
    if (!pn || !text) return bad(c, "bad_input", "رقم أو نص ناقص");
    const last = (await pool.query(
      `SELECT id, job_id, sent_at FROM wa_send_queue WHERE phone_norm=$1 AND status='sent' AND sent_at > NOW() - INTERVAL '30 days'
        ORDER BY sent_at DESC LIMIT 1`, [pn])).rows[0];
    if (!last) return c.json({ ok: true, ignored: "no_recent_send" });
    const ext = String(b.extId || "").slice(0, 200) || `h:${sha(text).slice(0, 20)}`;
    const opt = isOptOutText(text);
    // وصل قبل كده من الويب هوك (Coexistence) ⇒ مانسجّلوش تاني
    const seen = (await pool.query(
      "SELECT 1 FROM wa_replies WHERE phone_norm=$1 AND text=$2 AND at > NOW() - INTERVAL '1 day' LIMIT 1", [pn, text])).rowCount;
    if (seen) return c.json({ ok: true, duplicate: true });
    const ins = await pool.query(
      `INSERT INTO wa_replies(phone_norm, text, ext_id, source, job_id, queue_id, is_optout)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (phone_norm, ext_id) DO NOTHING RETURNING id`,
      [pn, text, ext, b.source === "list" ? "list" : "chat", last.job_id, last.id, opt]);
    if (!ins.rowCount) return c.json({ ok: true, duplicate: true });
    await pool.query("UPDATE wa_send_queue SET replied_at = COALESCE(replied_at, NOW()) WHERE id=$1", [last.id]);
    if (opt) await optOut(pn, "wa_web", text, "واتساب ويب");
    return c.json({ ok: true, optout: opt });
  });

  app.get("/api/cms/wa-sender/replies", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const canSee = typeof ctx.canSeePhones === "function" ? await ctx.canSeePhones(c) : false;
    const r = await pool.query(
      `SELECT w.id, w.phone_norm, w.text, w.source, w.is_optout, w.at, w.job_id, j.name AS job_name
         FROM wa_replies w LEFT JOIN wa_send_jobs j ON j.id = w.job_id ORDER BY w.at DESC LIMIT 100`);
    return c.json({ ok: true, replies: r.rows.map((x) => ({ ...x, id: Number(x.id),
      phone_norm: canSee ? x.phone_norm : `${x.phone_norm.slice(0, 3)}••••${x.phone_norm.slice(-2)}` })) });
  });

  return { reconcileStatuses, recentSet, recentMap, build, cloudTick, onCloudStatus, onCloudInbound, onQualityEvent, stateNow, schemaReady, imageHosts,
    startDueJobs, recoverStuck };
}
