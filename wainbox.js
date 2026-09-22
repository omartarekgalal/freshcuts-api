/* ═══════════════════════════════════════════════════════════════════════════
   WA INBOX — صندوق محادثات واتساب اللي الكاشير بيرد منه (بورتال المطعم).

   ليه الموديول ده أصلاً: الرقم الواحد يا يكون على تطبيق واتساب بزنس يا على
   Cloud API — مش الاتنين. وعمر قرّر رقم واحد لكل حاجة (الآلي + رد الكاشير)،
   يعني الرقم هيروح على الـAPI، وبالتالي **لازم صندوق الوارد يكون عندنا**.

   whatsapp.js = الإرسال الآلي + الويب هوك + القوالب (موجود من قبل).
   الموديول ده = طبقة المحادثات فوقه:
     - wa_threads: صف لكل جوال (آخر رسالة، غير مقروء، آخر وارد = النافذة).
     - نافذة الـ٢٤ ساعة: قاعدة ميتا — جوّه ٢٤ ساعة من آخر رسالة **من العميل**
       تقدر تبعت نص حر وببلاش. بره النافذة القالب المعتمد بس (وبفلوس).
       windowState() هي المصدر الوحيد للحقيقة، والواجهة بتعرضها للكاشير قبل
       ما يكتب — مش بعد ما الإرسال يترفض.
     - الرد: replyText (جوّه النافذة) / replyTemplate (بره) — الاتنين بيعدّوا
       على نفس بوابة whatsapp.js، فلو الموديول مقفول مفيش أي طلب شبكة.
     - القوالب الحيّة من ميتا (الاسم + حالة الاعتماد) — عرض بس، مابنعملش قوالب.

   كله واقف خلف WHATSAPP_ENABLED=1. من غيره القراءة بترجّع صندوق فاضي
   و«disabled»، والإرسال بيترفض قبل أي شبكة.
═══════════════════════════════════════════════════════════════════════════ */

import { GRAPH_VERSION, toWaId } from "./whatsapp.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();

/* نافذة خدمة العملاء عند ميتا. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/* حالة النافذة لمحادثة. lastInAt = آخر رسالة جاية **من العميل**.
   دالة صافية عشان الاختبارات والواجهة يحسبوا نفس الحاجة. */
export function windowState(lastInAt, now = Date.now()) {
  const t = lastInAt ? Date.parse(lastInAt) : NaN;
  if (!Number.isFinite(t)) {
    return { open: false, reason: "never", msLeft: 0, expiresAt: null };
  }
  const expiresAt = new Date(t + WINDOW_MS).toISOString();
  const msLeft = t + WINDOW_MS - now;
  if (msLeft > 0) return { open: true, reason: null, msLeft, expiresAt };
  return { open: false, reason: "expired", msLeft: 0, expiresAt };
}

/* نص مختصر للعرض في قايمة المحادثات. */
export function preview(text, max = 90) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* الجوال المقبول في الصندوق = سعودي متطبّع (5XXXXXXXX). */
export function validPhone(phoneNorm) {
  return /^5\d{8}$/.test(String(phoneNorm || ""));
}

export function register(ctx, deps = {}) {
  const { pool, getSettingsData } = ctx;
  const doFetch = deps.fetch || globalThis.fetch;
  const wa = deps.wa; // الـAPI الراجع من whatsapp.js register()

  const token = () => env("WHATSAPP_TOKEN") || env("META_CAPI_TOKEN");
  const wabaId = () => env("WHATSAPP_WABA_ID");
  const masterOn = () => env("WHATSAPP_ENABLED") === "1";

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_threads (
        phone_norm  TEXT PRIMARY KEY,
        last_in_at  TIMESTAMPTZ,              -- آخر رسالة من العميل = بداية النافذة
        last_out_at TIMESTAMPTZ,
        last_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_text   TEXT,
        last_dir    TEXT,                     -- in | out
        unread      INT NOT NULL DEFAULT 0,
        read_at     TIMESTAMPTZ,
        read_by     TEXT,
        order_no    TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS wa_threads_last_idx ON wa_threads(last_at DESC);
    `);
  }
  const ready = ensureSchema()
    .then(() => console.log("[wa-inbox] ready"))
    .catch((e) => console.error("[wa-inbox] init failed:", e.message));

  /* ── تحديث المحادثة من رسالة ─────────────────────────────────────────────
     بنناديها من whatsapp.js على كل وارد/صادر. مابترميش أبداً — فشل هنا
     مايوقّفش رسالة طلب. */
  async function touch({ phoneNorm, direction, text, at = null, orderNo = null }) {
    if (!validPhone(phoneNorm)) return;
    const inbound = direction === "in";
    try {
      await ready;
      await pool.query(
        `INSERT INTO wa_threads(phone_norm, last_in_at, last_out_at, last_at, last_text, last_dir, unread, order_no)
         VALUES ($1, CASE WHEN $2 THEN COALESCE($3::timestamptz, NOW()) END,
                     CASE WHEN NOT $2 THEN COALESCE($3::timestamptz, NOW()) END,
                     COALESCE($3::timestamptz, NOW()), $4, $5, CASE WHEN $2 THEN 1 ELSE 0 END, $6)
         ON CONFLICT (phone_norm) DO UPDATE SET
           last_in_at  = CASE WHEN $2 THEN GREATEST(COALESCE($3::timestamptz, NOW()), COALESCE(wa_threads.last_in_at, 'epoch'::timestamptz)) ELSE wa_threads.last_in_at END,
           last_out_at = CASE WHEN NOT $2 THEN GREATEST(COALESCE($3::timestamptz, NOW()), COALESCE(wa_threads.last_out_at, 'epoch'::timestamptz)) ELSE wa_threads.last_out_at END,
           last_at     = GREATEST(COALESCE($3::timestamptz, NOW()), wa_threads.last_at),
           last_text   = $4,
           last_dir    = $5,
           unread      = CASE WHEN $2 THEN wa_threads.unread + 1 ELSE 0 END,
           order_no    = COALESCE($6, wa_threads.order_no),
           updated_at  = NOW()`,
        [phoneNorm, inbound, at, preview(text, 200), direction, orderNo]);
    } catch (e) { console.error("[wa-inbox] touch failed:", e.message); }
  }

  /* ── القراءة ─────────────────────────────────────────────────────────────
     الصندوق مقفول = قايمة فاضية + السبب، مش خطأ (الواجهة بتخبّي التاب). */
  async function status() {
    let settingsOn = false;
    try { settingsOn = (await getSettingsData())?.notifications?.whatsappEnabled === true; } catch { /* off */ }
    const gate = wa ? await wa.gate() : "disabled";
    return {
      enabled: masterOn(),
      configured: wa ? wa.configured() : false,
      settingsOn,
      canSend: !gate,
      blocked: gate,                          // disabled | unconfigured | settings_off | null
      phoneId: env("WHATSAPP_PHONE_ID") || null,
      wabaId: wabaId() || null,
      webhookSecret: Boolean(env("WHATSAPP_APP_SECRET")),
      verifyToken: Boolean(env("WHATSAPP_VERIFY_TOKEN")),
      windowHours: WINDOW_MS / 3600000,
    };
  }

  async function listThreads({ limit = 60, q = "" } = {}) {
    if (!masterOn()) return { ok: true, disabled: true, threads: [], unread: 0 };
    await ready;
    const lim = Math.min(Math.max(Number(limit) || 60, 1), 200);
    const term = String(q || "").replace(/\D/g, "");
    const rows = (await pool.query(
      `SELECT t.phone_norm, t.last_in_at, t.last_at, t.last_text, t.last_dir, t.unread, t.order_no,
              c.name AS name, c.orders AS orders
         FROM wa_threads t
         LEFT JOIN cms_contacts c ON c.phone_norm = t.phone_norm
        WHERE ($1 = '' OR t.phone_norm LIKE '%' || $1 || '%')
        ORDER BY t.last_at DESC
        LIMIT $2`, [term, lim])).rows;
    const now = Date.now();
    const unread = (await pool.query("SELECT COALESCE(sum(unread),0)::int AS n FROM wa_threads")).rows[0]?.n || 0;
    return {
      ok: true,
      unread,
      threads: rows.map((r) => ({
        phone: r.phone_norm,
        name: r.name || null,
        orders: Number(r.orders) || 0,
        orderNo: r.order_no || null,
        lastText: r.last_text || "",
        lastDir: r.last_dir || null,
        lastAt: r.last_at,
        unread: Number(r.unread) || 0,
        window: windowState(r.last_in_at, now),
      })),
    };
  }

  async function getThread(phoneNorm, { limit = 80 } = {}) {
    if (!masterOn()) return { ok: false, error: "disabled" };
    if (!validPhone(phoneNorm)) return { ok: false, error: "bad_phone" };
    await ready;
    const lim = Math.min(Math.max(Number(limit) || 80, 1), 300);
    const head = (await pool.query(
      `SELECT t.phone_norm, t.last_in_at, t.unread, t.order_no, c.name AS name, c.orders AS orders,
              o.updates AS optin_updates, o.marketing AS optin_marketing
         FROM wa_threads t
         LEFT JOIN cms_contacts c ON c.phone_norm = t.phone_norm
         LEFT JOIN wa_optins  o ON o.phone_norm = t.phone_norm
        WHERE t.phone_norm = $1`, [phoneNorm])).rows[0];
    const msgs = (await pool.query(
      `SELECT wamid, direction, status, error, body, template, category, order_no, created_at
         FROM wa_messages WHERE phone_norm = $1
        ORDER BY created_at DESC LIMIT $2`, [phoneNorm, lim])).rows;
    return {
      ok: true,
      phone: phoneNorm,
      name: head?.name || null,
      orders: Number(head?.orders) || 0,
      orderNo: head?.order_no || null,
      optIn: { updates: head?.optin_updates === true, marketing: head?.optin_marketing === true },
      window: windowState(head?.last_in_at, Date.now()),
      messages: msgs.reverse().map((m) => ({
        id: m.wamid || `${m.direction}:${m.created_at}`,
        dir: m.direction,
        text: m.body || (m.template ? `[قالب: ${m.template}]` : ""),
        template: m.template || null,
        category: m.category || null,
        status: m.status || null,
        error: m.error || null,
        orderNo: m.order_no || null,
        at: m.created_at,
      })),
    };
  }

  async function markRead(phoneNorm, by = null) {
    if (!masterOn()) return { ok: false, error: "disabled" };
    if (!validPhone(phoneNorm)) return { ok: false, error: "bad_phone" };
    await ready;
    await pool.query(
      "UPDATE wa_threads SET unread=0, read_at=NOW(), read_by=$2, updated_at=NOW() WHERE phone_norm=$1",
      [phoneNorm, by ? String(by).slice(0, 60) : null]);
    return { ok: true };
  }

  /* ── الرد ────────────────────────────────────────────────────────────────
     النص الحر بيتقفل بره النافذة قبل أي طلب شبكة — القاعدة دي بتاعة ميتا
     ومش بنراهن عليها. */
  async function replyText({ phoneNorm, text, by = null }) {
    if (!masterOn()) return { ok: false, error: "disabled" };
    if (!validPhone(phoneNorm)) return { ok: false, error: "bad_phone" };
    const body = String(text ?? "").trim();
    if (!body) return { ok: false, error: "empty" };
    if (body.length > 4096) return { ok: false, error: "too_long" };
    if (!toWaId(phoneNorm)) return { ok: false, error: "bad_phone" };
    await ready;
    const row = (await pool.query("SELECT last_in_at FROM wa_threads WHERE phone_norm=$1", [phoneNorm])).rows[0];
    const win = windowState(row?.last_in_at, Date.now());
    if (!win.open) return { ok: false, error: "window_closed", window: win };
    const r = await wa.sendText({ phoneNorm, text: body });
    if (r.ok) await touch({ phoneNorm, direction: "out", text: body });
    return { ...r, window: win, by };
  }

  async function replyTemplate({ phoneNorm, template, params = {}, by = null }) {
    if (!masterOn()) return { ok: false, error: "disabled" };
    if (!validPhone(phoneNorm)) return { ok: false, error: "bad_phone" };
    if (!template) return { ok: false, error: "no_template" };
    const r = await wa.sendTemplate({ phoneNorm, template, params, requireOptIn: false });
    if (r.ok) await touch({ phoneNorm, direction: "out", text: `[قالب: ${template}]` });
    return { ...r, by };
  }

  /* ── القوالب الحيّة من ميتا ──────────────────────────────────────────────
     عرض بس: الاسم + حالة الاعتماد + اللغة + الفئة. مابنعملش قوالب من هنا. */
  async function liveTemplates() {
    if (!masterOn()) return { ok: false, error: "disabled", templates: [] };
    if (!token() || !wabaId()) return { ok: false, error: "unconfigured", templates: [] };
    try {
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId()}/message_templates`
        + "?fields=name,status,category,language,quality_score,rejected_reason&limit=100";
      const resp = await doFetch(url, { headers: { Authorization: `Bearer ${token()}` } });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.error) return { ok: false, error: data.error?.message || `HTTP ${resp.status}`, templates: [] };
      return {
        ok: true,
        templates: (data.data || []).map((t) => ({
          name: t.name, status: t.status, category: t.category, language: t.language,
          quality: t.quality_score?.score || null, rejected: t.rejected_reason || null,
        })),
      };
    } catch (e) {
      return { ok: false, error: String(e.message || "fetch_failed"), templates: [] };
    }
  }

  return { ready, touch, status, listThreads, getThread, markRead, replyText, replyTemplate, liveTemplates, masterOn };
}
