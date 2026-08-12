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

const env = (k, d) => (process.env[k] || d || "").toString().trim();

/* What we tell the customer at each stage. Stages missing here are internal
   and never notify (pending_payment, expired, paid_pos_failed...). */
const MESSAGES = {
  pos_created: (o) => `فريش كتس: استلمنا طلبك ${o.order_no} وتم الدفع بنجاح ✅`,
  accepted: (o) => `فريش كتس: المطعم بدأ تجهيز طلبك ${o.order_no} 👨‍🍳`,
  courier_assigned: () => `فريش كتس: المندوب في الطريق لاستلام طلبك 🛵`,
  on_the_way: () => `فريش كتس: طلبك في الطريق إليك الآن 🛵💨`,
  delivered: () => `فريش كتس: تم توصيل طلبك — بالهنا والشفا 🌟`,
  rejected_refunded: (o) => `فريش كتس: نعتذر، تعذّر تنفيذ طلبك ${o.order_no} وتم استرجاع المبلغ كاملاً لبطاقتك 💳`,
};
const DEFAULT_SMS_STAGES = ["pos_created", "rejected_refunded"];

const rl = new Map();
function rateLimited(ip, max = 60) {
  const now = Date.now();
  const slot = rl.get(ip);
  if (!slot || now - slot.start > 3600_000) { rl.set(ip, { start: now, n: 1 }); return false; }
  slot.n++;
  if (rl.size > 5000) rl.clear();
  return slot.n > max;
}

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, jb, normPhone } = ctx;

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
    `);
    // VAPID keys: settings-persisted, generated exactly once.
    const s = await getSettingsData();
    if (s.webPushKeys?.publicKey && s.webPushKeys?.privateKey) {
      vapid = s.webPushKeys;
    } else {
      vapid = webpush.generateVAPIDKeys();
      await pool.query(
        `UPDATE settings SET data = data || $1::jsonb WHERE id=1`,
        [jb({ webPushKeys: vapid })]
      );
      console.log("[notify] generated new VAPID key pair");
    }
    webpush.setVapidDetails("mailto:otg1194@gmail.com", vapid.publicKey, vapid.privateKey);
  }
  ensureSchema()
    .then(() => console.log("[notify] ready"))
    .catch((e) => console.error("[notify] init failed:", e.message));

  /* ── channel senders ── */

  async function sendPushTo(subs, payload) {
    let ok = 0;
    for (const row of subs) {
      try {
        await webpush.sendNotification(row.sub, JSON.stringify(payload), { TTL: 3600 });
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

  /* ── the one entry point shop.js calls on every status change ── */
  async function orderStatusChanged(orderNo, status) {
    const make = MESSAGES[status];
    if (!make) return; // internal stage — customers never hear about it
    const r = await pool.query(
      "SELECT order_no, phone_norm, option, total FROM shop_orders WHERE order_no=$1", [orderNo]);
    const order = r.rows[0];
    if (!order) return;
    const text = make(order);
    const cfg = (await getSettingsData()).notifications || {};

    // Push (default ON): to every live subscription for this phone or order.
    if (cfg.pushEnabled !== false) {
      const subs = (await pool.query(
        `SELECT id, sub FROM push_subs
          WHERE NOT disabled AND (phone_norm=$1 OR order_no=$2) LIMIT 20`,
        [order.phone_norm, order.order_no])).rows;
      if (subs.length) {
        sendPushTo(subs, {
          title: "فريش كتس 🍔", body: text,
          url: `https://order.o2m8.me/track/${order.order_no}`,
        }).catch(() => {});
      }
    }

    // SMS (default OFF, stage-filtered — each message costs money).
    const smsStages = Array.isArray(cfg.smsStages) && cfg.smsStages.length ? cfg.smsStages : DEFAULT_SMS_STAGES;
    if (cfg.smsEnabled === true && smsStages.includes(status)) {
      sendSms({ phoneNorm: order.phone_norm, body: text }).catch((e) =>
        console.error(`[notify] SMS failed for ${orderNo}:`, e.message));
    }

    // WhatsApp (default OFF; needs the coexistence step + an approved template).
    if (cfg.whatsappEnabled === true) {
      sendWhatsApp(order.phone_norm, text).catch((e) =>
        console.error(`[notify] WhatsApp failed for ${orderNo}:`, e.message));
    }
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
      `INSERT INTO push_subs(phone_norm, order_no, endpoint, sub)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET
         phone_norm = COALESCE(EXCLUDED.phone_norm, push_subs.phone_norm),
         order_no = COALESCE(EXCLUDED.order_no, push_subs.order_no),
         sub = EXCLUDED.sub, disabled = FALSE`,
      [/^5\d{8}$/.test(phone || "") ? phone : null,
       b.orderNo ? String(b.orderNo).slice(0, 30) : null,
       String(sub.endpoint), jb(sub)]
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
    const text = b.text || "رسالة تجريبية من فريش كتس ✅";
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
        const sent = await sendPushTo(subs, { title: "فريش كتس 🍔", body: text, url: "https://order.o2m8.me" });
        return c.json({ ok: true, sent, of: subs.length });
      }
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 502);
    }
  });

  return { orderStatusChanged };
}
