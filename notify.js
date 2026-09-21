/* ═══════════════════════════════════════════════════════════════════════════
   NOTIFY — customer-facing notifications for online orders.

   Omar's spec (2026-08-11): «الإشعارات تكون من المتصفح لو ينفع، ونعمل
   إمكانية واتساب وSMS لكن نتحكم في تفعيلها من لوحة التحكم».

   Three channels, one entry point (orderStatusChanged):
   - Browser push (Web Push / VAPID) — free, on by default. iOS caveat the
     dashboard repeats: Safari delivers push only for sites added to the
     home screen, so push is best-effort, never the only channel.
   - SMS (Taqnyat, same adapter the OTP uses) — costs money per message, so
     it is stage-filtered (settings.notifications.smsStages) and off until
     the Taqnyat credentials land.
   - WhatsApp (Cloud API) — business-initiated messages REQUIRE an approved
     template; the adapter is here and toggle-gated, but stays off until
     the coexistence QR step + template approval happen.

   VAPID keys are generated once on first boot and persisted in the settings
   row — losing them would orphan every subscription, so they are never
   env-only.

   Toggles (settings.notifications): pushEnabled (default true),
   smsEnabled (default false), smsStages, whatsappEnabled (default false).
═══════════════════════════════════════════════════════════════════════════ */

import webpush from "web-push";
import { sendSms } from "./accounts.js";
import { emitOrder } from "./order-events.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();
const trackHost = () => env("STOREFRONT_PUBLIC_URL", "https://freshcuts.sa").replace(/^https?:\/\//, "").replace(/\/+$/, "");

/* What we tell the customer at each stage. Stages missing here are internal
   and never notify (pending_payment, expired, paid_pos_failed...). */
const MESSAGES = {
  pos_created: (o) => `فريش كاتس: استلمنا طلبك ${o.order_no} وتم الدفع بنجاح ✅`,
  accepted: (o) => `فريش كاتس: المطعم بدأ تجهيز طلبك ${o.order_no} 👨‍🍳`,
  courier_assigned: () => `فريش كاتس: رتّبنا لك مندوب توصيل 🛵`,
  /* ١٧/٩ (عمر): «المندوب في الطريق» هي رسالة الحالة الوحيدة بالـSMS — فبرابط
     التتبع، وجزء UCS-2 واحد (≤٧٠) — رقم الطلب ١٤ حرف فالإيموجي بيتشال لو هيعدّي. */
  on_the_way: (o) => {
    const url = `${trackHost()}/track/${o.order_no}`;
    const full = `فريش كاتس: طلبك مع المندوب بالطريق 🛵 ${url}`;
    return full.length <= 70 ? full : `فريش كاتس: طلبك مع المندوب بالطريق ${url}`;
  },
  // Google Business review link (settings.storefront.seo.links.review overrides the env/default).
  delivered: () => `فريش كاتس: تم توصيل طلبك — بالهنا والشفا 🌟 عجبك الأكل؟ قيّمنا على جوجل: ${env("GOOGLE_REVIEW_URL", "https://g.page/r/CSG0gPAqlvHMEBM/review")}`,
  rejected_refunded: (o) => `فريش كاتس: نعتذر، تعذّر تنفيذ طلبك ${o.order_no} وتم استرجاع المبلغ كاملاً لبطاقتك 💳`,
  /* الاسترجاع اتأخر — ما نقولش «تم» وهو ما تمّش. الرسالة دي بتعترف
     بالمشكلة وبتوعد بمتابعة، والوعد ده مدعوم بإنذار درجة 3 في اللوحة
     بيفضل ولّع لحد ما حد يسترجع فعلاً. */
  refund_failed: (o) => `فريش كاتس: نعتذر عن طلبك ${o.order_no}. استرجاع المبلغ جارٍ وفريقنا بيتابعه — هنتواصل معك للتأكيد 🙏`,
};
const DEFAULT_SMS_STAGES = ["pos_created", "rejected_refunded", "refund_failed"];
/* رسايل الاسترجاع مش اختيارية: العميل دفع ولازم يعرف إن فلوسه راجعة. بتتبعت
   طول ما SMS مفعّل، حتى لو smsStages في الإعدادات ماذكرتهاش. */
export const MANDATORY_SMS_STAGES = ["rejected_refunded", "refund_failed"];
export const smsStagesOf = (cfg = {}) => {
  const base = Array.isArray(cfg.smsStages) && cfg.smsStages.length ? cfg.smsStages : DEFAULT_SMS_STAGES;
  return [...new Set([...base, ...MANDATORY_SMS_STAGES])];
};
export const statusSmsText = (status, order) => (MESSAGES[status] ? MESSAGES[status](order) : null);

const rl = new Map();
function rateLimited(ip, max = 60) {
  const now = Date.now();
  const slot = rl.get(ip);
  if (!slot || now - slot.start > 3600_000) { rl.set(ip, { start: now, n: 1 }); return false; }
  slot.n++;
  if (rl.size > 5000) rl.clear();
  return slot.n > max;
}

/* notify_sent (§٤-١): حدث واحد لكل قناة بعد المحاولة، و«none» لو مفيش قناة
   اتجرّبت. emitOrder مابترميش، والـtry هنا حزام أمان زيادة — الإشعار
   عمره ما يوقف انتقال الحالة. */
function emitNotify(orderNo, stage, channel, ok, extra = {}) {
  try {
    emitOrder("notify_sent", {
      orderNo: String(orderNo), source: "notify", channel, ok: Boolean(ok),
      data: { stage, channel, ok: Boolean(ok), ...extra },
    });
  } catch { /* never */ }
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb, normPhone } = ctx;
  // whatsapp.js (Cloud API بقوالب معتمدة). لو مش متمرّر = السلوك القديم.
  const wa = deps.wa || null;
  // حقن للاختبارات بس — الإنتاج بيستخدم web-push وTaqnyat الحقيقيين.
  const push = ctx.webpush || webpush;
  const smsSend = ctx.sendSms || sendSms;

  let vapid = null; // {publicKey, privateKey} — resolved during ensureSchema

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subs (
        id BIGSERIAL PRIMARY KEY,
        phone_norm TEXT,
        order_no TEXT,
        endpoint TEXT UNIQUE,
        sub JSONB NOT NULL,
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_ok_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS push_subs_phone_idx ON push_subs(phone_norm) WHERE NOT disabled;
      CREATE INDEX IF NOT EXISTS push_subs_order_idx ON push_subs(order_no) WHERE NOT disabled;
      -- الجهاز: عشان سلة متروكة من غير جوال تفضل قابلة للتنبيه
      ALTER TABLE push_subs ADD COLUMN IF NOT EXISTS device_id TEXT;
      CREATE INDEX IF NOT EXISTS push_subs_device_idx ON push_subs(device_id) WHERE NOT disabled;
      -- ٢١/٩: تطبيق أندرويد/آيفون (Capacitor) مابيشوفش Web Push — بيسجّل توكن
      -- FCM. نفس الجدول، عمود kind بيفرّق: 'web' (VAPID) أو 'fcm' (توكن تطبيق).
      ALTER TABLE push_subs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'web';
      ALTER TABLE push_subs ADD COLUMN IF NOT EXISTS platform TEXT;
      ALTER TABLE push_subs ADD COLUMN IF NOT EXISTS app_version TEXT;
      ALTER TABLE push_subs ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
      -- سجل الإرسال: من غيره اللوحة مابتعرفش وصل لمين ولا مين فتح.
      CREATE TABLE IF NOT EXISTS push_log (
        id BIGSERIAL PRIMARY KEY,
        sub_id BIGINT,
        phone_norm TEXT,
        order_no TEXT,
        stage TEXT,
        campaign_id INTEGER,
        title TEXT,
        body TEXT,
        url TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivered_at TIMESTAMPTZ,
        clicked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS push_log_sent_idx ON push_log(sent_at DESC);
      CREATE INDEX IF NOT EXISTS push_log_phone_idx ON push_log(phone_norm, sent_at DESC);
      CREATE INDEX IF NOT EXISTS push_log_camp_idx ON push_log(campaign_id) WHERE campaign_id IS NOT NULL;
    `);
    // تنضيف سجل قديم (٩٠ يوم) — مرة كل إقلاع، بهدوء.
    pool.query("DELETE FROM push_log WHERE sent_at < NOW() - INTERVAL '90 days'").catch(() => {});
    // VAPID keys: settings-persisted, generated exactly once.
    const s = await getSettingsData();
    if (s.webPushKeys?.publicKey && s.webPushKeys?.privateKey) {
      vapid = s.webPushKeys;
    } else {
      vapid = push.generateVAPIDKeys();
      await pool.query(
        `UPDATE settings SET data = data || $1::jsonb WHERE id=1`,
        [jb({ webPushKeys: vapid })]
      );
      console.log("[notify] generated new VAPID key pair");
    }
    push.setVapidDetails("mailto:otg1194@gmail.com", vapid.publicKey, vapid.privateKey);
  }
  ensureSchema()
    .then(() => console.log("[notify] ready"))
    .catch((e) => console.error("[notify] init failed:", e.message));

  /* ── channel senders ── */

  /* ═══ FCM (تطبيق أندرويد/آيفون) ═══════════════════════════════════════
     الـWebView جوّه التطبيق مابيدعمش Web Push خالص، فالتطبيق بيسجّل توكن
     FCM بدل الاشتراك. الإرسال بيبقى على FCM HTTP v1، واللي محتاج حساب خدمة
     (service account) من فايربيز في FCM_SERVICE_ACCOUNT (JSON خام أو base64).
     من غير المتغيّر ده الكود ساكت تماماً — التوكنات بتتخزّن وبس، فأول ما عمر
     يحط المفتاح كل المشتركين القدام يشتغلوا من غير أي نشر تاني. */
  let fcmSa = null, fcmTok = { v: null, exp: 0 };
  function fcmAccount() {
    if (fcmSa !== null) return fcmSa;
    const raw = env("FCM_SERVICE_ACCOUNT");
    if (!raw) return (fcmSa = false);
    try {
      const json = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
      const sa = JSON.parse(json);
      fcmSa = sa.client_email && sa.private_key && sa.project_id ? sa : false;
    } catch { fcmSa = false; }
    if (!fcmSa) console.error("[notify] FCM_SERVICE_ACCOUNT is set but unreadable");
    return fcmSa;
  }
  const fcmReady = () => Boolean(fcmAccount());
  async function fcmToken() {
    if (fcmTok.v && Date.now() < fcmTok.exp) return fcmTok.v;
    const sa = fcmAccount();
    if (!sa) throw Object.assign(new Error("FCM not configured"), { code: "FCM_UNCONFIGURED" });
    const { createSign } = await import("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = b64({ alg: "RS256", typ: "JWT" });
    const claim = b64({
      iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
    });
    const sig = createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) throw new Error(`FCM auth: ${d.error_description || d.error || r.status}`);
    fcmTok = { v: d.access_token, exp: Date.now() + (Number(d.expires_in || 3600) - 120) * 1000 };
    return fcmTok.v;
  }
  /* بيرمي زي web-push، وبـstatusCode 404/410 لو التوكن مات — عشان نفس
     منطق التنضيف اللي فوق يشتغل من غير فرع تاني. */
  async function fcmSend(token, payload) {
    const sa = fcmAccount();
    const at = await fcmToken();
    const data = {};
    for (const [k, v] of Object.entries(payload || {})) if (v != null) data[k] = String(v);
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: {
        token,
        // notification + data: النظام بيعرض الإشعار حتى والتطبيق مقفول،
        // والـdata بتوصل لـnotificationActionPerformed عشان الفتح يروح مكانه.
        notification: { title: payload.title || "فريش كاتس 🍔", body: payload.body || "" },
        data,
        android: { priority: "high", notification: { channel_id: payload.channel || "orders", click_action: "FLUTTER_NOTIFICATION_CLICK" } },
        apns: { payload: { aps: { sound: "default", "mutable-content": 1 } } },
      } }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) return true;
    const d = await r.json().catch(() => ({}));
    const status = d?.error?.details?.[0]?.errorCode || d?.error?.status || "";
    const dead = r.status === 404 || status === "UNREGISTERED" || status === "INVALID_ARGUMENT";
    throw Object.assign(new Error(`FCM: ${d?.error?.message || r.status}`), { statusCode: dead ? 410 : r.status });
  }

  /* بيرجّع عدد الاشتراكات اللي وصلها الإشعار فعلاً (0 لو ولا واحد).
     meta = {stage, orderNo, campaignId} — بيتكتب في push_log، والـid بيتحقن
     في الحمولة كـ`n` عشان الـservice worker يرجّع «وصل» و«اتفتح». */
  async function sendPushTo(subs, payload, meta = {}) {
    let ok = 0;
    for (const row of subs || []) {
      let logId = null;
      try {
        const lg = await pool.query(
          `INSERT INTO push_log(sub_id, phone_norm, order_no, stage, campaign_id, title, body, url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [row.id || null, row.phone_norm || meta.phoneNorm || null, meta.orderNo || row.order_no || null,
           String(meta.stage || "custom").slice(0, 40), meta.campaignId || null,
           String(payload.title || "").slice(0, 120), String(payload.body || "").slice(0, 400),
           String(payload.url || "").slice(0, 400)]).catch(() => null);
        logId = lg?.rows?.[0]?.id || null;
      } catch { /* السجل مش سبب لمنع إشعار */ }
      const body = logId ? { ...payload, n: String(logId) } : payload;
      try {
        if (row.kind === "fcm") {
          if (!fcmReady()) throw Object.assign(new Error("FCM not configured"), { statusCode: 0 });
          await fcmSend(row.sub?.token || row.sub, body);
        } else {
          await push.sendNotification(row.sub, JSON.stringify(body), { TTL: 3600 });
        }
        ok++;
        pool.query("UPDATE push_subs SET last_ok_at=NOW() WHERE id=$1", [row.id]).catch(() => {});
      } catch (e) {
        // 404/410 = the browser dropped the subscription — retire it quietly.
        if (e.statusCode === 404 || e.statusCode === 410) {
          pool.query("UPDATE push_subs SET disabled=TRUE WHERE id=$1", [row.id]).catch(() => {});
        }
        if (logId) pool.query("DELETE FROM push_log WHERE id=$1", [logId]).catch(() => {});
      }
    }
    return ok;
  }

  async function sendWhatsApp(phoneNorm, text) {
    const token = env("WHATSAPP_TOKEN"), phoneId = env("WHATSAPP_PHONE_ID");
    if (!token || !phoneId) throw Object.assign(new Error("WhatsApp not configured"), { code: "WA_UNCONFIGURED" });
    const resp = await fetch(`https://graph.facebook.com/v23.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to: `966${phoneNorm}`,
        type: "text", text: { body: text },
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw Object.assign(new Error(`WhatsApp: ${data.error?.message || resp.status}`), { resp: data });
    return data;
  }

  const orderSubs = async (phoneNorm, orderNo) => (await pool.query(
    `SELECT id, sub, kind, phone_norm, order_no FROM push_subs
      WHERE NOT disabled AND (phone_norm=$1 OR order_no=$2) LIMIT 20`,
    [phoneNorm, orderNo])).rows;

  /* Push لطلب واحد (البوابة/مركز الطلبات): كل اشتراك حي لجوال الطلب أو رقمه.
     بيرجّع عدد المرسل وبيطلق notify_sent (stage = payload.stage أو "custom").
     مابترميش — أي فشل = اللي اتبعت لحد دلوقتي. */
  async function sendOrderPush(orderNo, payload = {}) {
    const stage = String(payload?.stage || "custom").slice(0, 40);
    let sent = 0, of = 0;
    try {
      const cfg = (await getSettingsData()).notifications || {};
      if (cfg.pushEnabled === false) {
        emitNotify(orderNo, stage, "none", false, { reason: "push_disabled" });
        return 0;
      }
      const r = await pool.query("SELECT order_no, phone_norm FROM shop_orders WHERE order_no=$1", [String(orderNo)]);
      const order = r.rows[0];
      if (!order) return 0;
      const subs = await orderSubs(order.phone_norm, order.order_no);
      of = subs.length;
      if (!of) {
        emitNotify(orderNo, stage, "none", false, { reason: "no_subscriptions" });
        return 0;
      }
      const { stage: _stage, ...body } = payload || {};
      sent = await sendPushTo(subs, {
        title: "فريش كاتس 🍔",
        url: `${env("STOREFRONT_PUBLIC_URL", "https://freshcuts.sa")}/track/${order.order_no}`,
        ...body,
      }, { stage, orderNo: order.order_no, phoneNorm: order.phone_norm });
      emitNotify(orderNo, stage, "push", sent > 0, { sent, of });
      return sent;
    } catch (e) {
      console.error(`[notify] order push failed for ${orderNo}:`, e?.message);
      emitNotify(orderNo, stage, "push", false, { sent, of, error: "send_failed" });
      return sent;
    }
  }

  /* ── the one entry point shop.js calls on every status change ── */
  async function orderStatusChanged(orderNo, status) {
    const make = MESSAGES[status];
    if (!make) return; // internal stage — customers never hear about it
    const r = await pool.query(
      "SELECT order_no, phone_norm, option, total FROM shop_orders WHERE order_no=$1", [orderNo]);
    const order = r.rows[0];
    if (!order) return;
    const text = make(order);
    let cfg;
    try { cfg = (await getSettingsData()).notifications || {}; }
    catch (e) {
      emitNotify(orderNo, status, "none", false, { reason: "settings_failed" });
      throw e;
    }
    const attempts = [];

    // Push (default ON): to every live subscription for this phone or order.
    if (cfg.pushEnabled !== false) {
      let subs = [];
      try { subs = await orderSubs(order.phone_norm, order.order_no); }
      catch (e) {
        console.error(`[notify] push lookup failed for ${orderNo}:`, e?.message);
        emitNotify(orderNo, status, "push", false, { sent: 0, of: 0, error: "lookup_failed" });
        attempts.push(Promise.resolve());
      }
      if (subs.length) {
        // بعد التوصيل الضغطة تروح لصفحة التقييم على جوجل مباشرة — أقصر طريق
        // للمراجعة وهي أهم إشارة لترتيب الخرائط. باقي المراحل تفتح التتبع.
        const url = status === "delivered"
          ? env("GOOGLE_REVIEW_URL", "https://g.page/r/CSG0gPAqlvHMEBM/review")
          : `${env("STOREFRONT_PUBLIC_URL", "https://freshcuts.sa")}/track/${order.order_no}`;
        attempts.push(sendPushTo(subs, { title: "فريش كاتس 🍔", body: text, url },
          { stage: status, orderNo: order.order_no, phoneNorm: order.phone_norm }).then(
          (sent) => emitNotify(orderNo, status, "push", sent > 0, { sent, of: subs.length }),
          () => emitNotify(orderNo, status, "push", false, { sent: 0, of: subs.length })));
      }
    }

    const smsStages = smsStagesOf(cfg);

    // WhatsApp بالقوالب (whatsapp.js): بيتجرّب الأول عشان نعرف نستغنى عن SMS ولا لأ.
    // whatsappReplacesSms=true → لو اتقبل على واتساب مابنبعتش SMS، ولو فشل
    // لاحقاً (ويب هوك failed) whatsapp.js بيبعت نفس النص SMS.
    let waResult = null;
    if (wa && cfg.whatsappEnabled === true) {
      const replaces = cfg.whatsappReplacesSms === true;
      try {
        waResult = await wa.sendOrderUpdate(order, status, {
          fallbackSms: replaces && cfg.smsEnabled === true && smsStages.includes(status) ? text : null });
      } catch (e) { waResult = { ok: false, error: "send_failed" }; }
      if (!(waResult.skipped === "no_template_for_stage")) {
        emitNotify(orderNo, status, "whatsapp", waResult.ok === true,
          waResult.ok ? {} : { error: String(waResult.skipped || waResult.error || "send_failed").slice(0, 60) });
        attempts.push(Promise.resolve());
      }
    }
    const smsSkippedForWa = Boolean(waResult?.ok && cfg.whatsappReplacesSms === true);

    // SMS (default OFF, stage-filtered — each message costs money).
    if (cfg.smsEnabled === true && smsStages.includes(status) && !smsSkippedForWa) {
      attempts.push(Promise.resolve().then(() => smsSend({ phoneNorm: order.phone_norm, body: text, kind: "order_status", ref: `${orderNo}:${status}` })).then(
        () => emitNotify(orderNo, status, "sms", true),
        (e) => {
          console.error(`[notify] SMS failed for ${orderNo}:`, e?.message);
          emitNotify(orderNo, status, "sms", false, { error: String(e?.code || "send_failed").slice(0, 60) });
        }));
    }

    // WhatsApp (default OFF; needs the coexistence step + an approved template).
    if (!wa && cfg.whatsappEnabled === true) {
      attempts.push(sendWhatsApp(order.phone_norm, text).then(
        () => emitNotify(orderNo, status, "whatsapp", true),
        (e) => {
          console.error(`[notify] WhatsApp failed for ${orderNo}:`, e?.message);
          emitNotify(orderNo, status, "whatsapp", false, { error: String(e?.code || "send_failed").slice(0, 60) });
        }));
    }

    // مفيش ولا قناة اتجرّبت (Push مقفول أو مفيش اشتراكات، وSMS/واتساب مقفولين).
    if (!attempts.length) emitNotify(orderNo, status, "none", false, { reason: "no_channel" });
    // القنوات شغالة مع بعض (زي الأول)؛ بنستنى نتايجها بس عشان الحدث يتطلق.
    // shop.js أصلاً مابيستناش orderStatusChanged — بيعمل .catch بس.
    await Promise.allSettled(attempts);
  }

  /* ── routes ── */

  // PUBLIC: the storefront needs the public key to subscribe.
  app.get("/api/notify/vapid-key", (c) =>
    c.json(vapid ? { ok: true, publicKey: vapid.publicKey } : { ok: false }, vapid ? 200 : 503));

  /* PUBLIC: store a browser subscription, tied to a phone and/or an order.
     شكلين: اشتراك متصفح {subscription:{endpoint,keys}} أو توكن تطبيق
     {kind:"fcm", token}. الاتنين بيقعدوا في نفس الجدول — endpoint للتوكن =
     "fcm:<token>" عشان نفس قفل التكرار يشتغل. */
  app.post("/api/notify/subscribe", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    let kind = "web", endpoint = "", stored = null;
    if (b.kind === "fcm" || (!b.subscription && b.token)) {
      const tok = String(b.token || "").trim();
      if (tok.length < 20 || tok.length > 4096) return c.json({ ok: false, error: "bad token" }, 400);
      kind = "fcm"; endpoint = `fcm:${tok}`; stored = { kind: "fcm", token: tok };
    } else {
      const sub = b.subscription;
      if (!sub?.endpoint || !sub?.keys) return c.json({ ok: false, error: "bad subscription" }, 400);
      endpoint = String(sub.endpoint); stored = sub;
    }
    let phone = b.phone ? normPhone(b.phone) : null;
    if (!/^5\d{8}$/.test(phone || "")) phone = null;
    const orderNo = b.orderNo ? String(b.orderNo).slice(0, 30) : null;
    /* ٢١/٩: صفحة التتبع بتتفتح كتير من رابط SMS على جهاز تاني — فـfc_profile
       فاضي والاشتراك كان بيتسجّل بلا جوال، يعني الحملات مابتشوفوش. رقم الطلب
       عندنا، فبنجيب الجوال من الطلب نفسه بدل ما نستنى العميل. */
    if (!phone && orderNo) {
      const r = await pool.query("SELECT phone_norm FROM shop_orders WHERE order_no=$1", [orderNo]).catch(() => null);
      const p = r?.rows?.[0]?.phone_norm;
      if (/^5\d{8}$/.test(p || "")) phone = p;
    }
    /* المتصفح دوّر التوكن (pushsubscriptionchange): الاشتراك الجديد ملوش
       جوال ولا جهاز — بنورّثهم من القديم وبنقفله، وإلا كل تدوير بيرمي عميل
       من جمهور الحملات وهو فاكر نفسه لسه مشترك. */
    let inherited = null;
    if (b.oldEndpoint && String(b.oldEndpoint) !== endpoint) {
      const o = await pool.query(
        "SELECT phone_norm, order_no, device_id FROM push_subs WHERE endpoint=$1", [String(b.oldEndpoint).slice(0, 1000)]).catch(() => null);
      inherited = o?.rows?.[0] || null;
      if (inherited) {
        pool.query("UPDATE push_subs SET disabled=TRUE WHERE endpoint=$1", [String(b.oldEndpoint).slice(0, 1000)]).catch(() => {});
        if (!phone && /^5\d{8}$/.test(inherited.phone_norm || "")) phone = inherited.phone_norm;
      }
    }
    await pool.query(
      `INSERT INTO push_subs(phone_norm, order_no, endpoint, sub, device_id, kind, platform, app_version, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (endpoint) DO UPDATE SET
         phone_norm = COALESCE(EXCLUDED.phone_norm, push_subs.phone_norm),
         order_no = COALESCE(EXCLUDED.order_no, push_subs.order_no),
         device_id = COALESCE(EXCLUDED.device_id, push_subs.device_id),
         platform = COALESCE(EXCLUDED.platform, push_subs.platform),
         app_version = COALESCE(EXCLUDED.app_version, push_subs.app_version),
         kind = EXCLUDED.kind, last_seen_at = NOW(),
         sub = EXCLUDED.sub, disabled = FALSE`,
      [phone, orderNo || inherited?.order_no || null, endpoint, jb(stored),
       b.deviceId ? String(b.deviceId).slice(0, 64) : (inherited?.device_id || null),
       kind,
       b.platform ? String(b.platform).slice(0, 16) : null,
       b.appVersion ? String(b.appVersion).slice(0, 24) : null]
    );
    return c.json({ ok: true, kind, linked: Boolean(phone) });
  });

  /* PUBLIC: ربط كل اشتراكات جهاز بجوال اتأكّد بـOTP. الـtoken بتاع الحساب
     (cust:) هو الإثبات — الجوال مابيتاخدش من الجسم عشان محدش يربط رقم غيره. */
  app.post("/api/notify/link", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip, 120)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    // نفس قاعدة accounts.js: جلسة حيّة (١٨٠ يوم من آخر ظهور) = جوال متأكّد بـOTP
    const m = (c.req.header("Authorization") || "").match(/^Bearer cust:([a-f0-9]{48,96})$/i);
    if (!m) return c.json({ ok: false, error: "unauthorized" }, 401);
    const sess = await pool.query(
      "SELECT phone_norm FROM acct_sessions WHERE token=$1 AND last_seen_at > NOW() - INTERVAL '180 days'",
      [m[1]]).catch(() => null);
    const phone = sess?.rows?.[0]?.phone_norm;
    if (!/^5\d{8}$/.test(phone || "")) return c.json({ ok: false, error: "unauthorized" }, 401);
    const dev = b.deviceId ? String(b.deviceId).slice(0, 64) : null;
    const ep = b.endpoint ? String(b.endpoint).slice(0, 1000) : null;
    if (!dev && !ep) return c.json({ ok: false, error: "device_or_endpoint_required" }, 400);
    const r = await pool.query(
      `UPDATE push_subs SET phone_norm=$1, last_seen_at=NOW()
        WHERE NOT disabled AND (($2::text IS NOT NULL AND device_id=$2) OR ($3::text IS NOT NULL AND endpoint=$3))`,
      [phone, dev, ep]);
    return c.json({ ok: true, linked: r.rowCount });
  });

  /* PUBLIC: الـservice worker بيقول «وصل» و«اتفتح». من غير ده اللوحة بتعرف
     إننا بعتنا وبس — مش إن حد شاف. الـid رقم سطر في push_log، فمفيش بيانات
     شخصية في الطريق. */
  app.post("/api/notify/event", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip, 600)) return c.json({ ok: false }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false }, 400); }
    const id = Number(b.id);
    if (!Number.isFinite(id) || id <= 0) return c.json({ ok: false }, 400);
    const col = b.t === "click" ? "clicked_at" : "delivered_at";
    await pool.query(
      `UPDATE push_log SET ${col}=COALESCE(${col}, NOW())
        WHERE id=$1 AND sent_at > NOW() - INTERVAL '7 days'`, [id]).catch(() => {});
    return c.json({ ok: true });
  });

  // Admin: channel health for the dashboard toggles screen.
  app.get("/api/notify/channels", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = (await getSettingsData()).notifications || {};
    const [s, d] = await Promise.all([
      pool.query(`SELECT count(*) FILTER (WHERE NOT disabled)::int AS live,
                         count(*) FILTER (WHERE disabled)::int AS dead,
                         count(DISTINCT phone_norm) FILTER (WHERE NOT disabled AND phone_norm IS NOT NULL)::int AS reach,
                         count(*) FILTER (WHERE NOT disabled AND kind='fcm')::int AS app,
                         count(*) FILTER (WHERE NOT disabled AND created_at > NOW() - INTERVAL '7 days')::int AS new7
                    FROM push_subs`),
      pool.query(`SELECT count(*)::int AS sent,
                         count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
                         count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked
                    FROM push_log WHERE sent_at > NOW() - INTERVAL '30 days'`),
    ]);
    const st = s.rows[0], lg = d.rows[0];
    return c.json({
      ok: true,
      push: {
        configured: Boolean(vapid), enabled: cfg.pushEnabled !== false, subscriptions: st.live,
        // الوصول الحقيقي = عدد العملاء (أرقام جوال) مش عدد الأجهزة
        reach: st.reach, devicesDead: st.dead, appTokens: st.app, new7d: st.new7,
        fcmConfigured: fcmReady(),
        last30d: { sent: lg.sent, delivered: lg.delivered, clicked: lg.clicked,
          deliveredPct: lg.sent ? Math.round((lg.delivered / lg.sent) * 100) : null,
          clickedPct: lg.sent ? Math.round((lg.clicked / lg.sent) * 100) : null },
      },
      sms: {
        configured: Boolean(env("TAQNYAT_API_KEY") && env("TAQNYAT_SENDER")),
        enabled: cfg.smsEnabled === true,
        stages: smsStagesOf(cfg),
        mandatoryStages: MANDATORY_SMS_STAGES,
      },
      whatsapp: {
        configured: Boolean(env("WHATSAPP_TOKEN") && env("WHATSAPP_PHONE_ID")),
        enabled: cfg.whatsappEnabled === true,
      },
    });
  });

  /* Admin (dry-run، مفيش إرسال): لكل مرحلة — هل هتتبعت SMS؟ ونصها وعدد أجزائها.
     ?orderNo= بياخد رقم طلب حقيقي، غير كده رقم تجريبي بطول رقم الطلب الحالي. */
  app.get("/api/notify/sms-preview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = (await getSettingsData()).notifications || {};
    let order = null;
    const no = String(c.req.query("orderNo") || "").slice(0, 30);
    if (no) order = (await pool.query("SELECT order_no, phone_norm, option, total FROM shop_orders WHERE order_no=$1", [no])).rows[0] || null;
    if (!order) {
      const last = (await pool.query("SELECT order_no FROM shop_orders ORDER BY created_at DESC LIMIT 1")).rows[0];
      order = { order_no: last?.order_no || "FC-000000", option: "delivery", total: 96 };
    }
    const { smsParts } = await import("./smsrules.js");
    const stages = smsStagesOf(cfg);
    return c.json({
      ok: true, smsEnabled: cfg.smsEnabled === true, sender: env("TAQNYAT_SENDER") || null, stages,
      preview: Object.keys(MESSAGES).map((st) => {
        const text = MESSAGES[st](order);
        return { stage: st, willSms: cfg.smsEnabled === true && stages.includes(st), text, chars: text.length, parts: smsParts(text) };
      }),
    });
  });

  // Admin: fire a test message through any channel before going live.
  app.post("/api/notify/test", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const text = b.text || "رسالة تجريبية من فريش كاتس ✅";
    try {
      if (b.channel === "sms") {
        const phone = normPhone(b.phone);
        if (!/^5\d{8}$/.test(phone)) return c.json({ ok: false, error: "invalid_phone" }, 400);
        await sendSms({ phoneNorm: phone, body: text, kind: "test" });
      } else if (b.channel === "whatsapp") {
        const phone = normPhone(b.phone);
        if (!/^5\d{8}$/.test(phone)) return c.json({ ok: false, error: "invalid_phone" }, 400);
        await sendWhatsApp(phone, text);
      } else {
        const subs = (await pool.query(
          "SELECT id, sub, kind, phone_norm, order_no FROM push_subs WHERE NOT disabled ORDER BY id DESC LIMIT 5")).rows;
        const sent = await sendPushTo(subs, { title: "فريش كاتس 🍔", body: text, url: env("STOREFRONT_PUBLIC_URL", "https://freshcuts.sa") });
        return c.json({ ok: true, sent, of: subs.length });
      }
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 502);
    }
  });

  /* ── senders reusable by other modules (carts.js recovery) ──
     نفس قنوات إشعارات الطلب، بس بجمهور محدد بالجوال أو الجهاز. */
  async function sendToAudience({ phoneNorm, deviceId, title, body, url, stage, campaignId }) {
    const cfg = (await getSettingsData()).notifications || {};
    if (cfg.pushEnabled === false) return false;
    const subs = (await pool.query(
      `SELECT id, sub, kind, phone_norm, order_no FROM push_subs
        WHERE NOT disabled AND ((phone_norm IS NOT NULL AND phone_norm=$1) OR device_id=$2) LIMIT 10`,
      [phoneNorm || null, deviceId || ""])).rows;
    if (!subs.length) return false;
    const ok = await sendPushTo(subs, { title, body, url: url || env("STOREFRONT_PUBLIC_URL", "https://freshcuts.sa"),
      channel: campaignId ? "offers" : "orders" },
      { stage: stage || (campaignId ? "campaign" : "custom"), campaignId: campaignId || null, phoneNorm: phoneNorm || null });
    return ok > 0;
  }
  /* meta = {kind, ref} لسجل الرسايل (smslog.js) — اختياري */
  async function sendSmsTo(phoneNorm, body, meta = {}) {
    const cfg = (await getSettingsData()).notifications || {};
    if (cfg.smsEnabled !== true) return false;
    await sendSms({ phoneNorm, body, kind: meta.kind, ref: meta.ref });
    return true;
  }

  /* نتايج حملة إشعارات: بعتنا كام، وصل كام، اتفتح كام (cms.js بيعرضها) */
  async function campaignPushStats(campaignId) {
    const r = await pool.query(
      `SELECT count(*)::int AS sent,
              count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
              count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked
         FROM push_log WHERE campaign_id=$1`, [Number(campaignId)]);
    return r.rows[0];
  }
  /* مين اتبعتله إشعار خلال N يوم — فاصل الإشعارات (أخف من الـSMS لأنه ببلاش) */
  async function pushedSince(phones, days) {
    if (!Array.isArray(phones) || !phones.length || !(days > 0)) return new Set();
    const r = await pool.query(
      `SELECT DISTINCT phone_norm FROM push_log
        WHERE phone_norm = ANY($1) AND campaign_id IS NOT NULL
          AND sent_at > NOW() - ($2 || ' days')::interval`, [phones, String(days)]);
    return new Set(r.rows.map((x) => x.phone_norm));
  }
  return { orderStatusChanged, sendToAudience, sendSmsTo, sendPushTo, sendOrderPush,
    campaignPushStats, pushedSince, fcmReady };
}
