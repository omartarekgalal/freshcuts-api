/* ═══════════════════════════════════════════════════════════════════════════
   رد الموظف على محادثة واتساب — من اللوحة ومن البورتال (wastaff.js)

   طلب عمر (١٣/١٠): «هل نقدر نرد منه؟… هل ينفع المحادثة تفتح في البورتال ويرد بسرعة… ومجرد ما يرد ترجع تاني للبوت»
   و«عايز اتاكد ان الكاشير والمدير يقدروا يردوا ولا لازم من الموبايل؟».

   الإرسال: نص حر بس، جوّه نافذة الـ٢٤ ساعة بس، ومن الباب الوحيد: wa.sendFreeform ⇒ wa.guardSend ⇒ wa.deliver.
   مفيش نداء Graph هنا ولا تذكرة بتتعمل هنا. الأقفال هي أقفال الحارس بالاسم (disabled / unconfigured /
   settings_unreadable / master_off / settings_off / window_closed) + قفل واحد زيادة هنا: opted_out (العميل كتب «إيقاف»).
   وضع التجربة: لو القناة مقفولة والرقم في قايمة أرقام التجربة ⇒ الرد بيعدّي من باب التجربة بتاع الحارس (نفس شرط النافذة).
   أي رقم تاني والقناة مقفولة ⇒ مرفوض باسم القفل.

   «الموظف رد» عند البوت = صف صادر source='echo' في wa_messages — دي الإشارة الوحيدة اللي البوت والمساعد بيقروها
   (سكوت البوت، إلغاء الرد المؤجّل، قفل التحويل العادي). فالرد من هنا بيتسجّل بنفس المصدر: نفس أثر رد الكاشير من
   موبايل المطعم بالظبط، والبوت يرجع لوحده بنفس مُهَله. مفيش حالة جديدة ولا كتابة في جداول البوت.
   مين اللي رد ومنين (لوحة/بورتال) في جدول الملف ده: wa_staff_replies (wamid ← الاسم، الدور، المصدر).

   المسارات:
     البورتال (PIN — كاشير أو مدير؛ حساب المطبخ مرفوض من requirePortal):
       GET  /api/portal/wa/chats?filter=waiting|unread|all|bot|muted|ad&q=&limit=&before=
       GET  /api/portal/wa/chats/:key?limit=&before=
       POST /api/portal/wa/chats/:key/reply   {text}
       POST /api/portal/wa/chats/:key/read
       GET  /api/portal/wa/quick-replies
       GET  /api/portal/wa/chats/:key/media/:ref[?as=mp3]      (MD1 — wamedia.js: صورة / صوت / فيديو / ملف الرسالة)
       POST /api/portal/wa/chats/:key/take {force?} · /release · /done      (SR2 — waowner.js: مين ماسك المحادثة)
     اللوحة: GET /api/cms/wa/threads-quick (الردود السريعة)، والرد نفسه على مسار wahub الموجود
       POST /api/cms/wa/threads/:key/reply — بيتحوّل هنا (reply) لما الملف ده متسجّل.
   القراءة بتشتغل والإرسال مقفول (من دوال wahub، مش من صندوق البورتال القديم اللي بيرجّع disabled).
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import { tokenSecret } from "./portal-core.js";
import { FAQ_DEFS } from "./wabotrun.js";
import * as waowner from "./waowner.js";
import * as wamedia from "./wamedia.js";

export const MAX_TEXT = 4096;
export const GATES = Object.freeze(["disabled", "unconfigured", "settings_unreadable", "master_off", "settings_off", "window_closed", "opted_out", "not_in_allow_list"]);
export const GATE_AR = Object.freeze({
  disabled: "الإرسال من السيرفر مش متفعّل", unconfigured: "رقم واتساب أو التوكن مش متظبطين", settings_unreadable: "السيرفر مش قادر يقرا الإعدادات — مقفول احتياطي",
  master_off: "مفتاح المالك «الإرسال للعملاء» مقفول", settings_off: "مفتاح «واتساب» في إشعارات العميل مقفول",
  window_closed: "نافذة الـ٢٤ ساعة قفلت — العميل لازم يكتب الأول", opted_out: "العميل طلب إيقاف الرسايل", not_in_allow_list: "وضع التجربة: الرقم مش في أرقام التجربة",
});
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const normPhone = (raw) => { const d = String(raw || "").replace(/\D/g, "").replace(/^(00966|966)/, "").replace(/^0/, ""); return /^5\d{8}$/.test(d) ? d : ""; };

const DDL = `CREATE TABLE IF NOT EXISTS wa_staff_replies (
  id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), phone_norm TEXT NOT NULL, wamid TEXT UNIQUE,
  by_name TEXT, role TEXT, via TEXT NOT NULL, test BOOLEAN NOT NULL DEFAULT false, chars INT);
CREATE INDEX IF NOT EXISTS wa_staff_replies_phone_at ON wa_staff_replies (phone_norm, at DESC)`;

/* نص الرد: مقصوص من الأطراف، ١..٤٠٩٦ حرف */
export function cleanText(raw) {
  const body = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) return { ok: false, error: "empty" };
  if (body.length > MAX_TEXT) return { ok: false, error: "too_long" };
  return { ok: true, body };
}
/* الردود السريعة = إجابات الأسئلة الشائعة اللي المالك كتبها للبوت (settings.waBot.faq) — العربي أولاً. الفاضية مش بتتعرض. */
export function quickReplies(settings, defs = {}) {
  const faq = (settings && settings.waBot && settings.waBot.faq) || {};
  const out = [];
  for (const [key, v] of Object.entries(faq)) {
    const ar = String((v && v.ar) || "").trim(), en = String((v && v.en) || "").trim();
    if (!ar && !en) continue;
    out.push({ key, title: clip((defs[key] && defs[key].q) || key, 80), text: ar || en, textEn: en || null });
  }
  return out;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const log = deps.log || console;
  const wa = deps.wa || null;
  const hub = () => (typeof deps.hub === "function" ? deps.hub() : deps.hub) || null;
  const requirePortal = deps.requirePortal || null;
  const SALT = String(deps.keySalt || tokenSecret(process.env) || "");
  const ready = pool.query(DDL).then(() => true).catch((e) => { log.error("[wa-staff] schema:", e.message); return false; });
  /* SR2: مين ماسك المحادثة (سحب / سيبها للبوت / خلصت) — المنطق كله في waowner.js */
  const keyOf = (pn) => crypto.createHash("md5").update(`${SALT}:${pn}`).digest("hex");
  /* MD1: ملفات الرسايل (صور / صوت / فيديو) — بتتجاب من ميتا بتوكن السيرفر وبتتخزن خاص */
  const media = wamedia.create({ pool, wa, getSettingsData, log, transcode: deps.transcode, noTimer: deps.noTimer });
  const owner = waowner.create({ pool, getSettingsData, bot: deps.bot, keyOf, broadcast: deps.broadcast, log, noTimer: deps.noTimer, now: deps.now });

  async function phoneOfKey(raw) {
    const k = String(raw || "").trim();
    if (/^[0-9a-f]{32}$/.test(k)) {
      if (!SALT) return null;
      const r = await pool.query("SELECT phone_norm FROM wa_threads WHERE md5($1 || ':' || phone_norm) = $2 LIMIT 1", [SALT, k]);
      return r.rows[0]?.phone_norm || null;
    }
    return normPhone(k) || null;
  }
  const isStopped = async (pn) => {
    const r = await pool.query("SELECT stopped_at FROM wa_optins WHERE phone_norm=$1", [pn]);
    return Boolean(r.rows[0] && r.rows[0].stopped_at);
  };
  const windowOpen = async (pn) => {
    const r = await pool.query(`SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND direction='in' AND COALESCE(source,'api') <> 'history' AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`, [pn]);
    return Boolean(r.rows && r.rows.length);
  };
  const isTestPhone = async (pn) => { try { return (await wa.testPhones()).includes(pn); } catch { return false; } };

  /* حالة خانة الرد لمحادثة: {ok, gate, test}. نفس ترتيب الرفض اللي reply هيرجّعه — عشان الخانة تتقفل قبل الكتابة. */
  async function sendStateFor(pn) {
    if (!wa || typeof wa.gate !== "function") return { ok: false, gate: "disabled", test: false };
    if (await isStopped(pn)) return { ok: false, gate: "opted_out", test: false };
    let gate; try { gate = await wa.gate(); } catch { gate = "settings_unreadable"; }
    let test = false;
    if (gate) {
      /* القناة مقفولة: رقم تجربة بس، ومن غير القفل الصلب ومع رقم/توكن متظبطين */
      const hard = (typeof wa.envState === "function" && wa.envState() === "kill") || (typeof wa.configured === "function" && !wa.configured());
      if (hard || !(await isTestPhone(pn))) return { ok: false, gate, test: false };
      test = true;
    }
    if (!(await windowOpen(pn))) return { ok: false, gate: "window_closed", test };
    return { ok: true, gate: null, test };
  }
  /* حالة القناة من غير محادثة معيّنة (للقايمة) */
  async function channelState() {
    if (!wa || typeof wa.gate !== "function") return { ok: false, gate: "disabled" };
    let gate; try { gate = await wa.gate(); } catch { gate = "settings_unreadable"; }
    return { ok: !gate, gate: gate || null };
  }

  /* الرد نفسه. by/role/via للسجل. بيرجّع {ok, wamid, test} أو {ok:false, error, gate} — من غير أي استثناء. */
  async function reply({ phoneNorm, text, by = null, role = null, via = "dashboard" }) {
    const pn = normPhone(phoneNorm);
    if (!pn) return { ok: false, error: "bad_phone", gate: null };
    const t = cleanText(text);
    if (!t.ok) return { ok: false, error: t.error, gate: null };
    if (!wa || typeof wa.sendFreeform !== "function") return { ok: false, error: "disabled", gate: "disabled" };
    await ready;
    const st = await sendStateFor(pn);
    if (!st.ok) return { ok: false, error: st.gate, gate: st.gate };
    /* source:"echo" = إشارة «الموظف رد» للبوت (شوف رأس الملف). الحارس بيعيد كل الفحوص بنفسه قبل ما يدّي التذكرة. */
    const r = await wa.sendFreeform({ phoneNorm: pn, payload: { type: "text", text: { body: t.body, preview_url: false } }, source: "echo", test: st.test, preview: t.body });
    if (!r.ok) {
      const gate = r.skipped && GATES.includes(r.skipped) ? r.skipped : null;
      return { ok: false, error: r.skipped || r.error || "send_failed", gate, message: r.message || undefined };
    }
    try {
      await pool.query("INSERT INTO wa_staff_replies(phone_norm, wamid, by_name, role, via, test, chars) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (wamid) DO NOTHING",
        [pn, r.wamid || null, clip(by, 60), clip(role, 20), clip(via, 20), st.test === true, t.body.length]);
      await pool.query("UPDATE wa_threads SET unread=0, read_at=NOW(), read_by=$2, updated_at=NOW() WHERE phone_norm=$1", [pn, clip(by || role, 60)]);
    } catch (e) { log.error("[wa-staff] log:", e.message); }
    await owner.touch(pn);      // المحادثة مسحوبة ⇒ مهلة الرجوع للبوت تبدأ من جديد (الرد مابيسحبش محادثة مش مسحوبة)
    return { ok: true, wamid: r.wamid || null, test: st.test === true };
  }

  /* رسايل المحادثة: مين رد من اللوحة/البورتال (الصف نفسه source=echo). بيعدّل المصفوفة مكانها. */
  async function annotate(messages) {
    const ids = (messages || []).filter((m) => m && m.dir === "out" && m.source === "echo" && /^wamid\./.test(String(m.id || ""))).map((m) => m.id);
    if (!ids.length) return messages;
    try {
      await ready;
      const r = await pool.query("SELECT wamid, by_name, role, via FROM wa_staff_replies WHERE wamid = ANY($1::text[])", [ids]);
      const by = new Map(r.rows.map((x) => [x.wamid, x]));
      for (const m of messages) { const x = by.get(m.id); if (x) { m.source = "staff"; m.staff = { by: x.by_name || null, role: x.role || null, via: x.via }; } }
    } catch (e) { log.error("[wa-staff] annotate:", e.message); }
    return messages;
  }
  const quick = async () => quickReplies(await getSettingsData().catch(() => ({})), deps.faqDefs || FAQ_DEFS);

  const status = (r) => (["empty", "too_long", "bad_phone"].includes(r.error) ? 400 : 409);
  const refusal = (r) => ({ ok: false, error: r.error, gate: r.gate || null, message: (r.gate && GATE_AR[r.gate]) || r.message || undefined });

  /* ── اللوحة: الردود السريعة (إجابات المالك للأسئلة الشائعة — مش بيانات عملاء) ── */
  /* المسار تحت ‎/api/cms/wa/threads…‎ عشان ياخد نفس قسم الصلاحيات («الطلبات») من cms.js من غير سطر جديد هناك */
  app.get("/api/cms/wa/threads-quick", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, replies: await quick() });
  });

  /* SR2: مهلة رجوع المحادثة المسحوبة للبوت (settings.waInbox.holdAutoReleaseMin) — القراءة لأي دور في قسم «الطلبات»، الحفظ للمالك */
  app.get("/api/cms/wa/threads-hold", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, holdAutoReleaseMin: await owner.minutes(), default: waowner.HOLD.def, min: waowner.HOLD.min, max: waowner.HOLD.max,
      mediaKeepDays: wamedia.keepDays(await getSettingsData().catch(() => ({}))), mediaKeep: wamedia.KEEP, mediaUsage: await media.usage() });
  });
  app.post("/api/cms/wa/threads-hold", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(ctx.isOwner && (await ctx.isOwner(c)))) return c.json({ ok: false, error: "owner_only", message: "تعديل المهلة للمالك بس" }, 403);
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const cur = ((await getSettingsData().catch(() => ({}))) || {}).waInbox;
    const next = { ...(cur && typeof cur === "object" ? cur : {}) };
    if (b.holdAutoReleaseMin !== undefined || b.mediaKeepDays === undefined) {
      const v = Number(b.holdAutoReleaseMin);
      if (!Number.isFinite(v) || v < waowner.HOLD.min || v > waowner.HOLD.max) return c.json({ ok: false, error: "bad_value", message: `المهلة من ${waowner.HOLD.min} لـ${waowner.HOLD.max} دقيقة` }, 400);
      next.holdAutoReleaseMin = Math.round(v);
    }
    if (b.mediaKeepDays !== undefined) {      // MD1: مدة الاحتفاظ بنسخ الصور والصوت عندنا
      const d = Number(b.mediaKeepDays);
      if (!Number.isFinite(d) || d < wamedia.KEEP.min || d > wamedia.KEEP.max) return c.json({ ok: false, error: "bad_value", message: `مدة الاحتفاظ من ١ لـ${wamedia.KEEP.max} يوم، أو ٠ = بدون حذف` }, 400);
      next.mediaKeepDays = Math.round(d);
    }
    await pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waInbox}', $1::jsonb, true) WHERE id=1`, [JSON.stringify(next)]);
    return c.json({ ok: true, holdAutoReleaseMin: waowner.holdMinutes({ waInbox: next }), default: waowner.HOLD.def, min: waowner.HOLD.min, max: waowner.HOLD.max,
      mediaKeepDays: wamedia.keepDays({ waInbox: next }), mediaKeep: wamedia.KEEP });
  });

  /* ── البورتال ── */
  if (requirePortal) {
    const gateP = async (c) => {
      const a = await requirePortal(c); if (a.res) return a;
      if (!["cashier", "manager"].includes(a.user.role)) return { res: c.json({ ok: false, error: "forbidden", message: "المحادثات للكاشير والمدير" }, 403) };
      const h = hub(); if (!h) return { res: c.json({ ok: false, error: "unavailable" }, 503) };
      return { user: a.user, h, me: { id: a.user.id, name: a.user.name, role: a.user.role, via: "portal" } };
    };
    const ownerAct = (fn) => async (c) => {
      const a = await gateP(c); if (a.res) return a.res;
      const pn = await phoneOfKey(c.req.param("key"));
      if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
      let b = {}; try { b = await c.req.json(); } catch { b = {}; }
      try {
        const r = await owner[fn](pn, a.me, { force: b && b.force === true });
        try { deps.audit?.(a.user, `wa_${fn}`, null, r.ok, { via: "portal", error: r.ok ? null : r.error }, null, { emit: false }); } catch { /* السجل مايوقّفش */ }
        if (!r.ok) return c.json({ ok: false, error: r.error, owner: r.owner || undefined, message: r.message }, r.status || 409);
        return c.json({ ok: true, owner: r.owner });
      } catch (e) { log.error(`[wa-staff] ${fn}:`, e.message); return c.json({ ok: false, error: "unavailable" }, 503); }
    };
    app.get("/api/portal/wa/chats/:key/media/:ref", async (c) => {
      const a = await gateP(c); if (a.res) return a.res;
      const pn = await phoneOfKey(c.req.param("key"));
      if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
      return media.serve(c, { phoneNorm: pn, ref: c.req.param("ref"), as: c.req.query("as") || null });
    });
    app.post("/api/portal/wa/chats/:key/take", ownerAct("take"));
    app.post("/api/portal/wa/chats/:key/release", ownerAct("release"));
    app.post("/api/portal/wa/chats/:key/done", ownerAct("done"));
    app.get("/api/portal/wa/chats", async (c) => {
      const a = await gateP(c); if (a.res) return a.res;
      try {
        const out = await a.h.listThreads({ filter: c.req.query("filter") || "waiting", q: c.req.query("q") || "", limit: c.req.query("limit"), before: c.req.query("before") || null, full: true, me: a.me });
        return c.json({ ...out, send: await channelState(), role: a.user.role });
      } catch (e) { log.error("[wa-staff] chats:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
    });
    app.get("/api/portal/wa/chats/:key", async (c) => {
      const a = await gateP(c); if (a.res) return a.res;
      const pn = await phoneOfKey(c.req.param("key"));
      if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
      try {
        const r = await a.h.getThread(pn, { limit: c.req.query("limit"), before: c.req.query("before") || null, full: true, me: a.me });
        if (!r.ok) return c.json(r, 404);
        await annotate(r.messages);
        return c.json({ ...r, send: await sendStateFor(pn), role: a.user.role });
      } catch (e) { log.error("[wa-staff] chat:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
    });
    app.post("/api/portal/wa/chats/:key/read", async (c) => {
      const a = await gateP(c); if (a.res) return a.res;
      const pn = await phoneOfKey(c.req.param("key"));
      if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
      await pool.query("UPDATE wa_threads SET unread=0, read_at=NOW(), read_by=$2, updated_at=NOW() WHERE phone_norm=$1", [pn, clip(a.user.name || a.user.role, 60)]);
      return c.json({ ok: true });
    });
    app.post("/api/portal/wa/chats/:key/reply", async (c) => {
      const a = await gateP(c); if (a.res) return a.res;
      const pn = await phoneOfKey(c.req.param("key"));
      if (!pn) return c.json({ ok: false, error: "not_found" }, 404);
      let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
      const r = await reply({ phoneNorm: pn, text: b.text, by: a.user.name || a.user.id, role: a.user.role, via: "portal" });
      try { deps.audit?.(a.user, "wa_reply", null, r.ok, { via: "portal", error: r.ok ? null : r.error }, null, { emit: false }); } catch { /* السجل مايوقّفش الرد */ }
      if (!r.ok) return c.json(refusal(r), status(r));
      return c.json({ ok: true, wamid: r.wamid, test: r.test, send: await sendStateFor(pn), owner: await owner.ownerFor(pn, a.me).catch(() => null) });
    });
    app.get("/api/portal/wa/quick-replies", async (c) => {
      const a = await gateP(c); if (a.res) return a.res;
      return c.json({ ok: true, replies: await quick() });
    });
  }

  return { ready, reply, sendStateFor, channelState, annotate, quick, phoneOfKey, owner, media };
}
