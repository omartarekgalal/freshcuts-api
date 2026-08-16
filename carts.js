/* ═══════════════════════════════════════════════════════════════════════════
   CARTS — السلات المتروكة: نلتقطها، نقيسها، ونستردها.

   طلب عمر (2026-08-16): «نراقب السلات المتروكة بشكل واضح ونعملها خطة».

   الفكرة: المتجر بيبعت لقطة من السلة عند كل خطوة مهمة (اتضاف صنف، فتح
   الشيك أوت، اتحدد العنوان، اتفتحت شاشة الدفع). اللقطة بتتخزن على مفتاح
   الجهاز (device id في localStorage) وبتترقّى لرقم الجوال أول ما نعرفه —
   عشان نقدر نكلّم العميل فعلاً، مش نتفرج على رقم مجهول.

   الحقيقة اللي بتحكم التصميم: **معظم السلات المتروكة مجهولة الهوية**
   (العميل ما وصلش لخطوة الجوال). فالقياس بيفصل بين:
     • reachable   → عندنا جوال (push/SMS/WhatsApp ممكنة)
     • anonymous   → للقياس بس (تحسين المنتج، مش استرداد)

   المراحل (stage): cart → checkout → address → payment → ordered
   السلة بتتقفل (recovered) لحظة ما يتعمل طلب مدفوع بنفس الجوال/الجهاز.

   الاسترداد (recovery ladder) بيشتغل من الحارس كل ٥ دقايق:
     بعد ٤٥ دقيقة  → إشعار متصفح: «سلتك لسه مستنياك 🛒»
     بعد ٤ ساعات   → SMS/واتساب (لو مفعّلين) + كوبون اختياري
     مرة واحدة لكل سلة، وبس في ساعات مسموحة (مش ٣ الفجر).
═══════════════════════════════════════════════════════════════════════════ */

const env = (k, d) => (process.env[k] || d || "").toString().trim();
const STAGES = ["cart", "checkout", "address", "payment", "ordered"];
const rank = (s) => Math.max(0, STAGES.indexOf(String(s || "cart")));

/* ساعات مسموح فيها التواصل بتوقيت الرياض — المطعم بيقفل ٢-٣ فجراً،
   ورسالة الساعة ٤ الفجر بتخسر عميل مش بترجّعه. */
function riyadhHour() {
  return Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Riyadh", hour: "2-digit", hour12: false }));
}
const QUIET_FROM = 1, QUIET_TO = 10; // 01:00 → 10:00 صمت

const rl = new Map();
function rateLimited(ip, max = 240) {
  const now = Date.now();
  const slot = rl.get(ip);
  if (!slot || now - slot.start > 3600_000) { rl.set(ip, { start: now, n: 1 }); return false; }
  slot.n++;
  if (rl.size > 5000) rl.clear();
  return slot.n > max;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb, normPhone } = ctx;
  const notify = deps.notify || null;

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_carts (
        device_id TEXT PRIMARY KEY,
        phone_norm TEXT,
        stage TEXT NOT NULL DEFAULT 'cart',
        max_stage TEXT NOT NULL DEFAULT 'cart',
        items JSONB NOT NULL DEFAULT '[]'::jsonb,
        item_count INT NOT NULL DEFAULT 0,
        subtotal NUMERIC NOT NULL DEFAULT 0,
        option TEXT,
        has_location BOOLEAN NOT NULL DEFAULT FALSE,
        installed BOOLEAN,
        push_ready BOOLEAN,
        ua TEXT,
        recovered_order TEXT,
        recovered_at TIMESTAMPTZ,
        nudges JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS shop_carts_phone_idx ON shop_carts(phone_norm) WHERE phone_norm IS NOT NULL;
      CREATE INDEX IF NOT EXISTS shop_carts_open_idx ON shop_carts(updated_at DESC) WHERE recovered_order IS NULL;
    `);
  }
  ensureSchema()
    .then(() => console.log("[carts] schema ready"))
    .catch((e) => console.error("[carts] schema failed:", e.message));

  /* ── PUBLIC: لقطة السلة من المتجر ─────────────────────────────────────
     بتتنده عند كل تغيير مهم (debounced في الواجهة). مفيش أسرار هنا —
     أسوأ استغلال ممكن هو تلويث إحصائية، والحد الأدنى من الحماية كفاية. */
  app.post("/api/carts/snapshot", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const device = String(b.deviceId || "").slice(0, 64);
    if (!/^[a-z0-9_-]{8,64}$/i.test(device)) return c.json({ ok: false, error: "bad device" }, 400);
    const phone = b.phone ? normPhone(b.phone) : null;
    const items = Array.isArray(b.items) ? b.items.slice(0, 60) : [];
    const stage = STAGES.includes(String(b.stage)) ? String(b.stage) : "cart";

    await pool.query(
      `INSERT INTO shop_carts(device_id, phone_norm, stage, max_stage, items, item_count, subtotal,
                              option, has_location, installed, push_ready, ua)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (device_id) DO UPDATE SET
         phone_norm = COALESCE(EXCLUDED.phone_norm, shop_carts.phone_norm),
         stage = EXCLUDED.stage,
         -- max_stage بيفضل أبعد نقطة وصلها العميل (مش آخر خطوة رجع منها)
         max_stage = CASE WHEN $12::int > (CASE shop_carts.max_stage
             WHEN 'cart' THEN 0 WHEN 'checkout' THEN 1 WHEN 'address' THEN 2
             WHEN 'payment' THEN 3 WHEN 'ordered' THEN 4 ELSE 0 END)
           THEN EXCLUDED.stage ELSE shop_carts.max_stage END,
         items = EXCLUDED.items, item_count = EXCLUDED.item_count, subtotal = EXCLUDED.subtotal,
         option = EXCLUDED.option, has_location = EXCLUDED.has_location,
         installed = COALESCE(EXCLUDED.installed, shop_carts.installed),
         push_ready = COALESCE(EXCLUDED.push_ready, shop_carts.push_ready),
         ua = EXCLUDED.ua,
         -- سلة اتفتحت من جديد بعد ما اتسجلت مستردة: تبقى سلة جديدة
         recovered_order = CASE WHEN EXCLUDED.stage <> 'ordered' AND shop_carts.recovered_order IS NOT NULL
                                THEN NULL ELSE shop_carts.recovered_order END,
         nudges = CASE WHEN EXCLUDED.stage <> 'ordered' AND shop_carts.recovered_order IS NOT NULL
                       THEN '[]'::jsonb ELSE shop_carts.nudges END,
         updated_at = NOW()`,
      [device, /^5\d{8}$/.test(phone || "") ? phone : null, stage,
       jb(items.map((it) => ({ id: it.id, n: String(it.name || "").slice(0, 60), q: Number(it.qty) || 1, p: Number(it.price) || 0 }))),
       items.reduce((s, it) => s + (Number(it.qty) || 1), 0),
       Number(b.subtotal) || 0, b.option ? String(b.option).slice(0, 12) : null,
       Boolean(b.hasLocation), typeof b.installed === "boolean" ? b.installed : null,
       typeof b.pushReady === "boolean" ? b.pushReady : null,
       String(c.req.header("user-agent") || "").slice(0, 200), rank(stage)]
    );
    return c.json({ ok: true });
  });

  /* سلة تُقفل عند الطلب — shop.js بينده دي لحظة الدفع الناجح */
  async function markOrdered({ phoneNorm, deviceId, orderNo }) {
    await pool.query(
      `UPDATE shop_carts SET stage='ordered', max_stage='ordered',
              recovered_order=$3, recovered_at=NOW(), updated_at=NOW()
        WHERE (device_id = $2 OR (phone_norm IS NOT NULL AND phone_norm = $1))
          AND recovered_order IS NULL`,
      [phoneNorm || null, deviceId || "", String(orderNo)]
    ).catch((e) => console.error("[carts] markOrdered failed:", e.message));
  }

  /* ── الحارس: سلّم الاسترداد ────────────────────────────────────────── */
  const MSG = {
    push1: (n) => ({ title: "سلتك لسه مستنياك 🛒", body: `${n} صنف في سلتك — كمّل طلبك في دقيقة وهيوصلك سخن 🔥` }),
    sms1: (n, code) => code
      ? `فريش كتس: سلتك فيها ${n} صنف 🛒 كمّل طلبك دلوقتي واستخدم كود ${code} وخصمك جاهز: freshcuts.sa`
      : `فريش كتس: سلتك فيها ${n} صنف 🛒 كمّل طلبك ويوصلك سخن: freshcuts.sa`,
  };

  async function runRecovery() {
    const s = await getSettingsData();
    const cfg = s.abandonedCarts || {};
    if (cfg.enabled === false) return;
    const h = riyadhHour();
    if (h >= QUIET_FROM && h < QUIET_TO) return; // ساعات الصمت
    const pushAfter = Number(cfg.pushAfterMinutes) || 45;
    const smsAfter = Number(cfg.smsAfterMinutes) || 240;
    const minSubtotal = Number(cfg.minSubtotal) || 0;

    // المرحلة ١: إشعار متصفح
    const p1 = (await pool.query(
      `SELECT * FROM shop_carts
        WHERE recovered_order IS NULL AND item_count > 0 AND subtotal >= $2
          AND updated_at < NOW() - ($1 || ' minutes')::interval
          AND updated_at > NOW() - INTERVAL '3 days'
          AND NOT (nudges @> '["push1"]'::jsonb)
        LIMIT 50`, [String(pushAfter), minSubtotal])).rows;
    for (const row of p1) {
      let sent = false;
      if (notify && cfg.pushEnabled !== false) {
        sent = await notify.sendToAudience({
          phoneNorm: row.phone_norm, deviceId: row.device_id,
          ...MSG.push1(row.item_count), url: env("STOREFRONT_PUBLIC_URL", "https://freshcuts.sa"),
        }).catch(() => false);
      }
      await pool.query(
        "UPDATE shop_carts SET nudges = nudges || $2::jsonb WHERE device_id=$1",
        [row.device_id, jb(["push1", ...(sent ? [] : ["push1_nosub"])])]);
    }

    // المرحلة ٢: SMS/واتساب — للي عندنا رقمه بس
    const p2 = (await pool.query(
      `SELECT * FROM shop_carts
        WHERE recovered_order IS NULL AND item_count > 0 AND phone_norm IS NOT NULL
          AND subtotal >= $2
          AND updated_at < NOW() - ($1 || ' minutes')::interval
          AND updated_at > NOW() - INTERVAL '3 days'
          AND NOT (nudges @> '["sms1"]'::jsonb)
        LIMIT 25`, [String(smsAfter), minSubtotal])).rows;
    for (const row of p2) {
      const code = cfg.couponCode || null;
      let sent = false;
      if (notify && cfg.smsEnabled === true) {
        sent = await notify.sendSmsTo(row.phone_norm, MSG.sms1(row.item_count, code)).catch(() => false);
      }
      await pool.query(
        "UPDATE shop_carts SET nudges = nudges || $2::jsonb WHERE device_id=$1",
        [row.device_id, jb([sent ? "sms1" : "sms1_skipped"])]);
    }
  }
  const RECOVERY_MIN = Number(env("CART_RECOVERY_MINUTES", "5"));
  if (RECOVERY_MIN > 0) {
    setInterval(() => runRecovery().catch((e) => console.error("[carts] recovery failed:", e.message)),
      RECOVERY_MIN * 60_000);
  }

  /* ── ADMIN: الأرقام اللي بتتقال في اللوحة ─────────────────────────── */
  app.get("/api/carts/stats", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 7));
    const r = (await pool.query(
      `WITH w AS (SELECT * FROM shop_carts WHERE updated_at > NOW() - ($1 || ' days')::interval)
       SELECT
         count(*)::int AS carts,
         count(*) FILTER (WHERE recovered_order IS NOT NULL)::int AS ordered,
         count(*) FILTER (WHERE recovered_order IS NULL AND item_count > 0)::int AS open_carts,
         count(*) FILTER (WHERE recovered_order IS NULL AND phone_norm IS NOT NULL)::int AS reachable,
         COALESCE(sum(subtotal) FILTER (WHERE recovered_order IS NULL AND item_count > 0),0)::numeric AS open_value,
         count(*) FILTER (WHERE max_stage='cart')::int AS s_cart,
         count(*) FILTER (WHERE max_stage='checkout')::int AS s_checkout,
         count(*) FILTER (WHERE max_stage='address')::int AS s_address,
         count(*) FILTER (WHERE max_stage='payment')::int AS s_payment,
         count(*) FILTER (WHERE max_stage='ordered')::int AS s_ordered,
         count(*) FILTER (WHERE installed IS TRUE)::int AS installed,
         count(*) FILTER (WHERE push_ready IS TRUE)::int AS push_ready,
         count(*) FILTER (WHERE nudges @> '["push1"]'::jsonb)::int AS nudged_push,
         count(*) FILTER (WHERE nudges @> '["sms1"]'::jsonb)::int AS nudged_sms,
         count(*) FILTER (WHERE nudges <> '[]'::jsonb AND recovered_order IS NOT NULL)::int AS recovered_after_nudge
       FROM w`, [String(days)])).rows[0];
    const n = (v) => Number(v) || 0;
    const carts = n(r.carts), ordered = n(r.ordered);
    return c.json({
      ok: true, days,
      carts, ordered,
      conversionRate: carts ? ordered / carts : null,
      abandonRate: carts ? (carts - ordered) / carts : null,
      openCarts: n(r.open_carts), openValue: n(r.open_value), reachable: n(r.reachable),
      funnel: { cart: n(r.s_cart), checkout: n(r.s_checkout), address: n(r.s_address), payment: n(r.s_payment), ordered: n(r.s_ordered) },
      installed: n(r.installed), pushReady: n(r.push_ready),
      nudgedPush: n(r.nudged_push), nudgedSms: n(r.nudged_sms), recoveredAfterNudge: n(r.recovered_after_nudge),
    });
  });

  app.get("/api/carts/list", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      `SELECT device_id, phone_norm, stage, max_stage, item_count, subtotal, option, has_location,
              installed, push_ready, nudges, recovered_order, created_at, updated_at, items
         FROM shop_carts
        WHERE recovered_order IS NULL AND item_count > 0
        ORDER BY subtotal DESC, updated_at DESC LIMIT 100`)).rows;
    return c.json({ ok: true, carts: rows });
  });

  return { markOrdered, runRecovery };
}
