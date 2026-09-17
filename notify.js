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

/* What we tell the customer at each stage. Stages missing here are internal
   and never notify (pending_payment, expired, paid_pos_failed...). */
const MESSAGES = {
  pos_created: (o) => `فريش كاتس: استلمنا طلبك ${o.order_no} وتم الدفع بنجاح ✅`,
  accepted: (o) => `فريش كاتس: المطعم بدأ تجهيز طلبك ${o.order_no} 👨‍🍳`,
  courier_assigned: () => `فريش كاتس: رتّبنا لك مندوب توصيل 🛵`,
  on_the_way: () => `فريش كاتس: طلبك في الطريق إليك الآن 🛵💨`,
  // Google Business review link (settings.storefront.seo.links.review overrides the env/default).
  delivered: () => `فريش كاتس: تم توصيل طلبك — بالهنا والشفا 🌟 عجبك الأكل؟ قيّمنا على جوجل: ${env("GOOGLE_REVIEW_URL", "https://g.page/r/CSG0gPAqlvHMEBM/review")}`,
  rejected_refunded: (o) => `فريش كاتس: نعتذر، تعذّر تنفيذ طلبك ${o.order_no} وتم استرجاع المبلغ كاملاً لبطاقتك 💳`,
  /* الاسترجاع اتأخر — ما نقولش «تم» وهو ما تمّش. الرسالة دي بتعترف
     بالمشكلة وبتوعد بمتابعة، والوعد ده مدعوم بإنذار درجة 3 في اللوحة
     بيفضل ولّع لحد ما حد يسترجع فعلاً. */
  refund_failed: (o) => `فريش كاتس: نعتذر عن طلبك ${o.order_no}. استرجاع المبلغ جارٍ وفريقنا بيتابعه — هنتواصل معك للتأكيد 🙏`,
};
const DEFAULT_SMS_STAGES = ["pos_created", "rejected_refunded", "refund_failed"];

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
    `);
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

  /* بيرجّع عدد الاشتراكات اللي وصلها الإشعار فعلاً (0 لو ولا واحد). */
  async function sendPushTo(subs, payload) {
    let ok = 0;
    for (const row of subs || []) {
      try {
        await push.sendNotification(row.sub, JSON.stringify(payload), { TTL: 3600 });
        ok++;
        pool.query("UPDATE push_subs SET last_ok_at=NOW() WHERE id=$1", [row.id]).catch(() => {});
      } catch (e) {
        // 404/410 = the browser dropped the subscription — retire it quietly.
        if (e.statusCode === 404 || e.statusCode === 410) {
          pool.query("UPDATE push_subs SET disabled=TRUE WHERE id=$1", [row.id]).catch(() => {});
        }
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
    `SELECT id, sub FROM push_subs
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
      });
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
        attempts.push(sendPushTo(subs, { title: "فريش كاتس 🍔", body: text, url }).then(
          (sent) => emitNotify(orderNo, status, "push", sent > 0, { sent, of: subs.length }),
          () => emitNotify(orderNo, status, "push", false, { sent: 0, of: subs.length })));
      }
    }

    const smsStages = Array.isArray(cfg.smsStages) && cfg.smsStages.length ? cfg.smsStages : DEFAULT_SMS_STAGES;

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
      attempts.push(Promise.resolve().then(() => smsSend({ phoneNorm: order.phone_norm, body: text })).then(
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

  // PUBLIC: store a browser subscription, tied to a phone and/or an order.
  app.post("/api/notify/subscribe", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const sub = b.subscription;
    if (!sub?.endpoint || !sub?.keys) return c.json({ ok: false, error: "bad subscription" }, 400);
    const phone = b.phone ? normPhone(b.phone) : null;
    await pool.query(
      `INSERT INTO push_subs(phone_norm, order_no, endpoint, sub, device_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET
         phone_norm = COALESCE(EXCLUDED.phone_norm, push_subs.phone_norm),
         order_no = COALESCE(EXCLUDED.order_no, push_subs.order_no),
         device_id = COALESCE(EXCLUDED.device_id, push_subs.device_id),
         sub = EXCLUDED.sub, disabled = FALSE`,
      [/^5\d{8}$/.test(phone || "") ? phone : null,
       b.orderNo ? String(b.orderNo).slice(0, 30) : null,
       String(sub.endpoint), jb(sub),
       b.deviceId ? String(b.deviceId).slice(0, 64) : null]
    );
    return c.json({ ok: true });
  });

  // Admin: channel health for the dashboard toggles screen.
  app.get("/api/notify/channels", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = (await getSettingsData()).notifications || {};
    const subs = (await pool.query(
      "SELECT count(*)::int AS n FROM push_subs WHERE NOT disabled")).rows[0].n;
    return c.json({
      ok: true,
      push: { configured: Boolean(vapid), enabled: cfg.pushEnabled !== false, subscriptions: subs },
      sms: {
        configured: Boolean(env("TAQNYAT_API_KEY") && env("TAQNYAT_SENDER")),
        enabled: cfg.smsEnabled === true,
        stages: cfg.smsStages || DEFAULT_SMS_STAGES,
      },
      whatsapp: {
        configured: Boolean(env("WHATSAPP_TOKEN") && env("WHATSAPP_PHONE_ID")),
        enabled: cfg.whatsappEnabled === true,
      },
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
        await sendSms({ phoneNorm: phone, body: text });
      } else if (b.channel === "whatsapp") {
        const phone = normPhone(b.phone);
        if (!/^5\d{8}$/.test(phone)) return c.json({ ok: false, error: "invalid_phone" }, 400);
        await sendWhatsApp(phone, text);
      } else {
        const subs = (await pool.query(
          "SELECT id, sub FROM push_subs WHERE NOT disabled ORDER BY id DESC LIMIT 5")).rows;
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
  async function sendToAudience({ phoneNorm, deviceId, title, body, url }) {
    const cfg = (await getSettingsData()).notifications || {};
    if (cfg.pushEnabled === false) return false;
    const subs = (await pool.query(
      `SELECT id, sub FROM push_subs
        WHERE NOT disabled AND ((phone_norm IS NOT NULL AND phone_norm=$1) OR device_id=$2) LIMIT 10`,
      [phoneNorm || null, deviceId || ""])).rows;
    if (!subs.length) return false;
    const ok = await sendPushTo(subs, { title, body, url: url || env("STOREFRONT_PUBLIC_URL", "https://freshcuts.sa") });
    return ok > 0;
  }
  async function sendSmsTo(phoneNorm, body) {
    const cfg = (await getSettingsData()).notifications || {};
    if (cfg.smsEnabled !== true) return false;
    await sendSms({ phoneNorm, body });
    return true;
  }

  return { orderStatusChanged, sendToAudience, sendSmsTo, sendPushTo, sendOrderPush };
}
