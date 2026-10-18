/* ═══════════════════════════════════════════════════════════════════════════
   CC1a — مركز التواصل: إنستجرام (رسايل + كومنتات + منشن) وفيسبوك (ماسنجر + كومنتات) في نفس الصندوق.

   طلب عمر (١٨/١٠): «عايزه يكون contact center كامل، اربط فيه كل المنصات مش بس الواتساب» + «البورتال والبوت زي واتساب».
   الخطة: docs/designs-2026-10/contact-center/plan.md (عند اللوحة).

   ليه موديول لوحده ومش جوه whatsapp.js: كل جداول واتساب متربطة بالجوال السعودي (phone_norm) — حساب إنستجرام/ماسنجر مالوش
   جوال. فهنا هوية القناة (channel + ext_id) وبتترَبط بجوال **لما نعرفه** (الموظف بيربط، أو العميل كتب جواله) ⇒ نفس كارت العميل.

   الجداول (بتتعمل في الإقلاع):
     cc_identities  (channel, ext_id) ⇒ الاسم/اليوزر/الجوال لو اتربط
     cc_threads     محادثة: kind=dm (واحدة لكل شخص في القناة) أو kind=comment (واحدة لكل كومنت رئيسي على بوست)
     cc_messages    الرسايل والكومنتات والردود (ext_id فريد ⇒ تكرار الويب هوك مايدخلش مرتين، وردّنا اللي راجع صدى برضه)

   الاستقبال دايماً بيتسجّل (الويب هوك متوقّع + متوقّع بتوقيع التطبيق). **الإرسال** مقفول لحد:
     settings.cc.enabled (المفتاح الرئيسي) + settings.cc.channels.<ig_dm|fb_dm|ig_comment|fb_comment>.enabled
   والاتنين بيتعدّلوا من اللوحة (المالك) — مفيش env جديد: نفس WHATSAPP_VERIFY_TOKEN / WHATSAPP_APP_SECRET (نفس التطبيق) و META_CAPI_TOKEN.

   قواعد ميتا (مقروءة ١٨/١٠ من developers.facebook.com):
     - رسايل: رد حر جوه ٢٤ ساعة من آخر رسالة من العميل. بعدها لحد ٧ أيام بوسم HUMAN_AGENT — **موظف بس**، مش بوت ولا عروض.
     - كومنت: رد علني في أي وقت. «رد خاص» = رسالة واحدة في الخاص خلال ٧ أيام من الكومنت.
     - إنستجرام: نص الرسالة ≤ ١٠٠٠ بايت.
═══════════════════════════════════════════════════════════════════════════ */

import { verifySignature, GRAPH_VERSION } from "./whatsapp.js";
import { hubRoles } from "./wahub.js";
import { normPhone, maskPhone } from "./identity.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();
const iso = (v) => (v ? new Date(v).toISOString() : null);
const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export const DAY_MS = 24 * 3600_000;
export const HUMAN_AGENT_MS = 7 * DAY_MS;
export const PRIVATE_REPLY_MS = 7 * DAY_MS;
export const IG_TEXT_MAX_BYTES = 1000;
export const CHANNELS = Object.freeze(["ig_dm", "fb_dm", "ig_comment", "fb_comment"]);
export const CHANNEL_AR = Object.freeze({ ig_dm: "رسايل إنستجرام", fb_dm: "ماسنجر", ig_comment: "كومنتات إنستجرام", fb_comment: "كومنتات فيسبوك" });
/* الحقول اللي بنشترك فيها على الصفحة (subscribed_apps). إنستجرام بيوصل من حقول التطبيق نفسه بشرط إن التطبيق مشترك في الصفحة. */
export const PAGE_FIELDS = Object.freeze(["messages", "messaging_postbacks", "message_echoes", "message_reads", "messaging_referrals", "feed"]);

export const chanOf = (platform, kind) => `${platform}_${kind}`;      // ("ig","dm") ⇒ "ig_dm"
export const keyOf = (id) => `cc-${id}`;
export function idOfKey(k) { const m = /^cc-(\d{1,12})$/.exec(String(k || "").trim()); return m ? Number(m[1]) : null; }

export function ccConfig(settings) {
  const x = (settings && settings.cc) || {};
  const ch = {};
  for (const c of CHANNELS) ch[c] = { enabled: x.channels?.[c]?.enabled === true };
  return { enabled: x.enabled === true, channels: ch };
}

/* حالة الإرسال لمحادثة — المصدر الوحيد (الواجهة بتعرضها قبل ما الموظف يكتب).
   dm: open (٢٤ ساعة) › human (لحد ٧ أيام، موظف بس) › closed.  comment: علني دايماً + privateOpen (٧ أيام من الكومنت ولسه مابعتناش خاص). */
export function sendWindow(t, now = Date.now()) {
  const last = t && t.last_in_at ? Date.parse(t.last_in_at) : NaN;
  if (t && t.kind === "comment") {
    const first = t.created_at ? Date.parse(t.created_at) : NaN;
    const privateOpen = Number.isFinite(first) && now - first < PRIVATE_REPLY_MS && !t.private_sent_at;
    return { mode: "public", open: true, human: false, privateOpen, expiresAt: Number.isFinite(first) ? new Date(first + PRIVATE_REPLY_MS).toISOString() : null };
  }
  if (!Number.isFinite(last)) return { mode: "closed", open: false, human: false, privateOpen: false, expiresAt: null };
  if (now - last < DAY_MS) return { mode: "open", open: true, human: false, privateOpen: false, expiresAt: new Date(last + DAY_MS).toISOString() };
  if (now - last < HUMAN_AGENT_MS) return { mode: "human", open: false, human: true, privateOpen: false, expiresAt: new Date(last + HUMAN_AGENT_MS).toISOString() };
  return { mode: "closed", open: false, human: false, privateOpen: false, expiresAt: null };
}

/* جوال سعودي مكتوب في الرسالة (أرقام عربي أو لاتيني) ⇒ اقتراح ربط (الموظف بيأكّد). */
export function phoneInText(text) {
  const s = String(text || "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
  const m = /(?:\+?966|0)?\s*5(?:[\s-]?\d){8}/.exec(s);
  if (!m) return null;
  const d = m[0].replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
  return /^5\d{8}$/.test(d) ? d : null;
}

export function textBytes(s) { return Buffer.byteLength(String(s || ""), "utf8"); }

/* ── تحليل الويب هوك (صافية) ──
   ids = { pageId, igId }. بيرجّع قايمة أحداث موحّدة:
   { type:"dm", platform, extUser, mid, text, attachments, at, echo, storyReply, referral }
   { type:"dm_deleted", platform, mid } · { type:"read", platform, extUser, at }
   { type:"comment", platform, commentId, parentId, postId, text, fromId, fromName, at, own, verb } */
export function parseMetaWebhook(body, ids = {}) {
  const out = [];
  if (!body || typeof body !== "object") return out;
  const obj = body.object;
  const platform = obj === "instagram" ? "ig" : obj === "page" ? "fb" : null;
  if (!platform) return out;
  const ownIds = new Set([ids.pageId, ids.igId].filter(Boolean).map(String));
  for (const e of Array.isArray(body.entry) ? body.entry : []) {
    for (const m of Array.isArray(e.messaging) ? e.messaging : []) {
      const sender = String(m.sender?.id || ""), recipient = String(m.recipient?.id || "");
      const at = m.timestamp ? new Date(Number(m.timestamp)).toISOString() : new Date().toISOString();
      if (m.read) { out.push({ type: "read", platform, extUser: sender, at }); continue; }
      if (m.message) {
        const echo = m.message.is_echo === true || ownIds.has(sender);
        if (m.message.is_deleted) { out.push({ type: "dm_deleted", platform, mid: String(m.message.mid || "") }); continue; }
        const att = (Array.isArray(m.message.attachments) ? m.message.attachments : []).map((a) => ({ type: String(a.type || "file"), url: a.payload?.url || null }));
        out.push({ type: "dm", platform, extUser: echo ? recipient : sender, mid: String(m.message.mid || ""), text: String(m.message.text || ""), attachments: att, at, echo,
          storyReply: Boolean(m.message.reply_to?.story), referral: m.message.referral || m.referral || null });
        continue;
      }
      if (m.postback) {
        out.push({ type: "dm", platform, extUser: sender, mid: String(m.postback.mid || `pb-${sender}-${m.timestamp || ""}`), text: String(m.postback.title || m.postback.payload || ""), attachments: [], at, echo: false, storyReply: false, referral: m.postback.referral || null });
      }
    }
    for (const ch of Array.isArray(e.changes) ? e.changes : []) {
      const v = ch.value || {};
      if (platform === "ig" && ch.field === "comments") {
        const fromId = String(v.from?.id || "");
        out.push({ type: "comment", platform, commentId: String(v.id || ""), parentId: v.parent_id ? String(v.parent_id) : null, postId: String(v.media?.id || ""),
          text: String(v.text || ""), fromId, fromName: v.from?.username || null, at: new Date().toISOString(), own: ownIds.has(fromId), verb: "add" });
      } else if (platform === "ig" && ch.field === "mentions") {
        out.push({ type: "mention", platform, commentId: v.comment_id ? String(v.comment_id) : null, postId: String(v.media_id || ""), at: new Date().toISOString() });
      } else if (platform === "fb" && ch.field === "feed" && v.item === "comment") {
        const fromId = String(v.from?.id || "");
        out.push({ type: "comment", platform, commentId: String(v.comment_id || ""), parentId: v.parent_id && v.parent_id !== v.post_id ? String(v.parent_id) : null,
          postId: String(v.post_id || ""), text: String(v.message || ""), fromId, fromName: v.from?.name || null,
          at: v.created_time ? new Date(Number(v.created_time) * 1000).toISOString() : new Date().toISOString(), own: ownIds.has(fromId), verb: String(v.verb || "add") });
      }
    }
  }
  return out;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const log = ctx.log || console;
  const doFetch = deps.fetch || globalThis.fetch;
  const GRAPH = () => `https://graph.facebook.com/${env("META_API_VERSION") || GRAPH_VERSION}`;
  const PAGE_ID = () => env("FB_PAGE_ID") || env("META_PAGE_ID") || "1193489887177708";
  const IG_ID = () => env("IG_USER_ID") || env("META_IG_ID") || "17841414510113806";
  /* توكن مستخدم النظام: META_INBOX_TOKEN (توكن جديد فيه pages_messaging) لو موجود، وإلا نفس توكن النشر/الإعلانات */
  const USER_TOKEN = () => env("META_INBOX_TOKEN") || env("META_CAPI_TOKEN");
  const broadcast = (ev, d) => { try { deps.broadcast?.(ev, d); } catch { /* البث اختياري */ } };

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_identities (
        id SERIAL PRIMARY KEY, platform TEXT NOT NULL, ext_id TEXT NOT NULL, username TEXT, name TEXT,
        phone_norm TEXT, linked_by TEXT, linked_at TIMESTAMPTZ, profile_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (platform, ext_id));
      CREATE INDEX IF NOT EXISTS cc_identities_phone ON cc_identities(phone_norm) WHERE phone_norm IS NOT NULL;
      CREATE TABLE IF NOT EXISTS cc_threads (
        id BIGSERIAL PRIMARY KEY, platform TEXT NOT NULL, kind TEXT NOT NULL, ext_thread TEXT NOT NULL, identity_id INT REFERENCES cc_identities(id),
        post_id TEXT, post_permalink TEXT, post_caption TEXT,
        last_in_at TIMESTAMPTZ, last_out_at TIMESTAMPTZ, last_at TIMESTAMPTZ, last_text TEXT, last_dir TEXT,
        unread INT NOT NULL DEFAULT 0, read_at TIMESTAMPTZ, read_by TEXT, status TEXT NOT NULL DEFAULT 'open',
        done_at TIMESTAMPTZ, done_by TEXT, private_sent_at TIMESTAMPTZ, hidden BOOLEAN NOT NULL DEFAULT FALSE,
        suggested_phone TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (platform, kind, ext_thread));
      CREATE INDEX IF NOT EXISTS cc_threads_last ON cc_threads(last_at DESC);
      CREATE TABLE IF NOT EXISTS cc_messages (
        id BIGSERIAL PRIMARY KEY, thread_id BIGINT NOT NULL REFERENCES cc_threads(id), ext_id TEXT UNIQUE,
        direction TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', body TEXT, media JSONB, sender TEXT NOT NULL DEFAULT 'customer',
        staff_name TEXT, status TEXT NOT NULL DEFAULT 'received', error TEXT, deleted BOOLEAN NOT NULL DEFAULT FALSE,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS cc_messages_thread ON cc_messages(thread_id, id);
      CREATE TABLE IF NOT EXISTS cc_webhook_health (field TEXT PRIMARY KEY, last_at TIMESTAMPTZ, n BIGINT NOT NULL DEFAULT 0);
    `);
  }
  const ready = ensureSchema().then(() => log.log?.("[cc] schema ready")).catch((e) => log.error("[cc] schema failed:", e.message));
  const health = (f) => pool.query(`INSERT INTO cc_webhook_health(field, last_at, n) VALUES ($1, NOW(), 1)
      ON CONFLICT (field) DO UPDATE SET last_at = NOW(), n = cc_webhook_health.n + 1`, [f]).catch(() => {});

  /* ── Graph ── */
  async function graph(method, path, { token, body, query } = {}) {
    const qs = new URLSearchParams({ ...(query || {}), access_token: token || "" });
    const url = `${GRAPH()}/${path}${path.includes("?") ? "&" : "?"}${qs}`;
    try {
      const r = await doFetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      let json = null; try { json = await r.json(); } catch { json = null; }
      return { ok: r.ok && !json?.error, status: r.status, json };
    } catch (e) { return { ok: false, status: 0, json: null, error: e.message }; }
  }
  const gErr = (r) => r.json?.error?.message || r.error || `HTTP ${r.status}`;
  let pageTok = { token: "", at: 0 };
  async function pageToken() {
    if (pageTok.token && Date.now() - pageTok.at < 3600_000) return pageTok.token;
    const r = await graph("GET", `${PAGE_ID()}`, { token: USER_TOKEN(), query: { fields: "access_token" } });
    pageTok = { token: r.json?.access_token || "", at: Date.now() };
    return pageTok.token;
  }

  /* ── تخزين ── */
  async function identity(platform, extId, { username = null, name = null } = {}) {
    const r = await pool.query(`INSERT INTO cc_identities(platform, ext_id, username, name) VALUES ($1,$2,$3,$4)
      ON CONFLICT (platform, ext_id) DO UPDATE SET username = COALESCE(EXCLUDED.username, cc_identities.username), name = COALESCE(EXCLUDED.name, cc_identities.name)
      RETURNING *`, [platform, extId, username, name]);
    const row = r.rows[0];
    if (row && !row.profile_at && !row.username && !row.name) fillProfile(row).catch(() => {});
    return row;
  }
  /* الاسم/اليوزر مرة واحدة (أفضل محاولة) — من غير ما يأخّر الويب هوك */
  async function fillProfile(row) {
    await pool.query("UPDATE cc_identities SET profile_at = NOW() WHERE id = $1", [row.id]);
    const tok = await pageToken(); if (!tok) return;
    const fields = row.platform === "ig" ? "name,username" : "first_name,last_name,name";
    const r = await graph("GET", row.ext_id, { token: tok, query: { fields } });
    if (!r.ok) return;
    const name = r.json.name || [r.json.first_name, r.json.last_name].filter(Boolean).join(" ") || null;
    await pool.query("UPDATE cc_identities SET username = COALESCE($2, username), name = COALESCE($3, name) WHERE id = $1", [row.id, r.json.username || null, name]);
  }
  async function thread(platform, kind, extThread, fields = {}) {
    const r = await pool.query(`INSERT INTO cc_threads(platform, kind, ext_thread, identity_id, post_id, created_at) VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, NOW()))
      ON CONFLICT (platform, kind, ext_thread) DO UPDATE SET identity_id = COALESCE(cc_threads.identity_id, EXCLUDED.identity_id), post_id = COALESCE(cc_threads.post_id, EXCLUDED.post_id)
      RETURNING *`, [platform, kind, extThread, fields.identityId || null, fields.postId || null, fields.at || null]);
    return r.rows[0];
  }
  /* رسالة + تحديث رأس المحادثة. بيرجّع null لو ext_id متسجّل قبل كده (تكرار الويب هوك / صدى ردّنا). */
  async function addMessage(t, m) {
    const ins = await pool.query(`INSERT INTO cc_messages(thread_id, ext_id, direction, kind, body, media, sender, staff_name, status, error, at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, NOW())) ON CONFLICT (ext_id) DO NOTHING RETURNING id`,
      [t.id, m.extId || null, m.dir, m.kind || "text", m.body ?? null, m.media ? JSON.stringify(m.media) : null, m.sender || (m.dir === "in" ? "customer" : "staff"),
        m.staffName || null, m.status || (m.dir === "in" ? "received" : "sent"), m.error || null, m.at || null]);
    if (!ins.rows[0]) return null;
    const preview = clip(String(m.body || (m.media?.length ? `📎 ${m.media[0].type}` : "")).replace(/\s+/g, " "), 120);
    if (m.dir === "in") {
      const sp = phoneInText(m.body);
      await pool.query(`UPDATE cc_threads SET last_in_at = GREATEST(COALESCE(last_in_at, 'epoch'), COALESCE($2::timestamptz, NOW())), last_at = GREATEST(COALESCE(last_at, 'epoch'), COALESCE($2::timestamptz, NOW())), last_text = CASE WHEN COALESCE($2::timestamptz, NOW()) >= COALESCE(last_at, 'epoch') THEN $3 ELSE last_text END, last_dir = CASE WHEN COALESCE($2::timestamptz, NOW()) >= COALESCE(last_at, 'epoch') THEN 'in' ELSE last_dir END,
        unread = unread + 1, status = 'open', done_at = NULL, suggested_phone = COALESCE($4, suggested_phone) WHERE id = $1`, [t.id, m.at || null, preview, sp]);
    } else if (m.status !== "failed") {
      await pool.query("UPDATE cc_threads SET last_out_at = GREATEST(COALESCE(last_out_at, 'epoch'), COALESCE($3::timestamptz, NOW())), last_at = GREATEST(COALESCE(last_at, 'epoch'), COALESCE($3::timestamptz, NOW())), last_text = CASE WHEN COALESCE($3::timestamptz, NOW()) >= COALESCE(last_at, 'epoch') THEN $2 ELSE last_text END, last_dir = CASE WHEN COALESCE($3::timestamptz, NOW()) >= COALESCE(last_at, 'epoch') THEN 'out' ELSE last_dir END WHERE id = $1", [t.id, preview, m.at || null]);
    }
    broadcast("cc_chat_update", { key: keyOf(t.id), dir: m.dir, at: new Date().toISOString() });
    return ins.rows[0].id;
  }

  async function handleEvent(ev) {
    if (ev.type === "dm") {
      if (!ev.extUser) return;
      const idn = await identity(ev.platform, ev.extUser);
      const t = await thread(ev.platform, "dm", ev.extUser, { identityId: idn.id });
      const kind = ev.storyReply ? "story_reply" : ev.attachments.length && !ev.text ? "media" : "text";
      await addMessage(t, { extId: ev.mid || null, dir: ev.echo ? "out" : "in", kind, body: ev.text, media: ev.attachments.length ? ev.attachments : null,
        sender: ev.echo ? "page" : "customer", at: ev.at });
    } else if (ev.type === "dm_deleted") {
      if (ev.mid) await pool.query("UPDATE cc_messages SET deleted = TRUE WHERE ext_id = $1", [ev.mid]);
    } else if (ev.type === "read") {
      /* مقروء من العميل — مش محتاجينه في المرحلة دي غير للصحة */
    } else if (ev.type === "comment") {
      if (!ev.commentId) return;
      if (ev.verb === "remove") { await pool.query("UPDATE cc_messages SET deleted = TRUE WHERE ext_id = $1", [ev.commentId]); return; }
      const root = ev.parentId || ev.commentId;
      const idn = ev.own ? null : await identity(ev.platform, ev.fromId || `anon-${ev.commentId}`, ev.platform === "ig" ? { username: ev.fromName } : { name: ev.fromName });
      const t = await thread(ev.platform, "comment", root, { identityId: ev.parentId ? null : idn?.id, postId: ev.postId, at: ev.parentId ? null : ev.at });
      if (!t.post_permalink && ev.postId) fillPost(t).catch(() => {});
      await addMessage(t, { extId: ev.commentId, dir: ev.own ? "out" : "in", kind: ev.parentId ? "reply" : "comment", body: ev.text, sender: ev.own ? "page" : "customer", at: ev.at });
    } else if (ev.type === "mention") {
      /* منشن في كومنت على بوست حد تاني: نجيب الكومنت (أفضل محاولة) ونعامله ككومنت */
      if (!ev.commentId) return;
      const r = await graph("GET", IG_ID(), { token: USER_TOKEN(), query: { fields: `mentioned_comment.comment_id(${ev.commentId}){id,text,username,timestamp,media{id,permalink}}` } });
      const mc = r.json?.mentioned_comment; if (!mc) return;
      const idn = await identity("ig", `u:${mc.username || ev.commentId}`, { username: mc.username || null });
      const t = await thread("ig", "comment", String(mc.id), { identityId: idn.id, postId: mc.media?.id || ev.postId, at: mc.timestamp });
      if (mc.media?.permalink) await pool.query("UPDATE cc_threads SET post_permalink = $2 WHERE id = $1", [t.id, mc.media.permalink]);
      await addMessage(t, { extId: String(mc.id), dir: "in", kind: "mention", body: mc.text || "", sender: "customer", at: mc.timestamp });
    }
  }
  async function fillPost(t) {
    const tok = t.platform === "fb" ? await pageToken() : USER_TOKEN();
    const r = await graph("GET", t.post_id, { token: tok, query: { fields: t.platform === "ig" ? "permalink,caption" : "permalink_url,message" } });
    if (!r.ok) return;
    await pool.query("UPDATE cc_threads SET post_permalink = $2, post_caption = $3 WHERE id = $1",
      [t.id, r.json.permalink || r.json.permalink_url || null, clip(r.json.caption || r.json.message || "", 300) || null]);
  }

  async function processWebhook(body) {
    await ready;
    const evs = parseMetaWebhook(body, { pageId: PAGE_ID(), igId: IG_ID() });
    await health(`${body?.object || "?"}`);
    for (const ev of evs) {
      await health(`${ev.platform}:${ev.type}`);
      await handleEvent(ev).catch((e) => log.error("[cc] event:", ev.type, e.message));
    }
    return evs;
  }

  /* ── الويب هوك (نفس توكن التحقق وسر التطبيق بتوع واتساب: نفس تطبيق ميتا) ── */
  app.get("/api/meta/webhook", (c) => {
    const mode = c.req.query("hub.mode"), tok = c.req.query("hub.verify_token"), ch = c.req.query("hub.challenge");
    const expected = env("WHATSAPP_VERIFY_TOKEN");
    if (mode === "subscribe" && expected && tok === expected) return c.text(String(ch || ""), 200);
    return c.text("forbidden", 403);
  });
  app.post("/api/meta/webhook", async (c) => {
    let raw = "";
    try { raw = await c.req.text(); } catch { return c.json({ ok: true }); }
    if (!verifySignature(raw, c.req.header("x-hub-signature-256"), env("WHATSAPP_APP_SECRET") || env("META_APP_SECRET"))) {
      health("_bad_signature");
      return c.json({ ok: true, ignored: "signature" });
    }
    let body; try { body = JSON.parse(raw); } catch { return c.json({ ok: true, ignored: "json" }); }
    Promise.resolve().then(() => processWebhook(body)).catch((e) => log.error("[cc] webhook:", e.message));
    return c.json({ ok: true });
  });

  /* ── الإرسال (بوابة واحدة) ── */
  async function gate(t, channel) {
    const cfg = ccConfig(await getSettingsData().catch(() => ({})));
    if (!cfg.enabled) return { ok: false, error: "cc_off", message: "مركز التواصل مقفول من الإعدادات" };
    if (!cfg.channels[channel]?.enabled) return { ok: false, error: "channel_off", message: `${CHANNEL_AR[channel] || channel}: الإرسال مقفول من الإعدادات` };
    return { ok: true };
  }
  /* mode: "dm" (رسالة) | "public" (رد علني على الكومنت) | "private" (رد خاص على الكومنت) */
  async function send(t, { text, mode, staffName, sender = "staff" }) {
    const body = String(text || "").trim();
    if (!body) return { ok: false, error: "empty", message: "اكتب الرد" };
    const channel = chanOf(t.platform, t.kind === "dm" ? "dm" : "comment");
    const g = await gate(t, channel); if (!g.ok) return g;
    const w = sendWindow(t);
    const tok = await pageToken(); if (!tok) return { ok: false, error: "no_token", message: "توكن الصفحة مش متاح" };
    let r, kind;
    if (t.kind === "dm") {
      if (t.platform === "ig" && textBytes(body) > IG_TEXT_MAX_BYTES) return { ok: false, error: "too_long", message: "رسالة إنستجرام أطول من المسموح (١٠٠٠ بايت)" };
      if (!w.open && !w.human) return { ok: false, error: "window_closed", message: "عدّى أكتر من ٧ أيام على آخر رسالة من العميل — ميتا مابتسمحش بالرد" };
      if (!w.open && sender !== "staff") return { ok: false, error: "human_only", message: "بعد ٢٤ ساعة الرد من موظف بس" };
      const idn = (await pool.query("SELECT ext_id FROM cc_identities WHERE id = $1", [t.identity_id])).rows[0];
      if (!idn) return { ok: false, error: "no_recipient" };
      const payload = { recipient: { id: idn.ext_id }, message: { text: body } };
      if (w.open) payload.messaging_type = "RESPONSE"; else { payload.messaging_type = "MESSAGE_TAG"; payload.tag = "HUMAN_AGENT"; }
      r = await graph("POST", `${PAGE_ID()}/messages`, { token: tok, body: payload }); kind = "text";
    } else if (mode === "private") {
      if (!w.privateOpen) return { ok: false, error: "private_closed", message: t.private_sent_at ? "اتبعت رد خاص على الكومنت ده قبل كده (مسموح مرة واحدة)" : "عدّى ٧ أيام على الكومنت" };
      r = await graph("POST", `${PAGE_ID()}/messages`, { token: tok, body: { recipient: { comment_id: t.ext_thread }, message: { text: body } } }); kind = "private_reply";
    } else {
      const path = t.platform === "ig" ? `${t.ext_thread}/replies` : `${t.ext_thread}/comments`;
      r = await graph("POST", path, { token: t.platform === "ig" ? USER_TOKEN() : tok, body: { message: body } }); kind = "reply";
    }
    const extId = r.json?.message_id || r.json?.id || null;
    await addMessage(t, { extId: r.ok ? extId : null, dir: "out", kind, body, sender, staffName, status: r.ok ? "sent" : "failed", error: r.ok ? null : clip(gErr(r), 300) });
    if (r.ok && kind === "private_reply") await pool.query("UPDATE cc_threads SET private_sent_at = NOW() WHERE id = $1", [t.id]);
    if (r.ok) await pool.query("UPDATE cc_threads SET unread = 0, read_at = NOW(), read_by = COALESCE($2, read_by) WHERE id = $1", [t.id, staffName || null]);
    return r.ok ? { ok: true, id: extId, kind } : { ok: false, error: "graph", message: gErr(r) };
  }
  async function hide(t, hidden) {
    if (t.kind !== "comment") return { ok: false, error: "not_comment" };
    const tok = t.platform === "ig" ? USER_TOKEN() : await pageToken();
    const r = t.platform === "ig" ? await graph("POST", t.ext_thread, { token: tok, query: { hide: hidden ? "true" : "false" } })
      : await graph("POST", t.ext_thread, { token: tok, body: { is_hidden: hidden } });
    if (!r.ok) return { ok: false, error: "graph", message: gErr(r) };
    await pool.query("UPDATE cc_threads SET hidden = $2 WHERE id = $1", [t.id, hidden]);
    return { ok: true };
  }

  /* ── قراية للصندوق ── */
  const THREAD_SQL = `SELECT t.*, i.username, i.name, i.phone_norm, i.ext_id AS user_ext FROM cc_threads t LEFT JOIN cc_identities i ON i.id = t.identity_id`;
  function threadOut(r, { full }) {
    const channel = chanOf(r.platform, r.kind === "dm" ? "dm" : "comment");
    return {
      key: keyOf(r.id), channel, channelAr: CHANNEL_AR[channel], platform: r.platform, kind: r.kind,
      name: r.name || (r.username ? `@${r.username}` : null), username: r.username || null,
      phone: r.phone_norm ? (full ? `0${r.phone_norm}` : maskPhone(r.phone_norm)) : null, linked: Boolean(r.phone_norm),
      suggestedPhone: !r.phone_norm && r.suggested_phone ? (full ? `0${r.suggested_phone}` : maskPhone(r.suggested_phone)) : null,
      lastText: r.last_text || "", lastDir: r.last_dir || null, lastAt: iso(r.last_at || r.created_at), lastInAt: iso(r.last_in_at),
      unread: Number(r.unread || 0), status: r.status, doneAt: iso(r.done_at), doneBy: r.done_by || null, hidden: r.hidden === true,
      post: r.post_id ? { id: r.post_id, permalink: r.post_permalink || null, caption: r.post_caption || null } : null,
      window: sendWindow(r),
    };
  }
  async function listThreads({ channel = "", status = "open", q = "", limit = 50, before = null, full = false } = {}) {
    const where = [], args = [];
    if (CHANNELS.includes(channel)) { const [p, k] = channel.split("_"); args.push(p, k === "dm" ? "dm" : "comment"); where.push(`t.platform = $${args.length - 1} AND t.kind = $${args.length}`); }
    if (status === "open") where.push("t.status = 'open'"); else if (status === "unread") where.push("t.unread > 0"); else if (status === "done") where.push("t.status = 'done'");
    if (q) { args.push(`%${String(q).toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`); where.push(`(lower(COALESCE(i.username,'') || ' ' || COALESCE(i.name,'') || ' ' || COALESCE(t.last_text,'')) LIKE $${args.length})`); }
    if (before) { args.push(before); where.push(`COALESCE(t.last_at, t.created_at) < $${args.length}::timestamptz`); }
    args.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
    const r = await pool.query(`${THREAD_SQL} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(t.last_at, t.created_at) DESC LIMIT $${args.length}`, args);
    const counts = (await pool.query(`SELECT t.platform, t.kind, count(*) FILTER (WHERE t.status='open')::int AS open, count(*) FILTER (WHERE t.unread > 0)::int AS unread
      FROM cc_threads t GROUP BY 1,2`)).rows.reduce((o, x) => { o[chanOf(x.platform, x.kind === "dm" ? "dm" : "comment")] = { open: x.open, unread: x.unread }; return o; }, {});
    const threads = r.rows.map((x) => threadOut(x, { full }));
    return { ok: true, threads, counts, nextBefore: threads.length ? threads[threads.length - 1].lastAt : null };
  }
  async function getThread(id) { return (await pool.query(`${THREAD_SQL} WHERE t.id = $1`, [id])).rows[0] || null; }
  async function messagesOf(id, limit = 200) {
    const r = await pool.query(`SELECT id, ext_id, direction, kind, body, media, sender, staff_name, status, error, deleted, at FROM cc_messages WHERE thread_id = $1 ORDER BY at DESC, id DESC LIMIT $2`, [id, limit]);
    return r.rows.reverse().map((m) => ({ id: Number(m.id), dir: m.direction, kind: m.kind, body: m.deleted ? "" : (m.body || ""), deleted: m.deleted === true,
      media: m.media || null, sender: m.sender, staffName: m.staff_name || null, status: m.status, error: m.error || null, at: iso(m.at) }));
  }
  async function tick() {
    const r = await pool.query("SELECT count(*)::int AS n, max(last_at) AS m, sum(unread)::int AS u FROM cc_threads");
    const x = r.rows[0] || {};
    return `${x.n || 0}:${x.u || 0}:${x.m ? new Date(x.m).getTime() : 0}`;
  }
  async function link(id, phone, by) {
    const pn = normPhone(phone);
    if (!/^5\d{8}$/.test(String(pn || ""))) return { ok: false, error: "bad_phone", message: "رقم جوال سعودي غلط" };
    const t = await getThread(id); if (!t || !t.identity_id) return { ok: false, error: "no_identity" };
    await pool.query("UPDATE cc_identities SET phone_norm = $2, linked_by = $3, linked_at = NOW() WHERE id = $1", [t.identity_id, pn, by || null]);
    return { ok: true };
  }
  async function unlink(id) {
    const t = await getThread(id); if (!t || !t.identity_id) return { ok: false, error: "no_identity" };
    await pool.query("UPDATE cc_identities SET phone_norm = NULL, linked_by = NULL, linked_at = NULL WHERE id = $1", [t.identity_id]);
    await pool.query("UPDATE cc_threads SET suggested_phone = NULL WHERE identity_id = $1", [t.identity_id]);
    return { ok: true };
  }

  /* ── سحب أولي (مرة، بإيد المالك): آخر محادثات إنستجرام/ماسنجر + كومنتات آخر البوستات ── */
  async function backfill({ posts = 10, convs = 25 } = {}) {
    const tok = await pageToken(); const res = { igConversations: 0, fbConversations: 0, comments: 0, errors: [] };
    for (const platform of ["instagram", "messenger"]) {
      const r = await graph("GET", `${PAGE_ID()}/conversations`, { token: tok, query: { platform, limit: String(convs), fields: "participants,messages.limit(20){id,message,from,created_time}" } });
      if (!r.ok) { res.errors.push(`${platform}: ${clip(gErr(r), 160)}`); continue; }
      const p = platform === "instagram" ? "ig" : "fb";
      for (const cv of r.json.data || []) {
        const own = new Set([PAGE_ID(), IG_ID()]);
        const other = (cv.participants?.data || []).find((x) => !own.has(String(x.id)));
        if (!other) continue;
        for (const m of (cv.messages?.data || []).slice().reverse()) {
          const echo = own.has(String(m.from?.id || ""));
          await handleEvent({ type: "dm", platform: p, extUser: String(other.id), mid: m.id, text: m.message || "", attachments: [], at: m.created_time, echo, storyReply: false });
        }
        if (p === "ig") res.igConversations++; else res.fbConversations++;
      }
    }
    const ig = await graph("GET", `${IG_ID()}/media`, { token: USER_TOKEN(), query: { limit: String(posts), fields: "id,comments.limit(50){id,text,username,timestamp,from,replies{id,text,username,timestamp,from}}" } });
    if (ig.ok) for (const md of ig.json.data || []) for (const cm of md.comments?.data || []) {
      await handleEvent({ type: "comment", platform: "ig", commentId: cm.id, parentId: null, postId: md.id, text: cm.text || "", fromId: String(cm.from?.id || `u:${cm.username}`), fromName: cm.username || null, at: cm.timestamp, own: String(cm.from?.id || "") === IG_ID(), verb: "add" }); res.comments++;
      for (const rp of cm.replies?.data || []) await handleEvent({ type: "comment", platform: "ig", commentId: rp.id, parentId: cm.id, postId: md.id, text: rp.text || "", fromId: String(rp.from?.id || `u:${rp.username}`), fromName: rp.username || null, at: rp.timestamp, own: String(rp.from?.id || "") === IG_ID(), verb: "add" });
    } else res.errors.push(`ig media: ${clip(gErr(ig), 160)}`);
    const fb = await graph("GET", `${PAGE_ID()}/published_posts`, { token: tok, query: { limit: String(posts), fields: "id,comments.limit(50){id,message,from,created_time,comments{id,message,from,created_time}}" } });
    if (fb.ok) for (const po of fb.json.data || []) for (const cm of po.comments?.data || []) {
      const ts = (x) => (x ? String(Math.floor(Date.parse(x) / 1000)) : null);
      await handleEvent({ type: "comment", platform: "fb", commentId: cm.id, parentId: null, postId: po.id, text: cm.message || "", fromId: String(cm.from?.id || ""), fromName: cm.from?.name || null, at: cm.created_time, own: String(cm.from?.id || "") === PAGE_ID(), verb: "add" }); res.comments++;
      for (const rp of cm.comments?.data || []) await handleEvent({ type: "comment", platform: "fb", commentId: rp.id, parentId: cm.id, postId: po.id, text: rp.message || "", fromId: String(rp.from?.id || ""), fromName: rp.from?.name || null, at: rp.created_time, own: String(rp.from?.id || "") === PAGE_ID(), verb: "add" });
      void ts;
    } else res.errors.push(`fb posts: ${clip(gErr(fb), 160)}`);
    await recomputeHeads();
    /* السحب مايعلّمش «غير مقروء» — ده تاريخ */
    await pool.query("UPDATE cc_threads SET unread = 0 WHERE read_at IS NULL AND last_at < NOW() - interval '1 minute'").catch(() => {});
    return { ok: true, ...res };
  }

  /* رأس كل محادثة من رسايلها الحقيقية (وقت/نص/اتجاه آخر رسالة، وآخر وارد) — بعد السحب، ومرة في الإقلاع (تصحيح سحب ١٨/١٠ اللي اتسجّل بوقت السحب) */
  async function recomputeHeads() {
    await pool.query(`UPDATE cc_threads t SET last_at = x.at, last_text = left(regexp_replace(COALESCE(x.body, ''), '[[:space:]]+', ' ', 'g'), 120), last_dir = x.direction,
        last_in_at = (SELECT max(at) FROM cc_messages WHERE thread_id = t.id AND direction = 'in')
      FROM (SELECT DISTINCT ON (thread_id) thread_id, at, body, direction FROM cc_messages ORDER BY thread_id, at DESC, id DESC) x
      WHERE x.thread_id = t.id`);
  }
  ready.then(() => recomputeHeads()).catch((e) => log.error("[cc] heads:", e.message));

  /* ── حالة الربط (المالك) ── */
  async function status() {
    const tok = await pageToken();
    const perms = await graph("GET", "me/permissions", { token: USER_TOKEN() });
    const granted = (perms.json?.data || []).filter((p) => p.status === "granted").map((p) => p.permission);
    const need = ["pages_messaging", "instagram_manage_messages", "instagram_manage_comments", "pages_manage_engagement", "pages_read_user_content", "pages_manage_metadata"];
    const sub = tok ? await graph("GET", `${PAGE_ID()}/subscribed_apps`, { token: tok }) : { ok: false };
    const h = (await pool.query("SELECT field, last_at, n FROM cc_webhook_health ORDER BY field")).rows.map((x) => ({ field: x.field, lastAt: iso(x.last_at), n: Number(x.n) }));
    return { ok: true, pageId: PAGE_ID(), igId: IG_ID(), pageToken: Boolean(tok),
      permissions: Object.fromEntries(need.map((p) => [p, granted.includes(p)])),
      subscribed: sub.ok ? (sub.json.data || []).map((a) => ({ id: a.id, name: a.name, fields: a.subscribed_fields || [] })) : null,
      webhook: h, config: ccConfig(await getSettingsData().catch(() => ({}))) };
  }
  async function subscribe() {
    const tok = await pageToken(); if (!tok) return { ok: false, error: "no_token" };
    const granted = (await status()).permissions;
    const fields = PAGE_FIELDS.filter((f) => f === "feed" || granted.pages_messaging);
    const r = await graph("POST", `${PAGE_ID()}/subscribed_apps`, { token: tok, query: { subscribed_fields: fields.join(",") } });
    return r.ok ? { ok: true, fields } : { ok: false, error: "graph", message: gErr(r) };
  }

  /* ── الأدوار ── */
  async function access(c, { owner = false, phone = false } = {}) {
    const err = await requireAdmin(c); if (err) return { res: err };
    let user = null; try { user = await deps.whoami?.(c); } catch { user = null; }
    if (!user || !user.role) return { res: c.json({ ok: false, error: "unauthorized" }, 401) };
    if (owner && user.role !== "owner") return { res: c.json({ ok: false, error: "owner_only", message: "للمالك بس" }, 403) };
    const roles = hubRoles(await getSettingsData().catch(() => ({})));
    if (!roles.inbox.includes(user.role)) return { res: c.json({ ok: false, error: "role_not_allowed", message: "المحادثات مش متاحة لدورك" }, 403) };
    const full = roles.phone.includes(user.role);
    if (phone && !full) return { res: c.json({ ok: false, error: "phone_hidden", message: "الرقم مخفي لدورك" }, 403) };
    return { user, full, name: user.name || user.username || user.role };
  }
  async function portalAccess(c) {
    if (!deps.requirePortal) return { res: c.json({ ok: false, error: "unavailable" }, 503) };
    const a = await deps.requirePortal(c); if (a.res) return a;
    if (!["cashier", "manager"].includes(a.user.role)) return { res: c.json({ ok: false, error: "forbidden", message: "المحادثات للكاشير والمدير" }, 403) };
    return { user: a.user, full: true, name: a.user.name || a.user.role };
  }
  const bodyOf = async (c) => { try { return await c.req.json(); } catch { return {}; } };

  /* نفس المسارات للّوحة (/api/cms/cc) وللبورتال (/api/portal/cc) — الفرق في الحارس بس */
  for (const [base, guard] of [["/api/cms/cc", access], ["/api/portal/cc", portalAccess]]) {
    app.get(`${base}/threads`, async (c) => {
      const a = await guard(c); if (a.res) return a.res; await ready;
      try { return c.json({ ...(await listThreads({ channel: c.req.query("channel") || "", status: c.req.query("status") || "open", q: c.req.query("q") || "", limit: c.req.query("limit"), before: c.req.query("before") || null, full: a.full })), config: ccConfig(await getSettingsData().catch(() => ({}))) }); }
      catch (e) { log.error("[cc] threads:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
    });
    app.get(`${base}/threads-tick`, async (c) => { const a = await guard(c); if (a.res) return a.res; await ready; return c.json({ ok: true, tick: await tick() }); });
    app.get(`${base}/threads/:key`, async (c) => {
      const a = await guard(c); if (a.res) return a.res; await ready;
      const id = idOfKey(c.req.param("key")); const t = id && (await getThread(id));
      if (!t) return c.json({ ok: false, error: "not_found" }, 404);
      return c.json({ ok: true, thread: threadOut(t, { full: a.full }), messages: await messagesOf(id) });
    });
    app.post(`${base}/threads/:key/read`, async (c) => {
      const a = await guard(c); if (a.res) return a.res;
      const id = idOfKey(c.req.param("key")); if (!id) return c.json({ ok: false, error: "not_found" }, 404);
      await pool.query("UPDATE cc_threads SET unread = 0, read_at = NOW(), read_by = $2 WHERE id = $1", [id, a.name]);
      broadcast("cc_chat_update", { key: keyOf(id), what: "read" });
      return c.json({ ok: true });
    });
    app.post(`${base}/threads/:key/reply`, async (c) => {
      const a = await guard(c); if (a.res) return a.res;
      const id = idOfKey(c.req.param("key")); const t = id && (await getThread(id));
      if (!t) return c.json({ ok: false, error: "not_found" }, 404);
      const b = await bodyOf(c);
      const r = await send(t, { text: b.text, mode: b.mode === "private" ? "private" : "public", staffName: a.name, sender: "staff" });
      return c.json(r, r.ok ? 200 : (["cc_off", "channel_off"].includes(r.error) ? 409 : 400));
    });
    app.post(`${base}/threads/:key/done`, async (c) => {
      const a = await guard(c); if (a.res) return a.res;
      const id = idOfKey(c.req.param("key")); if (!id) return c.json({ ok: false, error: "not_found" }, 404);
      const b = await bodyOf(c);
      if (b.reopen) await pool.query("UPDATE cc_threads SET status = 'open', done_at = NULL, done_by = NULL WHERE id = $1", [id]);
      else await pool.query("UPDATE cc_threads SET status = 'done', done_at = NOW(), done_by = $2, unread = 0 WHERE id = $1", [id, a.name]);
      broadcast("cc_chat_update", { key: keyOf(id), what: b.reopen ? "reopen" : "done" });
      return c.json({ ok: true });
    });
    app.post(`${base}/threads/:key/hide`, async (c) => {
      const a = await guard(c); if (a.res) return a.res;
      const id = idOfKey(c.req.param("key")); const t = id && (await getThread(id));
      if (!t) return c.json({ ok: false, error: "not_found" }, 404);
      const cfg = ccConfig(await getSettingsData().catch(() => ({})));
      if (!cfg.enabled) return c.json({ ok: false, error: "cc_off", message: "مركز التواصل مقفول من الإعدادات" }, 409);
      const b = await bodyOf(c);
      const r = await hide(t, b.hidden !== false);
      return c.json(r, r.ok ? 200 : 400);
    });
  }
  /* ربط هوية بجوال: اللوحة للأدوار اللي بتشوف الأرقام؛ البورتال للكاشير والمدير */
  for (const [base, guard] of [["/api/cms/cc", (c) => access(c, { phone: true })], ["/api/portal/cc", portalAccess]]) {
    app.post(`${base}/threads/:key/link`, async (c) => {
      const a = await guard(c); if (a.res) return a.res;
      const id = idOfKey(c.req.param("key")); if (!id) return c.json({ ok: false, error: "not_found" }, 404);
      const b = await bodyOf(c);
      const t = await getThread(id);
      const r = b.unlink ? await unlink(id) : await link(id, b.phone || (b.useSuggested && t?.suggested_phone) || "", a.name);
      broadcast("cc_chat_update", { key: keyOf(id), what: "link" });
      return c.json(r, r.ok ? 200 : 400);
    });
  }
  /* المالك: الحالة + الإعدادات + الاشتراك + السحب الأولي */
  app.get("/api/cms/cc/status", async (c) => { const a = await access(c, { owner: true }); if (a.res) return a.res; await ready; return c.json(await status()); });
  app.put("/api/cms/cc/settings", async (c) => {
    const a = await access(c, { owner: true }); if (a.res) return a.res;
    const b = await bodyOf(c);
    const cur = await getSettingsData().catch(() => ({}));
    const prev = ccConfig(cur);
    const next = { enabled: typeof b.enabled === "boolean" ? b.enabled : prev.enabled, channels: { ...prev.channels } };
    for (const ch of CHANNELS) if (typeof b.channels?.[ch]?.enabled === "boolean") next.channels[ch] = { enabled: b.channels[ch].enabled };
    await pool.query("UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{cc}', $1::jsonb, true), updated_at=NOW() WHERE id=1", [JSON.stringify({ ...(cur.cc || {}), ...next })]);
    if (ctx.auditNote) { try { await ctx.auditNote(c, `💬 مركز التواصل: ${next.enabled ? "شغّال" : "مقفول"} · ${CHANNELS.filter((x) => next.channels[x].enabled).map((x) => CHANNEL_AR[x]).join("، ") || "ولا قناة"}`); } catch { /* اختياري */ } }
    return c.json({ ok: true, config: ccConfig({ cc: next }) });
  });
  app.post("/api/cms/cc/subscribe", async (c) => { const a = await access(c, { owner: true }); if (a.res) return a.res; const r = await subscribe(); return c.json(r, r.ok ? 200 : 400); });
  app.post("/api/cms/cc/backfill", async (c) => { const a = await access(c, { owner: true }); if (a.res) return a.res; await ready; return c.json(await backfill()); });

  return { ready, processWebhook, listThreads, getThread, messagesOf, send, link, unlink, backfill, status, subscribe, tick };
}
