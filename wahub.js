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
import { TEMPLATES as REG, STAGE_TEMPLATES, GRAPH_VERSION, revokeText, REVOKE_PLAIN } from "./whatsapp.js";
import { publicMedia } from "./wamedia.js";
import { readUpload } from "./wastaffmedia.js";
import { teamConfig } from "./wateam.js";
import { REVIEW_HANDOVER_REASONS, isReviewHandover } from "./reviewaudience.js";
import { classifyError, reasonText } from "./wacloud.js";      // TK1a: سبب فشل الرسالة بالعربي (نفس أسباب الحملات)

export const DEFAULT_INBOX_ROLES = Object.freeze(["owner", "operations", "kitchen"]);
const ROLE_IDS = ["owner", "marketing", "operations", "accounting", "kitchen"];
const TEMPLATE_SEND_ROLES = ["owner", "operations"];           // قالب مدفوع بره النافذة: المالك والعمليات بس
const FILTERS = ["all", "waiting", "bot", "muted", "ad", "unread", "held", "mine"];      // held/mine: SR2 (waowner.js)
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
export const maskPhone = (pn) => `…${String(pn || "").slice(-4)}`;

/* ═══ IBX1a (١٧/١٠ — عمر: «بحث في المحادثات بالكلمات والرقم يتكتب عربي أو إنجليزي») ═══
   توحيد النص للبحث: الأرقام الهندية والفارسية ⇒ لاتيني، أ/إ/آ/ٱ ⇒ ا، ة ⇒ ه، ى ⇒ ي، من غير تشكيل. نفس التحويل بيتعمل على نص الرسالة
   في SQL (translate) عشان «٥٠١٢» تلاقي «5012» والعكس، و«مشاوى» تلاقي «مشاوي». */
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩", FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
export const SEARCH_TRANSLATE_FROM = `${AR_DIGITS}${FA_DIGITS}أإآٱةى`;
export const SEARCH_TRANSLATE_TO = "01234567890123456789ااااهي";
export const SEARCH_SQL_NORM = (col) => `translate(lower(${col}), '${SEARCH_TRANSLATE_FROM}', '${SEARCH_TRANSLATE_TO}')`;
/* حرف بحرف (من غير حذف) عشان مواضع المقتطف تفضل مطابقة للنص الأصلي، وعشان يطابق translate في SQL بالظبط */
export function normSearchText(s) {
  return String(s ?? "").toLowerCase()
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d))).replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");
}
/* نص البحث ⇒ { term (منظّف، ≤ ٦٠ حرف), latin (نفسه بأرقام لاتينية), digits, isPhone (كله أرقام/مسافات/+/-), words (≤ ٤) } */
export function searchTerms(q) {
  const term = String(q || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const latin = normSearchText(term);
  const digits = latin.replace(/\D/g, "");
  const isPhone = Boolean(digits) && digits === latin.replace(/[\s+\-()]/g, "");
  const words = isPhone ? [] : latin.split(" ").filter((w) => w.length >= 2).slice(0, 4);
  return { term, latin, digits, isPhone, words };
}
const likeEsc = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
/* مقتطف حوالين أول كلمة من البحث (±span حرف) — المقارنة على النص الموحّد، والقص على النص الأصلي (نفس الأطوال: التحويل حرف بحرف) */
export function snippetOf(body, words, span = 60) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const norm = normSearchText(text);
  let at = -1;
  for (const w of words || []) { const i = norm.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return text.length > span * 2 ? `${text.slice(0, span * 2)}…` : text;
  const s = Math.max(0, at - span), e = Math.min(text.length, at + span);
  return `${s > 0 ? "…" : ""}${text.slice(s, e)}${e < text.length ? "…" : ""}`;
}

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
  /* SW1: مراحل تحديثات الطلب (قوايم) بتتسجّل كنص */
  for (const k of ["whatsappStages", "whatsappReplacesSmsStages"]) if (Array.isArray((s.notifications || {})[k])) put(`notifications.${k}`, (s.notifications || {})[k].map(String).join(","));
  put("waMaster.enabled", (s.waMaster || {}).enabled === true);
  put("waCloud.enabled", (s.waCloud || {}).enabled === true);
  for (const k of ["dailyCap", "hourCap", "perTick", "tierLimit", "reserveUtility",
    /* QP1: حدود حماية الجودة — أي تغيير فيها بيتسجّل باسم اللي غيّره */
    "spendDaySar", "brakeMinSends", "brakeStopPct", "brakeFailPct", "brakeWarnPct", "lowReadPct", "lowReadHours", "lowReadMinDelivered", "custCap7d", "custCap30d", "allowUnknownQuality", "cappedFallbackSms", "qualityMaxAgeMin"]) put(`waCloud.${k}`, (s.waCloud || {})[k]);
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
  const staff = () => (typeof deps.staff === "function" ? deps.staff() : deps.staff) || null;      // wastaff.js: رد الموظف (لوحة + بورتال)
  const flow = () => { try { return (typeof deps.flow === "function" ? deps.flow() : deps.flow) || null; } catch { return null; } };      // ST2: waflow.js
  /* ST2: محادثات الفريق نفسه (تنبيهات، ضغطات، تجديد) مش محادثات عملاء: بتتشال من القوايم والعدّادات افتراضياً. الأرقام = دليل الفريق (أو أرقام التنبيهات لحد ما الدليل يتكتب). */
  const teamPhones = async () => { try { return teamConfig((await getSettingsData()) || {}).members.map((m) => m.phone); } catch { return []; } };
  const SALT = String(deps.keySalt || tokenSecret(process.env) || "");
  const keyOf = (pn) => crypto.createHash("md5").update(`${SALT}:${pn}`).digest("hex");
  const ready = pool.query(DDL).then(() => true).catch((e) => { log.error("[wa-hub] schema:", e.message); return false; });
  /* SW1: «تم» من اللوحة/البورتال بيتسجّل على المحادثة (استعلام لوحده: فشله مايأثّرش على جداول القسم) */
  ready.then(() => pool.query("ALTER TABLE IF EXISTS wa_threads ADD COLUMN IF NOT EXISTS handled_at TIMESTAMPTZ")).catch((e) => log.error("[wa-hub] handled_at:", e.message));
  async function markHandled(pn) {
    try { await pool.query("UPDATE wa_threads SET handled_at = NOW() WHERE phone_norm = $1", [pn]); } catch (e) { log.error("[wa-hub] handled:", e.message); }
  }

  const meOf = (u) => (u ? { id: u.username || u.id, name: u.name || u.username, role: u.role, via: "dashboard" } : null);      // SR2: حساب اللوحة
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
  /* حالة الإرسال للي بيسأل: القفل المقفول باسمه (نفس أقفال الحارس) — عشان خانة الرد تتقفل قبل ما الكاشير يكتب.
     gate: disabled (مفتاح الخادم) | unconfigured | settings_unreadable | master_off | settings_off | null = مفتوح */
  async function sendState() {
    let gate = "disabled";
    try { gate = wa && typeof wa.gate === "function" ? await wa.gate("session") : "disabled"; } catch { gate = "settings_unreadable"; }      // SW1: خانة الرد = رد حر
    return { ok: !gate, gate: gate || null };
  }
  const pauseMinNow = async () => { try { const cfg = await bot()?.botConfig?.(); return Number(cfg?.humanPauseMin) || 30; } catch { return 30; } };

  /* آخر رسالة في صف القايمة: من آخر صف متخزّن (lm_*) لو موجود، وإلا من صف المحادثة زي الأول.
     TK1a (١٦/١٠ — علامات ✓✓ زي واتساب في القايمة): lastStatus = حالة آخر رسالة لو مننا (accepted/sent/delivered/read/failed)، وإلا null. */
  const lastOf = (r) => {
    if (!r.lm_dir) return { lastText: r.last_text || "", lastDir: r.last_dir || null, lastSource: r.last_source || null, lastAt: iso(r.last_at), lastStatus: null };
    const at = r.lm_at && r.last_at ? new Date(Math.max(new Date(r.lm_at).getTime(), new Date(r.last_at).getTime())) : r.lm_at || r.last_at;
    return { lastText: String(r.lm_body || (r.lm_template ? `[قالب: ${r.lm_template}]` : r.last_text || "")).replace(/\s+/g, " ").trim().slice(0, 200), lastDir: r.lm_dir, lastSource: r.last_source || null, lastAt: iso(at),
      lastStatus: r.lm_dir === "out" ? r.lm_status || null : null };
  };

  /* ═══ N1: القايمة ═══ */
  const FROM = `
      FROM wa_threads t
      LEFT JOIN cms_contacts c ON c.phone_norm = t.phone_norm
      LEFT JOIN wa_contact_names n ON n.phone_norm = t.phone_norm AND NOT n.removed
      LEFT JOIN wa_bot_chats b ON b.phone_norm = t.phone_norm`;
  /* SW1 («مستنية رد» كانت تحويلات مفتوحة بس — صورة من عميل محدش رد عليها ماكانتش بتظهر):
     «محتاجة رد» = آخر رسالة متخزّنة للمحادثة من العميل (مش تاريخ مستورد)، النافذة لسه مفتوحة (ينفع نرد)، ومحدش علّم «تم» بعدها.
     آخر رسالة من أكبر id (نفس قاعدة LR1: last_dir في wa_threads ممكن يتأخر رسالة). handled_at بيتقري بـto_jsonb عشان الاستعلام
     مايقعش على قاعدة العمود لسه مااتضافش فيها.
     M1 (EX1): الرد الآلي من تطبيق واتساب بزنس (echo_kind='auto') **مش رد موظف** — فبيتشال من «آخر رسالة»: عميل كتب وجاله الرد الآلي بس لسه «محتاج رد».
     رد البوت والمساعد والموظف (من اللوحة/البورتال/الموبايل) بيتحسبوا رد. */
  const UNANSWERED = `(t.last_in_at > NOW() - INTERVAL '24 hours'
      AND (SELECT m.direction FROM wa_messages m WHERE m.phone_norm = t.phone_norm AND COALESCE(m.source, 'api') <> 'history' AND COALESCE(m.echo_kind,'staff') <> 'auto' ORDER BY m.id DESC LIMIT 1) = 'in'
      AND COALESCE((to_jsonb(t)->>'handled_at')::timestamptz < t.last_in_at, TRUE))`;
  const COND = {
    all: "TRUE",
    muted: "b.muted_until > NOW()",
    waiting: `NOT COALESCE(b.muted_until > NOW(), FALSE) AND (b.handoff_at IS NOT NULL OR ${UNANSWERED})`,
    bot: "b.handoff_at IS NULL AND NOT COALESCE(b.muted_until > NOW(), FALSE) AND t.last_in_at > NOW() - INTERVAL '24 hours'",
    ad: "b.referral IS NOT NULL",
    unread: "t.unread > 0",
    held: "b.muted_until > NOW()",      // SR2: مسحوبة (نفس عمود الكتم)
    mine: "b.muted_until > NOW()",      // + قايمة أرقام الحساب من waowner (تحت)
  };
  /* مراجعة RV1 — «تقييم واطي» للمدير بس (reviewaudience.js): بوابة الكاشير من غير الإعداد «الكاشير كمان يشوف التقييمات الواطية» (hideReviewLow):
       • المحادثة اللي تحويلها المفتوح «تقييم واطي» (جوّه مدة التحويل handoffOpenHours) مش في قايمته ولا عدّاداته ولا بتتفتح عنده.
       • «تقييم واطي» عمره ما بيدخّل محادثة «مستنية موظف» عنده (حتى بعد المدة)، وسببه مابيظهرش في حالة المحادثة.
     المدير والمالك واللوحة زي ما هم. أي تحويل تاني (طلب تعديل، شكوى، موظف) بيظهر للكاشير عادي. */
  const RV_IN = `(${REVIEW_HANDOVER_REASONS.map((r) => `'${r.replace(/'/g, "")}'`).join(",")})`;
  const hoHoursNow = async () => { try { const cfg = await bot()?.botConfig?.(); const h = Math.round(Number(cfg?.handoffOpenHours)); return h > 0 && h <= 168 ? h : 24; } catch { return 24; } };
  const reviewHiddenSql = (hours) => `COALESCE(b.handoff_reason IN ${RV_IN} AND b.handoff_at > NOW() - make_interval(hours => ${Math.round(Number(hours)) || 24}), FALSE)`;
  const WAITING_NO_REVIEW = `NOT COALESCE(b.muted_until > NOW(), FALSE) AND ((b.handoff_at IS NOT NULL AND NOT COALESCE(b.handoff_reason IN ${RV_IN}, FALSE)) OR ${UNANSWERED})`;
  const maskReview = (r) => (r && isReviewHandover(r.handoff_reason) ? { ...r, handoff_at: null, handoff_reason: null } : r);
  async function listThreads({ filter = "all", q = "", limit = 40, before = null, full = false, me = null, team = false, hideReviewLow = false } = {}) {
    const f = FILTERS.includes(filter) ? filter : "all";
    const lim = Math.min(Math.max(Number(limit) || 40, 1), 100);
    const term = String(q || "").trim().slice(0, 40);
    const digits = term.replace(/\D/g, "");
    const hideRv = hideReviewLow === true ? reviewHiddenSql(await hoHoursNow()) : null;
    const waitingCond = hideRv ? WAITING_NO_REVIEW : COND.waiting;
    const p = [], where = [f === "waiting" ? waitingCond : COND[f], ...(hideRv ? [`NOT ${hideRv}`] : [])];
    const tp = await teamPhones();
    if (tp.length) { p.push(tp); where.push(team === true ? `t.phone_norm = ANY($${p.length}::text[])` : `NOT (t.phone_norm = ANY($${p.length}::text[]))`); }
    else if (team === true) where.push("FALSE");
    /* SR2: مين ماسك — من waowner عن طريق wastaff. «محادثاتي» = أرقام الحساب ده بس. */
    const own = staff()?.owner || null;
    const minePhones = own && me ? await own.minePhones(me) : [];
    if (f === "mine") { p.push(minePhones); where.push(`t.phone_norm = ANY($${p.length}::text[])`); }
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
    /* ST2: «مستنية رد» مترتبة بالأقدم انتظاراً (وقت التحويل، وإلا آخر رسالة من العميل) — قايمة قصيرة: من غير صفحات. */
    const byWait = f === "waiting";
    if (byWait && b4) { pageWhere.pop(); p.pop(); }
    p.push(byWait ? 101 : lim + 1);
    const rows = (await pool.query(
      `SELECT t.phone_norm, t.last_in_at, t.last_at, t.last_text, t.last_dir, t.unread, t.order_no,
              COALESCE(c.name, n.full_name, n.profile_name) AS name, c.orders AS orders,
              b.muted_until, b.mute_reason, b.muted_by, b.handoff_at, b.handoff_reason, (b.referral IS NOT NULL) AS ad,
              ${UNANSWERED} AS unanswered,
              lm.source AS last_source, lm.direction AS lm_dir, lm.body AS lm_body, lm.template AS lm_template, lm.created_at AS lm_at, lm.status AS lm_status,
              (SELECT max(m.created_at) FROM wa_messages m WHERE m.phone_norm = t.phone_norm AND m.source = 'echo' AND COALESCE(m.echo_kind,'staff') <> 'auto') AS last_echo_at
       ${FROM}
       /* LR1 (عطل ١٣/١٠): آخر رسالة = آخر صف اتخزّن للمحادثة (أكبر id). wa_threads.last_text بيتحدّث بمقارنة أوقات بالثانية،
          فلما رسالتين يتخزّنوا في أقل من ثانية (رسالة العميل بوقت واتساب ورد البوت بوقت السيرفر) المعاينة كانت بتفضل على اللي قبلها. */
       LEFT JOIN LATERAL (SELECT m.source, m.direction, m.body, m.template, m.created_at, m.status FROM wa_messages m
                           WHERE m.phone_norm = t.phone_norm AND COALESCE(m.source, 'api') <> 'history' ORDER BY m.id DESC LIMIT 1) lm ON TRUE
       WHERE ${pageWhere.join(" AND ")}
       ORDER BY ${byWait ? "COALESCE(b.handoff_at, t.last_in_at) ASC NULLS LAST, t.last_at DESC" : "t.last_at DESC"} LIMIT $${p.length}`, p)).rows || [];
    const cntWhere = [...(tp.length ? ["NOT (t.phone_norm = ANY($1::text[]))"] : []), ...(hideRv ? [`NOT ${hideRv}`] : [])];
    const cnt = (await pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${waitingCond})::int AS waiting, count(*) FILTER (WHERE ${COND.bot})::int AS bot,
              count(*) FILTER (WHERE ${COND.muted})::int AS muted, count(*) FILTER (WHERE ${COND.ad})::int AS ad,
              count(*) FILTER (WHERE ${COND.unread})::int AS unread, COALESCE(sum(t.unread), 0)::int AS unread_messages,
              min(COALESCE(b.handoff_at, t.last_in_at)) FILTER (WHERE ${waitingCond}) AS oldest_waiting
       ${FROM}${cntWhere.length ? ` WHERE ${cntWhere.join(" AND ")}` : ""}`, tp.length ? [tp] : [])).rows[0] || {};
    const t0 = now(), pauseMin = await pauseMinNow();
    const page = rows.slice(0, byWait ? 100 : lim).map((r) => (hideRv ? maskReview(r) : r));
    const owners = own ? await own.ownersFor(page, me) : new Map();
    const fl = flow(), flows = fl && team !== true ? await fl.flowsFor(page.map((r) => r.phone_norm), owners, me, new Map(page.map((r) => [r.phone_norm, { lastInAt: r.last_in_at, unanswered: r.unanswered === true }]))) : new Map();
    const transferred = fl && typeof fl.transferredCount === "function" ? await fl.transferredCount().catch(() => 0) : 0;
    return {
      ok: true, filter: f, team: team === true,
      counts: { all: cnt.total || 0, waiting: cnt.waiting || 0, bot: cnt.bot || 0, muted: cnt.muted || 0, ad: cnt.ad || 0, unread: cnt.unread || 0,
        held: cnt.muted || 0, mine: minePhones.length, transferred,
        unreadMessages: cnt.unread_messages || 0, oldestWaitingAt: iso(cnt.oldest_waiting) },
      threads: page.map((r) => ({
        key: keyOf(r.phone_norm), phone: full ? `0${r.phone_norm}` : maskPhone(r.phone_norm), phoneMasked: maskPhone(r.phone_norm),
        name: r.name || null, orders: Number(r.orders) || 0, orderNo: r.order_no || null,
        ...lastOf(r),
        unread: Number(r.unread) || 0, window: windowState(iso(r.last_in_at), t0), bot: botState(r, { now: t0, pauseMin }), ad: r.ad === true,
        owner: owners.get(r.phone_norm) || null,
        team: team === true, flow: flows.get(r.phone_norm) || null,      // ST2: الحالة والفعل الأساسي الواحد (waflow.flowOf)
        /* SW1: آخر رسالة من العميل ومحدش رد ولا علّم «تم» (والنافذة مفتوحة) — ده اللي بيدخّلها «مستنية رد» من غير تحويل */
        unanswered: r.unanswered === true,      // نفس شرط الفلتر بالظبط (محسوب في الاستعلام)
      })),
      nextBefore: !byWait && rows.length > lim ? iso(page[page.length - 1].last_at) : null,
    };
  }

  /* ═══ N1: المحادثة ═══ */
  /* TK1a: الرسالة اللي فشلت ⇒ السبب بالعربي من كود ميتا («131047:Re-engagement message» ⇒ «نافذة الـ٢٤ ساعة مقفولة»).
     الشاشة بتعرضه لما الموظف يدوس على ⚠. من غير كود (شبكة/مهلة) أو رسالة مافشلتش ⇒ null (الشاشة بتقول «ماوصلتش» من غير سبب). */
  const errorArOf = (m) => {
    if (!m || m.status !== "failed" || !m.error) return null;
    const code = /^\s*(\d{1,7})(?!\d)/.exec(String(m.error));
    return code ? reasonText(classifyError(Number(code[1])).reason) : null;
  };
  async function getThread(pn, { limit = 80, before = null, full = false, me = null, hideReviewLow = false } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 80, 1), 200);
    let head = (await pool.query(
      `SELECT t.phone_norm, t.last_in_at, t.last_at, t.unread, t.order_no, COALESCE(c.name, n.full_name, n.profile_name) AS name, c.orders AS orders,
              b.muted_until, b.mute_reason, b.muted_by, b.handoff_at, b.handoff_reason, (b.referral IS NOT NULL) AS ad,
              (SELECT max(m.created_at) FROM wa_messages m WHERE m.phone_norm = t.phone_norm AND m.source = 'echo' AND COALESCE(m.echo_kind,'staff') <> 'auto') AS last_echo_at,
              o.updates AS optin_updates, o.marketing AS optin_marketing, o.stopped_at
       ${FROM} LEFT JOIN wa_optins o ON o.phone_norm = t.phone_norm
       WHERE t.phone_norm = $1`, [pn])).rows[0];
    if (!head) return { ok: false, error: "not_found" };
    /* مراجعة RV1: بوابة الكاشير من غير الإعداد — «تقييم واطي» مفتوح على المحادثة ⇒ مش عنده (نفس رد «مش موجودة»)؛ بعد المدة ⇒ من غير سببه */
    if (hideReviewLow === true && isReviewHandover(head.handoff_reason)) {
      const at = head.handoff_at ? new Date(head.handoff_at).getTime() : NaN;
      if (Number.isFinite(at) && now() - at < (await hoHoursNow()) * 3600_000) return { ok: false, error: "not_found" };
      head = maskReview(head);
    }
    const b4 = before && Number.isFinite(Date.parse(before)) ? new Date(before).toISOString() : null;
    const msgs = (await pool.query(
      `SELECT wamid, direction, status, error, body, template, category, order_no, created_at, source, pricing, id, media
         FROM wa_messages WHERE phone_norm = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
        ORDER BY created_at DESC LIMIT $3`, [pn, b4, lim + 1])).rows || [];
    const page = msgs.slice(0, lim).reverse();
    const from = page.length ? iso(page[0].created_at) : null;
    /* CR2 (١٦/١٠): «رسالة اتمسحت» — المرجع محفوظ في pricing.revoke.original وقت الوصول. صف لسه نصه «[رسالة اتمسحت]» (الـrevoke وصل قبل الرسالة نفسها:
       ميتا مابتضمنش الترتيب) ⇒ نصه يتحل هنا من نسختنا. والرسالة الأصلية بتاخد revoked:true (نسختها زي ما هي، عمرها ما بتتمسح). */
    const revRefs = new Map();
    for (const m of page) { const ref = m.pricing && typeof m.pricing === "object" && m.pricing.revoke && m.pricing.revoke.original; if (ref) revRefs.set(String(ref), m); }
    const revBodies = new Map();
    const unresolved = [...revRefs].filter(([, m]) => String(m.body || "").trim() === REVOKE_PLAIN).map(([ref]) => ref);
    if (unresolved.length) { try { for (const r of (await pool.query("SELECT wamid, body FROM wa_messages WHERE wamid = ANY($1::text[]) AND phone_norm = $2", [unresolved, pn])).rows || []) revBodies.set(String(r.wamid), r.body); } catch { /* النص يفضل «رسالة اتمسحت» */ } }
    const revokeRef = (m) => (m.pricing && typeof m.pricing === "object" && m.pricing.revoke && m.pricing.revoke.original ? String(m.pricing.revoke.original) : null);
    /* M1: أنهي صدى في الصفحة دي «آلي» (رد من تطبيق واتساب بزنس مش موظف) — للشارة «آلي» في الشاشات. أي خطأ ⇒ من غير شارة. */
    let autoIds = new Set();
    try { const ids = page.filter((m) => m.source === "echo").map((m) => m.id); if (ids.length) { const ar = await pool.query("SELECT id FROM wa_messages WHERE id = ANY($1::bigint[]) AND echo_kind = 'auto'", [ids]); autoIds = new Set(((ar && ar.rows) || []).map((r) => String(r.id))); } } catch { autoIds = new Set(); }
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
    const own = staff()?.owner || null;
    const owner = own ? (await own.ownersFor([head], me)).get(pn) || null : null;      // SR2
    const isTeam = (await teamPhones()).includes(pn);
    const lastReal = [...msgs].filter((m) => (m.source || "api") !== "history").sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).pop() || null;
    const pending = Boolean(lastReal && lastReal.direction === "in" && head.last_in_at && Date.now() - new Date(head.last_in_at).getTime() < 24 * 3600_000);
    const fl = flow(), flowObj = fl && !isTeam ? await fl.flowFor(pn, me, owner, { lastInAt: head.last_in_at, unanswered: pending }).catch(() => null) : null;      // ST2
    const events = botRows.filter((r) => r.handoff && !(hideReviewLow === true && isReviewHandover(String(r.handoff).split(":")[0]))).map((r) => ({ at: iso(r.at), kind: "handover", reason: String(r.handoff).split(":")[0] }));
    if (state.state === "muted") events.push({ at: null, kind: "mute", until: state.mutedUntil, by: state.mutedBy, reason: state.reason });
    return {
      ok: true, key: keyOf(pn), phone: full ? `0${pn}` : maskPhone(pn), phoneMasked: maskPhone(pn),
      name: head.name || null, orders: Number(head.orders) || 0, orderNo: head.order_no || null, unread: Number(head.unread) || 0,
      optIn: { updates: head.optin_updates === true, marketing: head.optin_marketing === true, stopped: Boolean(head.stopped_at) },
      window: windowState(iso(head.last_in_at), t0), bot: state, ad: head.ad === true, owner, team: isTeam, flow: flowObj,
      messages: page.map((m) => {
        const d = m.direction === "in" && m.wamid ? byWamid.get(m.wamid) : null;
        const pr = m.pricing && typeof m.pricing === "object" && "billable" in m.pricing ? { billable: m.pricing.billable === true, category: m.pricing.category || null } : null;
        const rref = revokeRef(m), rtext = rref && revBodies.has(rref) ? revokeText({ body: revBodies.get(rref), echo: m.source === "echo" }) : null;      // CR2
        return { id: m.wamid || `${m.direction}:${iso(m.created_at)}`, mid: Number(m.id) || null, dir: m.direction, text: rtext || m.body || (m.template ? `[قالب: ${m.template}]` : ""),      // IBX1a: mid = رقم الصف (رابط «افتح الرسالة» من البحث وملف العميل)
          ...(rref ? { revokeOf: rref } : {}), ...(m.wamid && revRefs.has(String(m.wamid)) ? { revoked: true } : {}),      // CR2: صف المسح بيشاور على الأصل، والأصل عليه علامة «اتمسحت»
          template: m.template || null, category: m.category || null, status: m.status || null, error: m.error || null, errorAr: errorArOf(m), orderNo: m.order_no || null,
          source: m.source || "api", ...(m.source === "echo" ? { echoKind: autoIds.has(String(m.id)) ? "auto" : "staff" } : {}), at: iso(m.created_at), cost: pr, media: publicMedia(m),      // MD1: ملف الرسالة (من غير رقم ميتا)
          bot: d ? { decision: d.decision || null, replyKey: d.reply_key || null, reason: d.reason || null } : null };
      }),
      events,
      nextBefore: msgs.length > lim ? iso(page[0].created_at) : null,
    };
  }

  /* ═══ LR1: «فيه جديد؟» — قراءة خفيفة للتحديث التلقائي ═══
     استعلام واحد صغير بيرجّع «بصمة» للقايمة وبصمة للمحادثة المفتوحة. الشاشة بتسأل كل كام ثانية، ولما البصمة تتغيّر
     بتجيب القايمة/المحادثة الكاملة. البصمة بتتغيّر مع: رسالة جديدة (وارد/صادر)، تغيّر حالة رسالة (وصلت/اتقرت)، قراءة،
     سحب/ترك/قفل، تحويل لموظف أو كتم. مفيهاش أي محتوى ولا أرقام.
     الحاجة الوحيدة اللي بتتغيّر بالوقت من غير صف بيتعدّل (مهلة السحب خلصت، النافذة قفلت) مش في البصمة — الشاشة بتعيد
     التحميل الكامل كل دقيقة احتياطي. */
  async function tick(pn = null, { hideReviewLow = false } = {}) {
    const tp = await teamPhones();
    /* مراجعة RV1: بوابة الكاشير من غير الإعداد ⇒ محادثة «تقييم واطي» مفتوح مش في عدّاداته (مستني موظف / الجديد / البصمة) */
    const hideRv = hideReviewLow === true ? reviewHiddenSql(await hoHoursNow()) : null;
    const xw = [...(tp.length ? ["NOT (phone_norm = ANY($2::text[]))"] : []), ...(hideRv ? [`NOT EXISTS (SELECT 1 FROM wa_bot_chats b WHERE b.phone_norm = wa_threads.phone_norm AND ${hideRv})`] : [])];
    const X = xw.length ? ` WHERE ${xw.join(" AND ")}` : "", XT = `${tp.length ? " AND NOT (t.phone_norm = ANY($2::text[]))" : ""}${hideRv ? ` AND NOT ${hideRv}` : ""}`;
    const waitingCond = hideRv ? WAITING_NO_REVIEW : COND.waiting;
    const r = (await pool.query(
      `SELECT (SELECT count(*) FROM wa_threads${X})::int AS n,
              (SELECT COALESCE(sum(unread), 0) FROM wa_threads${X})::int AS u,
              (SELECT (extract(epoch FROM max(GREATEST(last_at, COALESCE(read_at, last_at)))) * 1000)::bigint FROM wa_threads${X}) AS tl,
              (SELECT (extract(epoch FROM max(updated_at)) * 1000)::bigint FROM wa_bot_chats) AS tb,
              (SELECT count(*) FROM wa_threads t LEFT JOIN wa_bot_chats b ON b.phone_norm = t.phone_norm WHERE ${waitingCond}${XT})::int AS w,
              (SELECT count(*) FROM wa_bot_chats WHERE muted_until > NOW())::int AS h,
              (SELECT min(COALESCE(b.handoff_at, t.last_in_at)) FROM wa_threads t LEFT JOIN wa_bot_chats b ON b.phone_norm = t.phone_norm WHERE ${waitingCond}${XT}) AS ow,
              (SELECT (extract(epoch FROM max(GREATEST(created_at, updated_at))) * 1000)::bigint FROM wa_messages WHERE phone_norm = $1) AS tm,
              (SELECT count(*) FROM wa_messages WHERE phone_norm = $1)::int AS cm,
              (SELECT (extract(epoch FROM updated_at) * 1000)::bigint FROM wa_bot_chats WHERE phone_norm = $1) AS tc`, tp.length ? [pn, tp] : [pn])).rows[0] || {};
    const fl = flow(), transferred = fl && typeof fl.transferredCount === "function" ? await fl.transferredCount().catch(() => 0) : 0;
    const list = [r.n || 0, r.u || 0, r.tl || 0, r.tb || 0, r.w || 0, r.h || 0, ...(fl ? [transferred] : [])].join(".");
    return { ok: true, list, chat: pn ? [r.cm || 0, r.tm || 0, r.tc || 0, r.h || 0].join(".") : null, waiting: r.w || 0, unread: r.u || 0, oldestWaitingAt: iso(r.ow), transferred };
  }
  app.get("/api/cms/wa/threads-tick", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    try {
      const k = c.req.query("chat");
      const pn = k ? await phoneOfKey(k, a.full) : null;
      return c.json(await tick(pn));
    } catch (e) { log.error("[wa-hub] tick:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
  });

  app.get("/api/cms/wa/threads", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    await ready;
    try {
      const out = await listThreads({ filter: c.req.query("filter") || c.req.query("f") || "all", q: c.req.query("q") || "", limit: c.req.query("limit"),
        before: c.req.query("before") || null, full: a.full, me: meOf(a.user), team: c.req.query("team") === "1" && a.user.role === "owner" });
      return c.json({ ...out, send: await sendState() });
    } catch (e) { log.error("[wa-hub] threads:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
  });
  app.get("/api/cms/wa/threads/:key", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const pn = await phoneOfKey(c.req.param("key"), a.full);
    if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
    try {
      const r = await getThread(pn, { limit: c.req.query("limit"), before: c.req.query("before") || null, full: a.full, me: meOf(a.user) });
      if (!r.ok) return c.json(r, 404);
      /* للمحادثة نفسها: قفل القناة أولاً، وبعده النافذة (نص حر بره الـ٢٤ ساعة مرفوض — القالب للمالك والعمليات) */
      /* wastaff: حالة الرد للمحادثة دي بالظبط (رقم تجربة والقناة مقفولة = مفتوح للتجربة؛ العميل وقّف الرسايل = مقفول) + مين رد من اللوحة/البورتال */
      /* SX1: البوت ساكت على الرقم ده ليه (never_list / alert_phone / staff / courier / staff_list) — رأس المحادثة بيقول «رقم موظف — البوت ساكت» */
      let neverReplyWhy = null; try { const bt = bot(); if (bt && typeof bt.neverReplyOf === "function") neverReplyWhy = (await bt.neverReplyOf(pn)) || null; } catch { neverReplyWhy = null; }
      const sf = staff();
      if (sf) { await sf.annotate(r.messages); return c.json({ ...r, neverReplyWhy, send: await sf.sendStateFor(pn) }); }
      const st = await sendState();
      return c.json({ ...r, neverReplyWhy, send: st.ok && !r.window.open ? { ok: false, gate: "window_closed" } : st });
    } catch (e) { log.error("[wa-hub] thread:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
  });
  /* ═══ IBX1a: البحث في المحادثات — بالاسم/الرقم (نفس شروط القايمة) + في نص الرسايل (مقتطف + مفتاح المحادثة ورقم الرسالة ⇒ «افتح الرسالة») ═══
     GET /api/cms/wa/search?q=&limit=&before=<mid>[&team=1]
       ⇒ { ok, q, isPhone, threads: [صفوف زي القايمة], hits: [{ key, name, phone, phoneMasked, mid, id, dir, source, template, at, snippet }], nextBefore }
     الأرقام الهندية/الفارسية/اللاتينية واحد، وجزء من الرقم كفاية؛ الدور اللي الرقم مخفي عنده بيدوّر بآخر ٤ أرقام بس (زي القايمة).
     كلمتين فأكتر = لازم يكونوا كلهم في الرسالة. أرقام الفريق بره إلا للمالك بـteam=1. التاريخ المستورد مش بيتدوّر فيه. */
  async function searchMessages({ q, limit = 30, before = null, full = false, team = false } = {}) {
    const st = searchTerms(q);
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
    if (!st.latin || (st.isPhone ? st.digits.length < 3 : st.words.length === 0)) return { ok: true, q: st.term, hits: [], nextBefore: null, terms: st };
    const needles = st.isPhone ? [st.digits] : st.words;
    const p = [], where = ["m.body IS NOT NULL", "COALESCE(m.source, 'api') <> 'history'"];
    for (const w of needles) { p.push(`%${likeEsc(w)}%`); where.push(`${SEARCH_SQL_NORM("m.body")} LIKE $${p.length} ESCAPE '\\'`); }
    const tp = await teamPhones();
    if (tp.length) { p.push(tp); where.push(team === true ? `m.phone_norm = ANY($${p.length}::text[])` : `NOT (m.phone_norm = ANY($${p.length}::text[]))`); }
    else if (team === true) where.push("FALSE");
    const b4 = Math.floor(Number(before));
    if (Number.isFinite(b4) && b4 > 0) { p.push(b4); where.push(`m.id < $${p.length}`); }
    p.push(lim + 1);
    const rows = (await pool.query(
      `SELECT m.id, m.wamid, m.direction, m.body, m.created_at, m.source, m.template, m.phone_norm, COALESCE(c.name, n.full_name, n.profile_name) AS name
         FROM wa_messages m
         JOIN wa_threads t ON t.phone_norm = m.phone_norm
         LEFT JOIN cms_contacts c ON c.phone_norm = m.phone_norm
         LEFT JOIN wa_contact_names n ON n.phone_norm = m.phone_norm AND NOT n.removed
        WHERE ${where.join(" AND ")}
        ORDER BY m.id DESC LIMIT $${p.length}`, p)).rows || [];
    const page = rows.slice(0, lim);
    return { ok: true, q: st.term, terms: st,
      hits: page.map((m) => ({ key: keyOf(m.phone_norm), name: m.name || null, phone: full ? `0${m.phone_norm}` : maskPhone(m.phone_norm), phoneMasked: maskPhone(m.phone_norm),
        mid: Number(m.id), id: m.wamid || `${m.direction}:${iso(m.created_at)}`, dir: m.direction, source: m.source || "api", template: m.template || null, at: iso(m.created_at),
        snippet: snippetOf(m.body, needles) })),
      nextBefore: rows.length > lim ? Number(page[page.length - 1].id) : null };
  }
  app.get("/api/cms/wa/search", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    await ready;
    try {
      const q = String(c.req.query("q") || "");
      const team = c.req.query("team") === "1" && a.user.role === "owner";
      const st = searchTerms(q);
      const [list, msgs] = await Promise.all([
        st.term && (st.isPhone ? st.digits.length >= 3 : st.term.length >= 2)
          ? listThreads({ filter: "all", q: st.isPhone ? st.digits : st.term, limit: 20, full: a.full, me: meOf(a.user), team }) : { threads: [] },
        searchMessages({ q, limit: c.req.query("limit"), before: c.req.query("before") || null, full: a.full, team }),
      ]);
      return c.json({ ok: true, q: st.term, isPhone: st.isPhone, threads: list.threads || [], hits: msgs.hits, nextBefore: msgs.nextBefore });
    } catch (e) { log.error("[wa-hub] search:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
  });
  app.post("/api/cms/wa/threads/:key/read", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const pn = await phoneOfKey(c.req.param("key"), a.full);
    if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
    await pool.query("UPDATE wa_threads SET unread=0, read_at=NOW(), read_by=$2, updated_at=NOW() WHERE phone_norm=$1", [pn, clip(a.user.name || a.user.role, 60)]);
    staff()?.chatUpdate?.(pn, "read");      // LR1: البورتال يعرف إن المحادثة اتقرت من اللوحة
    return c.json({ ok: true });
  });
  /* MD1: ملف الرسالة (صورة / صوت / فيديو / ملف) — نفس صلاحية المحادثة، والرسالة لازم تكون من نفس المحادثة */
  app.get("/api/cms/wa/threads/:key/media/:ref", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const pn = await phoneOfKey(c.req.param("key"), a.full);
    if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
    const md = staff()?.media || null;
    if (!md) return c.json({ ok: false, error: "unavailable" }, 503);
    return md.serve(c, { phoneNorm: pn, ref: c.req.param("ref"), as: c.req.query("as") || null });
  });
  /* SR2: سحب المحادثة / سيبها للبوت / خلصت — نفس دوال البورتال (waowner.js)؛ المالك والعمليات يقدروا ياخدوا محادثة حد تاني (force) */
  for (const fn of ["take", "release", "done"]) {
    app.post(`/api/cms/wa/threads/:key/${fn}`, async (c) => {
      const a = await access(c); if (a.res) return a.res;
      const pn = await phoneOfKey(c.req.param("key"), a.full);
      if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
      const own = staff()?.owner || null;
      if (!own) return c.json({ ok: false, error: "unavailable" }, 503);
      let b = {}; try { b = await c.req.json(); } catch { b = {}; }
      try {
        /* ST2: نفس الأفعال من waflow — «خلصت — اقفل» بنتيجة { outcome, note }، وكل رد معاه flow */
        const fl = flow();
        if (fl) {
          const r = fn === "done" ? await fl.close(pn, meOf(a.user), { outcome: b && b.outcome, note: b && b.note }) : fn === "take" ? await fl.take(pn, meOf(a.user), { force: b && b.force === true }) : await fl.release(pn, meOf(a.user));
          if (!r.ok) return c.json({ ok: false, error: r.error, owner: r.owner || undefined, message: r.message, outcomes: r.outcomes }, r.status || 409);
          return c.json({ ok: true, owner: r.owner, flow: r.flow });
        }
        const r = await own[fn](pn, meOf(a.user), { force: b && b.force === true });
        if (!r.ok) return c.json({ ok: false, error: r.error, owner: r.owner || undefined, message: r.message }, r.status || 409);
        if (fn === "done") await markHandled(pn);
        return c.json({ ok: true, owner: r.owner });
      } catch (e) { log.error(`[wa-hub] ${fn}:`, e.message); return c.json({ ok: false, error: "unavailable" }, 503); }
    });
  }
  /* «تم التعامل»: بيشيل التحويل المفتوح والكتم — نفس دالة البوت (مابنكتبش في جداوله) */
  app.post("/api/cms/wa/threads/:key/handled", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const pn = await phoneOfKey(c.req.param("key"), a.full);
    if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
    const b = bot();
    if (!b || typeof b.unmuteChat !== "function") return c.json({ ok: false, error: "bot_unavailable" }, 503);
    await b.unmuteChat(pn, { release: true });      // PS5: «تم التعامل» = سيبها للبوت فوراً (released_at) — رد الموظف اللي قبلها مايسكّتش البوت
    await markHandled(pn);
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
    /* wastaff.reply: نفس الحارس، + يتسجّل كرد موظف (البوت يسكت ويرجع لوحده) + مين رد + رقم التجربة في وضع التجربة */
    const sf = staff();
    if (sf) {
      const x = await sf.reply({ phoneNorm: pn, text: b.text, by: a.user.name || a.user.role, role: a.user.role, via: "dashboard" });
      if (x.ok) return c.json({ ok: true, wamid: x.wamid, test: x.test, send: await sf.sendStateFor(pn), ...(sf.owner ? { owner: await sf.owner.ownerFor(pn, meOf(a.user)).catch(() => null) } : {}) });
      return c.json({ ok: false, error: x.error, gate: x.gate || null, message: x.message || undefined }, ["empty", "too_long", "bad_phone"].includes(x.error) ? 400 : 409);
    }
    const ib = inbox();
    if (!ib) return c.json({ ok: false, error: "inbox_unavailable" }, 503);
    const r = await ib.replyText({ phoneNorm: pn, text: b.text, by: a.user.name || a.user.role });
    return r.ok ? c.json({ ok: true, wamid: r.wamid || null, window: r.window || null }) : c.json(refusal(r), ["empty", "too_long", "bad_phone"].includes(r.error) ? 400 : 409);
  });
  /* MD3 (١٦/١٠): صورة / ملف / رسالة صوتية من اللوحة — نفس صلاحية الرد ونفس أقفاله (wastaffmedia.js من خلال wastaff)، جوّه النافذة بس.
     multipart {file, caption?, voice?}. المسار تحت ‎/api/cms/wa/threads…‎ عشان ياخد نفس قسم الصلاحيات بتاع الرد. */
  app.post("/api/cms/wa/threads/:key/media", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const pn = await phoneOfKey(c.req.param("key"), a.full);
    if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
    const sf = staff();
    if (!sf || typeof sf.sendMedia !== "function") return c.json({ ok: false, error: "unavailable", message: "إرسال الملفات مش متاح على السيرفر ده" }, 503);
    const u = await readUpload(c);
    if (!u.ok) return c.json({ ok: false, error: u.error, message: u.message }, u.status);
    const x = await sf.sendMedia({ phoneNorm: pn, file: u.file, caption: u.caption, voice: u.voice, by: a.user.name || a.user.role, role: a.user.role, via: "dashboard" });
    if (!x.ok) return c.json({ ok: false, error: x.error, gate: x.gate || null, message: x.message || undefined }, x.status || 409);
    return c.json({ ok: true, wamid: x.wamid, test: x.test, kind: x.kind, converted: x.converted, send: await sf.sendStateFor(pn), ...(sf.owner ? { owner: await sf.owner.ownerFor(pn, meOf(a.user)).catch(() => null) } : {}) });
  });
  app.get("/api/cms/wa/threads-media-caps", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const sf = staff();
    if (!sf || typeof sf.mediaCaps !== "function") return c.json({ ok: false, error: "unavailable" }, 503);
    return c.json(await sf.mediaCaps());
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

  return { ready, listThreads, getThread, searchMessages, templatesView, sweep, sweepFor, masterCounts, keyOf, tick, markHandled };
}
