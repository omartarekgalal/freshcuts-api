/* ═══════════════════════════════════════════════════════════════════════════
   🔔 تحويلات واتساب على بوابة المطعم (١٣/١٠)

   البوت (wabotrun.js) لما يحوّل محادثة لموظف بيطلّع حدث `wa_handover` على قناة البوابة الحيّة. الحدث لوحده بيوصل للشاشات
   المفتوحة في اللحظة دي بس. الملف ده بيخلّيه «زي الطلب الجديد»:
     • بيسجّل كل تحويل في جدول (wa_handovers) — البوابة اللي تتفتح بعدين بتلاقي تحويلات اليوم التشغيلي اللي ماحدش قال عليها «تم».
     • بيضيف للحدث رقم التحويل وآخر رسالة من العميل، وبيبعت إشعار Web Push لأجهزة البوابة (نفس اشتراكات إشعارات الطلبات).
     • «تم» من أي جهاز بتشيل الكارت من كل الشاشات (حدث wa_handover_ack).
   مفيش أي إرسال للعميل من هنا، ومفيش تعديل في جداول البوت. رسالة SMS لعمر والمدير زي ما هي (البوت بيبعتها).
   وضع التجربة: الكارت بيظهر وعليه «تجربة»، من غير Web Push.

   RG1 (١٤/١٠ — عميل …0776 طلب مسؤول وفضل مستني: الإشعار رنّ مرتين بس ومحدش استلم):
     • ringDue: كل دقيقة (من دورة waflow) — تحويل مفتوح محدش استلمه ولا رد عليه ⇒ إشعار تاني لأجهزة البوابة كل waTeam.portalRing.everyMin
       (افتراضي ٣ د) لحد waTeam.portalRing.capMin (افتراضي ٤٥ د)، بـrequireInteraction + renotify. الحجز في الصف (rung_at) قبل الإرسال ⇒
       سيرفر وقع أو حاويتين وقت الـrollover مايبعتوش مرتين. وتحويل اتاستلم (wa_chat_holds) أو اترد عليه (echo من موظف) بيتقفل لوحده (wa_handover_ack).
     • escalate: خطوة المدير في السلّم (أو «طلب مسؤول» من الأول) ⇒ حدث wa_handover_escalated + إشعار لأجهزة دور المدير بس.
     • presence: كل استطلاع لقايمة التحويلات من البوابة (كل ٢٠ ث والشاشة ظاهرة) = «البوابة مفتوحة» للموظف ده على الجهاز ده
       (كتابة واحدة في الدقيقة بالكتير). wateam.js بيستخدمه: مفيش بوابة كاشير مفتوحة وقت الشغل ⇒ واتساب للكاشير.

   PO1 (١٤/١٠ مساءً — ٣٢ رسالة «البورتال مقفول» للكاشير في ٣.٥ ساعة): الحضور بقى = أي نشاط بوابة، مش استطلاع التحويلات بس:
     • requirePortal في portal.js بينده seen() بعد أي دخول ناجح (أي /api/portal/* و /api/tables/* ومسارات واتساب البوابة)،
       ومنهم فتح بث SSE (مرة لما الجهاز يفتحه — نبضاته مابتتحسبش، شوف تحت). نوع الإشارة (via): beat (نبضة البوابة الظاهرة) · poll (قايمة
       التحويلات — بتتسحب والشاشة ظاهرة بس) · action (POST/PUT… = حد داس) · api (أي قراءة تانية، ممكن من تاب في الخلفية) · sse (البث).
       beat / poll / action = «ظاهرة» (last_visible)، الباقي = «متوصّلة» بس.
     • لسه كتابة واحدة في الدقيقة لكل موظف/جهاز بالكتير: أول إشارة في الدقيقة بتتكتب، والباقي بيتحفظ في الذاكرة وبيتكتب بعد ما الدقيقة
       تخلص (flush كل ١٥ ث) — فآخر ظهور مابيتأخرش دقيقة عن الحقيقة.
     • seen_since / visible_since = بداية «الفتحة» الحالية (فجوة أكتر من ٢.٥ دقيقة بين كتابتين ⇒ فتحة جديدة). wateam.js بيستخدمها
       عشان «رجع» يبقى بس لما البورتال يفضل مفتوح backStableMin دقيقة — بصّة سريعة مابتنهيش التنبيه.
     • بعد المراجعة: الإشارة لازم تيجي من الجهاز نفسه. نبضة البث (ping كل ٢٠ ث) السيرفر هو اللي بيبعتها ومابيعرفش الجهاز استلمها ولا
       لأ (تاب متجمّد أو تابلت فصل) ⇒ مابقتش حضور؛ البث بيتحسب مرة واحدة لما الجهاز يفتحه. وrequirePortal بيعلّم الطلب (a.seen) فالمسار
       مابيعدّهوش تاني، وأي فشل في كتابة الحضور بيتسجّل (health()) بدل ما يضيع في صمت.
     • المراجعة التانية: صفوف RG1 القديمة بتاخد last_visible = last_seen مرة واحدة (PRESENCE_BACKFILL — كانت من استطلاع ظاهر بس)، وhealth()
       فيها failing / readFailing (آخر كتابة / قراية فشلت) عشان التحذير يبقى «دلوقتي» مش «حصل مرة من يوم التشغيل».
═══════════════════════════════════════════════════════════════════════════ */
import { bizDay, bizStart } from "./bizday.js";
import { isReviewHandover, reviewPortalRole, reviewPushRoles } from "./reviewaudience.js";

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const normPhone = (p) => { const d = String(p || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, ""); return /^5\d{8}$/.test(d) ? d : null; };
const DDL = `
  CREATE TABLE IF NOT EXISTS wa_handovers (
    id BIGSERIAL PRIMARY KEY,
    phone_norm TEXT NOT NULL,
    reason TEXT NOT NULL,
    reason_ar TEXT,
    urgent BOOLEAN NOT NULL DEFAULT FALSE,
    order_no TEXT,
    test BOOLEAN NOT NULL DEFAULT FALSE,
    last_text TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acked_at TIMESTAMPTZ,
    acked_by TEXT
  );
  CREATE INDEX IF NOT EXISTS wa_handovers_open_idx ON wa_handovers(at DESC) WHERE acked_at IS NULL;
  ALTER TABLE wa_handovers ADD COLUMN IF NOT EXISTS rung_at TIMESTAMPTZ;
  ALTER TABLE wa_handovers ADD COLUMN IF NOT EXISTS rings INT NOT NULL DEFAULT 0;
  ALTER TABLE wa_handovers ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
  CREATE TABLE IF NOT EXISTS portal_presence (
    staff_id TEXT NOT NULL,
    device TEXT NOT NULL,
    role TEXT,
    staff_name TEXT,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (staff_id, device)
  );
  ALTER TABLE portal_presence ADD COLUMN IF NOT EXISTS seen_since TIMESTAMPTZ;
  ALTER TABLE portal_presence ADD COLUMN IF NOT EXISTS via TEXT;
  ALTER TABLE portal_presence ADD COLUMN IF NOT EXISTS last_visible TIMESTAMPTZ;
  ALTER TABLE portal_presence ADD COLUMN IF NOT EXISTS visible_since TIMESTAMPTZ;
`;
const MIN = 60_000;
export const PRESENCE_WRITE_MS = 60_000;      // كتابة واحدة في الدقيقة لكل جهاز بالكتير
export const PRESENCE_FLUSH_MS = 15_000;      // الإشارات اللي جت جوّه الدقيقة بتتكتب بعد ما تخلص (آخر ظهور دقيق لحد ~١٥ ث)
export const STREAK_GAP_MS = 150_000;         // فجوة أكتر من كده بين كتابتين ⇒ «فتحة» جديدة (seen_since من الأول)
export const VISIBLE_VIA = Object.freeze(["beat", "poll", "action"]);
/* نوع إشارة الحضور من الطلب نفسه (PO1). null = مايتحسبش (الخروج).
   اشتراك الإشعارات بيتبعت لوحده أول ما البوابة تفتح (ممكن والتاب في الخلفية) ⇒ قراءة عادية مش «داس». */
export function presenceVia(method, path) {
  const p = String(path || "").split("?")[0], m = String(method || "GET").toUpperCase();
  if (p === "/api/portal/logout") return null;
  if (p === "/api/portal/presence") return "beat";
  if (p === "/api/portal/stream") return "sse";
  if (p === "/api/portal/wa-handovers" && m === "GET") return "poll";
  if (p.startsWith("/api/portal/push/") && p !== "/api/portal/push/test") return "api";
  if (!["GET", "HEAD", "OPTIONS"].includes(m)) return "action";
  return "api";
}
export const SAME_SIGNAL_MS = 1000;           // نفس الطلب اتبلّغ مرتين (requirePortal + المسار) ⇒ إشارة واحدة
const GAP_SQL = `INTERVAL '${STREAK_GAP_MS / 1000} seconds'`;
export const PRESENCE_UPSERT = `INSERT INTO portal_presence(staff_id, device, role, staff_name, last_seen, seen_since, via, last_visible, visible_since)
  VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz,$6,$7::timestamptz,$7::timestamptz)
  ON CONFLICT (staff_id, device) DO UPDATE SET role=EXCLUDED.role, staff_name=EXCLUDED.staff_name, via=EXCLUDED.via,
    seen_since = CASE WHEN portal_presence.seen_since IS NULL OR portal_presence.last_seen < EXCLUDED.last_seen - ${GAP_SQL}
                      THEN EXCLUDED.last_seen ELSE portal_presence.seen_since END,
    last_seen = GREATEST(portal_presence.last_seen, EXCLUDED.last_seen),
    visible_since = CASE WHEN EXCLUDED.last_visible IS NULL THEN portal_presence.visible_since
                         WHEN portal_presence.visible_since IS NULL OR portal_presence.last_visible IS NULL
                              OR portal_presence.last_visible < EXCLUDED.last_visible - ${GAP_SQL}
                         THEN EXCLUDED.last_visible ELSE portal_presence.visible_since END,
    last_visible = GREATEST(portal_presence.last_visible, EXCLUDED.last_visible)`;
/* المراجعة التانية: صفوف RG1 (قبل PO1) مالهاش last_visible، وكانت بتتكتب من استطلاع قايمة التحويلات بس — والبوابة مابتستطلعش غير والشاشة
   ظاهرة (PortalApp: `if (document.visibilityState !== "visible") return`) ⇒ last_seen بتاعها إشارة «ظاهرة» فعلاً. من غير النقل ده أول دورة بعد
   الـdeploy كانت بتشوف البوابة «ماتفتحتش خالص» (رسالة «مقفول من أول الشغل» لبوابة كانت ظاهرة من دقايق) واللوحة «ماتفتحش».
   via IS NULL = الصف اتكتب بكود RG1 بس (PO1 دايماً بيكتب via). مرة واحدة بالطبيعة: بعدها last_visible مش NULL. */
export const PRESENCE_BACKFILL = `UPDATE portal_presence SET last_visible = last_seen, visible_since = COALESCE(visible_since, seen_since, last_seen)
  WHERE via IS NULL AND last_visible IS NULL`;
const waitAr = (m) => (m < 1 ? "لسه دلوقتي" : m === 1 ? "دقيقة" : m === 2 ? "دقيقتين" : m <= 10 ? `${m} دقايق` : `${m} دقيقة`);
/* بصمة الجهاز من غير أي بيانات شخصية: hash قصير للـuser-agent (تابلت الكاشير ≠ موبايله) */
export function deviceOf(ua) {
  let h = 2166136261;
  for (const ch of String(ua || "-").slice(0, 300)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

/* صف الجدول ⇒ الشكل اللي البوابة بتعرضه (نفس حقول حدث البوت + id و lastText) */
export function publicRow(r) {
  const pn = String(r.phone_norm || "");
  return { id: Number(r.id), phone: `0${pn}`, phoneMasked: `…${pn.slice(-4)}`, reason: r.reason, reasonAr: r.reason_ar || r.reason,
    urgent: r.urgent === true, orderNo: r.order_no || null, at: r.at instanceof Date ? r.at.toISOString() : r.at, test: r.test === true,
    lastText: r.last_text || null };
}
/* opts.repeat = رنّة متكررة (RG1) بعد waitedMin دقيقة · opts.escalated = نسخة المدير (step manager، direct = العميل طلب مسؤول من الأول).
   نفس الـtag ⇒ الإشعار الجديد بيحل محل القديم على نفس الجهاز بدل ما يتكوّموا، وrenotify ⇒ بيرن تاني. */
export function pushPayloadFor(row, baseUrl, opts = {}) {
  const p = publicRow(row);
  /* RV1: تنبيه «تقييم واطي» إشعار هادي (من غير requireInteraction) — المدير بيقفله من شاشة التقييمات */
  const loud = (p.urgent && !isReviewHandover(p.reason)) || p.reason === "asked_manager";
  const tail = `${p.orderNo ? ` · طلب ${p.orderNo}` : ""}`;
  if (opts.escalated) {
    const w = Number(opts.waitedMin) || 0;
    return { kind: "wa_handover", title: `⬆️ تصعيد للمدير: ${p.reasonAr}`,
      body: opts.direct ? `عميل ${p.phoneMasked} طالب مسؤول — رد عليه من البوابة${tail}` : `عميل ${p.phoneMasked} مستني من ${waitAr(w)} ومحدش استلم${tail}`,
      url: baseUrl, tag: `wa-handover-${p.id}`, renotify: true, urgency: "high", ttl: 900, requireInteraction: true };
  }
  if (opts.repeat) {
    return { kind: "wa_handover", title: `🔔 لسه مستني ${waitAr(Number(opts.waitedMin) || 0)}: ${p.reasonAr}`,
      body: `عميل ${p.phoneMasked} محتاج موظف ومحدش استلم${tail}`,
      url: baseUrl, tag: `wa-handover-${p.id}`, renotify: true, urgency: "high", ttl: Math.max(120, (Number(opts.everyMin) || 3) * 60), requireInteraction: true };
  }
  return { kind: "wa_handover", title: `${p.urgent ? "🚨" : p.reason === "asked_manager" ? "🙋" : "💬"} واتساب: ${p.reasonAr}`,
    body: `عميل ${p.phoneMasked} محتاج موظف${tail}`,
    url: baseUrl, tag: `wa-handover-${p.id}`, renotify: true, urgency: loud ? "high" : "normal", ttl: 900, requireInteraction: loud };
}

/* RG1 — أنهي تحويل يرنّ تاني دلوقتي؟ (صافي) rows = تحويلات مفتوحة بعلاماتها (taken/answered/superseded).
   ⇒ { settle: [{id, by}] (اتاستلم/اترد عليه ⇒ يتقفل), ring: [row] } */
export function ringPlan(rows, { now, everyMin, capMin, enabled = true }) {
  const t = new Date(now).getTime(), settle = [], ring = [];
  for (const r of rows || []) {
    if (r.taken) { settle.push({ id: Number(r.id), by: "استلمها موظف" }); continue; }
    if (r.answered) { settle.push({ id: Number(r.id), by: "اترد على العميل" }); continue; }
    if (!enabled || r.superseded || r.test === true) continue;
    if (isReviewHandover(r.reason)) continue;      // RV1: «تقييم واطي» مابيرنّش تاني — الرنّة الهادية بتاعة شاشة التقييمات (مرة لكل تقييم) هي بس
    const at = new Date(r.at).getTime(), last = r.rung_at ? new Date(r.rung_at).getTime() : at;
    if (!Number.isFinite(at) || t - at > capMin * MIN) continue;
    if (t - last >= everyMin * MIN) ring.push(r);
  }
  return { settle, ring };
}

export function register(app, ctx, deps = {}) {
  const { pool } = ctx;
  const now = deps.now || (() => new Date());
  const log = deps.log || console;
  const ready = pool.query(DDL).then(() => pool.query(PRESENCE_BACKFILL).catch((e) => log.error("[wa-handover] presence backfill:", e.message)))
    .then(() => true).catch((e) => { log.error("[wa-handover] schema:", e.message); return false; });
  const pushApi = () => { try { return typeof deps.push === "function" ? deps.push() : deps.push || null; } catch { return null; } };
  const say = (ev, d) => { try { deps.broadcast?.(ev, d); } catch (e) { log.error("[wa-handover] broadcast:", e.message); } };
  const settingsNow = async () => { try { return typeof ctx.getSettingsData === "function" ? await ctx.getSettingsData() : null; } catch { return null; } };
  /* إشعار التحويل: لكل الأجهزة — إلا «تقييم واطي» (RV1): أجهزة المدير بس، والكاشير لو الإعداد مفتوح (reviewaudience.js). بيرجّع وعد مابيرميش. */
  async function pushRow(push, row, payload) {
    if (!push || typeof push.sendToSubs !== "function") return null;
    if (!isReviewHandover(row && row.reason)) return push.sendToSubs(payload);
    let last = null;
    for (const role of reviewPushRoles(await settingsNow())) last = await push.sendToSubs(payload, { role });
    return last;
  }

  /* البوت نده: سجّل، وبعدين ابعت الحدث (بالـid وآخر رسالة) + الإشعار. أي فشل في التسجيل مايمنعش الحدث الحي. */
  async function emit(data) {
    const d = data && typeof data === "object" ? data : {};
    const pn = normPhone(d.phone);
    let row = null;
    /* تنبيه تاني (البوت: محدش رد على التحويل بعد المدة المحددة): مفيش صف جديد — نفس كارت التحويل المفتوح بيرنّ تاني ومعاه reminder و waitedMin.
       لو الكارت اتقفل بـ«تم» خلاص، مفيش حاجة تتبعت. */
    if (d.reminder === true) {
      try {
        await ready;
        const r = pn ? await pool.query(`SELECT id, phone_norm, reason, reason_ar, urgent, order_no, test, last_text, at FROM wa_handovers WHERE phone_norm=$1 AND acked_at IS NULL ORDER BY at DESC LIMIT 1`, [pn]) : { rows: [] };
        const open = r.rows && r.rows[0] ? r.rows[0] : null;
        if (!open) return null;
        const out = { ...publicRow(open), reminder: true, waitedMin: Number(d.waitedMin) || null };
        try { deps.broadcast?.("wa_handover", out); } catch (e) { log.error("[wa-handover] broadcast:", e.message); }
        if (open.test !== true) { try { const push = pushApi(); if (push && typeof push.sendToSubs === "function") pushRow(push, open, pushPayloadFor(open, push.PORTAL_URL || "")).catch(() => {}); } catch { /* الإشعار مايوقّفش حاجة */ } }
        /* RG1: التنبيه التاني ده بيتحسب رنّة — الرنّة المتكررة بتعد من هنا (مفيش إشعارين ورا بعض) */
        try { await pool.query("UPDATE wa_handovers SET rung_at=$2 WHERE id=$1", [open.id, now().toISOString()]); } catch { /* */ }
        return out;
      } catch (e) { log.error("[wa-handover] reminder:", e.message); return null; }
    }
    if (pn && d.reason) {
      try {
        await ready;
        let last = null;
        try {
          const m = await pool.query("SELECT body FROM wa_messages WHERE phone_norm=$1 AND direction='in' ORDER BY created_at DESC LIMIT 1", [pn]);
          last = m.rows && m.rows[0] ? clip(String(m.rows[0].body || "").replace(/\s+/g, " ").trim(), 200) : null;
        } catch { /* آخر رسالة اختيارية */ }
        const urgent = d.urgent === true;   // البوت هو اللي بيقرر العاجل (شكوى، مشكلة، حساسية شديدة…)
        const r = await pool.query(
          `INSERT INTO wa_handovers(phone_norm, reason, reason_ar, urgent, order_no, test, last_text, at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, phone_norm, reason, reason_ar, urgent, order_no, test, last_text, at`,
          [pn, clip(d.reason, 40), clip(d.reasonAr, 80), urgent, clip(d.orderNo, 30), d.test === true, last,
            Number.isFinite(Date.parse(d.at)) ? new Date(d.at).toISOString() : now().toISOString()]);
        row = r.rows && r.rows[0] ? r.rows[0] : null;
      } catch (e) { log.error("[wa-handover] save:", e.message); }
    }
    const out = row ? publicRow(row) : { ...d, id: null, lastText: null };
    try { deps.broadcast?.("wa_handover", out); } catch (e) { log.error("[wa-handover] broadcast:", e.message); }
    if (row && row.test !== true) {
      try {
        const push = pushApi();
        if (push && typeof push.sendToSubs === "function") pushRow(push, row, pushPayloadFor(row, push.PORTAL_URL || "")).catch(() => {});
      } catch { /* الإشعار مايوقّفش حاجة */ }
    }
    return out;
  }

  /* تحويلات اليوم التشغيلي اللي لسه مفتوحة (الأحدث فوق). role = دور اللي بيسأل من البورتال: «تقييم واطي» بيظهر لجمهور التقييمات بس
     (المدير، والكاشير لو الإعداد مفتوح — RV1). من غير role (نداء داخلي) ⇒ الكل. */
  async function openList({ role = null } = {}) {
    await ready;
    const since = bizStart(bizDay(now()));
    const r = await pool.query(
      `SELECT id, phone_norm, reason, reason_ar, urgent, order_no, test, last_text, at
         FROM wa_handovers WHERE acked_at IS NULL AND at >= $1 ORDER BY at DESC LIMIT 50`, [since.toISOString()]);
    let rows = r.rows || [];
    if (role != null && rows.some((x) => isReviewHandover(x.reason))) {
      const s = await settingsNow();
      if (!reviewPortalRole(role, s)) rows = rows.filter((x) => !isReviewHandover(x.reason));
    }
    return rows.map(publicRow);
  }

  /* ── RG1: الرنّة المتكررة لحد ما حد يستلم ─────────────────────────────────
     ring = { enabled, everyMin, capMin } (waTeam.portalRing). بتتنادى كل دقيقة من دورة waflow. عمرها ما بترمي. */
  async function ringDue(ring, at = null) {
    const out = { settled: 0, rung: 0 };
    try {
      if (!(await ready)) return out;
      const t = at ? new Date(at) : now();
      const cap = Math.max(5, Number(ring && ring.capMin) || 45), every = Math.max(1, Number(ring && ring.everyMin) || 3);
      const r = await pool.query(
        `SELECT h.id, h.phone_norm, h.reason, h.reason_ar, h.urgent, h.order_no, h.test, h.last_text, h.at, h.rung_at, h.rings,
                EXISTS (SELECT 1 FROM wa_chat_holds c WHERE c.phone_norm=h.phone_norm AND c.state='held') AS taken,
                EXISTS (SELECT 1 FROM wa_messages m WHERE m.phone_norm=h.phone_norm AND m.source='echo' AND COALESCE(m.echo_kind,'staff') <> 'auto' AND m.created_at > h.at) AS answered,
                EXISTS (SELECT 1 FROM wa_handovers h2 WHERE h2.phone_norm=h.phone_norm AND h2.id > h.id) AS superseded
           FROM wa_handovers h WHERE h.acked_at IS NULL AND h.at > $1 ORDER BY h.at LIMIT 50`, [new Date(t.getTime() - Math.max(cap, 24 * 60) * MIN).toISOString()]);
      const plan = ringPlan(r.rows || [], { now: t, everyMin: every, capMin: cap, enabled: !ring || ring.enabled !== false });
      for (const s of plan.settle) {
        const u = await pool.query("UPDATE wa_handovers SET acked_at=NOW(), acked_by=$2 WHERE id=$1 AND acked_at IS NULL RETURNING id", [s.id, s.by]);
        if (u.rowCount) { out.settled++; say("wa_handover_ack", { id: s.id, by: s.by }); }
      }
      const push = pushApi();
      for (const row of plan.ring) {
        /* الحجز قبل الإرسال: نسخة واحدة بس بترنّ، والسيرفر لو وقع في النص مايبعتش تاني */
        const claim = await pool.query(`UPDATE wa_handovers SET rung_at=$2, rings=rings+1 WHERE id=$1 AND acked_at IS NULL AND COALESCE(rung_at, at) <= $3 RETURNING id`,
          [row.id, t.toISOString(), new Date(t.getTime() - every * MIN).toISOString()]);
        if (!claim.rowCount) continue;
        const waited = Math.max(0, Math.floor((t.getTime() - new Date(row.at).getTime()) / MIN));
        say("wa_handover", { ...publicRow(row), reminder: true, waitedMin: waited, ring: true });
        if (push && typeof push.sendToSubs === "function") { try { await push.sendToSubs(pushPayloadFor(row, push.PORTAL_URL || "", { repeat: true, waitedMin: waited, everyMin: every })); } catch { /* */ } }
        out.rung++;
      }
    } catch (e) { log.error("[wa-handover] ring:", e.message); }
    return out;
  }

  /* ── RG1: تصعيد للمدير ⇒ حدث wa_handover_escalated (البوابات بتاعة المدير بترنّ ببانر) + إشعار لأجهزة دور المدير بس.
     { phone, waitedMin, direct (العميل طلب مسؤول), push (waTeam.ladder.managerPush), reason, reasonAr } — عمرها ما بترمي. */
  async function escalate({ phone, waitedMin = 0, direct = false, push: doPush = true, reason = null, reasonAr = null } = {}) {
    try {
      await ready;
      const pn = normPhone(phone);
      if (!pn) return null;
      const r = await pool.query(`SELECT id, phone_norm, reason, reason_ar, urgent, order_no, test, last_text, at FROM wa_handovers WHERE phone_norm=$1 AND acked_at IS NULL ORDER BY at DESC LIMIT 1`, [pn]);
      const row = r.rows && r.rows[0] ? r.rows[0] : null;
      const base = row ? publicRow(row) : { id: null, phone: `0${pn}`, phoneMasked: `…${pn.slice(-4)}`, reason: reason || "handover", reasonAr: reasonAr || reason || "تحويل", urgent: false, orderNo: null, at: now().toISOString(), test: false, lastText: null };
      const ev = { ...base, step: "manager", role: "manager", waitedMin: Math.max(0, Math.floor(Number(waitedMin) || 0)), direct: direct === true };
      say("wa_handover_escalated", ev);
      if (doPush && !(row && row.test === true)) {
        const p = pushApi();
        if (p && typeof p.sendToSubs === "function") {
          const payload = pushPayloadFor(row || { id: `mgr-${pn.slice(-4)}`, phone_norm: pn, reason: base.reason, reason_ar: base.reasonAr, urgent: false, at: base.at }, p.PORTAL_URL || "", { escalated: true, direct, waitedMin: ev.waitedMin });
          try { ev.pushed = await p.sendToSubs(payload, { role: "manager" }); } catch { /* */ }
        }
      }
      if (row) { try { await pool.query("UPDATE wa_handovers SET escalated_at=$2, rung_at=$2 WHERE id=$1", [row.id, now().toISOString()]); } catch { /* */ } }
      return ev;
    } catch (e) { log.error("[wa-handover] escalate:", e.message); return null; }
  }

  /* ── حضور البوابة (طلب عمر ١٤/١٠: «البورتال مقفول وقت الشغل ⇒ واتساب للكاشير») ──
     PO1: أي نشاط بوابة لموظف كاشير/مدير (مش المطبخ، ومش مفتاح المالك من اللوحة). via = نوع الإشارة (presenceVia).
     أول إشارة في الدقيقة لكل موظف/جهاز بتتكتب على طول؛ اللي بعدها جوّه نفس الدقيقة بيتحفظ (الأحدث، والأحدث «الظاهر») وبيتكتب
     في flush بعد ما الدقيقة تخلص ⇒ كتابة واحدة في الدقيقة بالكتير، وآخر ظهور مابيقعش دقيقة ورا الحقيقة. */
  const seenAt = new Map();
  /* صحة الكتابة (بعد المراجعة): الكتابة مش مستنيّة (مابتأخّرش الطلب)، بس أي فشل بيتعدّ ويتسجّل في اللوج — أول مرة وبعدها مرة كل ١٠ دقايق.
     المراجعة التانية: العدّاد بيفضل (تاريخ)، بس «بيفشل دلوقتي» = آخر محاولة فشلت (failing: lastErrorAt بعد lastOkAt) — غلطة واحدة عدّت
     وبعدها آلاف كتابات ناجحة مابقتش تعمل تحذير أحمر للأبد. ونفس الكلام للقراية (presence() فشلت ⇒ التنبيه واللوحة مش شايفين حاجة). */
  const health = { writes: 0, errors: 0, lastOkAt: null, lastError: null, lastErrorAt: null, readErrors: 0, lastReadOkAt: null, lastReadError: null, lastReadErrorAt: null };
  const after = (a, b) => Boolean(a) && (!b || Date.parse(a) >= Date.parse(b));
  const healthNow = () => ({ ...health, failing: after(health.lastErrorAt, health.lastOkAt), readFailing: after(health.lastReadErrorAt, health.lastReadOkAt) });
  let loggedErrAt = -Infinity, loggedReadErrAt = -Infinity;
  const write = (r) => ready.then(() => pool.query(PRESENCE_UPSERT,
    [String(r.user.id).slice(0, 60), r.dev, String(r.user.role), r.user.name ? String(r.user.name).slice(0, 60) : null,
      new Date(r.t).toISOString(), r.via, r.vis ? new Date(r.vis).toISOString() : null]))
    .then(() => { health.writes++; health.lastOkAt = now().toISOString(); })
    .catch((e) => {
      health.errors++; health.lastError = clip(e && e.message, 160); health.lastErrorAt = now().toISOString();
      const t = now().getTime();
      if (t - loggedErrAt >= 10 * MIN) { loggedErrAt = t; try { log.error("[wa-handover] presence write failed:", health.lastError, `(${health.errors} so far)`); } catch { /* */ } }
    });
  function prune(t) {
    if (seenAt.size <= 500) return;
    for (const [k, s] of seenAt) if (!s.p && t - s.w > 10 * MIN) seenAt.delete(k);
    if (seenAt.size > 500) for (const k of [...seenAt.keys()].slice(0, 200)) seenAt.delete(k);
  }
  /* s = { w: وقت آخر كتابة (للحد)، wt: وقت الإشارة اللي اتكتبت، wv: وقتها «الظاهر» لو كانت ظاهرة، p: إشارة مستنية الـflush } */
  function touch(user, ua, via = "poll") {
    try {
      if (!via || !user || !user.id || user.admin === true || !["cashier", "manager"].includes(String(user.role))) return false;
      const dev = deviceOf(ua), k = `${user.id}|${dev}`, t = now().getTime(), vis = VISIBLE_VIA.includes(via);
      let s = seenAt.get(k);
      if (!s) { s = { w: -Infinity, wt: null, wv: null, p: null }; seenAt.set(k, s); prune(t); }
      /* نفس الطلب اتبلّغ مرتين (requirePortal + المسار، أو مسار بينده requirePortal مرتين): الكتابة اللي حصلت فيها كل اللي في التانية */
      if (s.wt !== null && t >= s.wt && t - s.wt < SAME_SIGNAL_MS && (!vis || (s.wv !== null && t - s.wv < SAME_SIGNAL_MS))) return false;
      if (t - s.w >= PRESENCE_WRITE_MS) {
        const r = { user, dev, t, via, vis: vis ? t : (s.p && s.p.vis) || null };
        s.w = t; s.wt = t; s.wv = r.vis; s.p = null;
        write(r);
        return true;
      }
      s.p = { user, dev, t, via, vis: vis ? t : (s.p && s.p.vis) || null };
      return false;
    } catch { return false; }
  }
  /* الإشارات اللي اتحفظت جوّه الدقيقة ⇒ كتابة واحدة بعد ما الدقيقة تخلص */
  function flush() {
    const t = now().getTime();
    let n = 0;
    for (const s of seenAt.values()) {
      if (!s.p || t - s.w < PRESENCE_WRITE_MS) continue;
      const r = s.p; s.p = null; s.w = t; s.wt = r.t; s.wv = r.vis;
      write(r); n++;
    }
    return n;
  }
  /* من requirePortal (portal.js ⇒ index.js): { ua, method, path, via? } — أي طلب بوابة ناجح، ومنهم فتح البث */
  function seen(user, info = {}) {
    const via = info.via || presenceVia(info.method, info.path);
    return via ? touch(user, info.ua, via) : false;
  }
  const flushTimer = deps.noTimer ? null : setInterval(() => { try { flush(); } catch { /* */ } }, PRESENCE_FLUSH_MS);
  if (flushTimer && typeof flushTimer.unref === "function") flushTimer.unref();
  /* آخر ظهور لكل موظف/جهاز (آخر ٧ أيام) ⇒ [{ staffId, name, role, device, lastSeen, seenSince, via, lastVisible, visibleSince }] */
  const isoOf = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  async function presence() {
    try {
      await ready;
      const r = await pool.query(`SELECT staff_id, staff_name, role, device, last_seen, seen_since, via, last_visible, visible_since FROM portal_presence
        WHERE last_seen > $1 ORDER BY last_seen DESC LIMIT 100`, [new Date(now().getTime() - 7 * 24 * 60 * MIN).toISOString()]);
      health.lastReadOkAt = now().toISOString();
      return (r.rows || []).map((x) => ({ staffId: x.staff_id, name: x.staff_name || null, role: x.role, device: x.device, lastSeen: isoOf(x.last_seen),
        seenSince: isoOf(x.seen_since), via: x.via || null, lastVisible: isoOf(x.last_visible), visibleSince: isoOf(x.visible_since) }));
    } catch (e) {
      health.readErrors++; health.lastReadError = clip(e && e.message, 160); health.lastReadErrorAt = now().toISOString();
      const t = now().getTime();
      if (t - loggedReadErrAt >= 10 * MIN) { loggedReadErrAt = t; try { log.error("[wa-handover] presence read failed:", health.lastReadError, `(${health.readErrors} so far)`); } catch { /* */ } }
      return null;
    }
  }

  const uaOf = (c) => (c.req && typeof c.req.header === "function" ? c.req.header("user-agent") : null);
  app.get("/api/portal/wa-handovers", async (c) => {
    const a = await deps.requirePortal(c); if (a.res) return a.res;
    if (!a.seen) touch(a.user, uaOf(c), "poll");      // requirePortal بتاع البوابة سجّلها خلاص (a.seen) ⇒ مفيش كتابة تانية
    try { return c.json({ ok: true, handovers: await openList({ role: String((a.user && a.user.role) || "") }) }); }
    catch (e) { log.error("[wa-handover] list:", e.message); return c.json({ ok: true, handovers: [] }); }
  });

  app.post("/api/portal/wa-handovers/:id/ack", async (c) => {
    const a = await deps.requirePortal(c); if (a.res) return a.res;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "bad_id" }, 400);
    await ready;
    const by = clip(a.user?.name || a.user?.role || "portal", 60);
    const r = await pool.query("UPDATE wa_handovers SET acked_at=NOW(), acked_by=$2 WHERE id=$1 AND acked_at IS NULL RETURNING id", [id, by]);
    if (r.rowCount) { try { deps.broadcast?.("wa_handover_ack", { id, by }); } catch { /* */ } }
    return c.json({ ok: true, id, already: !r.rowCount });
  });

  /* PO1: نبضة البوابة — البوابة بتبعتها كل دقيقة والشاشة ظاهرة بس (ومع الرجوع للشاشة). مفيش جسم مطلوب. */
  app.post("/api/portal/presence", async (c) => {
    const a = await deps.requirePortal(c); if (a.res) return a.res;
    if (!a.seen) touch(a.user, uaOf(c), "beat");
    return c.json({ ok: true });
  });

  return { emit, openList, ringDue, escalate, touch, seen, flush, presence, health: healthNow, ready, stop: () => { if (flushTimer) clearInterval(flushTimer); } };
}
