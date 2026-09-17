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
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { sendSms as defaultSendSms } from "./accounts.js";

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
        text: "أهلاً {{1}} 👋\nاستلمنا طلبك رقم {{2}} من فريش كاتس وتم الدفع بنجاح ✅\nالإجمالي: {{3}} ر.س\nهنبلغك هنا أول ما المطبخ يبدأ التجهيز.",
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
        text: "طلبك رقم {{1}} دخل المطبخ 👨‍🍳 وبنجهّزه على الفحم دلوقتي.\nهنبلغك أول ما يطلع.",
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
        text: "طلبك رقم {{1}} في الطريق إليك الآن 🛵\nجهّز جوالك عشان المندوب ممكن يتصل عند الوصول.",
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
        text: "طلبك رقم {{1}} جاهز للاستلام من فرع فريش كاتس ✅\nوريّ رقم الطلب للكاشير.",
        example: { body_text: [["W1726500000000"]] } },
    ],
    bind: (o) => ({ body: [o.order_no] }),
  },
  fc_order_delivered: {
    category: "UTILITY", stage: "delivered",
    components: [
      { type: "BODY",
        text: "تم توصيل طلبك رقم {{1}} ✅ بالهنا والشفا.\nلو في أي ملاحظة على الطلب رد على الرسالة دي وهنتابع معك.",
        example: { body_text: [["W1726500000000"]] } },
    ],
    bind: (o) => ({ body: [o.order_no] }),
  },
  fc_order_refunded: {
    category: "UTILITY", stage: "rejected_refunded",
    components: [
      { type: "BODY",
        text: "نعتذر منك، تعذّر تنفيذ طلبك رقم {{1}} وتم استرجاع المبلغ كاملاً لوسيلة الدفع 💳\nالمبلغ بيظهر حسب البنك خلال أيام العمل.",
        example: { body_text: [["W1726500000000"]] } },
    ],
    bind: (o) => ({ body: [o.order_no] }),
  },
  fc_refund_in_progress: {
    category: "UTILITY", stage: "refund_failed",
    components: [
      { type: "BODY",
        text: "نعتذر منك بخصوص طلبك رقم {{1}}. استرجاع المبلغ جارٍ وفريقنا بيتابعه، وهنتواصل معك للتأكيد 🙏",
        example: { body_text: [["W1726500000000"]] } },
    ],
    bind: (o) => ({ body: [o.order_no] }),
  },
  fc_cart_reminder: {
    category: "MARKETING",
    components: [
      { type: "BODY",
        text: "أهلاً {{1}} 👋 سلتك في فريش كاتس لسه مستنياك 🔥\nكمّل طلبك في دقيقة والمشاوي توصلك سخنة.",
        example: { body_text: [["محمد"]] } },
      { type: "FOOTER", text: "للإيقاف اكتب: إيقاف" },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "كمّل طلبك", url: "https://freshcuts.sa/{{1}}", example: ["?resume=abc123"] },
      ] },
    ],
    bind: (x) => ({ body: [x.name || "عميلنا"], button: [x.resumePath || ""] }),
  },
  fc_offer: {
    category: "MARKETING",
    components: [
      { type: "HEADER", format: "IMAGE", example: { header_handle: ["<upload handle — يتجاب وقت التقديم>"] } },
      { type: "BODY",
        text: "أهلاً {{1}} 👋\n{{2}} بـ{{3}} ر.س بس في فريش كاتس 🔥\nالعرض لفترة محدودة — اطلب من المتجر مباشرة.",
        example: { body_text: [["محمد", "كيلو مشاوي على الفحم مع طبق رز مجاناً", "96"]] } },
      { type: "FOOTER", text: "للإيقاف اكتب: إيقاف" },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "اطلب الآن", url: "https://freshcuts.sa/l/{{1}}", example: ["96-wa-kilo"] },
        { type: "QUICK_REPLY", text: "إيقاف العروض" },
      ] },
    ],
    bind: (x) => ({ header: x.imageUrl ? { image: x.imageUrl } : null, body: [x.name || "عميلنا", x.offer, x.price], button: [x.slug] }),
  },
  fc_winback: {
    category: "MARKETING",
    components: [
      { type: "BODY",
        text: "وحشتنا يا {{1}} 🙌\nعاملينلك خصم {{2}}٪ على طلبك الجاي من المتجر بكود {{3}}.",
        example: { body_text: [["محمد", "15", "BACK15"]] } },
      { type: "FOOTER", text: "للإيقاف اكتب: إيقاف" },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "اطلب الآن", url: "https://freshcuts.sa/{{1}}", example: ["?coupon=BACK15"] },
        { type: "QUICK_REPLY", text: "إيقاف العروض" },
      ] },
    ],
    bind: (x) => ({ body: [x.name || "عميلنا", String(x.percent), x.code], button: [`?coupon=${encodeURIComponent(x.code)}`] }),
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

/* جسم رسالة القالب لـ POST /{PHONE_ID}/messages. */
export function buildTemplatePayload(name, to, params = {}, lang = "ar") {
  const t = TEMPLATES[name];
  if (!t) throw Object.assign(new Error(`unknown template ${name}`), { code: "WA_UNKNOWN_TEMPLATE" });
  const components = [];
  if (params.header?.image) {
    components.push({ type: "header", parameters: [{ type: "image", image: { link: params.header.image } }] });
  }
  if (Array.isArray(params.body) && params.body.length) {
    components.push({ type: "body", parameters: params.body.map((v) => ({ type: "text", text: String(v ?? "").slice(0, 1000) })) });
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

/* بيفرد الويب هوك لـ { statuses:[...], messages:[...] } — بيتجاهل أي حاجة مش شكلها صح. */
export function parseWebhook(body) {
  const out = { statuses: [], messages: [] };
  for (const entry of body?.entry || []) {
    for (const ch of entry?.changes || []) {
      const v = ch?.value || {};
      for (const s of v.statuses || []) {
        out.statuses.push({ wamid: s.id, status: s.status, recipient: s.recipient_id,
          at: s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : null,
          pricing: s.pricing || null, errors: s.errors || null });
      }
      for (const m of v.messages || []) {
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title
          ?? m.interactive?.list_reply?.title ?? "";
        out.messages.push({ wamid: m.id, from: m.from, type: m.type, text: String(text || ""),
          at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null,
          referral: m.referral || null, // رسالة جاية من إعلان Click-to-WhatsApp
          intent: STOP_RE.test(text || "") ? "stop" : START_RE.test(text || "") ? "start" : null });
      }
    }
  }
  return out;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb, normPhone } = ctx;
  const doFetch = deps.fetch || globalThis.fetch;
  const smsSend = deps.sendSms || defaultSendSms;

  const token = () => env("WHATSAPP_TOKEN") || env("META_CAPI_TOKEN");
  const phoneId = () => env("WHATSAPP_PHONE_ID");
  const wabaId = () => env("WHATSAPP_WABA_ID");
  const masterOn = () => env("WHATSAPP_ENABLED") === "1";
  const configured = () => Boolean(token() && phoneId());

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
        `INSERT INTO wa_messages(wamid, direction, phone_norm, template, category, order_no, stage, status, error, body, fallback_sms)
         VALUES ($1,'out',$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (wamid) DO NOTHING`,
        [row.wamid || null, row.phone_norm || null, row.template || null, row.category || null,
         row.order_no || null, row.stage || null, row.status, row.error || null,
         row.body || null, row.fallback_sms || null]);
    } catch (e) { console.error("[wa] log failed:", e.message); }
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
        { code: `WA_${data.error?.code || resp.status}` });
    }
    return data;
  }

  /* الإرسال الأساسي. مابيرميش — بيرجّع {ok, wamid?, skipped?, error?}. */
  async function sendTemplate({ phoneNorm, template, params = {}, orderNo = null, stage = null, fallbackSms = null, requireOptIn = true }) {
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
    try {
      const data = await graphPost(`${phoneId()}/messages`, buildTemplatePayload(template, to, params));
      const wamid = data.messages?.[0]?.id || null;
      await logOut({ wamid, phone_norm: phoneNorm, template, category: t.category, order_no: orderNo,
        stage, status: "accepted", fallback_sms: fallbackSms });
      return { ok: true, wamid };
    } catch (e) {
      await logOut({ phone_norm: phoneNorm, template, category: t.category, order_no: orderNo, stage,
        status: "failed", error: String(e.code || e.message).slice(0, 120) });
      return { ok: false, error: String(e.code || "send_failed") };
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
  async function handleStatus(s) {
    const r = await pool.query(
      `UPDATE wa_messages SET status=$2, pricing=COALESCE($3, pricing),
         error=COALESCE($4, error), updated_at=NOW()
       WHERE wamid=$1 RETURNING id, phone_norm, order_no, fallback_sms, fallback_done`,
      [s.wamid, s.status, s.pricing ? jb(s.pricing) : null,
       s.errors?.length ? String(s.errors[0].code + ":" + (s.errors[0].title || "")).slice(0, 120) : null]);
    const row = r.rows[0];
    if (s.status !== "failed" || !row?.fallback_sms || row.fallback_done) return;
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

  async function handleInbound(m) {
    const pn = fromWaId(m.from);
    await pool.query(
      `INSERT INTO wa_messages(wamid, direction, phone_norm, status, body, pricing)
       VALUES ($1,'in',$2,'received',$3,$4) ON CONFLICT (wamid) DO NOTHING`,
      [m.wamid, pn, String(m.text || `[${m.type}]`).slice(0, 1000), m.referral ? jb({ referral: m.referral }) : null]);
    if (!pn) return;
    if (m.intent === "stop") {
      await recordOptIn({ phone: pn, marketing: false, source: "wa_stop" });
      pool.query(
        `UPDATE cms_contacts SET opted_out_at=COALESCE(opted_out_at, NOW()), optout_source='whatsapp'
          WHERE phone_norm=$1`, [pn]).catch(() => {});
    } else if (m.intent === "start") {
      await recordOptIn({ phone: pn, marketing: true, source: "wa_start" });
    }
    // الرد الآلي (إعلانات Click-to-WhatsApp وغيرها) — مفتاح منفصل، ببلاش جوّه النافذة.
    const cfg = (await getSettingsData().catch(() => ({})))?.notifications || {};
    if (cfg.whatsappAutoReply === true && !m.intent) {
      const text = cfg.whatsappAutoReplyText ||
        `أهلاً بك في فريش كاتس 🔥\nاطلب أونلاين وادفع في دقيقة: ${STORE()}/?utm_source=whatsapp&utm_medium=message\nولو محتاج مساعدة اكتب سؤالك وفريقنا يرد عليك.`;
      await sendText({ phoneNorm: pn, text });
    }
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
      return c.json({ ok: true, ignored: "signature" });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return c.json({ ok: true, ignored: "json" }); }
    const { statuses, messages } = parseWebhook(body);
    // بنرد فوراً؛ المعالجة في الخلفية (ميتا بتعيد لو اتأخرنا).
    Promise.resolve().then(async () => {
      await ready;
      for (const s of statuses) await handleStatus(s).catch((e) => console.error("[wa] status:", e.message));
      for (const m of messages) await handleInbound(m).catch((e) => console.error("[wa] inbound:", e.message));
    });
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
      try { results.push({ name: n, ok: true, ...(await graphPost(`${wabaId()}/message_templates`, templateSubmission(n))) }); }
      catch (e) { results.push({ name: n, ok: false, error: e.message }); }
    }
    return c.json({ ok: true, results });
  });

  return { sendTemplate, sendText, sendOrderUpdate, recordOptIn, gate, configured, masterOn, ready };
}
