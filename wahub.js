/* ═══════════════════════════════════════════════════════════════════════════
   قسم واتساب في اللوحة — مسارات القراءة (١٣/١٠). العقود: docs/designs-2026-10/whatsapp/hub-design.md §6.

   N1  المحادثات للوحة:  GET  /api/cms/wa/threads            (قايمة + عدّادات + صفحات)
                         GET  /api/cms/wa/threads/:key       (المحادثة: رسايل + قرارات البوت + أحداث)
                         POST /api/cms/wa/threads/:key/read | handled | reply | template
       • بتشتغل والإرسال مقفول (WHATSAPP_ENABLED off): قراءة من الجداول مباشرة.
       • مين يشوف: قايمة أدوار على السيرفر (الافتراضي: مالك، عمليات، مطبخ/كاشير) — settings.waHub.inboxRoles.
         التسويق والمحاسبة 403 حتى لو عندهم «الطلبات: عرض». الدور اللي مش في phoneRoles بيشوف الرقم مخفي ومفتاح بس.
       • الرد: بيعدّي من wainbox ⇒ whatsapp.guardSend. مفيش طريق إرسال تاني هنا، والرفض بيرجّع اسم القفل.
   N3  القوالب:          GET  /api/cms/wa/templates          (سبب الرفض زي ما ميتا كتبته، الجودة، مربوط بإيه،
                                                              إرسال/تسليم/قراءة ٣٠ يوم، سجل الأحداث)
   N7  سجل المفاتيح:     GET  /api/cms/wa/settings-log       (مين، إمتى، المفتاح، من ← إلى)
   عدّادا تأكيد المفتاح الرئيسي: GET /api/cms/wa/master-counts (طلبات الموقع في اليوم، مستلمين حملات Cloud في الطابور)

   مفيش أي إرسال مباشر من الملف ده ولا كتابة في جداول البوت («تم» بتنادي دالة البوت نفسها).
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import { windowState } from "./wainbox.js";
import { tokenSecret } from "./portal-core.js";
import { bizDay, bizStart, shiftDay } from "./bizday.js";
import * as CAT from "./watemplates.js";
import { TEMPLATES as REG, STAGE_TEMPLATES, GRAPH_VERSION } from "./whatsapp.js";

export const DEFAULT_INBOX_ROLES = Object.freeze(["owner", "operations", "kitchen"]);
const ROLE_IDS = ["owner", "marketing", "operations", "accounting", "kitchen"];
const TEMPLATE_SEND_ROLES = ["owner", "operations"];           // قالب مدفوع بره النافذة: المالك والعمليات بس
const FILTERS = ["all", "waiting", "bot", "muted", "ad", "unread"];
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
export const maskPhone = (pn) => `…${String(pn || "").slice(-4)}`;

/* أدوار مسموح لها تشوف المحادثات (المالك دايماً) + أدوار تشوف الرقم كامل */
export function hubRoles(settings) {
  const x = (settings && settings.waHub) || {};
  const clean = (l, d) => { const a = (Array.isArray(l) ? l : d).filter((r) => ROLE_IDS.includes(r)); return [...new Set(["owner", ...a])]; };
  const inbox = clean(x.inboxRoles, DEFAULT_INBOX_ROLES);
  return { inbox, phone: clean(x.phoneRoles, inbox).filter((r) => inbox.includes(r)) };
}

/* حالة المحادثة من وجهة نظر الكاشير: مكتومة › مستنية موظف › الموظف بيرد › النافذة قفلت › البوت */
export function botState(row, { now = Date.now(), pauseMin = 30 } = {}) {
  const t = (v) => (v ? new Date(v).getTime() : NaN);
  if (t(row.muted_until) > now) return { state: "muted", reason: row.mute_reason || null, mutedUntil: iso(row.muted_until), mutedBy: row.muted_by || null, handoffAt: iso(row.handoff_at) };
  if (row.handoff_at) return { state: "waiting", reason: row.handoff_reason || null, mutedUntil: null, mutedBy: null, handoffAt: iso(row.handoff_at) };
  if (now - t(row.last_echo_at) < pauseMin * 60_000) return { state: "staff", reason: null, mutedUntil: null, mutedBy: null, handoffAt: null };
  if (!windowState(iso(row.last_in_at), now).open) return { state: "closed", reason: null, mutedUntil: null, mutedBy: null, handoffAt: null };
  return { state: "bot", reason: null, mutedUntil: null, mutedBy: null, handoffAt: null };
}

/* ── سجل المفاتيح (N7): المسارات اللي بنراقبها — قيم بسيطة بس، ولا سر */
const SCALAR = (v) => v === null || ["boolean", "number", "string"].includes(typeof v);
export function watchedValues(settings) {
  const s = settings || {}, out = {};
  const put = (k, v) => { if (v !== undefined && SCALAR(v)) out[k] = typeof v === "string" ? v.slice(0, 200) : v; };
  /* المفاتيح الثلاثة الأساسية بتتراقب دايماً حتى لو عمرها ما اتكتبت (غايبة = مقفولة) — على السيرفر الحي ماكانش فيه
     ولا واحد منهم مكتوب فالقايمة كانت بتطلع من غيرهم. */
  put("notifications.whatsappEnabled", (s.notifications || {}).whatsappEnabled === true);
  for (const [k, v] of Object.entries(s.notifications || {})) if (/^whatsapp/i.test(k) && k !== "whatsappEnabled") put(`notifications.${k}`, v);
  put("waMaster.enabled", (s.waMaster || {}).enabled === true);
  put("waCloud.enabled", (s.waCloud || {}).enabled === true);
  for (const k of ["dailyCap", "hourCap", "perTick", "tierLimit", "reserveUtility"]) put(`waCloud.${k}`, (s.waCloud || {})[k]);
  for (const [k, v] of Object.entries(s.waSender || {})) if (!/hash|token|secret|key/i.test(k)) put(`waSender.${k}`, v);
  for (const k of ["phoneId", "wabaId"]) put(`waCloudActive.${k}`, (s.waCloudActive || {})[k]);
  put("waBot.mode", (s.waBot || {}).mode);
  return out;
}
export function diffWatched(prev, next) {
  const rows = [];
  for (const k of [...new Set([...Object.keys(prev || {}), ...Object.keys(next || {})])].sort()) {
    const a = (prev || {})[k], b = (next || {})[k];
    if (a === b) continue;
    if ((a === undefined || a === null) && b === false) continue;   // «مش مكتوب» و«مقفول» نفس الحالة — مش تغيير
    if ((b === undefined || b === null) && a === false) continue;
    rows.push({ key: k, from: a === undefined ? null : a, to: b === undefined ? null : b });
  }
  return rows;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS wa_settings_log (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    key TEXT NOT NULL,
    from_v JSONB, to_v JSONB,
    who TEXT
  );
  CREATE INDEX IF NOT EXISTS wa_settings_log_at_idx ON wa_settings_log(at DESC);
  CREATE TABLE IF NOT EXISTS wa_settings_snap (id INT PRIMARY KEY DEFAULT 1, data JSONB NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW());
`;

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const doFetch = deps.fetch || globalThis.fetch;
  const wa = deps.wa || null;
  const inbox = () => (typeof deps.waInbox === "function" ? deps.waInbox() : deps.waInbox) || null;
  const bot = () => (typeof deps.bot === "function" ? deps.bot() : deps.bot) || null;
  const SALT = String(deps.keySalt || tokenSecret(process.env) || "");
  const keyOf = (pn) => crypto.createHash("md5").update(`${SALT}:${pn}`).digest("hex");
  const ready = pool.query(DDL).then(() => true).catch((e) => { log.error("[wa-hub] schema:", e.message); return false; });

  /* ── مين يدخل ── */
  async function access(c, { phoneOnly = false } = {}) {
    const err = await requireAdmin(c); if (err) return { res: err };
    let user = null;
    try { user = await deps.whoami?.(c); } catch { user = null; }
    if (!user || !user.role) return { res: c.json({ ok: false, error: "unauthorized" }, 401) };
    const roles = hubRoles(await getSettingsData().catch(() => ({})));
    if (!roles.inbox.includes(user.role)) return { res: c.json({ ok: false, error: "role_not_allowed", message: "المحادثات مش متاحة لدورك" }, 403) };
    const full = roles.phone.includes(user.role);
    if (phoneOnly && !full) return { res: c.json({ ok: false, error: "phone_hidden", message: "الرقم مخفي لدورك" }, 403) };
    return { user, full };
  }
  /* :key = مفتاح المحادثة (٣٢ حرف) لأي دور مسموح، أو الرقم نفسه للي بيشوف الأرقام */
  async function phoneOfKey(raw, full) {
    const k = String(raw || "").trim();
    if (/^[0-9a-f]{32}$/.test(k)) {
      if (!SALT) return null;
      const r = await pool.query("SELECT phone_norm FROM wa_threads WHERE md5($1 || ':' || phone_norm) = $2 LIMIT 1", [SALT, k]);
      return r.rows[0]?.phone_norm || null;
    }
    const d = k.replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
    return full && /^5\d{8}$/.test(d) ? d : null;
  }
  const pauseMinNow = async () => { try { const cfg = await bot()?.botConfig?.(); return Number(cfg?.humanPauseMin) || 30; } catch { return 30; } };

  /* ═══ N1: القايمة ═══ */
  const FROM = `
      FROM wa_threads t
      LEFT JOIN cms_contacts c ON c.phone_norm = t.phone_norm
      LEFT JOIN wa_contact_names n ON n.phone_norm = t.phone_norm AND NOT n.removed
      LEFT JOIN wa_bot_chats b ON b.phone_norm = t.phone_norm`;
  const COND = {
    all: "TRUE",
    muted: "b.muted_until > NOW()",
    waiting: "b.handoff_at IS NOT NULL AND NOT COALESCE(b.muted_until > NOW(), FALSE)",
    bot: "b.handoff_at IS NULL AND NOT COALESCE(b.muted_until > NOW(), FALSE) AND t.last_in_at > NOW() - INTERVAL '24 hours'",
    ad: "b.referral IS NOT NULL",
    unread: "t.unread > 0",
  };
  async function listThreads({ filter = "all", q = "", limit = 40, before = null, full = false } = {}) {
    const f = FILTERS.includes(filter) ? filter : "all";
    const lim = Math.min(Math.max(Number(limit) || 40, 1), 100);
    const term = String(q || "").trim().slice(0, 40);
    const digits = term.replace(/\D/g, "");
    const p = [], where = [COND[f]];
    if (term) {
      if (digits && digits === term.replace(/[\s+-]/g, "")) {
        // بالرقم: اللي بيشوف الأرقام يبحث بأي جزء؛ غيره بآخر ٤ أرقام بس (مايقدرش يخمّن الرقم بالبحث)
        if (full) { p.push(digits.replace(/^966/, "").replace(/^0/, "")); where.push(`t.phone_norm LIKE '%' || $${p.length} || '%'`); }
        else { p.push(digits.slice(-4)); where.push(`right(t.phone_norm, ${Math.min(4, digits.length)}) = right($${p.length}, ${Math.min(4, digits.length)})`); }
      } else { p.push(term); where.push(`COALESCE(c.name, n.full_name, n.profile_name, '') ILIKE '%' || $${p.length} || '%'`); }
    }
    const b4 = before && Number.isFinite(Date.parse(before)) ? new Date(before).toISOString() : null;
    const pageWhere = [...where];
    if (b4) { p.push(b4); pageWhere.push(`t.last_at < $${p.length}`); }
    p.push(lim + 1);
    const rows = (await pool.query(
      `SELECT t.phone_norm, t.last_in_at, t.last_at, t.last_text, t.last_dir, t.unread, t.order_no,
              COALESCE(c.name, n.full_name, n.profile_name) AS name, c.orders AS orders,
              b.muted_until, b.mute_reason, b.muted_by, b.handoff_at, b.handoff_reason, (b.referral IS NOT NULL) AS ad,
              (SELECT m.source FROM wa_messages m WHERE m.phone_norm = t.phone_norm ORDER BY m.created_at DESC LIMIT 1) AS last_source,
              (SELECT max(m.created_at) FROM wa_messages m WHERE m.phone_norm = t.phone_norm AND m.source = 'echo') AS last_echo_at
       ${FROM}
       WHERE ${pageWhere.join(" AND ")}
       ORDER BY t.last_at DESC LIMIT $${p.length}`, p)).rows || [];
    const cnt = (await pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${COND.waiting})::int AS waiting, count(*) FILTER (WHERE ${COND.bot})::int AS bot,
              count(*) FILTER (WHERE ${COND.muted})::int AS muted, count(*) FILTER (WHERE ${COND.ad})::int AS ad,
              count(*) FILTER (WHERE ${COND.unread})::int AS unread, COALESCE(sum(t.unread), 0)::int AS unread_messages,
              min(b.handoff_at) FILTER (WHERE ${COND.waiting}) AS oldest_waiting
       ${FROM}`)).rows[0] || {};
    const t0 = now(), pauseMin = await pauseMinNow();
    const page = rows.slice(0, lim);
    return {
      ok: true, filter: f,
      counts: { all: cnt.total || 0, waiting: cnt.waiting || 0, bot: cnt.bot || 0, muted: cnt.muted || 0, ad: cnt.ad || 0, unread: cnt.unread || 0,
        unreadMessages: cnt.unread_messages || 0, oldestWaitingAt: iso(cnt.oldest_waiting) },
      threads: page.map((r) => ({
        key: keyOf(r.phone_norm), phone: full ? `0${r.phone_norm}` : maskPhone(r.phone_norm), phoneMasked: maskPhone(r.phone_norm),
        name: r.name || null, orders: Number(r.orders) || 0, orderNo: r.order_no || null,
        lastText: r.last_text || "", lastDir: r.last_dir || null, lastSource: r.last_source || null, lastAt: iso(r.last_at),
        unread: Number(r.unread) || 0, window: windowState(iso(r.last_in_at), t0), bot: botState(r, { now: t0, pauseMin }), ad: r.ad === true,
      })),
      nextBefore: rows.length > lim ? iso(page[page.length - 1].last_at) : null,
    };
  }

  /* ═══ N1: المحادثة ═══ */
  async function getThread(pn, { limit = 80, before = null, full = false } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 80, 1), 200);
    const head = (await pool.query(
      `SELECT t.phone_norm, t.last_in_at, t.last_at, t.unread, t.order_no, COALESCE(c.name, n.full_name, n.profile_name) AS name, c.orders AS orders,
              b.muted_until, b.mute_reason, b.muted_by, b.handoff_at, b.handoff_reason, (b.referral IS NOT NULL) AS ad,
              (SELECT max(m.created_at) FROM wa_messages m WHERE m.phone_norm = t.phone_norm AND m.source = 'echo') AS last_echo_at,
              o.updates AS optin_updates, o.marketing AS optin_marketing, o.stopped_at
       ${FROM} LEFT JOIN wa_optins o ON o.phone_norm = t.phone_norm
       WHERE t.phone_norm = $1`, [pn])).rows[0];
    if (!head) return { ok: false, error: "not_found" };
    const b4 = before && Number.isFinite(Date.parse(before)) ? new Date(before).toISOString() : null;
    const msgs = (await pool.query(
      `SELECT wamid, direction, status, error, body, template, category, order_no, created_at, source, pricing
         FROM wa_messages WHERE phone_norm = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
        ORDER BY created_at DESC LIMIT $3`, [pn, b4, lim + 1])).rows || [];
    const page = msgs.slice(0, lim).reverse();
    const from = page.length ? iso(page[0].created_at) : null;
    /* قرارات البوت على رسايل العميل في نفس المدى (المفتاح wamid الرسالة الواردة) + التحويلات كأحداث */
    let botRows = [];
    if (from) {
      try {
        botRows = (await pool.query(
          `SELECT wamid, at, decision, reason, reply_key, handoff FROM wa_bot_log WHERE phone_norm = $1 AND at >= $2::timestamptz - INTERVAL '1 minute' ORDER BY at`, [pn, from])).rows || [];
      } catch { botRows = []; }
    }
    const byWamid = new Map(botRows.filter((r) => r.wamid).map((r) => [r.wamid, r]));
    const t0 = now();
    const state = botState(head, { now: t0, pauseMin: await pauseMinNow() });
    const events = botRows.filter((r) => r.handoff).map((r) => ({ at: iso(r.at), kind: "handover", reason: String(r.handoff).split(":")[0] }));
    if (state.state === "muted") events.push({ at: null, kind: "mute", until: state.mutedUntil, by: state.mutedBy, reason: state.reason });
    return {
      ok: true, key: keyOf(pn), phone: full ? `0${pn}` : maskPhone(pn), phoneMasked: maskPhone(pn),
      name: head.name || null, orders: Number(head.orders) || 0, orderNo: head.order_no || null, unread: Number(head.unread) || 0,
      optIn: { updates: head.optin_updates === true, marketing: head.optin_marketing === true, stopped: Boolean(head.stopped_at) },
      window: windowState(iso(head.last_in_at), t0), bot: state, ad: head.ad === true,
      messages: page.map((m) => {
        const d = m.direction === "in" && m.wamid ? byWamid.get(m.wamid) : null;
        const pr = m.pricing && typeof m.pricing === "object" && "billable" in m.pricing ? { billable: m.pricing.billable === true, category: m.pricing.category || null } : null;
        return { id: m.wamid || `${m.direction}:${iso(m.created_at)}`, dir: m.direction, text: m.body || (m.template ? `[قالب: ${m.template}]` : ""),
          template: m.template || null, category: m.category || null, status: m.status || null, error: m.error || null, orderNo: m.order_no || null,
          source: m.source || "api", at: iso(m.created_at), cost: pr,
          bot: d ? { decision: d.decision || null, replyKey: d.reply_key || null, reason: d.reason || null } : null };
      }),
      events,
      nextBefore: msgs.length > lim ? iso(page[0].created_at) : null,
    };
  }

  app.get("/api/cms/wa/threads", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    await ready;
    try {
      return c.json(await listThreads({ filter: c.req.query("filter") || c.req.query("f") || "all", q: c.req.query("q") || "", limit: c.req.query("limit"),
        before: c.req.query("before") || null, full: a.full }));
    } catch (e) { log.error("[wa-hub] threads:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
  });
  app.get("/api/cms/wa/threads/:key", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const pn = await phoneOfKey(c.req.param("key"), a.full);
    if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
    try {
      const r = await getThread(pn, { limit: c.req.query("limit"), before: c.req.query("before") || null, full: a.full });
      return c.json(r, r.ok ? 200 : 404);
    } catch (e) { log.error("[wa-hub] thread:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
  });
  app.post("/api/cms/wa/threads/:key/read", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const pn = await phoneOfKey(c.req.param("key"), a.full);
    if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
    await pool.query("UPDATE wa_threads SET unread=0, read_at=NOW(), read_by=$2, updated_at=NOW() WHERE phone_norm=$1", [pn, clip(a.user.name || a.user.role, 60)]);
    return c.json({ ok: true });
  });
  /* «تم التعامل»: بيشيل التحويل المفتوح والكتم — نفس دالة البوت (مابنكتبش في جداوله) */
  app.post("/api/cms/wa/threads/:key/handled", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const pn = await phoneOfKey(c.req.param("key"), a.full);
    if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
    const b = bot();
    if (!b || typeof b.unmuteChat !== "function") return c.json({ ok: false, error: "bot_unavailable" }, 503);
    await b.unmuteChat(pn);
    return c.json({ ok: true });
  });
  /* الرد: نفس أقفال الصندوق (wainbox ⇒ الحارس المركزي). الرفض بيرجّع اسم القفل في gate. */
  const refusal = (r) => ({ ok: false, error: r.error || r.skipped || "send_failed", gate: r.skipped || (["disabled", "window_closed"].includes(r.error) ? r.error : null),
    window: r.window || undefined, message: r.message || undefined });
  app.post("/api/cms/wa/threads/:key/reply", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const pn = await phoneOfKey(c.req.param("key"), a.full);
    if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const ib = inbox();
    if (!ib) return c.json({ ok: false, error: "inbox_unavailable" }, 503);
    const r = await ib.replyText({ phoneNorm: pn, text: b.text, by: a.user.name || a.user.role });
    return r.ok ? c.json({ ok: true, wamid: r.wamid || null, window: r.window || null }) : c.json(refusal(r), ["empty", "too_long", "bad_phone"].includes(r.error) ? 400 : 409);
  });
  app.post("/api/cms/wa/threads/:key/template", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    if (!TEMPLATE_SEND_ROLES.includes(a.user.role)) return c.json({ ok: false, error: "role_not_allowed", message: "إرسال قالب للمالك والعمليات بس" }, 403);
    const pn = await phoneOfKey(c.req.param("key"), a.full);
    if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const ib = inbox();
    if (!ib) return c.json({ ok: false, error: "inbox_unavailable" }, 503);
    const r = await ib.replyTemplate({ phoneNorm: pn, template: String(b.template || ""), params: b.params && typeof b.params === "object" ? b.params : {}, by: a.user.name || a.user.role });
    return r.ok ? c.json({ ok: true, wamid: r.wamid || null }) : c.json(refusal(r), ["no_template", "bad_phone", "unknown_template"].includes(r.error) ? 400 : 409);
  });

  /* ═══ N3: القوالب ═══ */
  const DIRECT_WIRES = { fc_loyalty_status: { kind: "flow", id: "loyalty_status", label: "رصيد الولاء بعد التسليم" } };
  async function metaTemplates() {
    const token = wa?.token ? wa.token() : null, waba = wa?.idsInUse ? wa.idsInUse().wabaId : (wa?.wabaId ? wa.wabaId() : null);
    if (!token || !waba) return { ok: false, error: "unconfigured", list: [] };
    try {
      const out = [];
      let url = `https://graph.facebook.com/${GRAPH_VERSION}/${waba}/message_templates?fields=id,name,status,category,language,quality_score,rejected_reason&limit=200`;
      for (let i = 0; i < 5 && url; i++) {
        const resp = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.error) return { ok: false, error: clip(data.error?.message || `HTTP ${resp.status}`, 200), list: out };
        out.push(...(data.data || []));
        url = data.paging?.next && /^https:\/\/graph\.facebook\.com\//.test(data.paging.next) ? data.paging.next : null;
      }
      return { ok: true, list: out };
    } catch (e) { return { ok: false, error: clip(e.message || "fetch_failed", 200), list: [] }; }
  }
  async function templatesView() {
    const [meta, sends, events] = await Promise.all([
      metaTemplates(),
      pool.query(
        `SELECT template, count(*) FILTER (WHERE status NOT IN ('failed','skipped'))::int AS sent,
                count(*) FILTER (WHERE status IN ('delivered','read'))::int AS delivered, count(*) FILTER (WHERE status = 'read')::int AS read,
                count(*) FILTER (WHERE status = 'failed')::int AS failed, max(created_at) AS last_at
           FROM wa_messages WHERE direction='out' AND template IS NOT NULL AND created_at > NOW() - INTERVAL '30 days' AND COALESCE(source,'') <> 'test'
          GROUP BY template`).then((r) => r.rows || []).catch(() => []),
      pool.query("SELECT name, language, event, reason, at FROM wa_template_events ORDER BY at DESC LIMIT 500").then((r) => r.rows || []).catch(() => []),
    ]);
    const sendBy = new Map(sends.map((r) => [r.template, r]));
    const catBy = new Map();
    for (const t of CAT.TEMPLATES || []) { if (!catBy.has(t.name)) catBy.set(t.name, []); catBy.get(t.name).push(t); }
    const names = [...new Set([...Object.keys(REG), ...catBy.keys(), ...meta.list.map((m) => m.name)])].sort();
    const rows = names.map((name) => {
      const reg = REG[name] || null, cats = catBy.get(name) || [], first = cats[0] || null;
      const live = meta.list.filter((m) => m.name === name);
      const wired = [];
      const stage = Object.entries(STAGE_TEMPLATES).find(([, n]) => n === name);
      if (stage) wired.push({ kind: "stage", id: stage[0], label: first?.meta?.purpose || stage[0] });
      if (reg && reg.campaign) wired.push({ kind: "campaign", id: name, label: reg.campaign.label || name });
      if (DIRECT_WIRES[name]) wired.push(DIRECT_WIRES[name]);
      const s = sendBy.get(name);
      const rejected = live.filter((m) => m.rejected_reason && m.rejected_reason !== "NONE");
      return {
        name, inCatalog: Boolean(reg || first), category: (reg && reg.category) || first?.category || live[0]?.category || null,
        group: first?.group || null, purpose: first?.meta?.purpose || null, trigger: first?.meta?.trigger || null,
        languages: [...new Set([...cats.map((t) => t.language), ...live.map((m) => m.language)].filter(Boolean))],
        components: reg ? reg.components : (first ? first.components : null),
        statuses: live.map((m) => ({ language: m.language, status: m.status, category: m.category, quality: m.quality_score?.score || null,
          rejectedReason: m.rejected_reason && m.rejected_reason !== "NONE" ? m.rejected_reason : null, id: m.id || null })),
        submitted: live.length > 0,
        rejectedReason: rejected.length ? rejected[0].rejected_reason : null,          // زي ما ميتا كتبته، من غير تفسير
        categoryChanged: live.some((m) => m.category && reg && reg.category && m.category !== reg.category),
        quality: live.map((m) => m.quality_score?.score).find(Boolean) || null,
        wiredTo: wired, held: Boolean(CAT.HOLD && CAT.HOLD[name]), heldReason: (CAT.HOLD && CAT.HOLD[name]) || null,
        sent30d: s ? s.sent : 0, delivered30d: s ? s.delivered : 0, read30d: s ? s.read : 0, failed30d: s ? s.failed : 0, lastSentAt: s ? iso(s.last_at) : null,
        events: events.filter((e) => e.name === name).slice(0, 20).map((e) => ({ at: iso(e.at), event: e.event, reason: e.reason || null, language: e.language || null })),
      };
    });
    return { ok: true, meta: { ok: meta.ok, error: meta.ok ? null : meta.error, variants: meta.list.length }, count: rows.length,
      needAction: rows.filter((r) => r.rejectedReason || r.categoryChanged).length, templates: rows };
  }
  app.get("/api/cms/wa/templates", async (c) => {
    const err = await requireAdmin(c); if (err) return err;       // القسم: «العملاء» (cms.js PATH_SECTIONS) — المالك والتسويق
    try { return c.json(await templatesView()); }
    catch (e) { log.error("[wa-hub] templates:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
  });

  /* ═══ N7: سجل المفاتيح ═══
     مابنعدّلش كل مسار بيكتب إعداد: بنقارن القيم المراقَبة بآخر لقطة، وأي فرق = صف. sweep(who) بتتنادى بعد أي كتابة
     ناجحة على مسارات الإعدادات (middleware في index.js) باسم اللي كتب، وكل دقيقتين من غير اسم (سكربت/تعديل مباشر). */
  let sweeping = Promise.resolve();
  function sweep(who = null) {
    sweeping = sweeping.then(async () => {
      await ready;
      const next = watchedValues(await getSettingsData());
      const snap = (await pool.query("SELECT data FROM wa_settings_snap WHERE id=1")).rows[0];
      if (!snap) { await pool.query("INSERT INTO wa_settings_snap(id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING", [JSON.stringify(next)]); return 0; }
      const rows = diffWatched(snap.data || {}, next);
      if (!rows.length) return 0;
      for (const r of rows) {
        await pool.query("INSERT INTO wa_settings_log(key, from_v, to_v, who) VALUES ($1, $2::jsonb, $3::jsonb, $4)", [r.key, JSON.stringify(r.from), JSON.stringify(r.to), clip(who, 60)]);
      }
      await pool.query("UPDATE wa_settings_snap SET data=$1::jsonb, at=NOW() WHERE id=1", [JSON.stringify(next)]);
      return rows.length;
    }).catch((e) => { log.error("[wa-hub] settings sweep:", e.message); return 0; });
    return sweeping;
  }
  async function sweepFor(c) {
    let who = null;
    try { const u = await deps.whoami?.(c); who = u ? (u.name || u.username || u.role) : null; } catch { who = null; }
    return sweep(who);
  }
  if (deps.timer !== false) { const t = setInterval(() => { sweep(null); }, 120_000); t.unref?.(); sweep(null); }
  app.get("/api/cms/wa/settings-log", async (c) => {
    const err = await requireAdmin(c); if (err) return err;       // القسم: «الإعدادات» ⇒ المالك
    await sweep(null);
    const lim = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
    const key = String(c.req.query("key") || "").slice(0, 60);
    const rows = (await pool.query(
      `SELECT id, at, key, from_v, to_v, who FROM wa_settings_log WHERE ($1 = '' OR key LIKE $1 || '%') ORDER BY at DESC, id DESC LIMIT $2`, [key, lim])).rows || [];
    return c.json({ ok: true, watched: Object.keys(watchedValues(await getSettingsData())).sort(),
      rows: rows.map((r) => ({ id: Number(r.id), at: iso(r.at), key: r.key, from: r.from_v ?? null, to: r.to_v ?? null, who: r.who || null })) });
  });

  /* ═══ عدّادا تأكيد المفتاح الرئيسي ═══ */
  async function masterCounts() {
    const today = bizDay(new Date(now()));
    const from = bizStart(shiftDay(today, -7)), to = bizStart(today);
    const o = (await pool.query(
      `SELECT count(*)::int AS n FROM shop_orders WHERE created_at >= $1 AND created_at < $2 AND NOT COALESCE(is_test, FALSE)
          AND status NOT IN ('pending','expired','payment_failed','failed','cancelled')`, [from.toISOString(), to.toISOString()]).catch(() => ({ rows: [{ n: null }] }))).rows[0];
    const q = (await pool.query(
      `SELECT count(*)::int AS n, count(DISTINCT q.phone_norm)::int AS people FROM wa_send_queue q JOIN wa_send_jobs j ON j.id = q.job_id
        WHERE q.status = 'pending' AND j.status IN ('running','paused') AND COALESCE(q.channel, j.channel) = 'wa_cloud'`).catch(() => ({ rows: [{ n: null, people: null }] }))).rows[0];
    const n = o && o.n != null ? Number(o.n) : null;
    return { ok: true, days: 7, from: from.toISOString(), to: to.toISOString(), orders7d: n, ordersPerDay: n == null ? null : Math.round((n / 7) * 10) / 10,
      queuedCloudMessages: q && q.n != null ? Number(q.n) : null, queuedCloudRecipients: q && q.people != null ? Number(q.people) : null };
  }
  app.get("/api/cms/wa/master-counts", async (c) => {
    const err = await requireAdmin(c); if (err) return err;       // القسم: «الإعدادات» ⇒ المالك
    try { return c.json(await masterCounts()); }
    catch (e) { log.error("[wa-hub] counts:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
  });

  return { ready, listThreads, getThread, templatesView, sweep, sweepFor, masterCounts, keyOf };
}
