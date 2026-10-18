/* ═══════════════════════════════════════════════════════════════════════════
   WHATSAPP — WhatsApp Business Platform (Cloud API) لفريش كاتس.

   الخطة والقرارات: docs/growth-2026-09/05-whatsapp-api.md (ريبو freshcuts invite).

   🔒 SEC (١٢/١٠) — حارس واحد: **كل** رسالة واتساب لازم تعدّي guardSend() وتاخد منه تذكرة، و deliver(ticket, payload)
   هي المكان الوحيد في الكود كله اللي بينادي ‎/{phone_id}/messages‎ (wa-guard.test.mjs بيعدّ المواضع ويفشل لو زاد موضع).
   الأقفال: مفتاح الخادم (env) **و** مفتاح المالك في اللوحة (settings.waMaster.enabled) **و** الإعداد **و** موافقة العميل
   المناسبة لنوع الرسالة. الاستثناء الوحيد = أرقام التجربة المكتوبة في اللوحة (settings.waBot.testPhones).

   الموديول ده **مقفول افتراضياً**. مفيش رسالة بتطلع إلا لو الأربعة دول مع بعض:
     ١) env ‏WHATSAPP_ENABLED=1                       (المفتاح الرئيسي — Coolify)
     ٢) env ‏WHATSAPP_PHONE_ID + توكن (WHATSAPP_TOKEN أو META_CAPI_TOKEN)
     ٣) settings.notifications.whatsappEnabled === true  (مفتاح اللوحة)
     ٤) العميل موافق (wa_optins) — ولرسايل التسويق: مش مسجّل «إيقاف» في cms_contacts
   أي شرط ناقص = { ok:false, skipped:"<السبب>" } من غير أي طلب شبكة.

   المحتوى:
   - TEMPLATES: سجل القوالب — نص التقديم لميتا (components) + bind() بيبني
     الباراميترات من الطلب. الأسماء ثابتة، ولازم تطابق اللي اتوافق عليه في ميتا.
   - sendTemplate / sendText / sendOrderUpdate: الإرسال + تسجيل في wa_messages.
   - الويب هوك: GET تحقق (hub.challenge)، POST بتوقيع X-Hub-Signature-256
     (WHATSAPP_APP_SECRET). حالات الرسايل بتتحدّث، و«failed» لرسالة طلب
     بيعمل SMS بديل (لو SMS مفعّل). «إيقاف/STOP» بيلغي التسويق.
   - الموافقة: recordOptIn() من الشيك أوت + /api/wa/optin.
   الويب هوك دايماً بيرد 200 (Cloudflare بيبلع الـ5xx وميتا بتعيد المحاولة).

   Coexistence (٢٨/٩): الرقم على تطبيق واتساب بزنس والـAPI مع بعض. الويب هوك
   بقى بيفهم smb_message_echoes (الكاشير بعت من الموبايل ⇒ صادر في نفس
   المحادثة، من غير رد آلي)، smb_app_state_sync (أسماء جهات الاتصال)، history
   (تاريخ المحادثات مرة واحدة — idempotent وبسقف)، و message_template_status_update.
   كله idempotent بالـwamid، والمعالجة بعد الرد 200. مستمعين on("status"/"inbound")
   بيحدّثوا طابور الحملات (wasender.js). الربط نفسه وحالته في wacloud.js.
═══════════════════════════════════════════════════════════════════════════ */

import { courierOf, courierChatUrl } from "./couriercontact.js";      // SB5
import { waPolicyCfg, closedWindowStage } from "./wapolicy.js";      // ١٤/١٠: سياسة النافذة المقفولة
import crypto from "node:crypto";
import { sendSms as defaultSendSms } from "./accounts.js";
import { isOptOutText } from "./wamsg.js";
import { echoKind, echoSettings, ECHO, STAFF_ECHO_SQL } from "./waecho.js";
import * as CAT from "./watemplates.js";
import { staffPhones } from "./staffalerts.js";
import { termsCoverOrder, TERMS_CURRENT, TERMS_VERSIONS, POS_REVIEW_CONSENT, posReviewConsentOn, posReviewConsentCovers, KA2_REVIEW_CONSENT, ka2ReviewConsentOn, ka2ReviewConsentCovers } from "./waconsent.js";
import { custCapOf, custCapReason } from "./waquality.js";
import { waStageOn, FREE_STAGES, freeStageText } from "./waswitches.js";      // RT2 مراجعة: سجل المراحل الحرة الواحد
import { staffRoleOf } from "./wateam.js";
import { journeyCfg, holdUntil, orderCapDecision, ORDER_SENT_SQL, CAP_EXEMPT_SOURCES } from "./wajourney.js";      // CJ1a (١٧/١٠): مفيش رسايل ورا بعض + سقف رسايل الطلب

const env = (k, d) => (process.env[k] || d || "").toString().trim();
export const GRAPH_VERSION = "v23.0";
const STORE = () => env("STOREFRONT_PUBLIC_URL", "https://freshcuts.sa").replace(/\/+$/, "");

/* ── سجل القوالب ─────────────────────────────────────────────────────────────
   category: UTILITY | MARKETING | AUTHENTICATION (زي ميتا بالظبط).
   components: جسم التقديم لـ POST /{WABA_ID}/message_templates (مع أمثلة).
   bind(ctx): بيرجّع { body:[...], button:[suffix] } — بالترتيب الموضعي {{1}}.. */
/* ── القوالب الـ٨ المشتركة مع الكتالوج (١٢/١٠) ───────────────────────────────
   كانت مكتوبة هنا بنص أقدم (٢٨/٩) ومكتوبة تاني في watemplates.js بنص أحدث، والسجل كان بيحتفظ بالأقدم.
   ولا واحد منهم اتقدّم لميتا قبل كده، فالنص الحي بقى نص الكتالوج — مصدر واحد للنص، وهنا بس:
     stage  مرحلة الطلب اللي بتبعته (notify.js)
     data   صف الطلب ⇒ بيانات الكتالوج (نفس مسارات meta.vars — الاختبار بيتأكد إن مفيش متغيّر فاضي ولا متبدّل)
     guard  شرط إضافي على الطلب؛ false ⇒ مفيش إرسال (skipped: stage_not_applicable). */
function fromCatalog(name, { stage = null, data, guard = null } = {}) {
  const t = CAT.findTemplate(name, "ar");
  if (!t) throw new Error(`catalogue template missing: ${name}`);
  return {
    category: t.category, stage, guard, components: t.components, language: "ar", variants: { ar: t.components }, wording: "catalogue",
    bind: (ctx) => {
      const r = CAT.bindTemplate(t, data(ctx || {}));
      return { body: r.body, button: r.buttons.map((b) => b.text), missing: r.missing };
    },
  };
}
const orderData = (o) => ({ customer: { name: o.name }, order: { order_no: o.order_no, total: o.total } });
const isDelivery = (o) => o.option === "delivery" && !o.table_no;

export const TEMPLATES = {
  fc_order_received: fromCatalog("fc_order_received", { stage: "pos_created", data: orderData }),
  fc_order_preparing: fromCatalog("fc_order_preparing", { stage: "accepted", data: orderData }),
  // «في الطريق» و«تم التوصيل» لطلب توصيل بس — طلب الاستلام/الطاولة مالوش مندوب ولا «توصيل»
  fc_order_on_the_way: fromCatalog("fc_order_on_the_way", { stage: "on_the_way", data: orderData, guard: isDelivery }),
  fc_order_ready_pickup: fromCatalog("fc_order_ready_pickup", { stage: "pickup_ready", data: orderData, guard: (o) => o.option === "pickup" && !o.table_no }),
  fc_order_delivered: fromCatalog("fc_order_delivered", { stage: "delivered", data: orderData, guard: isDelivery }),
  // الحالة rejected_refunded بتتسجّل كمان لما «مفيش مبلغ يتسترجع» (shop.js refundOrder) — «تم الاسترجاع» بس لو فيه رقم استرجاع فعلي
  fc_order_refunded: fromCatalog("fc_order_refunded", { stage: "rejected_refunded", data: orderData, guard: (o) => Boolean(o.refund_id) }),
  fc_refund_in_progress: fromCatalog("fc_refund_in_progress", { stage: "refund_failed", data: orderData }),
  /* ── قوالب التسويق (حملات wasender على قناة Cloud API — ٢٨/٩) ──────────
     قواعد ميتا: مفيش متغير في أول الجسم ولا آخره، أمثلة لكل متغير، ومتغير
     زرار الـURL في آخر الرابط بس. زرار الرابط = نفس روابطنا المتتبّعة لكل عميل
     (/l/<slug>-<code> — cms.js بيحسب الضغطة على صف الطابور). «إيقاف» زرار رد
     سريع: الضغطة بتيجي في الويب هوك كرسالة نصها «إيقاف» ⇒ نفس مسار الإيقاف.
     campaign: القالب ينفع لحملة، و needs = اللي لازم الحملة توفّره. */
  fc_cart_reminder: {
    /* متقاعد (١٢/١٠): عمره ما اتربط بمُرسل ولا اتقدّم لميتا، وfc_cart_1h في الكتالوج بنفس الغرض وبنص معتمد اللهجة.
       باقي في السجل عشان الأسماء القديمة ماتتكسرش، بس مابيتقدّمش لميتا (retired). */
    category: "MARKETING", retired: true,
    components: [
      { type: "BODY",
        text: "أهلاً {{1}} 👋 سلتك في فريش كاتس لسا تنتظرك 🔥\nكمّل طلبك في دقيقة وتوصلك المشاوي حارّة.",
        example: { body_text: [["محمد"]] } },
      { type: "FOOTER", text: "للإيقاف ردّ: إيقاف" },
      { type: "BUTTONS", buttons: [
        // نفس رابط استرجاع السلة بتاع الـSMS (carts.js ‏/c/<code>)
        { type: "URL", text: "كمّل طلبك", url: "https://freshcuts.sa/c/{{1}}", example: ["k7q2m9"] },
        { type: "QUICK_REPLY", text: "إيقاف" },
      ] },
    ],
    bind: (x) => ({ body: [x.name || "عميلنا"], button: [x.cartCode || x.code || ""] }),
  },
  fc_offer_img: {
    category: "MARKETING", campaign: { needs: ["image"], label: "عرض بصورة" },
    components: [
      { type: "HEADER", format: "IMAGE", example: { header_handle: ["<upload handle — بيتجاب وقت التقديم>"] } },
      { type: "BODY",
        text: "أهلاً {{1}} 👋\n{{2}}\nاطلبه من موقع فريش كاتس للتوصيل أو الاستلام 🔥",
        example: { body_text: [["محمد", "بوكس التشكيلة من فريش كاتس بـ105 ريال"]] } },
      { type: "FOOTER", text: "للإيقاف ردّ: إيقاف" },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "اطلب الآن", url: "https://freshcuts.sa/l/{{1}}", example: ["w12-a1b2c3"] },
        { type: "QUICK_REPLY", text: "إيقاف" },
      ] },
    ],
    bind: (x) => ({ header: x.imageUrl ? { image: x.imageUrl } : null,
      body: [x.name || "عميلنا", x.offer || ""], button: [x.linkSuffix || ""],
      missing: [!x.offer && "offer", !x.imageUrl && "image", !x.linkSuffix && "linkSuffix"].filter(Boolean) }),
  },
  fc_winback: {
    category: "MARKETING", campaign: { needs: ["coupon"], label: "اشتقنا لك + كود" },
    components: [
      { type: "BODY",
        text: "اشتقنا لك يا {{1}} 🙌\nآخر مرة طلبت {{2}}، وجهّزنا لك كود {{3}} على طلبك الجاي من موقعنا.\nالكود لك أنت بس ولفترة محدودة.",
        example: { body_text: [["محمد", "كفتة مشوية", "W12K7Q2M"]] } },
      { type: "FOOTER", text: "للإيقاف ردّ: إيقاف" },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "اطلب الآن", url: "https://freshcuts.sa/l/{{1}}", example: ["w12-a1b2c3"] },
        { type: "QUICK_REPLY", text: "إيقاف" },
      ] },
    ],
    bind: (x) => ({ body: [x.name || "عميلنا", x.dish || "", x.coupon || x.code || ""],
      button: [x.linkSuffix || ""],
      missing: [!x.dish && "dish", !(x.coupon || x.code) && "coupon", !x.linkSuffix && "linkSuffix"].filter(Boolean) }),
  },
  // قوالب التحقق نصها ثابت من ميتا («{{1}} هو رمز التحقق الخاص بك.») — تعريفها في الكتالوج (تحذير الأمان + ٥ دقايق + نسخ الرمز)
  fc_otp: fromCatalog("fc_otp", { data: (x) => ({ otp: { code: x.code == null ? "" : String(x.code) } }) }),
};

/* المرحلة (زي notify.js) → اسم القالب. المراحل اللي مش هنا مالهاش واتساب. */
export const STAGE_TEMPLATES = Object.fromEntries(
  Object.entries(TEMPLATES).filter(([, t]) => t.stage).map(([name, t]) => [t.stage, name]));

/* 📍 RT2 (١٧/١٠ — عمر: «موصلتش رسايل واتس اب ان الطلب جاهز»): القالب البديل لكل مرحلة لما المالك يحطها في waBot.windowV2Stages —
   الافتراضي <الاسم>_v2 (SB4)، وpickup_ready بديلها اسم تاني: fc_order_pickup_ready (صياغة المالك بدل fc_order_ready_pickup المرفوض عند ميتا).
   نفس الاسم بيدّي **نص الرسالة الحرة** جوّه النافذة (ببلاش، من غير اعتماد)، وبره النافذة بيتبعت قالب بس لو ميتا بتقول APPROVED. */
export const V2_TEMPLATE_NAMES = Object.freeze({ pickup_ready: "fc_order_pickup_ready" });
export const v2TemplateOf = (stage, template) => V2_TEMPLATE_NAMES[stage] || `${template}_v2`;
/* 📍 RT2: مراحل «رسالة حرة بس» (من غير قالب ولا SMS): collected = الكاشير سلّم طلب الاستلام. جوّه نافذة الـ٢٤ ساعة بس؛ النص بلهجة بيضاء.
   RT2 مراجعة (١٧/١٠): السجل الواحد waswitches.FREE_STAGES (نفس المفاتيح — اختبار الانجراف)، والنص من اللوحة (waBot.texts) وإلا الافتراضي من هناك. */
const FREE_STAGE_GUARDS = Object.freeze({ collected: (o) => o.option === "pickup" && !o.table_no });
export const FREE_STAGE_TEXT = Object.freeze(Object.fromEntries(Object.keys(FREE_STAGES).map((stage) => [stage,
  Object.freeze({ guard: FREE_STAGE_GUARDS[stage] || (() => true), text: (o, snap) => freeStageText(stage, snap, "ar") })])));
/* RT2 مراجعة (١٧/١٠): حالات ميتا اللي الإرسال بيها **أكيد** هيفشل ⇒ template_not_approved من غير نداء. PENDING بعد تعديل (ميتا بتبعت النسخة المعتمدة
   القديمة) / IN_APPEAL / PAUSED بيكمّلوا لـsendTemplate زي الأول وميتا بتقرر (وSMS الويب هوك «failed» لسه شغّالة). */
export const TEMPLATE_BLOCKING_STATUSES = Object.freeze(["REJECTED", "NOT_SUBMITTED", "DISABLED", "PENDING_DELETION", "DELETED"]);

/* ── سجل قوالب قابل للتوسيع ─────────────────────────────────────────────
   كتالوج قوالب خارجي (مثلاً watemplates.js) بيتسجّل هنا وقت الإقلاع، والتقديم
   لميتا والإرسال والحملات بيقروا من نفس TEMPLATES (مفيش نسخة تانية).
   شكل كل قالب: { category, components, bind(ctx) ⇒ {header?, body[], button[]},
     stage?  (مرحلة طلب في notify.js), campaign? {label, needs:["image"|"coupon"]} }
   قالب حملة (campaign) الـbind بتاعه بياخد السياق ده (wacloud.campaignParams):
     { name, offer, imageUrl, linkSuffix, dish, coupon }
   الاسم الموجود مابيتغيّرش إلا بـ {override:true}. */
export function registerTemplates(defs, { override = false } = {}) {
  const added = [], skipped = [];
  for (const [name, t] of Object.entries(defs || {})) {
    const okShape = /^[a-z0-9_]{1,512}$/.test(name) && t && ["UTILITY", "MARKETING", "AUTHENTICATION"].includes(t.category)
      && Array.isArray(t.components) && typeof t.bind === "function";
    if (!okShape || (TEMPLATES[name] && !override)) { skipped.push(name); continue; }
    TEMPLATES[name] = t;
    if (t.stage && (override || !STAGE_TEMPLATES[t.stage])) STAGE_TEMPLATES[t.stage] = name;
    added.push(name);
  }
  return { added, skipped };
}

/* ── كتالوج watemplates.js ⇒ السجل (١٢/١٠) ─────────────────────────────────
   العطل: index.js كان بيدّي registerTemplates الـTEMPLATES بتاعة watemplates.js زي ما هي — وهي **قايمة** (array) من
   غير bind لكل قالب، وregisterTemplates مستنية خريطة {اسم: {…, bind()}}. فالمفاتيح بقت "0","1",… واتتخطّى الكل:
   السيرفر الحي مايعرفش غير الـ١١ قالب القدام، وfc_winback_45 مايتقدّمش من اللوحة.
   الحل: الدالة دي بتحوّل القايمة لخريطة بالاسم ومعاها bind (من bindTemplate بتاع الكتالوج) وتسجّلها.
   • القالب المسجّل بـcatalog:true **من غير** stage ولا campaign: يتعرض ويتقدّم لميتا بس — مابيدخلش في تحديثات
     الطلب التلقائية ولا في قايمة قوالب الحملات. مفيش حاجة بتتقدّم لوحدها، والإرسال ومفاتيحه زي ما هم.
   • اسم موجود في السجل (الـ٨ اللي في الاتنين) بيفضل على تعريف whatsapp.js.
   • نفس الاسم بلغتين (قوالب الفريق ar + en) = قالب واحد بـvariants؛ التقديم بيبعت كل لغة.
   mod = موديول watemplates.js (TEMPLATES قايمة + bindTemplate + validateTemplate)، أو خريطة جاهزة بالشكل القديم. */
export function registerCatalog(mod, { override = false } = {}) {
  const src = mod && (mod.TEMPLATES || mod.CATALOG || mod.default);
  if (!Array.isArray(src)) return { ...registerTemplates(src || {}, { override }), invalid: [], shape: "map" };
  const bindFn = typeof mod.bindTemplate === "function" ? mod.bindTemplate : null;
  const validate = typeof mod.validateTemplate === "function" ? mod.validateTemplate : () => [];
  const defs = {}, invalid = [];
  for (const t of src) {
    const name = t && t.name;
    if (!name || !Array.isArray(t.components)) { invalid.push(String(name || "?")); continue; }
    let errs = [];
    try { errs = validate(t) || []; } catch (e) { errs = [e.message]; }
    if (errs.length) { invalid.push(`${name}: ${errs[0]}`); continue; }
    const lang = String(t.language || "ar");
    if (defs[name]) { defs[name].variants[lang] = t.components; continue; }   // لغة تانية لنفس الاسم
    defs[name] = {
      category: t.category, components: t.components, language: lang, variants: { [lang]: t.components },
      catalog: true, group: t.group || (t.meta && t.meta.group) || null, purpose: (t.meta && t.meta.purpose) || null,
      // نفس شكل bind بتاع السجل: {body[], button[]} — + missing عشان المُرسل مايبعتش متغيّر فاضي
      bind: (ctx) => {
        if (!bindFn) return { body: [], button: [], missing: ["bindTemplate"] };
        const r = bindFn(t, ctx || {});
        return { body: r.body || [], button: (r.buttons || []).map((b) => b.text), missing: r.missing || [] };
      },
    };
  }
  return { ...registerTemplates(defs, { override }), invalid, shape: "list" };
}
export const isCatalogTemplate = (name) => Boolean(TEMPLATES[name] && TEMPLATES[name].catalog);

/* RV4 (١٦/١٠): خطأ Graph ⇒ نتيجة مقروءة للوحة. ميتا بتحط السبب الحقيقي في error_user_title / error_user_msg
   (مثلاً 100/2388060 «Button format is incorrect — Buttons can't have any variables, newlines, emojis…») و message بيبقى «Invalid parameter» بس.
   error = message — title: msg (اللوحة بتعرض error)، و meta = {code, subcode, title, detail, type, fbtrace}.
   التنضيف: أي توكن من secrets (≥ ٨ حروف) ⇒ [token]، أي رابط فيه access_token/token= ⇒ [link]، و Bearer/EAA… ⇒ [token]. */
const scrubMeta = (v, secrets, max) => {
  let s = String(v ?? "");
  for (const t of secrets || []) if (t && String(t).length >= 8) s = s.split(String(t)).join("[token]");
  s = s.replace(/https?:\/\/[^\s"'<>]*(?:access_token|[?&]token=|signature=)[^\s"'<>]*/gi, "[link]")
    .replace(/access_token=[^&\s"'<>]+/gi, "access_token=[token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [token]")
    .replace(/\bEA[A-Za-z0-9]{20,}/g, "[token]");
  return s.replace(/\s+/g, " ").trim().slice(0, max);
};
export function metaErrorOf(e, secrets = []) {
  const g = (e && typeof e.graph === "object" && e.graph) || {};
  const message = scrubMeta(e && e.message, secrets, 300);
  const title = scrubMeta(g.error_user_title, secrets, 200) || null;
  const detail = scrubMeta(g.error_user_msg, secrets, 600) || null;
  const why = [title, detail].filter(Boolean).join(": ");
  const error = [message, why && why !== message ? why : ""].filter(Boolean).join(" — ") || "meta_error";
  const num = (x) => (x === undefined || x === null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);
  return { error, meta: { code: num(g.code), subcode: num(g.error_subcode), title, detail,
    type: g.type ? scrubMeta(g.type, secrets, 60) : null, fbtrace: g.fbtrace_id ? scrubMeta(g.fbtrace_id, secrets, 40) : null } };
}
export const templateLanguages = (name) => (TEMPLATES[name] && TEMPLATES[name].variants ? Object.keys(TEMPLATES[name].variants) : ["ar"]);

function money(n) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(2) : String(n ?? ""); }

/* 5XXXXXXXX → 9665XXXXXXXX. أي حاجة تانية = null (مابنبعتش لأرقام مش سعودية). */
export function toWaId(phoneNorm) {
  const d = String(phoneNorm || "").replace(/\D/g, "");
  if (/^5\d{8}$/.test(d)) return `966${d}`;
  if (/^9665\d{8}$/.test(d)) return d;
  return null;
}
export function fromWaId(waId) {
  const d = String(waId || "").replace(/\D/g, "");
  return /^9665\d{8}$/.test(d) ? d.slice(3) : null;
}

/* قيمة متغير في القالب. ميتا بترفض (132018) أي باراميتر فيه سطر جديد أو tab
   أو أكتر من ٤ مسافات ورا بعض، وبترفض الفاضي — فبننضّفه هنا مرة واحدة. */
export function cleanParam(v, max = 1000) {
  const s = String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max);
  return s || "-";
}

/* متغيّر ناقص = مفيش إرسال. bind بيرجّع missing[]، وكمان أي قيمة جسم/زرار فاضية أو «-» بتتمسك هنا
   (cleanParam بتحوّل الفاضي لـ«-» عشان ميتا ماترفضش — وده بالظبط اللي مايصحّش يوصل لعميل).
   لاحقة زرار الرابط لازم حروف رابط آمنة بس (ميتا بتطلب ترميز أي رمز خاص). */
export function paramProblem(name, params = {}, lang = null) {
  const t = TEMPLATES[name];
  if (!t) return "unknown_template";
  if (Array.isArray(params.missing) && params.missing.length) return `missing:${params.missing.join(",")}`.slice(0, 120);
  const blank = (v) => { const s = String(v ?? "").replace(/[\r\n\t]+/g, " ").trim(); return !s || s === "-"; };
  const comps = (t.variants && t.variants[lang || t.language || "ar"]) || t.components;
  const auth = t.category === "AUTHENTICATION";
  const bodyText = comps.find((c) => c.type === "BODY")?.text || "";
  const need = auth ? 1 : new Set([...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
  const body = Array.isArray(params.body) ? params.body : [];
  if (body.length !== need) return `body_params:${body.length}/${need}`;
  if (body.some(blank)) return "empty_body_param";
  if (auth && !/^[A-Za-z0-9]{1,15}$/.test(String(body[0]))) return "bad_otp_code";
  const btns = comps.find((c) => c.type === "BUTTONS")?.buttons || [];
  const dyn = auth ? 1 : btns.filter((b) => b.type === "URL" && /\{\{1\}\}/.test(b.url || "")).length;
  const button = Array.isArray(params.button) ? params.button : [];
  if (dyn && (button.length < dyn || button.slice(0, dyn).some(blank))) return "empty_button_param";
  if (dyn && !auth && button.slice(0, dyn).some((v) => !/^[A-Za-z0-9._~-]{1,200}$/.test(String(v)))) return "unsafe_button_param";
  if (comps.some((c) => c.type === "HEADER" && c.format === "IMAGE") && !params.header?.image) return "missing_header_image";
  return null;
}

/* نص القالب بعد التعويض — للعرض في صندوق المحادثات بدل «[قالب: …]». */
export function renderTemplateText(name, params = {}) {
  const t = TEMPLATES[name];
  const body = t?.components.find((c) => c.type === "BODY")?.text;
  if (!body) return "";
  const vals = Array.isArray(params.body) ? params.body : [];
  return body.replace(/\{\{(\d+)\}\}/g, (m, i) => (vals[Number(i) - 1] != null ? cleanParam(vals[Number(i) - 1]) : m));
}

/* جسم رسالة القالب لـ POST /{PHONE_ID}/messages. */
export function buildTemplatePayload(name, to, params = {}, lang = "ar") {
  const t = TEMPLATES[name];
  if (!t) throw Object.assign(new Error(`unknown template ${name}`), { code: "WA_UNKNOWN_TEMPLATE" });
  const components = [];
  if (params.header?.image) {
    components.push({ type: "header", parameters: [{ type: "image", image: { link: params.header.image } }] });
  } else if (params.header?.video) {
    // حملات واتساب (١٣/١٠): قالب بهيدر فيديو — رابط https عام لملف mp4 (wacloud.js mediaRule)
    components.push({ type: "header", parameters: [{ type: "video", video: { link: params.header.video } }] });
  }
  if (Array.isArray(params.body) && params.body.length) {
    components.push({ type: "body", parameters: params.body.map((v) => ({ type: "text", text: cleanParam(v) })) });
  }
  if (Array.isArray(params.button) && params.button.length) {
    if (t.category === "AUTHENTICATION") {
      components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: String(params.button[0]) }] });
    } else {
      /* SB5: قالب فيه زرّين رابط بمتغيّر (راسل المندوب + التتبع) ⇒ كل زر بمتغيّره بالترتيب. زر واحد ⇒ زي الأول. */
      const btns = t.components.find((c) => c.type === "BUTTONS")?.buttons || [];
      const dyn = btns.map((b, i) => (b.type === "URL" && /\{\{1\}\}/.test(b.url || "") ? i : -1)).filter((i) => i >= 0);
      const idxs = dyn.length ? dyn : [btns.findIndex((b) => b.type === "URL")].filter((i) => i >= 0);
      idxs.forEach((idx, k) => { if (params.button[k] == null && k > 0) return; components.push({ type: "button", sub_type: "url", index: String(idx), parameters: [{ type: "text", text: String(params.button[k] ?? "") }] }); });
    }
  }
  /* CW1: أزرار الرد السريع بـpayload خاص بكل رسالة (أزرار المندوب: رقم الرحلة + توقيع) ⇒ الضغطة بترجع بالـpayload ده في الويب هوك
     (interactiveId) بدل نص الزر. params.quickReplies[i] = payload الزر رقم i من أزرار الرد السريع بالترتيب. */
  if (Array.isArray(params.quickReplies) && params.quickReplies.length) {
    const comps = (t.variants && t.variants[lang]) || t.components;
    const btns = comps.find((c) => c.type === "BUTTONS")?.buttons || [];
    let k = 0;
    btns.forEach((b, idx) => {
      if (b.type !== "QUICK_REPLY") return;
      const pl = params.quickReplies[k++];
      if (pl != null && String(pl)) components.push({ type: "button", sub_type: "quick_reply", index: String(idx), parameters: [{ type: "payload", payload: String(pl).slice(0, 256) }] });
    });
  }
  return { messaging_product: "whatsapp", recipient_type: "individual", to, type: "template",
    template: { name, language: { code: lang }, components } };
}

/* جسم التقديم لميتا (مراجعة القوالب). */
export function templateSubmission(name, lang) {
  const t = TEMPLATES[name];
  if (!t) throw new Error(`unknown template ${name}`);
  // قالب كتالوج بأكتر من لغة: مكوّنات اللغة المطلوبة (الافتراضي لغته الأساسية). القوالب القديمة: عربي زي ما كانت.
  const language = lang || t.language || "ar";
  const components = t.variants ? t.variants[language] : t.components;
  if (!components) throw new Error(`template ${name} has no ${language} version`);
  return { name, language, category: t.category, components };
}

/* X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(appSecret, rawBody). مقارنة ثابتة الوقت. */
export function verifySignature(raw, header, secret) {
  if (!secret || !header || !String(header).startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const got = String(header).slice(7);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
}

/* M2 (١٢/١٠): «الغاء» و«وقف» لوحدهم اتشالوا من هنا — العميل اللي بيكتبهم غالباً قصده طلبه مش رسايلنا. البوت بيسأله «تلغي طلبك ولا توقف الرسايل؟» (wabotrun: cancel_what). */
const STOP_RE = /^\s*(stop|unsubscribe|إيقاف|ايقاف|إيقاف العروض|ايقاف العروض|إلغاء الاشتراك|الغاء الاشتراك)\s*$/i;
const START_RE = /^\s*(start|ابدأ|ابدا|اشتراك)\s*$/i;

const isoOf = (ts) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};
const MEDIA_AR = { image: "صورة", video: "فيديو", audio: "رسالة صوتية", voice: "رسالة صوتية", document: "ملف",
  sticker: "ملصق", location: "موقع", contacts: "جهة اتصال", reaction: "تفاعل", unsupported: "رسالة مش مدعومة", revoke: "رسالة اتمسحت" };

/* نص أي رسالة (وارد/صدى/تاريخ) — والوسائط بتتكتب بين أقواس عشان الكاشير يفهم. */
export function messageText(m) {
  const t = m?.text?.body ?? m?.button?.text ?? m?.interactive?.button_reply?.title
    ?? m?.interactive?.list_reply?.title ?? m?.image?.caption ?? m?.video?.caption ?? m?.document?.caption ?? null;
  if (t != null && String(t).trim()) return String(t);
  if (m?.type === "reaction") return m.reaction?.emoji ? `[تفاعل ${m.reaction.emoji}]` : "[تفاعل]";
  if (m?.type === "document" && m.document?.filename) return `[ملف: ${m.document.filename}]`;
  if (m?.type === "template") return "[قالب]";
  return m?.type ? `[${MEDIA_AR[m.type] || m.type}]` : "";
}
/* CR2 (١٦/١٠) — العميل مسح رسالة («حذف للجميع»): ميتا بتبعت رسالة نوعها revoke ومعاها revoke.original_message_id = wamid الرسالة اللي اتمسحت
   (مرجع ميتا: webhooks/reference/messages/revoke — لأرقام تطبيق واتساب بزنس «Coexistence»، لحد يومين من إرسال الرسالة). نسختنا من الرسالة
   عمرها ما بتتمسح: صف الـrevoke بيتكتب نصه «مسحت رسالتها: <نصها>» وبيحفظ المرجع في wa_messages.revoked_wamid.
   مرجع مش موجود في الحمولة (نسخة قديمة / شكل تاني) ⇒ تقدير: آخر رسالة منها قبلها بـREVOKE_GAP_SEC ثانية بالكتير ⇒ «مسحت رسالة بعد N ثانية من …» (تقدير). */
export const REVOKE_GAP_SEC = 10;
export const REVOKE_PLAIN = "[رسالة اتمسحت]";
export function revokeOf(m) {
  if (m?.type !== "revoke") return null;
  const r = m.revoke && typeof m.revoke === "object" ? m.revoke : {};
  const ref = [r.original_message_id, r.message_id, r.id].find((x) => typeof x === "string" && x.trim());
  return { original: ref ? ref.trim().slice(0, 200) : null, keys: Object.keys(r).slice(0, 10) };
}
const clipQ = (t, n = 300) => { const x = String(t ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
/* نص صف الـrevoke: body = نص الرسالة اللي اتمسحت (عندنا) · gapSec + lastText = التقدير (من غير مرجع) · echo = الموظف مسح من موبايل المطعم */
export function revokeText({ body = null, gapSec = null, lastText = null, echo = false } = {}) {
  if (body != null && String(body).trim()) return echo ? `اتمسحت من موبايل المطعم: ${clipQ(body, 900)}` : `مسحت رسالتها: ${clipQ(body, 900)}`;
  if (!echo && lastText != null && String(lastText).trim() && Number.isFinite(Number(gapSec)) && Number(gapSec) >= 0 && Number(gapSec) <= REVOKE_GAP_SEC)
    { const n = Math.round(Number(gapSec)); return `مسحت رسالة بعد ${n} ${n >= 3 && n <= 10 ? "ثواني" : "ثانية"} من «${clipQ(lastText, 200)}» (تقدير)`; }
  return REVOKE_PLAIN;
}
/* MD1 (١٣/١٠): بيانات ملف الرسالة (صورة / صوت / فيديو / ملف / ملصق) زي ما ميتا بعتتها — بتتحفظ في wa_messages.media
   عشان الصندوق يقدر يفتح الملف بعدين (wamedia.js). رقم الملف ده مابيطلعش للمتصفح. */
const MEDIA_KINDS = ["image", "video", "audio", "document", "sticker"];
export function mediaOf(m) {
  const kind = MEDIA_KINDS.includes(m?.type) ? m.type : null;
  const o = kind ? m[kind] : null;
  if (!o || !o.id || !/^\d{5,40}$/.test(String(o.id))) return null;
  return { kind, id: String(o.id), mime: o.mime_type ? String(o.mime_type).slice(0, 80) : null, sha256: o.sha256 ? String(o.sha256).slice(0, 100) : null,
    ...(kind === "audio" ? { voice: o.voice === true } : {}), ...(o.filename ? { filename: String(o.filename).slice(0, 120) } : {}), ...(o.caption ? { caption: String(o.caption).slice(0, 1000) } : {}) };
}
export const MEDIA_HOSTS = [".fbsbx.com", ".facebook.com", ".fbcdn.net", ".whatsapp.net"];
export const mediaHostOk = (url) => { try { const u = new URL(String(url)); return u.protocol === "https:" && MEDIA_HOSTS.some((h) => u.hostname.endsWith(h)); } catch { return false; } };
export const intentOf = (text) => (STOP_RE.test(text || "") || isOptOutText(text || "") ? "stop" : START_RE.test(text || "") ? "start" : null);

/* بيفرد الويب هوك — بيتجاهل أي حاجة مش شكلها صح.
   الحقول (field) اللي بنفهمها:
     messages            وارد العملاء + حالات رسايلنا (+ اسم البروفايل)
     smb_message_echoes  الكاشير بعت من تطبيق واتساب بزنس على الموبايل (Coexistence)
     smb_app_state_sync  جهات اتصال التطبيق (إضافة/حذف) — اسم للجوال
     history             تاريخ المحادثات القديمة (مرة واحدة بعد الربط، على دفعات)
     message_template_status_update  اعتماد/رفض قالب
   opts.phoneId: لو محدد، أي تغيير لرقم تاني بيتشال (نفس الـWABA ممكن يبقى فيه أكتر من رقم).
   W5 (١٢/١٠) — الرقم ممكن ياخد phone_number_id **جديد** بعد ربط في محفظة تانية، وويب هوك مزامنة جهات الاتصال
   والتاريخ بييجوا مرة واحدة: لو اترموا عشان الـid مش بتاع الـenv مايتطلبوش تاني. فالحدث بيتقبل لو:
     • الـid = opts.phoneId (الـenv)                                    ⇒ via "env"
     • الـid في opts.phoneIds (أرقام آخر ربط ناجح في wa_onboarding)       ⇒ via "onboarding"
     • metadata.display_phone_number = رقم من opts.ownNumbers (رقمنا)    ⇒ via "number"
   أي رقم تاني لسه بيترفض (ignored: "other_phone"). من غير أي فلتر (ولا واحد من التلاتة) كله بيتقبل زي الأول. */
const digitsOf = (v) => String(v ?? "").replace(/\D/g, "");
export function acceptPhone(pid, displayNumber, { phoneId = null, phoneIds = [], ownNumbers = [] } = {}) {
  const ids = (phoneIds || []).map(String).filter(Boolean), nums = (ownNumbers || []).map(digitsOf).filter(Boolean);
  if (!phoneId && !ids.length && !nums.length) return { ok: true, via: null };       // مفيش فلتر
  if (!pid) return { ok: true, via: null };                                          // حدث على مستوى الحساب (account_update…)
  if (phoneId && String(pid) === String(phoneId)) return { ok: true, via: "env" };
  if (ids.includes(String(pid))) return { ok: true, via: "onboarding" };
  if (nums.length && nums.includes(digitsOf(displayNumber))) return { ok: true, via: "number" };
  return { ok: false, via: null };
}
export function parseWebhook(body, { phoneId = null, phoneIds = [], ownNumbers = [] } = {}) {
  const out = { statuses: [], messages: [], echoes: [], contacts: [], profiles: [], history: [],
    historyErrors: [], historyMeta: [], templateEvents: [], accountEvents: [], qualityEvents: [], fields: [] };
  for (const entry of body?.entry || []) {
    for (const ch of entry?.changes || []) {
      const v = ch?.value || {};
      const field = String(ch?.field || "messages");
      const pid = v.metadata?.phone_number_id ? String(v.metadata.phone_number_id) : null;
      const acc = acceptPhone(pid, v.metadata?.display_phone_number, { phoneId, phoneIds, ownNumbers });
      if (!acc.ok) { out.fields.push({ field, ignored: "other_phone", phoneId: pid }); continue; }
      /* account_update (PARTNER_ADDED / ACCOUNT_VIOLATION…) وأي حدث حساب: نص مختصر من الحمولة يتسجّل في
         wa_webhook_health.last_note — ده اللي بيقول الحساب اتشارك مع مين وبأي أرقام بعد الربط. */
      const note = field === "account_update" || field === "phone_number_name_update" || field === "business_capability_update"
        ? JSON.stringify(v).slice(0, 480) : (acc.via && acc.via !== "env" ? `via:${acc.via} phone_id:${pid}` : null);
      out.fields.push({ field, phoneId: pid, via: acc.via, ...(note ? { note } : {}) });
      if (field === "account_update") out.accountEvents.push({ event: v.event || null, wabaId: v.waba_info?.waba_id ? String(v.waba_info.waba_id) : null,
        ownerBusinessId: v.waba_info?.owner_business_id ? String(v.waba_info.owner_business_id) : null, entryId: entry?.id ? String(entry.id) : null });
      /* QP1: أحداث الجودة/الحساب (جودة الرقم وحده، جودة/حالة قالب، مخالفة حساب) ⇒ wasender بيخزّنها وبوابة الجودة بتوقّف الحملات */
      /* حدث جودة لرقم تاني على نفس الحساب (لو عرفنا رقمنا من ownNumbers) مايخصّناش */
      const otherNumber = field === "phone_number_quality_update" && v.display_phone_number && (ownNumbers || []).map(digitsOf).filter(Boolean).length
        && !(ownNumbers || []).map(digitsOf).includes(digitsOf(v.display_phone_number));
      if (field === "phone_number_quality_update") { if (!otherNumber) out.qualityEvents.push({ kind: "phone", event: v.event || null, tier: v.current_limit || null }); }
      else if (field === "message_template_quality_update") out.qualityEvents.push({ kind: "template", state: v.new_quality_score || null, name: v.message_template_name || null, language: v.message_template_language || null });
      else if (field === "message_template_status_update" && v.message_template_name) out.qualityEvents.push({ kind: "template", event: v.event || null, name: v.message_template_name, language: v.message_template_language || null });
      else if (field === "account_update" || field === "account_alerts") out.qualityEvents.push({ kind: "account", event: v.event || v.alert_type || null });
      const bizPhone = String(v.metadata?.display_phone_number || "").replace(/\D/g, "");
      for (const s of v.statuses || []) {
        out.statuses.push({ wamid: s.id, status: s.status, recipient: s.recipient_id,
          at: isoOf(s.timestamp), pricing: s.pricing || null, errors: s.errors || null });
      }
      for (const c of v.contacts || []) {
        if (c?.wa_id && c.profile?.name) out.profiles.push({ waId: String(c.wa_id), name: String(c.profile.name).slice(0, 80) });
      }
      for (const m of v.messages || []) {
        const text = messageText(m);
        out.messages.push({ wamid: m.id, from: m.from, type: m.type, text,
          at: isoOf(m.timestamp),
          interactiveId: m.button?.payload ?? m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? null,
          /* FD1 مراجعة ٣: الرسالة اللي العميل ضغط زرها أو رد عليها (wamid) — كل قوالب الحملات فيها نفس زر «أبغى أطلب»، فالضغطة بتتعرف بالرسالة دي */
          contextId: typeof m.context?.id === "string" && m.context.id ? m.context.id.slice(0, 200) : null,
          referral: m.referral || null, // رسالة جاية من إعلان Click-to-WhatsApp
          /* EX6: رسالة نوعها مش مدعوم (أول رسالة من إعلان اتشافت كده ١٣/١٠) — نحفظ اللي ميتا قالته عنها: الأخطاء وأسماء الحقول اللي جت، عشان نعرف هي إيه. */
          ...(m.type === "unsupported" || Array.isArray(m.errors) ? { unsupported: { errors: (Array.isArray(m.errors) ? m.errors : []).slice(0, 3).map((e) => ({ code: e.code ?? null, title: String(e.title || e.message || "").slice(0, 120), details: String(e.error_data?.details || "").slice(0, 200) })), keys: Object.keys(m).slice(0, 20), context: m.context ? Object.keys(m.context).slice(0, 10) : null } } : {}),
          // موقع العميل (مشاركة الموقع) — البوت بيتأكد بيه إن التوصيل يوصله (wabotrun: area)
          location: m.type === "location" && Number.isFinite(Number(m.location?.latitude)) && Number.isFinite(Number(m.location?.longitude))
            ? { lat: Number(m.location.latitude), lng: Number(m.location.longitude) } : null,
          ...(mediaOf(m) ? { media: mediaOf(m) } : {}),
          ...(revokeOf(m) ? { revoke: revokeOf(m) } : {}),      // CR2: الرسالة اتمسحت — مرجع الرسالة الأصلية
          intent: m.type === "reaction" || m.type === "revoke" ? null : intentOf(text) });
      }
      for (const m of v.message_echoes || []) {
        out.echoes.push({ wamid: m.id, from: m.from, to: m.to, type: m.type, text: messageText(m), at: isoOf(m.timestamp), ...(mediaOf(m) ? { media: mediaOf(m) } : {}), ...(revokeOf(m) ? { revoke: revokeOf(m) } : {}) });
      }
      for (const s of v.state_sync || []) {
        const c = s?.contact || {};
        if (!c.phone_number) continue;
        out.contacts.push({ phone: String(c.phone_number).replace(/\D/g, ""), fullName: c.full_name ? String(c.full_name).slice(0, 80) : null,
          firstName: c.first_name ? String(c.first_name).slice(0, 40) : null,
          action: s.action === "remove" ? "remove" : "add", at: isoOf(s.metadata?.timestamp) });
      }
      for (const h of v.history || []) {
        if (Array.isArray(h?.errors) && h.errors.length) {
          for (const e of h.errors) out.historyErrors.push({ code: e.code, title: e.title || e.message || "", details: e.error_data?.details || null });
        }
        if (h?.metadata) out.historyMeta.push({ phase: h.metadata.phase ?? null, chunk: h.metadata.chunk_order ?? null, progress: h.metadata.progress ?? null });
        for (const th of h?.threads || []) {
          for (const m of th?.messages || []) {
            const from = String(m.from || "").replace(/\D/g, "");
            // الصادر = من رقمنا. الـthread id هو رقم العميل.
            const out_ = (bizPhone && from === bizPhone) || (th.id && from && from !== String(th.id).replace(/\D/g, ""));
            out.history.push({ wamid: m.id, customer: String(th.id || (out_ ? m.to : m.from) || "").replace(/\D/g, ""),
              direction: out_ ? "out" : "in", type: m.type, text: messageText(m), at: isoOf(m.timestamp),
              status: m.history_context?.status ? String(m.history_context.status).toLowerCase() : null });
          }
        }
      }
      if (field === "message_template_status_update" && (v.message_template_name || v.event)) {
        out.templateEvents.push({ name: v.message_template_name || null, language: v.message_template_language || null,
          id: v.message_template_id != null ? String(v.message_template_id) : null, event: v.event || null, reason: v.reason || null });
      }
    }
  }
  return out;
}

/* ترتيب الحالات: الحالة الأقدم مابتكتبش فوق الأحدث (ميتا بتبعت read قبل delivered أحياناً).
   failed بيكسب بس لو لسه ماوصلتش. */
const RANK = { accepted: 0, sent: 1, delivered: 2, read: 3 };
export function nextStatus(cur, incoming) {
  if (!incoming) return cur || null;
  if (!cur) return incoming;
  if (incoming === "failed") return RANK[cur] >= 2 ? cur : "failed";
  if (cur === "failed") return RANK[incoming] >= 2 ? incoming : cur;
  if (!(incoming in RANK)) return cur;
  return (RANK[incoming] ?? -1) > (RANK[cur] ?? -1) ? incoming : cur;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb, normPhone } = ctx;
  const doFetch = deps.fetch || globalThis.fetch;
  const smsSend = deps.sendSms || defaultSendSms;

  /* صندوق المحادثات (wainbox.js) بيتركّب بعدنا — بيتحقن هنا عشان كل رسالة
     رايحة/جاية تحدّث صف المحادثة. فاضي = الصندوق مش مركّب، وكله شغّال زي ما هو. */
  let inbox = null;
  const setInbox = (i) => { inbox = i; };
  /* PH1 (١٦/١٠ بعد حادثة 131042): مراقب الصحة (wahealth.js) بيتركّب بعدنا — بيتحقن هنا. قبل أي قالب مش تجربة الحارس بيسأله:
     مشكلة دفع/قفل/توكن لسه قايمة ⇒ القالب بيتخطّى «pay_hold» (من غير طلب لميتا، ومن غير ما يتحسب فشل) والـSMS البديل بيكمّل عند المنادي.
     الرسايل الحرة جوّه النافذة مابتتسألش. فاضي = زي الأول. */
  let payHold = null;
  const setPayHold = (fn) => { payHold = typeof fn === "function" ? fn : null; };
  /* 📍 RT2 (١٧/١٠): حالة القالب عند ميتا — wacloud.js بيحقن دالة بتقرا من كاش قايمة message_templates (١٠ دقايق). قبل أي قالب بفلوس في تحديث طلب:
     مش APPROVED ⇒ template_not_approved من غير طلب لميتا (fc_order_ready_pickup مرفوض، وfc_order_pickup_ready لسه ماتقدّمش) — notify.js بيبعت SMS البديل
     وبيسجّل السبب. مانعرفش الحالة (مفيش دالة / ميتا مش مقروءة) ⇒ null ⇒ زي الأول وميتا بتقرر. */
  let templateStatus = null;
  const setTemplateStatus = (fn) => { templateStatus = typeof fn === "function" ? fn : null; };
  async function templateStatusOf(name, lang = "ar") {
    if (!templateStatus) return null;
    try { const st = await templateStatus(name, lang); return st ? String(st).toUpperCase() : null; } catch { return null; }
  }
  async function holdBlocks(ctx) {
    if (!payHold) return false;
    try { return Boolean(await payHold(ctx)); } catch { return false; }
  }
  /* LR1: كل رسالة اتخزّنت لمحادثة (عميل / بوت / مساعد / رد موظف / موبايل المطعم / قالب) ⇒ حدث «chat» للمستمعين
     (wastaff بيبعته لشاشة البورتال: wa_chat_update). رسايل التاريخ القديم (silent) مابتبعتش حدث. من غير نص ولا اسم. */
  const touchThread = async (a) => {
    let r; try { r = await inbox?.touch?.(a); } catch { /* الصندوق مايوقّفش رسالة */ }
    if (a && a.phoneNorm && !a.silent) { try { await emit("chat", { phoneNorm: a.phoneNorm, what: "message", dir: a.direction === "in" ? "in" : "out", at: a.at || null }); } catch { /* الحدث مايوقّفش رسالة */ } }
    return r;
  };

  /* مستمعين للويب هوك (wasender بيسجّل هنا عشان حالات رسايل الحملة وردودها
     تحدّث صفوف الطابور). مستمع بيقع مابيوقّفش الباقي. */
  const hooks = { inbound: [], status: [], account: [], chat: [], quality: [], claim: [] };      // CW1: claim = مستمع يقدر «يمسك» الرسالة (أزرار المندوب الخارجي) فالبوت والرد الآلي مايردّوش
  const on = (ev, fn) => { if (hooks[ev] && typeof fn === "function") hooks[ev].push(fn); };
  const emit = async (ev, x) => {
    for (const fn of hooks[ev] || []) { try { await fn(x); } catch (e) { console.error(`[wa] ${ev} hook:`, e.message); } }
  };

  /* ── البوت (ردود آلية) ─────────────────────────────────────────────────
     setBot({ matchIntent(text, ctx), buildReply(intent, ctx) }) — مثلاً wabot.js.
     ١٢/١٠: البوت بقى wabotrun.js وكل مفاتيحه من اللوحة (settings.waBot: الوضع off/dry/test/live، قايمة
     أرقام التجربة، نافذة سكوت الموظف…) — مفيش WHATSAPP_BOT_ENABLED ولا WHATSAPP_BOT_HANDOFF_HOURS.
     setBotRuntime(fn): fn(ev) بترجّع true لو البوت «ماسك» الرسالة (أي وضع غير off) ⇒ الرد الآلي القديم مايشتغلش.
     setBot القديمة باقية بالاسم بس (مابتعملش حاجة) عشان أي كود قديم بيناديها مايقعش. */
  let botRuntime = null;
  const setBotRuntime = (fn) => { botRuntime = typeof fn === "function" ? fn : null; };
  const setBot = () => {};
  /* الكاشير رد من الموبايل (صدى) على العميل ده خلال آخر `hours` ساعة؟ — البوت والرد الآلي القديم بيسكتوا. */
  async function humanActive(pn, hours = 12) {
    const h = Math.max(0, Number(hours) || 0);
    if (!h) return false;
    const r = await pool.query(
      `SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND source='echo' AND created_at > NOW() - make_interval(hours => $2::int) AND ${STAFF_ECHO_SQL} LIMIT 1`,
      [pn, Math.ceil(h)]).catch(() => ({ rowCount: 0 }));
    return r.rowCount > 0;
  }

  // التوكن: WHATSAPP_TOKEN لو اتحط، وإلا توكن مستخدم النظام الدائم (META_CAPI_TOKEN).
  const token = () => env("WHATSAPP_TOKEN") || env("META_CAPI_TOKEN");
  /* W5 (١٢/١٠): الأرقام الفعّالة = آخر ربط ناجح (wacloud.js بيحطها هنا من settings.waCloudActive) وإلا الـenv.
     كده بعد ربط ناجح على حساب/رقم جديد الإرسال والقوالب والصندوق بيقروا الأرقام الجديدة من غير تعديل env أعمى.
     مفيش أي إرسال بيتفتح من هنا: WHATSAPP_ENABLED وكل المفاتيح زي ما هي. */
  let activeIds = { phoneId: null, wabaId: null, source: "env" };
  const setActiveIds = (a) => {
    const p = a && a.phoneId ? String(a.phoneId).replace(/\D/g, "") : null, w = a && a.wabaId ? String(a.wabaId).replace(/\D/g, "") : null;
    activeIds = p || w ? { phoneId: p, wabaId: w, source: (a && a.source) || "onboarding" } : { phoneId: null, wabaId: null, source: "env" };
    return idsInUse();
  };
  const phoneId = () => activeIds.phoneId || env("WHATSAPP_PHONE_ID");
  const wabaId = () => activeIds.wabaId || env("WHATSAPP_WABA_ID");
  const idsInUse = () => ({ phoneId: phoneId() || null, wabaId: wabaId() || null,
    phoneSource: activeIds.phoneId ? activeIds.source : (env("WHATSAPP_PHONE_ID") ? "env" : null),
    wabaSource: activeIds.wabaId ? activeIds.source : (env("WHATSAPP_WABA_ID") ? "env" : null),
    envPhoneId: env("WHATSAPP_PHONE_ID") || null, envWabaId: env("WHATSAPP_WABA_ID") || null });
  /* أرقام إضافية الويب هوك يقبلها (wacloud.js: phone_id بتاع آخر ربط + رقمنا المعروض) */
  let webhookAccept = () => ({ phoneIds: [], ownNumbers: [] });
  const setWebhookAccept = (fn) => { if (typeof fn === "function") webhookAccept = fn; };
  const masterOn = () => env("WHATSAPP_ENABLED") === "1";
  /* مفتاح الخادم = قفل صلب فوق مفتاح اللوحة (الاتنين لازم يسمحوا):
       "1"                 ⇒ allow  (الخادم سامح — القرار لمفتاح المالك في اللوحة)
       "0"/off/false/no    ⇒ kill   (قفل صريح: ولا رسالة، ولا حتى لأرقام التجربة)
       مش مكتوب            ⇒ unset  (العملاء مقفولين زي الأول؛ أرقام التجربة بس شغّالة) */
  const envState = () => {
    const v = env("WHATSAPP_ENABLED").toLowerCase();
    return v === "1" ? "allow" : (["0", "off", "false", "no"].includes(v) ? "kill" : "unset");
  };
  const configured = () => Boolean(token() && phoneId());
  const HISTORY_MAX = () => Math.max(0, Number(env("WHATSAPP_HISTORY_MAX", "20000")) || 0);

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_optins (
        phone_norm TEXT PRIMARY KEY,
        updates BOOLEAN NOT NULL DEFAULT FALSE,     -- تحديثات الطلب (utility)
        marketing BOOLEAN NOT NULL DEFAULT FALSE,   -- عروض/سلة متروكة (marketing)
        source TEXT, order_no TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS wa_messages (
        id BIGSERIAL PRIMARY KEY,
        wamid TEXT UNIQUE,
        direction TEXT NOT NULL,                    -- out | in
        phone_norm TEXT,
        template TEXT, category TEXT, order_no TEXT, stage TEXT,
        status TEXT,                                -- accepted|sent|delivered|read|failed|skipped|received
        error TEXT,
        pricing JSONB,
        body TEXT,
        fallback_sms TEXT,                          -- نص SMS البديل لو الرسالة فشلت
        fallback_done BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS wa_messages_phone_idx ON wa_messages(phone_norm, created_at DESC);
      CREATE INDEX IF NOT EXISTS wa_messages_order_idx ON wa_messages(order_no);
      -- Coexistence (٢٨/٩): مصدر الرسالة — api | echo (من الموبايل) | history | campaign
      ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS source TEXT;
      ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS msg_type TEXT;
      ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS echo_kind TEXT;   -- M1: صدى موبايل المطعم «auto» (رد آلي من تطبيق واتساب بزنس) أو «staff» — waecho.js
      ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS media JSONB;      -- MD1: بيانات ملف الرسالة (mediaOf)
      ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS revoked_wamid TEXT;      -- CR2: صف «رسالة اتمسحت» ⇒ wamid الرسالة اللي اتمسحت (نسختها بتفضل زي ما هي)
      -- SEC (١٢/١٠): العميل كتب «إيقاف» على واتساب ⇒ ولا قالب (تسويق ولا تحديثات) لحد ما يرجع يوافق.
      -- عمود مستقل عشان source بيتكتب فوقه مع كل طلب (shop.js) فماينفعش يبقى هو العلامة.
      ALTER TABLE wa_optins ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMPTZ;
      -- TC2 (١٣/١٠، قرار المالك: العروض للكل إلا اللي طلب إيقاف): علامة «رفض العروض» الصريحة من أي مصدر (إيقاف في واتساب،
      -- رفض من المتجر). عمود marketing لوحده مايكفيش: صف جديد بيتولد false من غير ما العميل يقول حاجة.
      ALTER TABLE wa_optins ADD COLUMN IF NOT EXISTS marketing_off_at TIMESTAMPTZ;
      -- أسماء جهات الاتصال من تطبيق واتساب بزنس + اسم البروفايل من الوارد
      -- ١٤/١٠ (wapolicy.js): رسايل طلب اتشالت عمداً والنافذة مقفولة («بنجهّز» / التقييم اندمج في التوصيل) — للتقرير اليومي (مش wa_messages: صف هناك = رسالة صادرة)
      CREATE TABLE IF NOT EXISTS wa_policy_skips (
        id BIGSERIAL PRIMARY KEY,
        order_no TEXT, phone_norm TEXT, stage TEXT, reason TEXT,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS wa_policy_skips_at_idx ON wa_policy_skips(at);
      CREATE TABLE IF NOT EXISTS wa_contact_names (
        phone_norm TEXT PRIMARY KEY,
        full_name TEXT, first_name TEXT, profile_name TEXT,
        removed BOOLEAN NOT NULL DEFAULT FALSE,
        src_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- صحة الويب هوك: آخر حدث لكل field (للوحة الحالة)
      CREATE TABLE IF NOT EXISTS wa_webhook_health (
        field TEXT PRIMARY KEY,
        last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        n BIGINT NOT NULL DEFAULT 0,
        last_note TEXT
      );
      CREATE TABLE IF NOT EXISTS wa_template_events (
        id BIGSERIAL PRIMARY KEY,
        name TEXT, language TEXT, template_id TEXT, event TEXT, reason TEXT,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS wa_history_state (
        id INT PRIMARY KEY DEFAULT 1,
        imported INT NOT NULL DEFAULT 0,
        skipped INT NOT NULL DEFAULT 0,
        chunks INT NOT NULL DEFAULT 0,
        last_meta JSONB, errors JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO wa_history_state(id) VALUES (1) ON CONFLICT DO NOTHING;
    `);
  }
  const ready = ensureSchema()
    .then(() => console.log(`[wa] ready (master=${masterOn() ? "ON" : "off"}, configured=${configured()})`))
    .catch((e) => console.error("[wa] init failed:", e.message));

  async function settingsOn() {
    try { return (await getSettingsData())?.notifications?.whatsappEnabled === true; }
    catch { return false; }
  }

  /* مفتاح المالك في اللوحة (settings.waMaster.enabled) — بيتكتب من مسار واحد للمالك بس (wacloud.js: POST /api/cms/wa-cloud/master)،
     ومحمي من الحفظ العام للإعدادات (settings-guard.js: SERVER_OWNED_PATHS). الافتراضي مقفول. */
  const dashMasterOf = (s) => Boolean(s && s.waMaster && s.waMaster.enabled === true);
  const testPhonesOf = (s) => staffPhones(s && s.waBot && s.waBot.testPhones);
  async function settingsSnap() {
    try { return (await getSettingsData()) || {}; } catch { return null; }   // مش قادرين نقرا الإعدادات = مقفول
  }
  /* أقفال القناة (من غير العميل): السبب اللي بيمنع، أو null. نفس الترتيب القديم + مفتاح المالك.
     SW1 (١٣/١٠ — M6): المسارين اتفصلوا.
       kind "session"  = رد حر جوّه نافذة الـ٢٤ ساعة (البوت + رد الموظف): مفتاح الخادم + الإعداد + مفتاح المالك. **مش** محتاج
                         notifications.whatsappEnabled — المفتاح ده بتاع القوالب (تحديثات الطلب والحملات) ومايصحّش يقفل الرد على عميل كلّمنا.
       kind "template" = القوالب: الأربعة زي الأول (الافتراضي، وأي منادي قديم بيفضل على الأربعة). */
  function channelBlock(s, kind = "template") {
    if (envState() !== "allow") return "disabled";
    if (!configured()) return "unconfigured";
    if (!s) return "settings_unreadable";
    if (!dashMasterOf(s)) return "master_off";
    if (kind !== "session" && !(s.notifications && s.notifications.whatsappEnabled === true)) return "settings_off";
    return null;
  }

  /* كام طلب متسجّل معاه قبول الشروط (للوحة والتحقق بعد النشر). الجدول مش موجود/خطأ = null */
  async function termsRecorded() {
    try { return (await pool.query("SELECT count(DISTINCT order_no)::int AS n FROM wa_optin_log WHERE kind='terms'")).rows[0]?.n ?? 0; }
    catch { return null; }
  }

  /* السبب اللي بيمنع الإرسال، أو null لو كله تمام. SW1: gate("session") = أقفال الرد الحر (من غير مفتاح تحديثات الطلب). */
  async function gate(kind = "template") {
    return channelBlock(await settingsSnap(), kind === "session" ? "session" : "template");
  }

  /* موافقة العميل. stopped = كتب «إيقاف» على واتساب ولسه مارجعش. للتحديثات: موافقة صريحة **بعد** الإيقاف بترجّعها
     (waconsent.js بيكتب updates_answered_at)؛ للتسويق: «START» بس (بيمسح stopped_at). */
  async function optInOf(phoneNorm) {
    const r = await pool.query(
      `SELECT updates, marketing, stopped_at, marketing_off_at, (to_jsonb(wa_optins)->>'updates_answered_at')::timestamptz AS answered_at
         FROM wa_optins WHERE phone_norm=$1`, [phoneNorm]);
    const o = r.rows[0] || {};
    const stoppedAt = o.stopped_at ? new Date(o.stopped_at).getTime() : null;
    const answeredAt = o.answered_at ? new Date(o.answered_at).getTime() : null;
    return { updates: o.updates === true, marketing: o.marketing === true, stopped: Boolean(stoppedAt), marketingOff: Boolean(o.marketing_off_at),
      stoppedForUpdates: Boolean(stoppedAt) && !(answeredAt && answeredAt > stoppedAt),
      saidNoToUpdates: Boolean(answeredAt) && o.updates !== true };   // جاوب «لا» بنفسه (سؤال قديم/الحساب/البوت)
  }
  async function marketingSuppressed(phoneNorm) {
    try {
      const r = await pool.query("SELECT 1 FROM cms_contacts WHERE phone_norm=$1 AND opted_out_at IS NOT NULL", [phoneNorm]);
      return r.rowCount > 0;
    } catch (e) {
      return !(e && e.code === "42P01");   // الجدول مش موجود = مفيش إيقاف مسجّل؛ أي خطأ تاني = مانبعتش
    }
  }

  /* ══ الحارس المركزي ════════════════════════════════════════════════════════════════════════════════════
     كل إرسال واتساب (قالب، رد حر من الصندوق/البورتال، حملة، أتمتة، بوت، تجربة) لازم يعدّي من هنا.
       kind:     "template" (بيتدفع، بره النافذة) | "session" (رد حر جوّه نافذة الـ٢٤ ساعة)
       template: اسم القالب (الفئة بتتاخد من السجل — المنادي مايقدرش يدّعي فئة)
       orderNo:  الطلب اللي الرسالة عنه (للقوالب الخدمية: الموافقة = الطلب ده اتعمل تحت شروط بتذكر واتساب)
       purpose:  "marketing" بيفرض موافقة التسويق مهما كانت فئة القالب (الحملات)
       test:     إرسال تجربة — للأرقام اللي في قايمة التجربة في اللوحة **بس** (allowList بتضيّق، ماتوسّعش)
     بيرجّع {ok:true, ticket} أو {ok:false, reason}. التذكرة لرقم واحد، مرة واحدة، ودقيقة واحدة. */
  /* العميل كلّمنا في آخر ٢٤ ساعة؟ (رسالة حقيقية وصلت على الويب هوك، مش تاريخ مستورد) */
  async function windowOpen(pn) {
    const r = await pool.query(
      `SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND direction='in' AND COALESCE(source,'api') <> 'history'
          AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`, [pn]);
    return Boolean(r.rows && r.rows.length);
  }
  /* QP1 (M7-6): سقف العميل للقوالب التسويقية — واحد كل ٧ أيام و٣ كل ٣٠ يوم، من أي حملة أو أتمتة (العدّ من wa_messages:
     قالب اتقبل وفئته تسويق أو مصدره حملة). الحدود من settings.waCloud (custCap7d / custCap30d). ماقدرناش نعدّ ⇒ مانبعتش. */
  async function marketingCapReason(pn, s) {
    try {
      const r = await pool.query(
        `SELECT count(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS d7, count(*)::int AS d30
           FROM wa_messages WHERE phone_norm=$1 AND direction='out' AND template IS NOT NULL
            AND (category='MARKETING' OR source='campaign') AND COALESCE(status,'') NOT IN ('failed','skipped')
            AND created_at > NOW() - INTERVAL '30 days'`, [pn]);
      return custCapReason((r.rows && r.rows[0]) || {}, custCapOf(s));
    } catch { return "marketing_cap_unreadable"; }
  }
  /* RV1 (عمر ١٥/١٠: «عملاء المحل صالة وتيك أواي موافقين مسبقاً وقت الدفع عند الكاشير») — أساس موافقة تالت للقالب الخدمي، ضيّق بالقصد:
     قالب التقييم بس (POS_REVIEW_CONSENT.templates) · المصدر "review" (مسح التقييمات) · الطلب فاتورة كاشير pos:… · ميتا ماحوّلتش القالب تسويق ·
     إعداد «عملاء الكاشير موافقين وقت الدفع» مفتوح · وصف إثبات pos_payment لنفس الجوال ونفس الفاتورة (waconsent.js). أي حاجة تانية ⇒ لأ.
     بيتنده بعد «إيقاف» و«لا» الصريحة (هما بيغلبوه)، وجوّه فرع الخدمي بس — العروض وقواعدها مابتتلمسش. */
  async function posReviewBasis({ s, template, source, orderNo, pn }) {
    if (!POS_REVIEW_CONSENT.templates.includes(template) || source !== "review") return false;
    if (!/^pos:/.test(String(orderNo || ""))) return false;
    if (Object.keys(CAT.META_CATEGORY || {}).some((k) => k.startsWith(`${template}:`))) return false;
    if (posReviewConsentOn(s) && await posReviewConsentCovers(pool, pn, orderNo)) return true;
    /* KA2 (عمر ١٨/١٠: «كيتا هي اللي بتبعتلنا الرقم، موافقين») — طلب التقييم لطلب كيتا اللي KA2 دخّلته (صف keeta_order لنفس الجوال والطلب) والمفتاح مفتوح */
    return KA2_REVIEW_CONSENT.templates.includes(template) && ka2ReviewConsentOn(s) && ka2ReviewConsentCovers(pool, pn, orderNo);
  }
  const TICKETS = new WeakSet();
  const TICKET_TTL_MS = 60_000;
  async function guardSend({ phoneNorm, kind, template = null, purpose = null, source = null, test = false, allowList = null, fromId = null, orderNo = null, staff = false, courier = false, proactive = false, stage = null } = {}) {
    const no = (reason) => ({ ok: false, reason });
    await ready;
    const pn = String(phoneNorm || "");
    const to = toWaId(pn);
    if (!to) return no("invalid_phone");
    if (kind !== "template" && kind !== "session") return no("bad_kind");
    const isTest = test === true || Array.isArray(allowList);
    const s = await settingsSnap();
    const grant = () => {
      const ticket = Object.freeze({ to, phoneNorm: pn, kind, test: isTest, fromId: isTest && fromId ? String(fromId) : null, at: Date.now() });
      TICKETS.add(ticket);
      return { ok: true, ticket, test: isTest };
    };
    if (isTest) {
      if (envState() === "kill") return no("disabled");
      if (!configured()) return no("unconfigured");
      if (!s) return no("settings_unreadable");
      if (!testPhonesOf(s).includes(pn)) return no("not_in_allow_list");
      if (Array.isArray(allowList) && !staffPhones(allowList).includes(pn)) return no("not_in_allow_list");
      /* رسالة حرة لرقم تجربة: نفس شرط النافذة (ميتا بترفضها بره الـ٢٤ ساعة أصلاً) — التجربة مابتعدّيش قاعدة العملاء دي */
      if (kind === "session" && !(await windowOpen(pn))) return no("window_closed");
      return grant();
    }
    /* ST1: قالب لموظف (staff) مش «تحديث طلب لعميل» ⇒ أقفال الرد الحر (الخادم + الإعداد + مفتاح المالك) من غير مفتاح تحديثات الطلب */
    const staffTpl = (staff === true || courier === true) && kind === "template";      // CW1: قالب المندوب الخارجي زي قالب الفريق — أقفال الرد الحر
    const blocked = channelBlock(s, staffTpl ? "session" : kind);      // SW1: الرد الحر مابيقفش على مفتاح تحديثات الطلب
    if (blocked) return no(blocked);
    /* CJ1a (١٧/١٠ — عمر: «ليه ٣ رسايل في دقيقتين»): رحلة العميل في النافذة (wajourney.js)
         (١) proactive:true (حملة / متابعة / حارس النافذة / «أنا معك» / تأكيد المحادثة / طلب التقييم) والعميل وصلته رسالة من أي نظام من أقل من burstHoldMin
             ⇒ burst_hold + until: المنادي بيأجّل لحد الوقت ده (مش بيلغي). تحديثات الطلب والرد على كلام العميل مش proactive فمابيتلمسوش.
         (٤) رسالة عن طلب (orderNo + stage) من غير ما تكون رد على العميل / فريق / تجربة: سقف رسايل الطلب الواحد ⇒ order_cap / order_cap_low (policy:true =
             مفيش SMS بدلها، وبيتسجّل في wa_policy_skips للتقرير). ماقدرناش نعدّ ⇒ تحديث الطلب بيعدّي (السقف مش موافقة). */
    if (!staff && !courier) {
      if (proactive === true) {
        const until = await holdUntil((sql, p) => pool.query(sql, p).then((r) => (r && r.rows) || []), { phone: pn, cfg: s && s.waBot });
        if (until) return { ok: false, reason: "burst_hold", until: until.toISOString() };
      }
      if (orderNo && stage && !CAP_EXEMPT_SOURCES.has(String(source || ""))) {
        const jc = journeyCfg(s && s.waBot);
        if (jc.journeyBursts && jc.orderMsgCap > 0) {
          let sent = null;
          try { const r = await pool.query(ORDER_SENT_SQL, [String(orderNo)]); sent = r && r.rows && r.rows[0] ? Number(r.rows[0].n) || 0 : 0; } catch { sent = null; }
          if (sent !== null) {
            const dec = orderCapDecision({ sent, stage, cap: jc.orderMsgCap, tail: jc.orderMsgTail });
            if (!dec.ok) {
              pool.query("INSERT INTO wa_policy_skips(order_no, phone_norm, stage, reason) VALUES ($1,$2,$3,$4)", [String(orderNo).slice(0, 30), pn, String(stage).slice(0, 30), dec.reason]).catch(() => {});
              return { ok: false, reason: dec.reason, policy: true };
            }
          }
        }
      }
    }
    if (kind === "session") {
      // رد حر: العميل لازم يكون كلّمنا في آخر ٢٤ ساعة (رسالة حقيقية وصلت على الويب هوك، مش تاريخ مستورد)
      if (!(await windowOpen(pn))) return no("window_closed");
      return grant();
    }
    const t = TEMPLATES[template];
    if (!t) return no("unknown_template");
    /* ST1 (١٢/١٠ — تنبيهات الفريق على واتساب): قالب فريق لموظف. الحارس نفسه بيتأكد — المنادي مايقدرش يدّعي:
         • الرقم في دليل الفريق في الإعدادات (settings.waTeam.members، أو أرقام التنبيهات لحد ما الدليل يتكتب) وإلا not_staff
         • القالب من مجموعة «الفريق» في الكتالوج، فئته UTILITY، وميتا ماحوّلتوش تسويق، ومش حملة — وإلا not_staff_template
       موافقة العميل (wa_optins) مابتتطلبش: ده موظف عندنا مش عميل. أي رقم تاني أو أي قالب تاني بيكمل على قواعد العملاء تحت زي ما هو. */
    /* PH1: آخر خطوة قبل التذكرة لأي قالب (بعد كل قواعد الموافقة، فالتجربة مابتتحرقش على رقم مرفوض أصلاً) */
    const holdCtx = (mk) => ({ template, category: t.category, marketing: mk, source, orderNo, phoneNorm: pn });
    /* CW1 (١٦/١٠ — أزرار المندوب الخارجي): قالب «طلب توصيل» لمندوب خارجي. الحارس نفسه بيتأكد — المنادي مايقدرش يدّعي:
         • الرقم = جوال مندوب على رحلة خارجية شغّالة (dl_ext_runs: مش ملغية ولا متسلّمة ولا منتهية) وإلا not_courier
         • القالب من مجموعة «المندوب» في الكتالوج، فئته UTILITY، وميتا ماحوّلتوش تسويق، ومش حملة — وإلا not_courier_template
       موافقة العميل مابتتطلبش: ده مندوب شغّال على طلب عندنا والمدير كتب رقمه بإيده، مش عميل. */
    if (courier === true) {
      const reclassed = Object.keys(CAT.META_CATEGORY || {}).some((k) => k.startsWith(`${template}:`));
      if (t.group !== "courier" || t.category !== "UTILITY" || reclassed || purpose === "marketing" || source === "campaign") return no("not_courier_template");
      let live = false;
      try {
        const r = await pool.query(
          `SELECT 1 FROM dl_ext_runs WHERE right(regexp_replace(COALESCE(courier_phone,''), '[^0-9]', '', 'g'), 9) = $1
              AND revoked_at IS NULL AND delivered_at IS NULL AND expires_at > NOW() LIMIT 1`, [pn]);
        live = Boolean(r.rows && r.rows.length);
      } catch { live = false; }
      if (!live) return no("not_courier");
      if (await holdBlocks(holdCtx(false))) return no("pay_hold");      // PH1: وقت مشكلة الدفع مفيش قالب مدفوع
      return grant();
    }
    if (staff === true) {
      if (!staffRoleOf(s, pn)) return no("not_staff");
      const reclassed = Object.keys(CAT.META_CATEGORY || {}).some((k) => k.startsWith(`${template}:`));
      if (t.group !== "staff" || t.category !== "UTILITY" || reclassed || purpose === "marketing" || source === "campaign") return no("not_staff_template");
      if (await holdBlocks(holdCtx(false))) return no("pay_hold");
      return grant();
    }
    const marketing = t.category === "MARKETING" || purpose === "marketing" || source === "campaign";
    if (t.category === "AUTHENTICATION" && !marketing) return (await holdBlocks(holdCtx(false))) ? no("pay_hold") : grant();   // كود تحقق العميل طلبه بنفسه
    const o = await optInOf(pn);
    if (marketing) {
      /* TC2 (١٣/١٠، قرار المالك بنصّه: «العروض التسويقية تكون للكل على مسئوليتي الا لو العميل طلب ايقاف»):
         العروض بتتبعت لأي عميل **إلا** اللي طلب إيقاف — «إيقاف» في واتساب، رفض صريح للعروض من أي مصدر، أو إيقاف رسايل
         التسويق عموماً (cms_contacts). مابقاش فيه شرط موافقة مسبقة على العروض. */
      if (o.stopped || o.marketingOff || await marketingSuppressed(pn)) return no("opted_out");
      const capped = await marketingCapReason(pn, s);      // QP1: marketing_cap_7d | marketing_cap_30d | marketing_cap_unreadable
      if (capped) return no(capped);
    } else {
      /* TC (١٣/١٠، قرار عمر): القالب الخدمي بيتبعت لو
           • العميل مش موقِّف («إيقاف» بيغلب أي حاجة، حتى طلب جديد)، و
           • (وافق صراحةً على التحديثات) أو (الرسالة عن طلب متسجّل إنه اتعمل تحت شروط بتذكر تحديثات الطلب على واتساب
             — وما قالش «لا» بنفسه قبل كده).
         من غير طلب، أو طلب قديم مالوش قبول متسجّل ⇒ no_optin. */
      if (o.stoppedForUpdates) return no("opted_out");
      if (!o.updates) {
        if (o.saidNoToUpdates) return no("no_optin");
        if (!(orderNo && await termsCoverOrder(pool, pn, orderNo)) && !(await posReviewBasis({ s, template, source, orderNo, pn }))) return no("no_optin");
      }
    }
    if (await holdBlocks(holdCtx(marketing))) return no("pay_hold");
    return grant();
  }

  /* المكان الوحيد اللي بيكلّم ‎/messages‎. من غير تذكرة من guardSend = خطأ، ومفيش طلب شبكة. */
  async function deliver(ticket, payload) {
    const refuse = (code) => { throw Object.assign(new Error(`WhatsApp send refused: ${code}`), { code }); };
    if (!ticket || !TICKETS.has(ticket)) refuse("WA_NO_GUARD");
    TICKETS.delete(ticket);
    if (Date.now() - ticket.at > TICKET_TTL_MS) refuse("WA_GUARD_EXPIRED");
    if (!payload || String(payload.to) !== ticket.to) refuse("WA_GUARD_MISMATCH");
    if ((payload.type === "template") !== (ticket.kind === "template")) refuse("WA_GUARD_MISMATCH");
    /* «مقروء + جاري الكتابة» (sendTyping): مش رسالة — جسم Graph بتاعها مافيهوش «to». الرقم بيتراجع هنا على التذكرة زي أي إرسال، وبعدها بيتشال من الجسم. */
    let body = payload;
    if (payload.status === "read" && payload.message_id) { if (ticket.kind !== "session") refuse("WA_GUARD_MISMATCH"); const { to: _to, ...receipt } = payload; body = receipt; }
    return graphPost(`${ticket.fromId || phoneId()}/messages`, body);
  }

  async function recordOptIn({ phone, updates, marketing, source = "checkout", orderNo = null }) {
    const pn = normPhone(phone);
    if (!/^5\d{8}$/.test(pn)) return { ok: false, error: "invalid_phone" };
    await pool.query(
      `INSERT INTO wa_optins(phone_norm, updates, marketing, source, order_no, marketing_off_at)
       VALUES ($1, COALESCE($2,FALSE), COALESCE($3,FALSE), $4, $5, CASE WHEN $3 IS FALSE THEN NOW() END)
       ON CONFLICT (phone_norm) DO UPDATE SET
         updates = COALESCE($2, wa_optins.updates),
         marketing = COALESCE($3, wa_optins.marketing),
         source = EXCLUDED.source, order_no = COALESCE(EXCLUDED.order_no, wa_optins.order_no),
         marketing_off_at = CASE WHEN $3 IS FALSE THEN COALESCE(wa_optins.marketing_off_at, NOW()) WHEN $3 IS TRUE THEN NULL ELSE wa_optins.marketing_off_at END,
         updated_at = NOW()`,
      [pn, typeof updates === "boolean" ? updates : null, typeof marketing === "boolean" ? marketing : null,
       String(source).slice(0, 40), orderNo ? String(orderNo).slice(0, 30) : null]);
    return { ok: true };
  }

  async function logOut(row) {
    try {
      await pool.query(
        `INSERT INTO wa_messages(wamid, direction, phone_norm, template, category, order_no, stage, status, error, body, fallback_sms, source)
         VALUES ($1,'out',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (wamid) DO NOTHING`,
        [row.wamid || null, row.phone_norm || null, row.template || null, row.category || null,
         row.order_no || null, row.stage || null, row.status, row.error || null,
         row.body || null, row.fallback_sms || null, row.source || "api"]);
      /* MD3: ملف أرسله موظف (صورة / ملف / رسالة صوتية) — بياناته قبل ما المحادثة تتحدّث، عشان الشاشات تلاقيه أول ما تقرا */
      if (row.media && row.wamid) await pool.query("UPDATE wa_messages SET media=$2::jsonb, msg_type=$3 WHERE wamid=$1", [row.wamid, JSON.stringify(row.media), row.media.kind || null]);
    } catch (e) { console.error("[wa] log failed:", e.message); }
    // الصادر اللي ميتا قبلته بس بيظهر في المحادثة (الفاشل له صفه في wa_messages).
    if (row.status === "accepted" && row.phone_norm) {
      await touchThread({ phoneNorm: row.phone_norm, direction: "out",
        text: row.body || (row.template ? `[قالب: ${row.template}]` : ""), orderNo: row.order_no || null });
    }
  }

  async function graphPost(path, payload) {
    const resp = await doFetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) {
      throw Object.assign(new Error(data.error?.message || `HTTP ${resp.status}`),
        { code: `WA_${data.error?.code || resp.status}`, graph: data.error || null });
    }
    return data;
  }

  async function graphGet(path) {
    const resp = await doFetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, { method: "GET", headers: { Authorization: `Bearer ${token()}` } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) throw Object.assign(new Error(data.error?.message || `HTTP ${resp.status}`), { code: `WA_${data.error?.code || resp.status}`, graph: data.error || null });      // RV4: graph زي graphPost (metaErrorOf)
    return data;
  }

  /* MD1: ملف رسالة من ميتا — قراءة بس (مش إرسال، فمفيش حارس): رقم الملف ⇒ رابط مؤقت ⇒ البايتات، والاتنين بتوكن السيرفر.
     التوكن بيتبعت لدومينات ميتا بس (mediaHostOk). بيرجّع {ok, buf, mime} أو {ok:false, error: expired|too_large|unconfigured|bad_id|bad_host|unavailable}. */
  async function fetchMedia(mediaId, { maxBytes = 25 * 1024 * 1024 } = {}) {
    if (!/^\d{5,40}$/.test(String(mediaId || ""))) return { ok: false, error: "bad_id" };
    if (!configured()) return { ok: false, error: "unconfigured" };
    let meta;
    try { meta = await graphGet(String(mediaId)); }
    catch (e) { return { ok: false, error: /^WA_(100|404)$/.test(String(e.code || "")) ? "expired" : "unavailable" }; }
    if (!meta || !meta.url || !mediaHostOk(meta.url)) return { ok: false, error: "bad_host" };
    if (Number(meta.file_size) > maxBytes) return { ok: false, error: "too_large" };
    const resp = await doFetch(String(meta.url), { method: "GET", headers: { Authorization: `Bearer ${token()}` } });
    if (!resp.ok) return { ok: false, error: resp.status === 404 ? "expired" : "unavailable" };
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, error: "too_large" };
    if (!buf.length) return { ok: false, error: "unavailable" };
    return { ok: true, buf, mime: meta.mime_type ? String(meta.mime_type) : null };
  }

  /* MD3 (١٦/١٠، عمر: «الموظفين يقدروا يبعتوا صور ومرفقات وصوت»): رفع ملف لميتا ⇒ رقم الملف (media id) اللي رسالة الصورة/الملف/الصوت
     بتشاور عليه. **ده مش إرسال**: مابيوصلش لأي عميل — الإرسال نفسه بعدها من الباب الوحيد (sendFreeform ⇒ guardSend ⇒ deliver).
     التوكن رايح لـgraph.facebook.com بس. بيرجّع {ok, id} أو {ok:false, error: disabled|unconfigured|bad_file|upload_failed, code?, message?}. مابيرميش. */
  async function uploadMedia({ buf, mime, filename = null } = {}) {
    if (envState() === "kill") return { ok: false, error: "disabled" };
    if (!configured()) return { ok: false, error: "unconfigured" };
    const type = String(mime || "").split(";")[0].trim().toLowerCase();
    if (!Buffer.isBuffer(buf) || !buf.length || !/^[a-z]+\/[a-z0-9.+-]+$/.test(type)) return { ok: false, error: "bad_file" };
    try {
      const fd = new FormData();
      fd.append("messaging_product", "whatsapp");
      fd.append("type", type);
      fd.append("file", new Blob([buf], { type }), String(filename || "file").replace(/[\u0000-\u001f"\/]+/g, "_").slice(0, 120) || "file");
      const resp = await doFetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId()}/media`, { method: "POST", headers: { Authorization: `Bearer ${token()}` }, body: fd });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.error || !/^\d{5,40}$/.test(String(data.id || ""))) {
        return { ok: false, error: "upload_failed", code: Number(data.error?.code) || resp.status || null, message: String(data.error?.message || `HTTP ${resp.status}`).slice(0, 200) };
      }
      return { ok: true, id: String(data.id) };
    } catch (e) { return { ok: false, error: "upload_failed", code: null, message: String(e.message || e).slice(0, 200) }; }
  }

  /* الإرسال الأساسي. مابيرميش — بيرجّع {ok, wamid?, skipped?, error?, code?}.
     source/body اختياريين: الحملات بتبعت نص القالب بعد التعويض عشان يظهر في
     المحادثة زي ما العميل شافه (مش «[قالب: …]»). */
  async function sendTemplate({ phoneNorm, template, params = {}, orderNo = null, stage = null, fallbackSms = null,
    requireOptIn = true, source = null, body = null, lang = null, allowList = null, test = false, staff = false, courier = false, proactive = false }) {
    await ready;
    const t = TEMPLATES[template];
    if (!t) return { ok: false, error: "unknown_template" };
    const to = toWaId(phoneNorm);
    if (!to) return { ok: false, skipped: "invalid_phone" };
    /* SEC: الحارس المركزي — أقفال القناة + موافقة العميل حسب فئة القالب. requireOptIn اتلغى مفعوله (الموافقة دايماً
       مطلوبة)؛ الاستثناء الوحيد = أرقام التجربة اللي في اللوحة (test / allowList). */
    void requireOptIn;
    const g = await guardSend({ phoneNorm, kind: "template", template, source, purpose: source === "campaign" ? "marketing" : null,
      test, allowList, orderNo, staff, courier, proactive: proactive === true || source === "campaign" || source === "review" || source === "ka2", stage });      // CJ1a: الحملة وطلب التقييم ورسالة KA2 مبادِرين دايماً
    if (!g.ok) return { ok: false, skipped: g.reason, ...(g.until ? { until: g.until } : {}), ...(g.policy ? { policy: true } : {}) };
    const language = lang || t.language || "ar";
    const bad = paramProblem(template, params, language);
    if (bad) {
      await logOut({ phone_norm: phoneNorm, template, category: t.category, order_no: orderNo, stage, status: "skipped",
        error: `param:${bad}`.slice(0, 120), source });
      return { ok: false, skipped: "missing_param", detail: bad };
    }
    const text = body || renderTemplateText(template, params) || null;
    try {
      const data = await deliver(g.ticket, buildTemplatePayload(template, to, params, language));
      const wamid = data.messages?.[0]?.id || null;
      await logOut({ wamid, phone_norm: phoneNorm, template, category: t.category, order_no: orderNo,
        stage, status: "accepted", fallback_sms: fallbackSms, source, body: text });
      return { ok: true, wamid };
    } catch (e) {
      await logOut({ phone_norm: phoneNorm, template, category: t.category, order_no: orderNo, stage,
        status: "failed", error: String(e.code || e.message).slice(0, 120), source, body: text });
      const code = Number(String(e.code || "").replace(/^WA_/, "")) || null;
      return { ok: false, error: String(e.code || "send_failed"), code, message: String(e.message || "").slice(0, 200) };
    }
  }

  /* ST1: قالب فريق لموظف من دليل الفريق (wateam.js). المتغيّرات بتتبني من بيانات الكتالوج، والحارس بيتأكد إن الرقم موظف والقالب قالب فريق. */
  async function sendStaffTemplate({ phoneNorm, template, data = {}, lang = "ar" }) {
    const t = TEMPLATES[template];
    if (!t || typeof t.bind !== "function") return { ok: false, error: "unknown_template" };
    const language = t.variants && t.variants[lang] ? lang : (t.language || "ar");
    return sendTemplate({ phoneNorm, template, params: t.bind(data || {}), lang: language, source: "team", staff: true });
  }

  /* رسالة حرة بجسم Cloud API جاهز (نص / interactive) — للبوت. جوّه نافذة الـ٢٤ ساعة بس (المنادي مسؤول عنها).
     allowList = وضع التجربة: للأرقام دي بس ومن غير مفاتيح العملاء. من غيرها = البوابة الكاملة (gate).
     محاولة واحدة، مفيش إعادة. بيرجّع {ok, wamid?} أو {ok:false, skipped|error, code?, message?}. */
  async function sendFreeform({ phoneNorm, payload, source = "bot", allowList = null, preview = null, test = false, orderNo = null, stage = null, fallbackSms = null, media = null, proactive = false }) {
    await ready;
    const to = toWaId(phoneNorm);
    if (!to) return { ok: false, skipped: "invalid_phone" };
    if (!payload || !payload.type || payload.type === "template") return { ok: false, skipped: "bad_payload" };
    const g = await guardSend({ phoneNorm, kind: "session", source, test, allowList, proactive: proactive === true, orderNo, stage });      // CJ1a: الهدوء بعد آخر رسالة + سقف رسايل الطلب
    if (!g.ok) return { ok: false, skipped: g.reason, ...(g.until ? { until: g.until } : {}), ...(g.policy ? { policy: true } : {}) };
    const text = String(preview || payload.text?.body || payload.interactive?.body?.text || `[${payload.type}]`).slice(0, 500);
    try {
      const data = await deliver(g.ticket, { ...payload, messaging_product: "whatsapp", recipient_type: "individual", to });
      const wamid = data.messages?.[0]?.id || null;
      await logOut({ wamid, phone_norm: phoneNorm, status: "accepted", source, body: text, order_no: orderNo, stage, fallback_sms: fallbackSms, media });      // SB4: تحديث الطلب الحر بيتسجّل بطلبه ومرحلته وبديل الـSMS · MD3: + بيانات الملف
      return { ok: true, wamid };
    } catch (e) {
      const code = Number(String(e.code || "").replace(/^WA_/, "")) || null;
      return { ok: false, error: String(e.code || "send_failed"), code, message: String(e.message || "").slice(0, 200) };
    }
  }

  /* «مقروء + جاري الكتابة» على رسالة عميل لسه واصلة (لمساعد الطلبات: العميل يشوف إن الرد بيتكتب بدل سكوت كام ثانية).
     نفس قواعد الرد الحر بالظبط: تذكرة من guardSend (نفس الأقفال والنافذة، وقايمة التجربة في وضع التجربة) + الرسالة نفسها لازم تكون رسالة **واردة**
     من نفس الرقم في آخر ٢٤ ساعة (مانعلّمش «مقروء» على رسالة مش بتاعته ولا قديمة). مابتتسجّلش كرسالة صادرة: مفيش محتوى. عمرها ما بترمي. */
  async function sendTyping({ phoneNorm, wamid, allowList = null, test = false }) {
    await ready;
    const to = toWaId(phoneNorm);
    if (!to) return { ok: false, skipped: "invalid_phone" };
    if (!wamid) return { ok: false, skipped: "no_message" };
    try {
      const own = await pool.query(`SELECT 1 FROM wa_messages WHERE wamid=$1 AND phone_norm=$2 AND direction='in' AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`, [String(wamid), phoneNorm]);
      if (!(own.rows && own.rows.length)) return { ok: false, skipped: "not_his_message" };
      const g = await guardSend({ phoneNorm, kind: "session", source: "bot", test, allowList });
      if (!g.ok) return { ok: false, skipped: g.reason };
      await deliver(g.ticket, { messaging_product: "whatsapp", to, status: "read", message_id: String(wamid), typing_indicator: { type: "text" } });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e.code || "send_failed"), message: String(e.message || "").slice(0, 200) }; }
  }
  /* رسالة حرة — بتشتغل بس جوّه نافذة الـ٢٤ ساعة (العميل كلّمنا). ببلاش. */
  async function sendText({ phoneNorm, text, previewUrl = true }) {
    await ready;
    const to = toWaId(phoneNorm);
    if (!to) return { ok: false, skipped: "invalid_phone" };
    const g = await guardSend({ phoneNorm, kind: "session", source: "reply" });
    if (!g.ok) return { ok: false, skipped: g.reason };
    try {
      const data = await deliver(g.ticket, {
        messaging_product: "whatsapp", to, type: "text", text: { body: String(text).slice(0, 4096), preview_url: previewUrl } });
      const wamid = data.messages?.[0]?.id || null;
      await logOut({ wamid, phone_norm: phoneNorm, status: "accepted", body: String(text).slice(0, 500) });
      return { ok: true, wamid };
    } catch (e) {
      return { ok: false, error: String(e.code || "send_failed") };
    }
  }

  /* notify.js بينده دي لكل تغيير حالة. order = صف shop_orders. */
  async function sendOrderUpdate(order, stage, { fallbackSms = null } = {}) {
    const template = STAGE_TEMPLATES[stage];
    const freeDef = !template && FREE_STAGE_TEXT[stage] ? FREE_STAGE_TEXT[stage] : null;      // RT2: مرحلة حرة من غير قالب
    if (!template && !freeDef) return { ok: false, skipped: "no_template_for_stage" };
    /* SW1 (M6-2): المرحلة لازم تكون متعلّم عليها في notifications.whatsappStages (الافتراضي [] ⇒ ولا تحديث طلب بيطلع على واتساب
       لحد ما المالك يختار). الفحص هنا مش عند المنادي بس، عشان أي منادي جديد يبقى محكوم بنفس القاعدة. */
    const snap = await settingsSnap();
    if (!waStageOn(snap && snap.notifications, stage)) return { ok: false, skipped: "stage_off" };
    let row = {};
    try {
      const r = await pool.query(
        `SELECT customer->>'name' AS name, option, total, refund_id,
                NULLIF(to_jsonb(shop_orders)->>'table_no','')::int AS table_no
           FROM shop_orders WHERE order_no=$1`, [order.order_no]);
      row = r.rows[0] || {};
    } catch { /* الاسم اختياري؛ من غير الصف الحارس بيشتغل على اللي جاي من notify */ }
    const o = { ...order, option: row.option ?? order.option, total: row.total ?? order.total, table_no: row.table_no ?? order.table_no ?? null,
      refund_id: row.refund_id ?? order.refund_id ?? null, name: String(row.name || "").trim() };
    if (freeDef) return sendFreeStage(o, stage, freeDef, snap);      // RT2
    const t = TEMPLATES[template];
    if (typeof t.guard === "function" && !t.guard(o)) return { ok: false, skipped: "stage_not_applicable" };
    const params = t.bind(o);
    /* SB4 (عمر ١٤/١٠: «حاول نفتح مع العملاء نوافذ ٢٤ ساعة… توفر علينا»): العميل كلّمنا في آخر ٢٤ ساعة ⇒ التحديث رسالة حرة ببلاش بنفس نص القالب
       (وزر التتبع، أو «تمام / عندي ملاحظة» للتوصيل) بدل قالب بفلوس. نفس الحارس (guardSend session: كل الأقفال + النافذة) ونفس موافقة القالب الخدمي:
       موقِّف التحديثات / قال «لا» / مالوش قبول ولا الطلب تحت الشروط الجديدة ⇒ مفيش رسالة حرة (والقالب بعده بيتمنع بنفس السبب). waBot.windowFreeUpdates مقفول ⇒ زي الأول. */
    const wb = (snap && snap.waBot) || {};
    /* SB5: «طلبك مع المندوب» ⇒ اسم المندوب وزر «راسل المندوب» (رابطنا، مش رقمه) لو عندنا جواله */
    let courier = null;
    if (stage === "on_the_way" && wb.courierContact !== false) { try { const sr = await pool.query("SELECT driver FROM dl_shipments WHERE shop_order_no=$1 ORDER BY id DESC LIMIT 1", [order.order_no]); courier = courierOf(sr.rows && sr.rows[0] ? sr.rows[0].driver : null, order.order_no); } catch { courier = null; } }
    if (wb.windowFreeUpdates !== false && order.phone_norm && !channelBlock(snap, "template")) {      // نفس أقفال القالب (ومنها مفتاح تحديثات الطلب) — الرسالة الحرة هنا مابتعدّيش قفل القالب
      try {
        const pn = String(order.phone_norm), op = await optInOf(pn);
        const consent = !op.stoppedForUpdates && (op.updates || (!op.saidNoToUpdates && await termsCoverOrder(pool, pn, order.order_no)));
        if (consent && await windowOpen(pn)) {
          {
            /* ETA1: «يوصلك تقريباً قبل 9:45 م» في رسالة «في الطريق» الحرة بس (جوّه النافذة، من غير قوالب جديدة) — من الموديل الذكي وبنفس الوعد المتحفّظ. */
            let etaLine = null;
            if (stage === "on_the_way") { try { const { etaWaLine } = await import("./smarteta.js"); etaLine = await etaWaLine(order.order_no); } catch { etaLine = null; } }
            const withEta = (txt) => (etaLine ? `${txt}\n⏱ ${etaLine}` : txt);
            /* RT2 (١٧/١٠): المرحلة في waBot.windowV2Stages ⇒ نص الرسالة الحرة من القالب البديل (لـpickup_ready = صياغة المالك fc_order_pickup_ready؛ لباقي المراحل نص v2 = نفس النص) */
            const v2n = v2TemplateOf(stage, template);
            const useV2 = Array.isArray(wb.windowV2Stages) && wb.windowV2Stages.includes(stage) && TEMPLATES[v2n] && typeof TEMPLATES[v2n].bind === "function";
            const textName = useV2 ? v2n : template;
            const textParams = useV2 ? TEMPLATES[v2n].bind({ ...orderData(o), ...o }) : params;
            const body = withEta(renderTemplateText(textName, textParams)).slice(0, 1000);
            const ub = (TEMPLATES[textName].components.find((c) => c.type === "BUTTONS")?.buttons || []).find((b) => b.type === "URL");
            const url = ub ? String(ub.url).replace("{{1}}", String((textParams.button || [])[0] || "")) : null;
            const cUrl = courier && courier.wa ? courierChatUrl(order.order_no) : null;
            const cBody = cUrl && courier.first_name && TEMPLATES.fc_order_on_the_way_courier ? withEta(renderTemplateText("fc_order_on_the_way_courier", { body: [order.order_no, courier.first_name] })) : body;
            const payload = cUrl
              ? { type: "interactive", interactive: { type: "cta_url", body: { text: `${cBody}\n${url ? `🔗 ${url}` : ""}`.trim().slice(0, 1000) }, action: { name: "cta_url", parameters: { display_text: "راسل المندوب", url: cUrl } } } }
              : stage === "delivered"
              ? { type: "interactive", interactive: { type: "button", body: { text: body }, action: { buttons: [{ type: "reply", reply: { id: "تمام 👍", title: "تمام 👍" } }, { type: "reply", reply: { id: "عندي ملاحظة", title: "عندي ملاحظة" } }] } } }
              : url && /^https:\/\/freshcuts\.sa\//.test(url) && !/\{\{/.test(url) ? { type: "interactive", interactive: { type: "cta_url", body: { text: body }, action: { name: "cta_url", parameters: { display_text: String(ub.text).slice(0, 20), url } } } }
              : { type: "text", text: { body, preview_url: false } };
            const r = await sendFreeform({ phoneNorm: pn, payload, source: "window", preview: body, orderNo: order.order_no, stage, fallbackSms });      // الحارس الكامل جوّه sendFreeform
            if (r.ok) return { ok: true, wamid: r.wamid, free: true };
            /* CJ1 مراجعة (١٧/١٠): السقف رفض الرسالة الحرة (policy:true) ⇒ بنقف هنا. لو كمّلنا لمسار القالب، guardSend هيرفضه بنفس العدّ وهيسجّل صف **تاني**
               لنفس الطلب/المرحلة/السبب في wa_policy_skips ⇒ «تقرير ماجد» (skipped + saved_sar) كان بيتضاعف. الشكل نفس اللي كان القالب هيرجّعه. */
            if (r.policy === true) return { ok: false, skipped: r.skipped, policy: true };
          }
        }
      } catch (e) { console.error("[wa] window update:", e.message); }
    }
    /* ١٤/١٠ — «مانبعتش قالب بفلوس لكل مرحلة» (wapolicy.js): النافذة **مقفولة** ⇒ «بنجهّز» (accepted) مابتطلعش قالب (waBot.closedPolicy + closedSkipPreparing).
       بنتأكد من النافذة بنفسنا (مش من فشل المسار الحر): مفتوحة والرسالة الحرة ماطلعتش لأي سبب ⇒ القالب زي الأول. الشطب بيتسجّل في wa_policy_skips للتقرير،
       وnotify.js مابيبعتش SMS بدلها (policy:true). */
    if (order.phone_norm) {
      const dec = closedWindowStage(stage, waPolicyCfg(snap || {}));
      if (!dec.send) {
        let open = null; try { open = await windowOpen(String(order.phone_norm)); } catch { open = null; }
        if (open === false) {
          pool.query("INSERT INTO wa_policy_skips(order_no, phone_norm, stage, reason) VALUES ($1,$2,$3,$4)", [String(order.order_no).slice(0, 30), String(order.phone_norm), stage, dec.reason]).catch(() => {});
          return { ok: false, skipped: `policy_${dec.reason}`, policy: true };
        }
      }
    }
    /* 📍 RT2 (١٧/١٠): قبل أي قالب بفلوس — حالة القالب عند ميتا لو نقدر نقراها (setTemplateStatus): مش APPROVED ⇒ template_not_approved من غير طلب لميتا ولا صف فاشل.
       notify.js بيبعت SMS البديل (لو المرحلة في smsStages) وبيسجّل السبب في notify_sent. مانعرفش الحالة ⇒ زي الأول وميتا بتقرر. */
    const paid = async (name, p) => {
      const st = await templateStatusOf(name, "ar");
      if (st && TEMPLATE_BLOCKING_STATUSES.includes(st)) return { ok: false, skipped: "template_not_approved", template: name, status: st };      // RT2 مراجعة: الأكيد بس
      return sendTemplate({ phoneNorm: order.phone_norm, template: name, params: p, orderNo: order.order_no, stage, fallbackSms });
    };
    /* SB4: نسخة v2 (بزر رد سريع يفتح نافذة) بعد ما المالك يحط المرحلة في waBot.windowV2Stages (يعني ميتا اعتمدتها) */
    if (stage === "on_the_way" && wb.courierTemplate === true && courier && courier.first_name && courier.wa && TEMPLATES.fc_order_on_the_way_courier) {      // SB5: بعد اعتماد ميتا
      const cp = TEMPLATES.fc_order_on_the_way_courier.bind({ ...orderData(o), courier });
      if (!(cp.missing && cp.missing.length)) return paid("fc_order_on_the_way_courier", cp);
    }
    const v2 = v2TemplateOf(stage, template);      // RT2: pickup_ready ⇒ fc_order_pickup_ready (الاسم البديل)
    if (Array.isArray(wb.windowV2Stages) && wb.windowV2Stages.includes(stage) && TEMPLATES[v2] && typeof TEMPLATES[v2].bind === "function") {
      const p2 = TEMPLATES[v2].bind({ ...orderData(o), ...o });      // كتالوج: مسارات order.* / customer.*
      if (!(p2.missing && p2.missing.length)) return paid(v2, p2);
    }
    return paid(template, params);
  }

  /* 📍 RT2 (١٧/١٠): مرحلة «رسالة حرة بس» (FREE_STAGE_TEXT) — نفس أقفال القالب (ومنها مفتاح تحديثات الطلب) + نفس موافقة التحديثات + النافذة مفتوحة؛
     غير كده مفيش قالب يتبعت بداله ⇒ السبب بيرجع للمنادي (window_closed / no_optin / stopped …) ويتسجّل. الحارس الكامل جوّه sendFreeform (سقف CJ1a بيحكمها). */
  async function sendFreeStage(o, stage, def, snap) {
    if (typeof def.guard === "function" && !def.guard(o)) return { ok: false, skipped: "stage_not_applicable" };
    const wb = (snap && snap.waBot) || {};
    if (wb.windowFreeUpdates === false) return { ok: false, skipped: "window_updates_off" };
    const blocked = channelBlock(snap, "template");
    if (blocked) return { ok: false, skipped: blocked };
    if (!o.phone_norm) return { ok: false, skipped: "invalid_phone" };
    const pn = String(o.phone_norm), op = await optInOf(pn);
    const consent = !op.stoppedForUpdates && (op.updates || (!op.saidNoToUpdates && await termsCoverOrder(pool, pn, o.order_no)));
    if (!consent) return { ok: false, skipped: op.stoppedForUpdates ? "stopped" : "no_optin" };
    if (!(await windowOpen(pn))) return { ok: false, skipped: "window_closed" };
    const body = String(def.text(o, snap)).slice(0, 1000);      // RT2 مراجعة: النص من اللوحة (waBot.texts) وإلا الافتراضي
    const r = await sendFreeform({ phoneNorm: pn, payload: { type: "text", text: { body, preview_url: false } }, source: "window", preview: body, orderNo: o.order_no, stage });
    if (r.ok) return { ok: true, wamid: r.wamid, free: true };
    return { ok: false, skipped: r.skipped || r.error || "send_failed", ...(r.policy ? { policy: true } : {}) };
  }

  /* قالب كتالوج مرتبط بطلب محدد، **مرة وحدة للطلب** (١٢/١٠ — رصيد الولاء): نفس أقفال sendTemplate الأربعة وموافقة
     العميل حسب فئة القالب. لو نفس القالب اتقبل لنفس الطلب قبل كده (wa_messages) ⇒ already_sent من غير أي طلب شبكة. */
  async function sendOrderTemplateOnce({ order, template, data, stage = null }) {
    await ready;
    const t = TEMPLATES[template];
    if (!t || typeof t.bind !== "function") return { ok: false, error: "unknown_template" };
    const blocked = await gate();
    if (blocked) return { ok: false, skipped: blocked };
    if (!order || !order.order_no) return { ok: false, skipped: "no_order" };
    const dup = await pool.query(
      "SELECT 1 FROM wa_messages WHERE order_no=$1 AND template=$2 AND direction='out' AND status NOT IN ('failed','skipped') LIMIT 1",
      [String(order.order_no), template]);
    if (dup.rows.length) return { ok: false, skipped: "already_sent" };
    return sendTemplate({ phoneNorm: order.phone_norm, template, params: t.bind(data || {}), orderNo: order.order_no, stage });
  }

  /* ── الويب هوك ── */
  const errOf = (s) => (s.errors?.length ? String(s.errors[0].code + ":" + (s.errors[0].title || s.errors[0].message || "")).slice(0, 120) : null);

  async function handleStatus(s) {
    // الحالة الأقدم مابتكتبش فوق الأحدث (nextStatus بنفس المنطق في SQL)
    const r = await pool.query(
      `UPDATE wa_messages SET status = CASE
           WHEN $2 = 'failed' THEN CASE WHEN status IN ('delivered','read') THEN status ELSE 'failed' END
           WHEN status = 'failed' THEN CASE WHEN $2 IN ('delivered','read') THEN $2 ELSE status END
           WHEN (CASE $2 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE -1 END)
              > (CASE status WHEN 'accepted' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE -1 END)
             THEN $2
           ELSE status END,
         pricing=COALESCE($3, pricing), error=COALESCE($4, error), updated_at=NOW()
       WHERE wamid=$1 RETURNING id, phone_norm, order_no, fallback_sms, fallback_done, status`,
      [s.wamid, s.status, s.pricing ? jb(s.pricing) : null, errOf(s)]);
    const row = r.rows[0];
    /* RF1 (١٤/١٠): حالة لرسالة مالهاش صف عندنا (الويب هوك سبق تسجيل الرسالة، أو رسالة اتبعتت من بره السيرفر) كانت بتضيع من غير أثر.
       بنعدّها في صحة الويب هوك (_status_unmatched، وآخر نوع حالة) عشان نعرف لو ميتا بتبعت «read» وإحنا مش لاقيين صفها. */
    if (!row && s.wamid) {
      pool.query(`INSERT INTO wa_webhook_health(field, last_at, n, last_note) VALUES ('_status_unmatched', NOW(), 1, $1)
                  ON CONFLICT (field) DO UPDATE SET last_at=NOW(), n = wa_webhook_health.n + 1, last_note=$1`, [String(s.status || "").slice(0, 20)]).catch(() => {});
    }
    if (row && row.phone_norm) await emit("chat", { phoneNorm: row.phone_norm, what: "status", dir: "out", at: s.at || null });      // LR1: علامات ✓✓ بتتحدّث لوحدها
    await emit("status", { ...s, error: errOf(s), code: s.errors?.[0]?.code != null ? Number(s.errors[0].code) : null });
    const finalStatus = row?.status || s.status;
    if (finalStatus !== "failed" || !row?.fallback_sms || row.fallback_done) return;
    let smsOn = false;
    try { smsOn = (await getSettingsData())?.notifications?.smsEnabled === true; } catch { /* off */ }
    if (!smsOn) return;
    const claim = await pool.query(
      "UPDATE wa_messages SET fallback_done=TRUE WHERE id=$1 AND NOT fallback_done RETURNING id", [row.id]);
    if (!claim.rowCount) return; // حد تاني سبقنا (ويب هوك مكرر)
    try { await smsSend({ phoneNorm: row.phone_norm, body: row.fallback_sms,
      kind: "order_status", ref: `${row.order_no || "-"}:wa_fallback` }); }
    catch (e) { console.error(`[wa] SMS fallback failed for ${row.order_no}:`, e.message); }
  }

  async function applyIntent(pn, intent) {
    /* M2: «إيقاف» (مكتوبة أو زر القالب) = إيقاف **العروض** بس (marketing_off_at + cms_contacts.opted_out_at). تحديثات الطلب بتقف بس لما العميل يضغط الزر التاني
       «أوقف تحديثات الطلب» ⇒ stop_all (stopped_at). */
    if (intent === "stop" || intent === "stop_all") {
      await recordOptIn({ phone: pn, marketing: false, source: "wa_stop" });
      if (intent === "stop_all") await pool.query("UPDATE wa_optins SET stopped_at=NOW() WHERE phone_norm=$1", [pn]).catch(() => {});
      pool.query(
        `UPDATE cms_contacts SET optout_source = CASE WHEN opted_out_at IS NULL THEN 'whatsapp' ELSE optout_source END, opted_out_at=COALESCE(opted_out_at, NOW())
          WHERE phone_norm=$1`, [pn]).catch(() => {});      // EX4: إيقاف قديم من قناة تانية (رابط SMS / موظف) بيفضل بمصدره
    } else if (intent === "start") {
      await recordOptIn({ phone: pn, marketing: true, source: "wa_start" });
      await pool.query("UPDATE wa_optins SET stopped_at=NULL WHERE phone_norm=$1", [pn]).catch(() => {});
      /* EX4 (١٣/١٠): الإيقاف من واتساب بيعلّم العميل «موقوف» في ملف العملاء كمان (cms_contacts.opted_out_at) والحارس والحملات بيقروه من هناك — و«اشتراك» ماكانتش بتشيله،
         فالعميل يفضل محجوب عن العروض بعد ما رجع. دلوقتي الرجوع بيشيل الإيقاف اللي **مصدره واتساب بس** (إيقاف من رابط SMS أو من موظف بيفضل زي ما هو) ويتسجّل. */
      try {
        const cl = await pool.query("UPDATE cms_contacts SET opted_out_at=NULL, optout_source=NULL, optout_reason=NULL, optout_by=NULL WHERE phone_norm=$1 AND opted_out_at IS NOT NULL AND optout_source='whatsapp' RETURNING 1", [pn]);
        if (cl.rowCount) await pool.query("INSERT INTO cms_optout_log(phone_norm, action, source) VALUES ($1,'resubscribe','whatsapp')", [pn]).catch(() => {});
      } catch { /* ملف العملاء مش موجود في البيئة دي */ }
    }
  }

  /* CR2 (١٦/١٠): رسالة اتمسحت ⇒ نص صفها من نسختنا للرسالة الأصلية (بالمرجع)، أو تقدير من آخر رسالة لو المرجع مش في الحمولة. أي خطأ ⇒ «[رسالة اتمسحت]» زي الأول. */
  async function revokeInfo(pn, m, { echo = false } = {}) {
    const ref = m.revoke && m.revoke.original ? String(m.revoke.original) : null;
    const meta = { original: ref, keys: (m.revoke && m.revoke.keys) || [] };
    try {
      if (ref) {
        const r = (await pool.query("SELECT body, direction FROM wa_messages WHERE wamid=$1 AND ($2::text IS NULL OR phone_norm=$2) LIMIT 1", [ref, pn || null])).rows[0];
        return { ref, text: revokeText({ body: r ? r.body : null, echo }), meta: { ...meta, found: Boolean(r) } };
      }
      if (echo || !pn) return { ref: null, text: REVOKE_PLAIN, meta: { ...meta, found: false } };
      const at = m.at && Number.isFinite(Date.parse(m.at)) ? new Date(m.at) : new Date();
      const r = (await pool.query(
        `SELECT body, created_at FROM wa_messages WHERE phone_norm=$1 AND direction='in' AND COALESCE(msg_type,'') <> 'revoke'
            AND created_at <= $2::timestamptz + INTERVAL '5 seconds' AND created_at > $2::timestamptz - make_interval(secs => $3::int) ORDER BY created_at DESC LIMIT 1`,
        [pn, at.toISOString(), REVOKE_GAP_SEC])).rows[0];
      const gap = r ? Math.max(0, (at.getTime() - new Date(r.created_at).getTime()) / 1000) : null;
      return { ref: null, text: revokeText({ gapSec: gap, lastText: r ? r.body : null }), meta: { ...meta, found: false, guess: Boolean(r) } };
    } catch (e) { console.error("[wa] revoke:", e.message); return { ref, text: REVOKE_PLAIN, meta: { ...meta, error: true } }; }
  }

  async function handleInbound(m) {
    const pn = fromWaId(m.from);
    const rv = m.revoke ? await revokeInfo(pn, m) : null;      // CR2
    if (rv) m = { ...m, text: rv.text };
    const ins = await pool.query(
      `INSERT INTO wa_messages(wamid, direction, phone_norm, status, body, pricing, source, msg_type)
       VALUES ($1,'in',$2,'received',$3,$4,'api',$5) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
      [m.wamid, pn, String(m.text || `[${m.type}]`).slice(0, 1000), m.referral || m.unsupported || rv ? jb({ ...(m.referral ? { referral: m.referral } : {}), ...(m.unsupported ? { unsupported: m.unsupported } : {}), ...(rv ? { revoke: rv.meta } : {}) }) : null, m.type || null]);
    if (ins.rowCount === 0) return; // ويب هوك مكرر — اتعالج قبل كده
    if (rv && rv.ref) await pool.query("UPDATE wa_messages SET revoked_wamid=$2 WHERE wamid=$1", [m.wamid, rv.ref]).catch((e) => console.error("[wa] revoke ref:", e.message));
    if (m.media) await pool.query("UPDATE wa_messages SET media=$2::jsonb WHERE wamid=$1", [m.wamid, jb(m.media)]).catch((e) => console.error("[wa] media meta:", e.message));
    if (!pn) return;
    /* يفتح/يجدّد نافذة الـ٢٤ ساعة ويرفع «غير مقروء» للكاشير. */
    await touchThread({ phoneNorm: pn, direction: "in", text: m.text || `[${m.type}]`, at: m.at || null });
    await applyIntent(pn, m.intent);
    const ev = { phone: pn, phoneNorm: pn, wamid: m.wamid, text: m.text || "", type: m.type, interactiveId: m.interactiveId || null, contextId: m.contextId || null,
      referral: m.referral || null, location: m.location || null, media: m.media || null, isEcho: false, ts: m.at, at: m.at, intent: m.intent, source: "api" };
    await emit("inbound", ev);
    /* CW1 (١٦/١٠): رسالة من مندوب خارجي على رحلة شغّالة (ضغطة زر «استلمت / وصلت / سلّمت» أو أي رسالة منه) — courierwa.js بيمسكها:
       بيطبّق المرحلة ويرد بالأزرار اللي بعدها، والبوت مايبيعلوش ولا يرحّب بيه. أي خطأ في المستمع ⇒ الرسالة تكمل للبوت زي الأول. */
    for (const fn of hooks.claim) {
      let mine = false;
      try { mine = (await fn(ev)) === true; } catch (e) { console.error("[wa] claim hook:", e.message); }
      if (mine) return;
    }
    if (botRuntime) {
      let owned = false;
      try { owned = (await botRuntime(ev)) === true; } catch (e) { console.error("[wa] bot:", e.message); owned = true; }
      if (owned) return;   // البوت ماسك المحادثة (حتى لو قرر يسكت) — مفيش رد آلي قديم فوقه
    }
    // الرد الآلي (إعلانات Click-to-WhatsApp وغيرها) — مفتاح منفصل، ببلاش جوّه النافذة،
    // وبيسكت لو الكاشير بيكلّم العميل من الموبايل (نفس قاعدة البوت).
    const cfg = (await getSettingsData().catch(() => ({})))?.notifications || {};
    if (cfg.whatsappAutoReply === true && !m.intent && !(await humanActive(pn))) {
      const text = cfg.whatsappAutoReplyText ||
        `أهلاً بك في فريش كاتس 🔥\nاطلب أونلاين وادفع في دقيقة: ${STORE()}/?utm_source=whatsapp&utm_medium=message\nوإذا تحتاج مساعدة اكتب سؤالك ويرد عليك فريقنا.`;
      await sendText({ phoneNorm: pn, text });
    }
  }

  /* الكاشير بعت من تطبيق واتساب بزنس على الموبايل (Coexistence). بيتسجّل صادر
     في نفس المحادثة عشان الصندوق يعرض كل حاجة — ومفيش أي رد آلي عليه. */
  async function handleEcho(e) {
    const pn = fromWaId(e.to);
    const rv = e.revoke ? await revokeInfo(pn, e, { echo: true }) : null;      // CR2: الموظف مسح رسالة من موبايل المطعم
    if (rv) e = { ...e, text: rv.text };
    const ins = await pool.query(
      `INSERT INTO wa_messages(wamid, direction, phone_norm, status, body, source, msg_type, created_at)
       VALUES ($1,'out',$2,'sent',$3,'echo',$4, COALESCE($5::timestamptz, NOW())) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
      [e.wamid, pn, String(e.text || `[${e.type}]`).slice(0, 1000), e.type || null, e.at]);
    if (ins.rowCount === 0 || !pn) return;
    if (rv && rv.ref) await pool.query("UPDATE wa_messages SET revoked_wamid=$2 WHERE wamid=$1", [e.wamid, rv.ref]).catch((x) => console.error("[wa] revoke ref:", x.message));
    if (e.media) await pool.query("UPDATE wa_messages SET media=$2::jsonb WHERE wamid=$1", [e.wamid, jb(e.media)]).catch((x) => console.error("[wa] media meta:", x.message));
    /* M1 (١٢/١٠): رد آلي من تطبيق واتساب بزنس (ترحيب / أسئلة الإعلان الجاهزة) ولا موظف؟ بيتحدد لحظة التسجيل من التوقيت (waecho.js) وبيتخزّن في echo_kind.
       الصدى الآلي **مش** «موظف بيرد»: البوت مايسكتش بسببه. أي خطأ في التصنيف ⇒ يفضل «موظف» (السلوك القديم). رد الموظف من اللوحة/البورتال مابيعدّيش من هنا أصلاً. */
    let kind = "staff";
    try {
      const es = echoSettings(await getSettingsData().catch(() => ({})));
      const at = e.at ? new Date(e.at) : new Date();
      const li = await pool.query("SELECT max(created_at) AS at FROM wa_messages WHERE phone_norm=$1 AND direction='in' AND created_at <= $2::timestamptz", [pn, new Date(at.getTime() + ECHO.earlySec * 1000).toISOString()]);
      const last = li.rows[0] && li.rows[0].at ? new Date(li.rows[0].at).getTime() : null;
      kind = echoKind({ text: e.type === "text" ? e.text : "", deltaSec: last === null ? null : (at.getTime() - last) / 1000, maxSec: es.maxSec, texts: es.texts });
      await pool.query("UPDATE wa_messages SET echo_kind=$2 WHERE wamid=$1", [e.wamid, kind]);
    } catch (x) { kind = "staff"; console.error("[wa] echo kind:", x.message); }
    await touchThread({ phoneNorm: pn, direction: "out", text: e.text || `[${e.type}]`, at: e.at || null });
    // المستمعين يعرفوا إن إنسان بيرد (البوت بيسكت) — isEcho:true = مش رسالة عميل
    await emit("inbound", { phone: pn, phoneNorm: pn, wamid: e.wamid, text: e.text || "", type: e.type, interactiveId: null,
      referral: null, isEcho: true, echoKind: kind, ts: e.at, at: e.at, intent: null, source: "echo" });
  }

  /* جهات اتصال تطبيق واتساب بزنس — اسم للجوال (الأحدث بيكسب). */
  async function handleContact(c) {
    const pn = fromWaId(c.phone);
    if (!pn) return;
    await pool.query(
      `INSERT INTO wa_contact_names(phone_norm, full_name, first_name, removed, src_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (phone_norm) DO UPDATE SET
         full_name = CASE WHEN $4 THEN wa_contact_names.full_name ELSE COALESCE($2, wa_contact_names.full_name) END,
         first_name = CASE WHEN $4 THEN wa_contact_names.first_name ELSE COALESCE($3, wa_contact_names.first_name) END,
         removed = $4, src_at = $5, updated_at = NOW()
       WHERE wa_contact_names.src_at IS NULL OR $5::timestamptz IS NULL OR $5::timestamptz >= wa_contact_names.src_at`,
      [pn, c.fullName, c.firstName, c.action === "remove", c.at]);
  }
  async function handleProfile(p) {
    const pn = fromWaId(p.waId);
    if (!pn) return;
    await pool.query(
      `INSERT INTO wa_contact_names(phone_norm, profile_name) VALUES ($1,$2)
       ON CONFLICT (phone_norm) DO UPDATE SET profile_name=$2, updated_at=NOW()`, [pn, p.name]);
  }

  /* تاريخ المحادثات (مرة واحدة بعد الربط، على دفعات لحد ٦ شهور). idempotent
     بالـwamid، وسقف إجمالي (WHATSAPP_HISTORY_MAX، افتراضي ٢٠ ألف) عشان الجدول
     مايتملاش. مابيرفعش «غير مقروء»، و«إيقاف» بيتطبّق بس لو من آخر ٣٠ يوم. */
  async function handleHistory({ items, errors, meta }) {
    const st = (await pool.query("SELECT imported FROM wa_history_state WHERE id=1")).rows[0] || { imported: 0 };
    let room = Math.max(0, HISTORY_MAX() - (Number(st.imported) || 0));
    let imported = 0, skipped = 0;
    const sorted = [...items].sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
    for (const h of sorted) {
      const pn = fromWaId(h.customer);
      if (!pn || !h.wamid) { skipped++; continue; }
      if (room <= 0) { skipped++; continue; }
      const ins = await pool.query(
        `INSERT INTO wa_messages(wamid, direction, phone_norm, status, body, source, msg_type, created_at)
         VALUES ($1,$2,$3,$4,$5,'history',$6, COALESCE($7::timestamptz, NOW())) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
        [h.wamid, h.direction, pn, h.direction === "in" ? "received" : (h.status || "sent"),
          String(h.text || `[${h.type}]`).slice(0, 1000), h.type || null, h.at]);
      if (ins.rowCount === 0) { skipped++; continue; }
      imported++; room--;
      await touchThread({ phoneNorm: pn, direction: h.direction, text: h.text || `[${h.type}]`, at: h.at || null, silent: true });
      if (h.direction === "in" && h.at && Date.now() - Date.parse(h.at) < 30 * 86400000) {
        const intent = intentOf(h.text);
        if (intent === "stop") await applyIntent(pn, intent);
      }
    }
    await pool.query(
      `UPDATE wa_history_state SET imported = imported + $1, skipped = skipped + $2, chunks = chunks + 1,
         last_meta = COALESCE($3, last_meta), errors = CASE WHEN $4::jsonb IS NULL THEN errors ELSE $4::jsonb END, updated_at = NOW()
       WHERE id=1`,
      [imported, skipped, meta?.length ? jb(meta[meta.length - 1]) : null, errors?.length ? jb(errors) : null]);
    return { imported, skipped };
  }

  async function health(fields) {
    const seen = new Map();
    for (const f of fields) seen.set(f.field, f.ignored ? `${f.ignored}${f.phoneId ? ` phone_id:${f.phoneId}` : ""}` : (f.note || null));
    for (const [field, note] of seen) {
      await pool.query(
        `INSERT INTO wa_webhook_health(field, last_at, n, last_note) VALUES ($1, NOW(), 1, $2)
         ON CONFLICT (field) DO UPDATE SET last_at=NOW(), n = wa_webhook_health.n + 1, last_note=$2`,
        [String(field).slice(0, 60), note]).catch(() => {});
    }
  }

  /* الويب هوك كله بعد التوقيع. مستقلة عشان الاختبارات تناديها من غير HTTP. */
  async function processWebhook(body) {
    await ready;
    let acc = { phoneIds: [], ownNumbers: [] };
    try { acc = (await webhookAccept()) || acc; } catch { /* الفلتر الأساسي يكفي */ }
    // الـenv id يفضل مقبول حتى لو الأرقام الفعّالة اتغيّرت (فترة الانتقال: أحداث الرقمين بتتسجّل)
    const envPid = env("WHATSAPP_PHONE_ID") || null;
    const p = parseWebhook(body, { phoneId: envPid || phoneId() || null,
      phoneIds: [phoneId(), ...(acc.phoneIds || [])].filter(Boolean), ownNumbers: acc.ownNumbers || [] });
    for (const a of p.accountEvents || []) { try { for (const fn of hooks.account || []) await fn(a); } catch (e) { console.error("[wa] account hook:", e.message); } }
    for (const qe of p.qualityEvents || []) await emit("quality", qe);      // QP1
    await health(p.fields);
    for (const x of p.profiles) await handleProfile(x).catch((e) => console.error("[wa] profile:", e.message));
    for (const s of p.statuses) await handleStatus(s).catch((e) => console.error("[wa] status:", e.message));
    for (const m of p.messages) await handleInbound(m).catch((e) => console.error("[wa] inbound:", e.message));
    for (const e of p.echoes) await handleEcho(e).catch((er) => console.error("[wa] echo:", er.message));
    for (const c of p.contacts) await handleContact(c).catch((e) => console.error("[wa] contact:", e.message));
    if (p.history.length || p.historyErrors.length || p.historyMeta.length) {
      await handleHistory({ items: p.history, errors: p.historyErrors, meta: p.historyMeta })
        .catch((e) => console.error("[wa] history:", e.message));
    }
    for (const t of p.templateEvents) {
      await pool.query("INSERT INTO wa_template_events(name, language, template_id, event, reason) VALUES ($1,$2,$3,$4,$5)",
        [t.name, t.language, t.id, t.event, t.reason]).catch(() => {});
    }
    return p;
  }

  // تحقق ميتا وقت ربط الويب هوك.
  app.get("/api/wa/webhook", (c) => {
    const mode = c.req.query("hub.mode"), tok = c.req.query("hub.verify_token"), ch = c.req.query("hub.challenge");
    const expected = env("WHATSAPP_VERIFY_TOKEN");
    if (mode === "subscribe" && expected && tok === expected) return c.text(String(ch || ""), 200);
    return c.text("forbidden", 403);
  });

  app.post("/api/wa/webhook", async (c) => {
    let raw = "";
    try { raw = await c.req.text(); } catch { return c.json({ ok: true }); }
    if (!verifySignature(raw, c.req.header("x-hub-signature-256"), env("WHATSAPP_APP_SECRET"))) {
      console.warn("[wa] webhook signature missing/invalid — ignored");
      pool.query(`INSERT INTO wa_webhook_health(field, last_at, n, last_note) VALUES ('_bad_signature', NOW(), 1, NULL)
        ON CONFLICT (field) DO UPDATE SET last_at=NOW(), n = wa_webhook_health.n + 1`).catch(() => {});
      return c.json({ ok: true, ignored: "signature" });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return c.json({ ok: true, ignored: "json" }); }
    // بنرد فوراً؛ المعالجة في الخلفية (ميتا بتعيد لو اتأخرنا).
    Promise.resolve().then(() => processWebhook(body)).catch((e) => console.error("[wa] webhook:", e.message));
    return c.json({ ok: true });
  });

  // PUBLIC: موافقة من المتجر (لو الشيك أوت مابعتهاش مع الطلب).
  app.post("/api/wa/optin", async (c) => {
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    /* WO (١٢/١٠): المسار ده عام ومن غير تحقق — أي حد كان يقدر يبعت رقم أي حد بـupdates:true ويسجّل «موافقة».
       دلوقتي بيقبل **الإلغاء بس** (updates:false / marketing:false). الموافقة بتتسجّل من رقم متحقق بالـOTP:
       POST /api/account/wa-updates أو مع الشيك أوت (waconsent.js). */
    if (b.updates === true || b.marketing === true) return c.json({ ok: false, error: "optin_needs_verified_phone" }, 403);
    const r = await recordOptIn({ phone: b.phone, updates: b.updates === false ? false : undefined,
      marketing: b.marketing === false ? false : undefined, source: "storefront" });
    return c.json(r, r.ok ? 200 : 400);
  });

  // Admin: الحالة من غير أي سر.
  app.get("/api/wa/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const counts = (await pool.query(
      `SELECT count(*) FILTER (WHERE updates)::int AS updates, count(*) FILTER (WHERE marketing)::int AS marketing FROM wa_optins`)).rows[0];
    const last7 = (await pool.query(
      `SELECT direction, status, count(*)::int AS n FROM wa_messages
        WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY 1,2 ORDER BY 1,2`)).rows;
    const snap = await settingsSnap();
    return c.json({ ok: true, master: masterOn(), configured: configured(), settingsOn: await settingsOn(),
      envState: envState(), dashMaster: dashMasterOf(snap), blockedBy: channelBlock(snap), testPhones: testPhonesOf(snap).length,
      terms: { current: TERMS_CURRENT, waOrderUpdates: TERMS_VERSIONS[TERMS_CURRENT].waOrderUpdates === true, ordersRecorded: await termsRecorded() },
      phoneId: phoneId() || null, wabaId: wabaId() || null,
      webhookSecret: Boolean(env("WHATSAPP_APP_SECRET")), verifyToken: Boolean(env("WHATSAPP_VERIFY_TOKEN")),
      optins: counts, last7, templates: Object.keys(TEMPLATES) });
  });

  // Admin: القوالب بصيغة التقديم (للمراجعة قبل الإرسال لميتا).
  app.get("/api/wa/templates", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    // القوالب القديمة + قوالب الكتالوج (catalog:true، وكل لغة لوحدها) — للعرض بس، مفيش تقديم هنا
    return c.json({ ok: true, templates: Object.keys(TEMPLATES).flatMap((n) => templateLanguages(n).map((lang) => ({
      ...templateSubmission(n, TEMPLATES[n].variants ? lang : undefined), catalog: isCatalogTemplate(n), group: TEMPLATES[n].group || null }))) });
  });

  /* رفع صورة المثال لقالب بهيدر صورة (Resumable Upload API) ⇒ header_handle.
     ميتا مابتقبلش رابط — لازم handle. بيتنده بس من التقديم (مقفول بمفتاح). */
  async function uploadHandle(imageUrl) {
    const appId = env("WHATSAPP_APP_ID", "1073414588466040");
    const img = await doFetch(imageUrl);
    if (!img.ok) throw new Error(`sample image HTTP ${img.status}`);
    const buf = Buffer.from(await img.arrayBuffer());
    const type = (img.headers?.get?.("content-type") || "image/jpeg").split(";")[0];
    const s = await doFetch(`https://graph.facebook.com/${GRAPH_VERSION}/${appId}/uploads?file_length=${buf.length}&file_type=${encodeURIComponent(type)}`,
      { method: "POST", headers: { Authorization: `Bearer ${token()}` } });
    const sd = await s.json().catch(() => ({}));
    if (!sd.id) throw new Error(sd.error?.message || "upload session failed");
    const u = await doFetch(`https://graph.facebook.com/${GRAPH_VERSION}/${sd.id}`,
      { method: "POST", headers: { Authorization: `OAuth ${token()}`, file_offset: "0" }, body: buf });
    const ud = await u.json().catch(() => ({}));
    if (!ud.h) throw new Error(ud.error?.message || "upload failed");
    return ud.h;
  }

  // Admin: تقديم القوالب لميتا — مفتاح مستقل WHATSAPP_TEMPLATES_WRITE=1 (مابيبعتش رسايل).
  app.post("/api/wa/templates/submit", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (env("WHATSAPP_TEMPLATES_WRITE") !== "1") return c.json({ ok: false, error: "templates_write_disabled" });
    if (!token() || !wabaId()) return c.json({ ok: false, error: "unconfigured" });
    let b = {};
    try { b = await c.req.json(); } catch { /* الكل */ }
    /* من غير names = القوالب القديمة بس (زي الأول). قالب الكتالوج بيتقدّم بالاسم، **واحد في الطلب**:
       تقديمه قرار يدوي لكل قالب — مفيش ضغطة تقدّم الكتالوج كله، ومفيش حاجة بتتقدّم لوحدها. */
    const asked = Array.isArray(b.names) && b.names.length ? b.names.map(String)
      : Object.keys(TEMPLATES).filter((n) => !isCatalogTemplate(n) && !TEMPLATES[n].retired);
    const results = [];
    const jobs = [];
    for (const n of asked) {
      if (!TEMPLATES[n]) { results.push({ name: n, ok: false, error: "unknown" }); continue; }
      // موقوف عن التقديم (سبب مكتوب في الكتالوج) أو متقاعد — مايتقدّمش إلا بـ force:true من المالك
      const held = TEMPLATES[n].retired ? "retired" : (CAT.HOLD && CAT.HOLD[n]) || null;
      if (held && b.force !== true) { results.push({ name: n, ok: false, error: "held", reason: held }); continue; }
      if (isCatalogTemplate(n) && asked.length > 1) { results.push({ name: n, ok: false, error: "catalog_one_at_a_time" }); continue; }
      const langs = isCatalogTemplate(n) ? templateLanguages(n).filter((l) => !b.language || l === String(b.language)) : [undefined];
      if (!langs.length) { results.push({ name: n, ok: false, error: "no_such_language" }); continue; }
      for (const l of langs) jobs.push([n, l]);
    }
    for (const [n, l] of jobs) {
      const tag = l && templateLanguages(n).length > 1 ? { language: l } : {};
      try {
        const sub = templateSubmission(n, l);
        const hdr = sub.components.find((x) => x.type === "HEADER" && (x.format === "IMAGE" || x.format === "VIDEO"));
        if (hdr) {
          const sampleUrl = hdr.format === "VIDEO" ? b.sampleVideoUrl : b.sampleImageUrl;
          if (!sampleUrl) { results.push({ name: n, ...tag, ok: false, error: hdr.format === "VIDEO" ? "sample_video_required" : "sample_image_required" }); continue; }
          const h = await uploadHandle(String(sampleUrl));
          sub.components = sub.components.map((x) => (x === hdr ? { ...x, example: { header_handle: [h] } } : x));
        }
        /* edit:true = تعديل قالب موجود عند ميتا بنفس الاسم واللغة (مرفوض/موقوف: من غير حد؛ معتمد: مرة في اليوم) بدل إنشاء
           جديد — ميتا بترفض إنشاء اسم موجود. بنجيب رقم القالب بالاسم ونبعت المكوّنات بس (الفئة مابتتغيّرش في التعديل). */
        if (b.edit === true) {
          const found = await graphGet(`${wabaId()}/message_templates?name=${encodeURIComponent(n)}&fields=id,name,language,status&limit=50`);
          const row = (found.data || []).find((x) => x.name === n && x.language === sub.language);
          if (!row) { results.push({ name: n, ...tag, ok: false, error: "not_at_meta" }); continue; }
          const r = await graphPost(String(row.id), { components: sub.components });
          results.push({ name: n, ...tag, ok: r.success !== false, edited: true, id: String(row.id), was: row.status });
          continue;
        }
        results.push({ name: n, ...tag, ok: true, ...(await graphPost(`${wabaId()}/message_templates`, sub)) });
      }
      /* RV4: سبب ميتا الحقيقي (error_user_title / error_user_msg + code/subcode) بدل «Invalid parameter» بس — من غير التوكن ولا روابط فيها توكن */
      catch (e) { results.push({ name: n, ...tag, ok: false, ...metaErrorOf(e, [token()]) }); }
    }
    return c.json({ ok: true, results });
  });

  return { fetchMedia, uploadMedia, sendTemplate, sendStaffTemplate, sendText, sendFreeform, sendTyping, sendOrderUpdate, sendOrderTemplateOnce, recordOptIn, applyIntent, gate, configured, masterOn, ready, setInbox, setPayHold, setTemplateStatus,
    guardSend, deliver, envState, dashMasterOn: async () => dashMasterOf(await settingsSnap()), testPhones: async () => testPhonesOf(await settingsSnap()),
    on, processWebhook, token, phoneId, wabaId, setBot, setBotRuntime, humanActive,
    setActiveIds, idsInUse, setWebhookAccept };
}
