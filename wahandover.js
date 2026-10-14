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
═══════════════════════════════════════════════════════════════════════════ */
import { bizDay, bizStart } from "./bizday.js";

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
`;
const MIN = 60_000;
export const PRESENCE_WRITE_MS = 60_000;      // كتابة واحدة في الدقيقة لكل جهاز بالكتير
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
  const loud = p.urgent || p.reason === "asked_manager";
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
  const ready = pool.query(DDL).then(() => true).catch((e) => { log.error("[wa-handover] schema:", e.message); return false; });
  const pushApi = () => { try { return typeof deps.push === "function" ? deps.push() : deps.push || null; } catch { return null; } };
  const say = (ev, d) => { try { deps.broadcast?.(ev, d); } catch (e) { log.error("[wa-handover] broadcast:", e.message); } };

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
        if (open.test !== true) { try { const push = pushApi(); if (push && typeof push.sendToSubs === "function") push.sendToSubs(pushPayloadFor(open, push.PORTAL_URL || "")).catch(() => {}); } catch { /* الإشعار مايوقّفش حاجة */ } }
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
        if (push && typeof push.sendToSubs === "function") push.sendToSubs(pushPayloadFor(row, push.PORTAL_URL || "")).catch(() => {});
      } catch { /* الإشعار مايوقّفش حاجة */ }
    }
    return out;
  }

  /* تحويلات اليوم التشغيلي اللي لسه مفتوحة (الأحدث فوق) */
  async function openList() {
    await ready;
    const since = bizStart(bizDay(now()));
    const r = await pool.query(
      `SELECT id, phone_norm, reason, reason_ar, urgent, order_no, test, last_text, at
         FROM wa_handovers WHERE acked_at IS NULL AND at >= $1 ORDER BY at DESC LIMIT 50`, [since.toISOString()]);
    return (r.rows || []).map(publicRow);
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
     استطلاع حقيقي بس = حضور (تاب في الخلفية على آيفون بيوقف الاستطلاع ⇒ مش حاضر، وده المقصود: مابيقدرش يرن). */
  const seenAt = new Map();
  function touch(user, ua) {
    try {
      if (!user || !user.id || !["cashier", "manager"].includes(String(user.role))) return false;
      const dev = deviceOf(ua), k = `${user.id}|${dev}`, t = now().getTime();
      if (t - (seenAt.get(k) || 0) < PRESENCE_WRITE_MS) return false;
      seenAt.set(k, t);
      if (seenAt.size > 500) for (const x of [...seenAt.keys()].slice(0, 200)) seenAt.delete(x);
      ready.then(() => pool.query(`INSERT INTO portal_presence(staff_id, device, role, staff_name, last_seen) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (staff_id, device) DO UPDATE SET role=EXCLUDED.role, staff_name=EXCLUDED.staff_name, last_seen=EXCLUDED.last_seen`,
        [String(user.id).slice(0, 60), dev, String(user.role), user.name ? String(user.name).slice(0, 60) : null, new Date(t).toISOString()])).catch(() => {});
      return true;
    } catch { return false; }
  }
  /* آخر ظهور لكل موظف/جهاز (آخر ٧ أيام) ⇒ [{ staffId, name, role, device, lastSeen }] */
  async function presence() {
    try {
      await ready;
      const r = await pool.query(`SELECT staff_id, staff_name, role, device, last_seen FROM portal_presence WHERE last_seen > $1 ORDER BY last_seen DESC LIMIT 100`, [new Date(now().getTime() - 7 * 24 * 60 * MIN).toISOString()]);
      return (r.rows || []).map((x) => ({ staffId: x.staff_id, name: x.staff_name || null, role: x.role, device: x.device, lastSeen: x.last_seen instanceof Date ? x.last_seen.toISOString() : x.last_seen }));
    } catch { return null; }
  }

  app.get("/api/portal/wa-handovers", async (c) => {
    const a = await deps.requirePortal(c); if (a.res) return a.res;
    touch(a.user, c.req.header ? c.req.header("user-agent") : null);
    try { return c.json({ ok: true, handovers: await openList() }); }
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

  return { emit, openList, ringDue, escalate, touch, presence, ready };
}
