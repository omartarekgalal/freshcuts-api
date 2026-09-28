/* ═══════════════════════════════════════════════════════════════════════════
   WHATSAPP — WhatsApp Business Platform (Cloud API) لفريش كاتس.

   الخطة والقرارات: docs/growth-2026-09/05-whatsapp-api.md (ريبو freshcuts invite).

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

import crypto from "node:crypto";
import { sendSms as defaultSendSms } from "./accounts.js";
import { isOptOutText } from "./wamsg.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();
export const GRAPH_VERSION = "v23.0";
const STORE = () => env("STOREFRONT_PUBLIC_URL", "https://freshcuts.sa").replace(/\/+$/, "");

/* ── سجل القوالب ─────────────────────────────────────────────────────────────
   category: UTILITY | MARKETING | AUTHENTICATION (زي ميتا بالظبط).
   components: جسم التقديم لـ POST /{WABA_ID}/message_templates (مع أمثلة).
   bind(ctx): بيرجّع { body:[...], button:[suffix] } — بالترتيب الموضعي {{1}}.. */
export const TEMPLATES = {
  fc_order_received: {
    category: "UTILITY", stage: "pos_created",
    components: [
      { type: "BODY",
        text: "أهلاً {{1}} 👋\nاستلمنا طلبك رقم {{2}} من فريش كاتس وتم الدفع بنجاح ✅\nالإجمالي: {{3}} ر.س\nبنبلغك هنا أول ما يبدأ التجهيز.",
        example: { body_text: [["محمد", "W1726500000000", "96.00"]] } },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "تتبّع طلبك", url: "https://freshcuts.sa/track/{{1}}", example: ["W1726500000000"] },
      ] },
    ],
    bind: (o) => ({ body: [o.name || "عميلنا", o.order_no, money(o.total)], button: [o.order_no] }),
  },
  fc_order_preparing: {
    category: "UTILITY", stage: "accepted",
    components: [
      { type: "BODY",
        text: "طلبك رقم {{1}} صار في المطبخ 👨‍🍳 ونجهّزه الحين.\nبنبلغك أول ما يطلع.",
        example: { body_text: [["W1726500000000"]] } },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "تتبّع طلبك", url: "https://freshcuts.sa/track/{{1}}", example: ["W1726500000000"] },
      ] },
    ],
    bind: (o) => ({ body: [o.order_no], button: [o.order_no] }),
  },
  fc_order_on_the_way: {
    category: "UTILITY", stage: "on_the_way",
    components: [
      { type: "BODY",
        text: "طلبك رقم {{1}} في الطريق إليك الآن 🛵\nخلّ جوالك قريب، المندوب ممكن يتصل عند الوصول.",
        example: { body_text: [["W1726500000000"]] } },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "تتبّع طلبك", url: "https://freshcuts.sa/track/{{1}}", example: ["W1726500000000"] },
      ] },
    ],
    bind: (o) => ({ body: [o.order_no], button: [o.order_no] }),
  },
  fc_order_ready_pickup: {
    category: "UTILITY", stage: "pickup_ready",
    components: [
      { type: "BODY",
        text: "طلبك رقم {{1}} جاهز للاستلام من فرع فريش كاتس ✅\nاعرض رقم الطلب على الكاشير.",
        example: { body_text: [["W1726500000000"]] } },
    ],
    bind: (o) => ({ body: [o.order_no] }),
  },
  fc_order_delivered: {
    category: "UTILITY", stage: "delivered",
    components: [
      { type: "BODY",
        text: "تم توصيل طلبك رقم {{1}} ✅ بالعافية.\nإذا عندك أي ملاحظة على الطلب رد على هذه الرسالة ونتابع معك.",
        example: { body_text: [["W1726500000000"]] } },
    ],
    bind: (o) => ({ body: [o.order_no] }),
  },
  fc_order_refunded: {
    category: "UTILITY", stage: "rejected_refunded",
    components: [
      { type: "BODY",
        text: "نعتذر منك، ما قدرنا ننفّذ طلبك رقم {{1}} وتم استرجاع المبلغ كاملاً لوسيلة الدفع 💳\nيظهر المبلغ حسب البنك خلال أيام العمل.",
        example: { body_text: [["W1726500000000"]] } },
    ],
    bind: (o) => ({ body: [o.order_no] }),
  },
  fc_refund_in_progress: {
    category: "UTILITY", stage: "refund_failed",
    components: [
      { type: "BODY",
        text: "نعتذر منك بخصوص طلبك رقم {{1}}. استرجاع المبلغ جاري وفريقنا يتابعه، وبنتواصل معك للتأكيد 🙏",
        example: { body_text: [["W1726500000000"]] } },
    ],
    bind: (o) => ({ body: [o.order_no] }),
  },
  /* ── قوالب التسويق (حملات wasender على قناة Cloud API — ٢٨/٩) ──────────
     قواعد ميتا: مفيش متغير في أول الجسم ولا آخره، أمثلة لكل متغير، ومتغير
     زرار الـURL في آخر الرابط بس. زرار الرابط = نفس روابطنا المتتبّعة لكل عميل
     (/l/<slug>-<code> — cms.js بيحسب الضغطة على صف الطابور). «إيقاف» زرار رد
     سريع: الضغطة بتيجي في الويب هوك كرسالة نصها «إيقاف» ⇒ نفس مسار الإيقاف.
     campaign: القالب ينفع لحملة، و needs = اللي لازم الحملة توفّره. */
  fc_cart_reminder: {
    category: "MARKETING",
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
        text: "أهلاً {{1}} 👋\n{{2}}\nالعرض لفترة محدودة، اطلب من المتجر مباشرة 🔥",
        example: { body_text: [["محمد", "كيلو مشاوي على الفحم مع طبق رز مجاناً بـ96 ريال"]] } },
      { type: "FOOTER", text: "للإيقاف ردّ: إيقاف" },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "اطلب الآن", url: "https://freshcuts.sa/l/{{1}}", example: ["w12-a1b2c3"] },
        { type: "QUICK_REPLY", text: "إيقاف" },
      ] },
    ],
    bind: (x) => ({ header: x.imageUrl ? { image: x.imageUrl } : null,
      body: [x.name || "عميلنا", x.offer || "عروض جديدة في فريش كاتس"], button: [x.linkSuffix || ""] }),
  },
  fc_winback: {
    category: "MARKETING", campaign: { needs: ["coupon"], label: "اشتقنا لك + كود" },
    components: [
      { type: "BODY",
        text: "اشتقنا لك يا {{1}} 🙌\nآخر مرة طلبت {{2}}، وجهّزنا لك كود {{3}} على طلبك الجاي من المتجر.\nالكود لك أنت بس ولفترة محدودة.",
        example: { body_text: [["محمد", "كفتة مشوية", "W12K7Q2M"]] } },
      { type: "FOOTER", text: "للإيقاف ردّ: إيقاف" },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "اطلب الآن", url: "https://freshcuts.sa/l/{{1}}", example: ["w12-a1b2c3"] },
        { type: "QUICK_REPLY", text: "إيقاف" },
      ] },
    ],
    bind: (x) => ({ body: [x.name || "عميلنا", x.dish || "أكلتك المفضّلة", x.coupon || x.code || ""],
      button: [x.linkSuffix || ""] }),
  },
  fc_otp: {
    // قوالب التحقق نصها ثابت من ميتا («{{1}} هو رمز التحقق الخاص بك.») —
    // إحنا بنختار بس: تحذير الأمان + مدة الصلاحية + زرار نسخ الكود.
    category: "AUTHENTICATION",
    components: [
      { type: "BODY", add_security_recommendation: true },
      { type: "FOOTER", code_expiration_minutes: 5 },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "نسخ الرمز" }] },
    ],
    bind: (x) => ({ body: [String(x.code)], button: [String(x.code)] }),
  },
};

/* المرحلة (زي notify.js) → اسم القالب. المراحل اللي مش هنا مالهاش واتساب. */
export const STAGE_TEMPLATES = Object.fromEntries(
  Object.entries(TEMPLATES).filter(([, t]) => t.stage).map(([name, t]) => [t.stage, name]));

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
  }
  if (Array.isArray(params.body) && params.body.length) {
    components.push({ type: "body", parameters: params.body.map((v) => ({ type: "text", text: cleanParam(v) })) });
  }
  if (Array.isArray(params.button) && params.button.length) {
    if (t.category === "AUTHENTICATION") {
      components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: String(params.button[0]) }] });
    } else {
      const urlIdx = (t.components.find((c) => c.type === "BUTTONS")?.buttons || []).findIndex((b) => b.type === "URL");
      if (urlIdx >= 0) {
        components.push({ type: "button", sub_type: "url", index: String(urlIdx),
          parameters: [{ type: "text", text: String(params.button[0] ?? "") }] });
      }
    }
  }
  return { messaging_product: "whatsapp", recipient_type: "individual", to, type: "template",
    template: { name, language: { code: lang }, components } };
}

/* جسم التقديم لميتا (مراجعة القوالب). */
export function templateSubmission(name, lang = "ar") {
  const t = TEMPLATES[name];
  if (!t) throw new Error(`unknown template ${name}`);
  return { name, language: lang, category: t.category, components: t.components };
}

/* X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(appSecret, rawBody). مقارنة ثابتة الوقت. */
export function verifySignature(raw, header, secret) {
  if (!secret || !header || !String(header).startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const got = String(header).slice(7);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
}

const STOP_RE = /^\s*(stop|unsubscribe|إيقاف|ايقاف|إيقاف العروض|ايقاف العروض|الغاء|إلغاء الاشتراك|الغاء الاشتراك|وقف)\s*$/i;
const START_RE = /^\s*(start|ابدأ|ابدا|اشتراك)\s*$/i;

const isoOf = (ts) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};
const MEDIA_AR = { image: "صورة", video: "فيديو", audio: "رسالة صوتية", voice: "رسالة صوتية", document: "ملف",
  sticker: "ملصق", location: "موقع", contacts: "جهة اتصال", reaction: "تفاعل", unsupported: "رسالة مش مدعومة" };

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
export const intentOf = (text) => (STOP_RE.test(text || "") || isOptOutText(text || "") ? "stop" : START_RE.test(text || "") ? "start" : null);

/* بيفرد الويب هوك — بيتجاهل أي حاجة مش شكلها صح.
   الحقول (field) اللي بنفهمها:
     messages            وارد العملاء + حالات رسايلنا (+ اسم البروفايل)
     smb_message_echoes  الكاشير بعت من تطبيق واتساب بزنس على الموبايل (Coexistence)
     smb_app_state_sync  جهات اتصال التطبيق (إضافة/حذف) — اسم للجوال
     history             تاريخ المحادثات القديمة (مرة واحدة بعد الربط، على دفعات)
     message_template_status_update  اعتماد/رفض قالب
   opts.phoneId: لو محدد، أي تغيير لرقم تاني بيتشال (نفس الـWABA ممكن يبقى فيه أكتر من رقم). */
export function parseWebhook(body, { phoneId = null } = {}) {
  const out = { statuses: [], messages: [], echoes: [], contacts: [], profiles: [], history: [],
    historyErrors: [], historyMeta: [], templateEvents: [], fields: [] };
  for (const entry of body?.entry || []) {
    for (const ch of entry?.changes || []) {
      const v = ch?.value || {};
      const field = String(ch?.field || "messages");
      const pid = v.metadata?.phone_number_id ? String(v.metadata.phone_number_id) : null;
      if (phoneId && pid && pid !== String(phoneId)) { out.fields.push({ field, ignored: "other_phone" }); continue; }
      out.fields.push({ field, phoneId: pid });
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
          referral: m.referral || null, // رسالة جاية من إعلان Click-to-WhatsApp
          intent: m.type === "reaction" ? null : intentOf(text) });
      }
      for (const m of v.message_echoes || []) {
        out.echoes.push({ wamid: m.id, from: m.from, to: m.to, type: m.type, text: messageText(m), at: isoOf(m.timestamp) });
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
  const touchThread = (a) => { try { return inbox?.touch?.(a); } catch { /* الصندوق مايوقّفش رسالة */ } };

  /* مستمعين للويب هوك (wasender بيسجّل هنا عشان حالات رسايل الحملة وردودها
     تحدّث صفوف الطابور). مستمع بيقع مابيوقّفش الباقي. */
  const hooks = { inbound: [], status: [] };
  const on = (ev, fn) => { if (hooks[ev] && typeof fn === "function") hooks[ev].push(fn); };
  const emit = async (ev, x) => {
    for (const fn of hooks[ev] || []) { try { await fn(x); } catch (e) { console.error(`[wa] ${ev} hook:`, e.message); } }
  };

  /* ── البوت (ردود آلية) ─────────────────────────────────────────────────
     setBot({ matchIntent(text, ctx), buildReply(intent, ctx) }) — مثلاً wabot.js.
     بيشتغل بس لو WHATSAPP_BOT_ENABLED=1، ومش على صدى، ومش على «إيقاف/ابدأ»،
     و**بيسكت** WHATSAPP_BOT_HANDOFF_HOURS (افتراضي ١٢) ساعة بعد آخر رسالة
     الكاشير بعتها من الموبايل للعميل ده (تسليم لإنسان). buildReply بيرجّع
     جسم رسالة Cloud API واحد أو قايمة (من غير to/messaging_product — بنكمّلهم). */
  let bot = null;
  const setBot = (b) => { bot = b && typeof b.matchIntent === "function" && typeof b.buildReply === "function" ? b : null; };
  const handoffHours = () => Math.max(0, Number(env("WHATSAPP_BOT_HANDOFF_HOURS", "12")) || 0);
  async function humanActive(pn) {
    if (!handoffHours()) return false;
    const r = await pool.query(
      `SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND source='echo' AND created_at > NOW() - make_interval(hours => $2::int) LIMIT 1`,
      [pn, handoffHours()]).catch(() => ({ rowCount: 0 }));
    return r.rowCount > 0;
  }
  async function runBot(ev) {
    if (env("WHATSAPP_BOT_ENABLED") !== "1" || !bot || ev.isEcho || ev.intent || !ev.phone) return { skipped: "off" };
    if (await humanActive(ev.phone)) return { skipped: "human_handoff" };
    const ctx = { phone: ev.phone, text: ev.text, interactiveId: ev.interactiveId, referral: ev.referral, ts: ev.ts, store: STORE() };
    const intent = await bot.matchIntent(ev.text, ctx);
    if (!intent) return { skipped: "no_intent" };
    const out = await bot.buildReply(intent, ctx);
    const list = (Array.isArray(out) ? out : [out]).filter(Boolean);
    let sent = 0;
    for (const payload of list) {
      if ((await gate())) break;
      try {
        const data = await graphPost(`${phoneId()}/messages`, { ...payload, messaging_product: "whatsapp", to: toWaId(ev.phone) });
        await logOut({ wamid: data.messages?.[0]?.id || null, phone_norm: ev.phone, status: "accepted", source: "bot",
          body: String(payload.text?.body || payload.interactive?.body?.text || `[${payload.type || "bot"}]`).slice(0, 500) });
        sent++;
      } catch (e) { console.error("[wa] bot reply:", e.message); break; }
    }
    return { intent, sent };
  }

  // التوكن: WHATSAPP_TOKEN لو اتحط، وإلا توكن مستخدم النظام الدائم (META_CAPI_TOKEN).
  const token = () => env("WHATSAPP_TOKEN") || env("META_CAPI_TOKEN");
  const phoneId = () => env("WHATSAPP_PHONE_ID");
  const wabaId = () => env("WHATSAPP_WABA_ID");
  const masterOn = () => env("WHATSAPP_ENABLED") === "1";
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
      -- أسماء جهات الاتصال من تطبيق واتساب بزنس + اسم البروفايل من الوارد
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

  /* السبب اللي بيمنع الإرسال، أو null لو كله تمام. */
  async function gate() {
    if (!masterOn()) return "disabled";
    if (!configured()) return "unconfigured";
    if (!(await settingsOn())) return "settings_off";
    return null;
  }

  async function optInOf(phoneNorm) {
    const r = await pool.query("SELECT updates, marketing FROM wa_optins WHERE phone_norm=$1", [phoneNorm]);
    return r.rows[0] || { updates: false, marketing: false };
  }
  async function marketingSuppressed(phoneNorm) {
    try {
      const r = await pool.query("SELECT 1 FROM cms_contacts WHERE phone_norm=$1 AND opted_out_at IS NOT NULL", [phoneNorm]);
      return r.rowCount > 0;
    } catch { return false; } // الجدول مش موجود = مفيش إيقاف مسجّل
  }

  async function recordOptIn({ phone, updates, marketing, source = "checkout", orderNo = null }) {
    const pn = normPhone(phone);
    if (!/^5\d{8}$/.test(pn)) return { ok: false, error: "invalid_phone" };
    await pool.query(
      `INSERT INTO wa_optins(phone_norm, updates, marketing, source, order_no)
       VALUES ($1, COALESCE($2,FALSE), COALESCE($3,FALSE), $4, $5)
       ON CONFLICT (phone_norm) DO UPDATE SET
         updates = COALESCE($2, wa_optins.updates),
         marketing = COALESCE($3, wa_optins.marketing),
         source = EXCLUDED.source, order_no = COALESCE(EXCLUDED.order_no, wa_optins.order_no),
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

  /* الإرسال الأساسي. مابيرميش — بيرجّع {ok, wamid?, skipped?, error?, code?}.
     source/body اختياريين: الحملات بتبعت نص القالب بعد التعويض عشان يظهر في
     المحادثة زي ما العميل شافه (مش «[قالب: …]»). */
  async function sendTemplate({ phoneNorm, template, params = {}, orderNo = null, stage = null, fallbackSms = null,
    requireOptIn = true, source = null, body = null }) {
    await ready;
    const t = TEMPLATES[template];
    if (!t) return { ok: false, error: "unknown_template" };
    const to = toWaId(phoneNorm);
    if (!to) return { ok: false, skipped: "invalid_phone" };
    const blocked = await gate();
    if (blocked) return { ok: false, skipped: blocked };
    if (requireOptIn && t.category !== "AUTHENTICATION") {
      const o = await optInOf(phoneNorm);
      if (t.category === "UTILITY" && !o.updates) return { ok: false, skipped: "no_optin" };
      if (t.category === "MARKETING") {
        if (!o.marketing) return { ok: false, skipped: "no_optin" };
        if (await marketingSuppressed(phoneNorm)) return { ok: false, skipped: "opted_out" };
      }
    }
    const text = body || renderTemplateText(template, params) || null;
    try {
      const data = await graphPost(`${phoneId()}/messages`, buildTemplatePayload(template, to, params));
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

  /* رسالة حرة — بتشتغل بس جوّه نافذة الـ٢٤ ساعة (العميل كلّمنا). ببلاش. */
  async function sendText({ phoneNorm, text, previewUrl = true }) {
    await ready;
    const to = toWaId(phoneNorm);
    if (!to) return { ok: false, skipped: "invalid_phone" };
    const blocked = await gate();
    if (blocked) return { ok: false, skipped: blocked };
    try {
      const data = await graphPost(`${phoneId()}/messages`, {
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
    if (!template) return { ok: false, skipped: "no_template_for_stage" };
    let name = "";
    try {
      const r = await pool.query("SELECT customer->>'name' AS name FROM shop_orders WHERE order_no=$1", [order.order_no]);
      name = String(r.rows[0]?.name || "").trim().split(/\s+/)[0] || "";
    } catch { /* الاسم اختياري */ }
    const params = TEMPLATES[template].bind({ ...order, name });
    return sendTemplate({ phoneNorm: order.phone_norm, template, params, orderNo: order.order_no, stage, fallbackSms });
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
    if (intent === "stop") {
      await recordOptIn({ phone: pn, marketing: false, source: "wa_stop" });
      pool.query(
        `UPDATE cms_contacts SET opted_out_at=COALESCE(opted_out_at, NOW()), optout_source='whatsapp'
          WHERE phone_norm=$1`, [pn]).catch(() => {});
    } else if (intent === "start") {
      await recordOptIn({ phone: pn, marketing: true, source: "wa_start" });
    }
  }

  async function handleInbound(m) {
    const pn = fromWaId(m.from);
    const ins = await pool.query(
      `INSERT INTO wa_messages(wamid, direction, phone_norm, status, body, pricing, source, msg_type)
       VALUES ($1,'in',$2,'received',$3,$4,'api',$5) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
      [m.wamid, pn, String(m.text || `[${m.type}]`).slice(0, 1000), m.referral ? jb({ referral: m.referral }) : null, m.type || null]);
    if (ins.rowCount === 0) return; // ويب هوك مكرر — اتعالج قبل كده
    if (!pn) return;
    /* يفتح/يجدّد نافذة الـ٢٤ ساعة ويرفع «غير مقروء» للكاشير. */
    await touchThread({ phoneNorm: pn, direction: "in", text: m.text || `[${m.type}]`, at: m.at || null });
    await applyIntent(pn, m.intent);
    const ev = { phone: pn, phoneNorm: pn, wamid: m.wamid, text: m.text || "", type: m.type, interactiveId: m.interactiveId || null,
      referral: m.referral || null, isEcho: false, ts: m.at, at: m.at, intent: m.intent, source: "api" };
    await emit("inbound", ev);
    if (bot && env("WHATSAPP_BOT_ENABLED") === "1") { await runBot(ev).catch((e) => console.error("[wa] bot:", e.message)); return; }
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
    const ins = await pool.query(
      `INSERT INTO wa_messages(wamid, direction, phone_norm, status, body, source, msg_type, created_at)
       VALUES ($1,'out',$2,'sent',$3,'echo',$4, COALESCE($5::timestamptz, NOW())) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
      [e.wamid, pn, String(e.text || `[${e.type}]`).slice(0, 1000), e.type || null, e.at]);
    if (ins.rowCount === 0 || !pn) return;
    await touchThread({ phoneNorm: pn, direction: "out", text: e.text || `[${e.type}]`, at: e.at || null });
    // المستمعين يعرفوا إن إنسان بيرد (البوت بيسكت) — isEcho:true = مش رسالة عميل
    await emit("inbound", { phone: pn, phoneNorm: pn, wamid: e.wamid, text: e.text || "", type: e.type, interactiveId: null,
      referral: null, isEcho: true, ts: e.at, at: e.at, intent: null, source: "echo" });
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
    for (const f of fields) seen.set(f.field, f.ignored || null);
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
    const p = parseWebhook(body, { phoneId: phoneId() || null });
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
    // التسويق مايتفعّلش من طلب مجهول — بس تحديثات الطلب أو الإلغاء.
    const r = await recordOptIn({ phone: b.phone, updates: typeof b.updates === "boolean" ? b.updates : undefined,
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
    return c.json({ ok: true, master: masterOn(), configured: configured(), settingsOn: await settingsOn(),
      phoneId: phoneId() || null, wabaId: wabaId() || null,
      webhookSecret: Boolean(env("WHATSAPP_APP_SECRET")), verifyToken: Boolean(env("WHATSAPP_VERIFY_TOKEN")),
      optins: counts, last7, templates: Object.keys(TEMPLATES) });
  });

  // Admin: القوالب بصيغة التقديم (للمراجعة قبل الإرسال لميتا).
  app.get("/api/wa/templates", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, templates: Object.keys(TEMPLATES).map((n) => templateSubmission(n)) });
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
    const names = Array.isArray(b.names) && b.names.length ? b.names : Object.keys(TEMPLATES);
    const results = [];
    for (const n of names) {
      if (!TEMPLATES[n]) { results.push({ name: n, ok: false, error: "unknown" }); continue; }
      try {
        const sub = templateSubmission(n);
        const hdr = sub.components.find((x) => x.type === "HEADER" && x.format === "IMAGE");
        if (hdr) {
          if (!b.sampleImageUrl) { results.push({ name: n, ok: false, error: "sample_image_required" }); continue; }
          const h = await uploadHandle(String(b.sampleImageUrl));
          sub.components = sub.components.map((x) => (x === hdr ? { ...x, example: { header_handle: [h] } } : x));
        }
        results.push({ name: n, ok: true, ...(await graphPost(`${wabaId()}/message_templates`, sub)) });
      }
      catch (e) { results.push({ name: n, ok: false, error: e.message }); }
    }
    return c.json({ ok: true, results });
  });

  return { sendTemplate, sendText, sendOrderUpdate, recordOptIn, gate, configured, masterOn, ready, setInbox,
    on, processWebhook, token, phoneId, wabaId, setBot, runBot, humanActive };
}
