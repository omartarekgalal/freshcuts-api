/* ═══════════════════════════════════════════════════════════════════════════
   🔔 تحويلات واتساب على بوابة المطعم (١٣/١٠)

   البوت (wabotrun.js) لما يحوّل محادثة لموظف بيطلّع حدث `wa_handover` على قناة البوابة الحيّة. الحدث لوحده بيوصل للشاشات
   المفتوحة في اللحظة دي بس. الملف ده بيخلّيه «زي الطلب الجديد»:
     • بيسجّل كل تحويل في جدول (wa_handovers) — البوابة اللي تتفتح بعدين بتلاقي تحويلات اليوم التشغيلي اللي ماحدش قال عليها «تم».
     • بيضيف للحدث رقم التحويل وآخر رسالة من العميل، وبيبعت إشعار Web Push لأجهزة البوابة (نفس اشتراكات إشعارات الطلبات).
     • «تم» من أي جهاز بتشيل الكارت من كل الشاشات (حدث wa_handover_ack).
   مفيش أي إرسال للعميل من هنا، ومفيش تعديل في جداول البوت. رسالة SMS لعمر والمدير زي ما هي (البوت بيبعتها).
   وضع التجربة: الكارت بيظهر وعليه «تجربة»، من غير Web Push.
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
`;

/* صف الجدول ⇒ الشكل اللي البوابة بتعرضه (نفس حقول حدث البوت + id و lastText) */
export function publicRow(r) {
  const pn = String(r.phone_norm || "");
  return { id: Number(r.id), phone: `0${pn}`, phoneMasked: `…${pn.slice(-4)}`, reason: r.reason, reasonAr: r.reason_ar || r.reason,
    urgent: r.urgent === true, orderNo: r.order_no || null, at: r.at instanceof Date ? r.at.toISOString() : r.at, test: r.test === true,
    lastText: r.last_text || null };
}
export function pushPayloadFor(row, baseUrl) {
  const p = publicRow(row);
  return { kind: "wa_handover", title: `${p.urgent ? "🚨" : "💬"} واتساب: ${p.reasonAr}`,
    body: `عميل ${p.phoneMasked} محتاج موظف${p.orderNo ? ` · طلب ${p.orderNo}` : ""}`,
    url: baseUrl, tag: `wa-handover-${p.id}`, renotify: true, urgency: p.urgent ? "high" : "normal", ttl: 900, requireInteraction: p.urgent };
}

export function register(app, ctx, deps = {}) {
  const { pool } = ctx;
  const now = deps.now || (() => new Date());
  const log = deps.log || console;
  const ready = pool.query(DDL).then(() => true).catch((e) => { log.error("[wa-handover] schema:", e.message); return false; });

  /* البوت نده: سجّل، وبعدين ابعت الحدث (بالـid وآخر رسالة) + الإشعار. أي فشل في التسجيل مايمنعش الحدث الحي. */
  async function emit(data) {
    const d = data && typeof data === "object" ? data : {};
    const pn = normPhone(d.phone);
    let row = null;
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
        const push = typeof deps.push === "function" ? deps.push() : deps.push;
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

  app.get("/api/portal/wa-handovers", async (c) => {
    const a = await deps.requirePortal(c); if (a.res) return a.res;
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

  return { emit, openList, ready };
}
