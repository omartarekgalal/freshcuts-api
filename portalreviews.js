/* ═══════════════════════════════════════════════════════════════════════════
   ⭐ التقييمات الواطية في بورتال المدير (RV1 — عمر ١٥/١٠/٢٠٢٦ ١٤:١٥)

   عمر بنصّه: «التقييمات لازم تظهر ف البورتال عند المدير عشان يقفلها من عنده».
   في آخر ٦٠ يوم كان فيه ٧ تقييمات واطية ومااتقفلش ولا واحد في الوارد — مفيش حد بيشوفها وهو واقف في المطعم.

   القواعد:
     • مصدر واحد: نفس صف التقييم (reviews) اللي «التقييمات ← الوارد» في اللوحة بيقراه. القفل من البورتال = resolved / resolved_by /
       resolution_note زي «تم الحل» في اللوحة بالظبط، و«تم الحل» في اللوحة بقت بتنادي نفس الدالة (closeReview). مفيش نسخة تانية.
     • التقييم الواطي = أقل من ٤ نجوم (أو «يحتاج تحسين» من قالب واتساب)، حقيقي (مش تجربة ولا مخفي)، من آخر ٣٠ يوم وهو مفتوح،
       أو اتقفل في آخر ٧ أيام (للمراجعة).
     • النتيجة (outcome): «اتحلت» / «مش عميل» / «اتقفلت من غير إجراء» ⇒ بيتقفل. «اتواصلنا ومحتاج متابعة» / «اتصلنا ومحدش رد» ⇒ بيفضل مفتوح
       في «متابعة» (والعميل ده مابيتسألش تقييم تاني طول ما عنده تقييم واطي مفتوح — reviews.js open_complaint).
     • سجل الإجراءات (review_actions): كل ملاحظة / اتصال / واتساب / نتيجة / رجوع — مين وإمتى ومن فين (البورتال أو اللوحة).
     • «شافها» (portal_seen_at): أول ما المدير يفتح شاشة التقييمات، اللي كان جديد بيتعلّم اتشاف ⇒ عدّاد «جديد» بيصفر. الرنّة الهادية بتحصل
       في البورتال لما يوصل تقييم واطي جديد (عدّاد الجديد زاد) — مرة واحدة، مش رنّة متكررة.
     • القفل بيقفل كمان تنبيه واتساب «تقييم واطي» المفتوح لنفس العميل (wa_handovers.reason = review_low) ⇒ الرنّة بتاعته بتسكت في كل البوابات.
     • الأدوار: المدير (والمالك بمفتاح اللوحة = مدير في البوابة). الكاشير لأ — إلا لو الإعداد waBot.reviewFlow.portalCashier مفتوح.
       المطبخ أبداً (requirePortal بيقفله).
   مفيش أي رسالة للعميل من هنا: «اتصل» = tel: من موبايل المدير، و«واتساب» = محادثة البوابة نفسها (حارس الإرسال المعتاد).
═══════════════════════════════════════════════════════════════════════════ */
import { KIND_AR, REVIEW_KINDS } from "./wareviews.js";
import { reviewPortalRole } from "./reviewaudience.js";

export const REVIEW_PORTAL_DDL = `
  ALTER TABLE reviews ADD COLUMN IF NOT EXISTS outcome TEXT;
  ALTER TABLE reviews ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ;
  ALTER TABLE reviews ADD COLUMN IF NOT EXISTS outcome_by TEXT;
  ALTER TABLE reviews ADD COLUMN IF NOT EXISTS outcome_via TEXT;
  ALTER TABLE reviews ADD COLUMN IF NOT EXISTS portal_seen_at TIMESTAMPTZ;
  ALTER TABLE reviews ADD COLUMN IF NOT EXISTS portal_seen_by TEXT;
  CREATE TABLE IF NOT EXISTS review_actions (
    id BIGSERIAL PRIMARY KEY,
    review_id BIGINT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    by_name TEXT,
    by_role TEXT,
    via TEXT,                -- portal | dashboard
    action TEXT NOT NULL,    -- note | call | wa | outcome | reopen
    outcome TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS review_actions_review_idx ON review_actions(review_id, at);
  CREATE INDEX IF NOT EXISTS reviews_low_open_idx ON reviews(created_at DESC) WHERE rating < 4 AND NOT resolved;
`;

/* النتايج — كلام فريق (لهجة المطعم). closes = بيتقفل؛ غير كده بيفضل مفتوح في «متابعة». needsNote = لازم سبب مكتوب. */
export const OUTCOMES = Object.freeze([
  Object.freeze({ id: "resolved", ar: "اتحلت ✅", hint: "كلّمنا العميل والمشكلة اتحلت", closes: true }),
  Object.freeze({ id: "follow_up", ar: "اتواصلنا ومحتاج متابعة", hint: "بيفضل مفتوح في «متابعة» لحد ما تقفله", closes: false }),
  Object.freeze({ id: "no_answer", ar: "اتصلنا ومحدش رد", hint: "بيفضل في «متابعة» — جرّب تاني", closes: false }),
  Object.freeze({ id: "not_customer", ar: "مش عميل / رقم غلط", hint: "بيتقفل", closes: true }),
  Object.freeze({ id: "closed", ar: "اتقفلت من غير إجراء", hint: "اكتب السبب", closes: true, needsNote: true }),
]);
export const outcomeOf = (id) => OUTCOMES.find((o) => o.id === id) || null;
export const FOLLOW_OUTCOMES = Object.freeze(OUTCOMES.filter((o) => !o.closes).map((o) => o.id));
const ACTION_AR = Object.freeze({ note: "ملاحظة", call: "اتصل بالعميل", wa: "فتح محادثة واتساب", outcome: "نتيجة", reopen: "رجّعه مفتوح" });

const clip = (v, n) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s ? s.slice(0, n) : null; };
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
/* الشرط المشترك للتقييم الواطي الحقيقي */
export const LOW_REAL_SQL = "r.rating < 4 AND NOT COALESCE(r.is_test, false) AND r.hidden_at IS NULL";
const IN_PORTAL_SQL = `${LOW_REAL_SQL} AND ((NOT r.resolved AND r.created_at > NOW() - INTERVAL '30 days') OR (r.resolved AND r.resolved_at > NOW() - INTERVAL '7 days'))`;

export const COUNTS_SQL = `SELECT
    count(*) FILTER (WHERE NOT r.resolved AND (r.outcome IS NULL OR NOT (r.outcome = ANY($1::text[]))))::int AS new,
    count(*) FILTER (WHERE NOT r.resolved AND r.outcome = ANY($1::text[]))::int AS follow,
    count(*) FILTER (WHERE r.resolved)::int AS closed,
    count(*) FILTER (WHERE NOT r.resolved AND r.portal_seen_at IS NULL AND r.outcome IS NULL)::int AS unread,
    max(r.id) FILTER (WHERE NOT r.resolved AND r.portal_seen_at IS NULL AND r.outcome IS NULL) AS newest_unread
  FROM reviews r WHERE ${IN_PORTAL_SQL}`;
export const LIST_SQL = `SELECT r.id, r.rating, r.rating_exact, r.comment, r.categories, r.code_label, r.channel, r.kind, r.order_no, r.phone_norm, r.name,
    r.created_at, r.resolved, r.resolved_by, r.resolved_at, r.resolution_note, r.outcome, r.outcome_at, r.outcome_by, r.outcome_via,
    r.portal_seen_at, r.portal_seen_by,
    (SELECT iv.ref FROM review_invites iv WHERE iv.review_id = r.id OR (r.order_no IS NOT NULL AND iv.order_no = r.order_no) ORDER BY iv.created_at DESC LIMIT 1) AS ref
  FROM reviews r WHERE ${IN_PORTAL_SQL}
  ORDER BY r.resolved, r.created_at DESC LIMIT 100`;

export function countsOf(row) {
  const r = row || {};
  const n = (v) => Math.max(0, Number(v) || 0);
  return { new: n(r.new), follow: n(r.follow), closed: n(r.closed), open: n(r.new) + n(r.follow), unread: n(r.unread), newestUnread: r.newest_unread != null ? Number(r.newest_unread) : null };
}

/* صف القاعدة ⇒ الكارت اللي البوابة بتعرضه (صافي) */
export function publicReview(r, actions = []) {
  const pn = /^5\d{8}$/.test(String(r.phone_norm || "")) ? String(r.phone_norm) : null;
  const exact = r.rating_exact !== false;
  const kind = REVIEW_KINDS.includes(r.kind) ? r.kind : null;
  const orderNo = /^W\d{6,20}$/.test(String(r.order_no || "")) ? String(r.order_no) : null;
  const ref = r.ref ? String(r.ref) : orderNo || (/^pos:/.test(String(r.order_no || "")) ? "طلب من الكاشير" : null);
  const status = r.resolved ? "closed" : FOLLOW_OUTCOMES.includes(r.outcome) ? "follow" : "new";
  const oc = r.outcome ? outcomeOf(r.outcome) : null;
  return {
    id: Number(r.id), rating: Number(r.rating), exact,
    stars: exact ? "⭐".repeat(Math.max(1, Math.min(5, Number(r.rating) || 1))) : null,
    ratingAr: exact ? `${Number(r.rating)} من ٥` : "يحتاج تحسين",
    kind, kindAr: kind ? KIND_AR[kind] : (r.code_label || null),
    channel: r.channel || null, channelAr: r.channel === "whatsapp" ? "واتساب" : r.channel === "sms" ? "رسالة بعد الطلب" : r.channel === "qr" ? "QR" : r.channel === "nfc" ? "NFC" : r.channel ? "صفحة التقييم" : null,
    orderNo, ref, name: r.name || null,
    phone: pn ? `0${pn}` : null, phoneMasked: pn ? `…${pn.slice(-4)}` : null, waPhone: pn,
    comment: r.comment || null, categories: Array.isArray(r.categories) ? r.categories : [],
    at: iso(r.created_at), status, unread: !r.resolved && !r.portal_seen_at && !r.outcome,
    outcome: r.outcome || null, outcomeAr: oc ? oc.ar : r.outcome || null, outcomeAt: iso(r.outcome_at), outcomeBy: r.outcome_by || null, outcomeVia: r.outcome_via || null,
    resolvedAt: iso(r.resolved_at), resolvedBy: r.resolved_by || null, note: r.resolution_note || null,
    actions: (actions || []).map((a) => ({ at: iso(a.at), by: a.by_name || null, role: a.by_role || null, via: a.via || null, action: a.action,
      actionAr: ACTION_AR[a.action] || a.action, outcome: a.outcome || null, outcomeAr: a.outcome ? (outcomeOf(a.outcome) || {}).ar || a.outcome : null, note: a.note || null })),
  };
}

async function logAction(pool, { id, action, outcome = null, note = null, by = null, role = null, via = "portal" }) {
  await pool.query(`INSERT INTO review_actions(review_id, action, outcome, note, by_name, by_role, via) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, action, outcome, note, clip(by, 60), clip(role, 20), via]);
}
/* تنبيه واتساب «تقييم واطي» المفتوح لنفس العميل بيتقفل مع التقييم (الجدول ممكن مايكونش موجود ⇒ ولا حاجة) */
async function ackLowHandovers(pool, phone, by) {
  if (!/^5\d{8}$/.test(String(phone || ""))) return [];
  try {
    const r = await pool.query("UPDATE wa_handovers SET acked_at=NOW(), acked_by=$2 WHERE phone_norm=$1 AND reason='review_low' AND acked_at IS NULL RETURNING id", [phone, clip(`تقييم: ${by || "المدير"}`, 60)]);
    return (r.rows || []).map((x) => Number(x.id));
  } catch { return []; }
}

/* القفل / المتابعة — الدالة الوحيدة اللي بتكتب نتيجة تقييم (البورتال + «تم الحل» في اللوحة).
   ⇒ { ok, status: closed|follow, outcome, by, handoversAcked } أو { ok:false, error } */
export async function closeReview(pool, { id, outcome = "resolved", note = null, by = null, role = null, via = "portal" } = {}) {
  const oc = outcomeOf(outcome);
  if (!oc) return { ok: false, error: "bad_outcome", message: "اختار نتيجة من القايمة" };
  const nt = clip(note, 500);
  if (oc.needsNote && !nt) return { ok: false, error: "note_required", message: "اكتب السبب في الملاحظة" };
  const who = clip(by, 60) || "المدير";
  const label = oc.ar.replace(/\s*✅\s*$/, "");
  const summary = `${label}${nt ? ` — ${nt}` : ""}`.slice(0, 500);
  const r = oc.closes
    ? await pool.query(`UPDATE reviews SET resolved=TRUE, resolved_by=$2, resolved_at=NOW(), resolution_note=$3, outcome=$4, outcome_at=NOW(), outcome_by=$2, outcome_via=$5,
                               portal_seen_at=COALESCE(portal_seen_at, NOW()), portal_seen_by=COALESCE(portal_seen_by, $2)
                         WHERE id=$1 RETURNING phone_norm`, [id, who, summary, oc.id, via])
    : await pool.query(`UPDATE reviews SET resolved=FALSE, resolved_by=NULL, resolved_at=NULL, resolution_note=$3, outcome=$4, outcome_at=NOW(), outcome_by=$2, outcome_via=$5,
                               portal_seen_at=COALESCE(portal_seen_at, NOW()), portal_seen_by=COALESCE(portal_seen_by, $2)
                         WHERE id=$1 RETURNING phone_norm`, [id, who, summary, oc.id, via]);
  if (!r.rowCount) return { ok: false, error: "not_found", message: "التقييم مش موجود" };
  await logAction(pool, { id, action: "outcome", outcome: oc.id, note: nt, by: who, role, via }).catch(() => {});
  const handoversAcked = await ackLowHandovers(pool, r.rows[0] && r.rows[0].phone_norm, who);
  return { ok: true, status: oc.closes ? "closed" : "follow", outcome: oc.id, by: who, handoversAcked };
}

export function register(app, ctx, deps = {}) {
  const { pool, getSettingsData } = ctx;
  const log = deps.log || console;
  const ready = async () => { try { return typeof deps.ready === "function" ? (await deps.ready()) !== false : true; } catch { return false; } };
  /* كل أحداث الملف ده لجمهور التقييمات بس (المدير، والكاشير لو الإعداد مفتوح) — portal.js broadcast بيفلتر بالدور */
  const say = (ev, d) => { try { deps.broadcast?.(ev, d, { scope: "reviews" }); } catch (e) { log.error("[portal-reviews] broadcast:", e.message); } };
  const audit = (user, action, ok, detail) => { try { deps.audit?.(user, action, null, ok, detail, null, { emit: false }); } catch { /* السجل مايوقفش حاجة */ } };

  /* المدير (والمالك) دايماً؛ الكاشير بس لو الإعداد مفتوح؛ المطبخ أبداً (requirePortal). ⇒ { user } أو { res } */
  async function access(c) {
    const a = await deps.requirePortal(c);
    if (a.res) return a;
    if (a.user.role === "manager") return a;
    let s = null;
    try { s = await getSettingsData(); } catch { s = null; }
    if (reviewPortalRole(a.user.role, s)) return a;      // نفس القاعدة اللي البث والإشعارات وقايمة التحويلات بيفلتروا بيها (reviewaudience.js)
    return { res: c.json({ ok: false, error: "forbidden", message: "التقييمات للمدير بس" }, 403) };
  }
  const who = (u) => clip((u && (u.name || u.role)) || "البوابة", 60);
  const unavailable = (c) => c.json({ ok: false, error: "unavailable", message: "التقييمات مش متاحة دلوقتي — جرّب تاني بعد دقيقة" }, 503);
  async function counts() { return countsOf(((await pool.query(COUNTS_SQL, [FOLLOW_OUTCOMES])).rows || [])[0]); }
  /* التقييم لازم يكون واطي وحقيقي (البوابة مابتقفلش تقييمات عالية ولا تجارب) */
  async function lowRow(id) {
    const r = await pool.query("SELECT id, rating, phone_norm, resolved, is_test, hidden_at FROM reviews WHERE id=$1", [id]);
    const x = r.rows && r.rows[0];
    return x && Number(x.rating) < 4 && !x.is_test && !x.hidden_at ? x : null;
  }
  const idOf = (c) => { const n = Number(c.req.param("id")); return Number.isInteger(n) && n > 0 ? n : null; };
  const body = async (c) => { try { const b = await c.req.json(); return b && typeof b === "object" ? b : {}; } catch { return {}; } };

  app.get("/api/portal/reviews", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    if (!(await ready())) return unavailable(c);
    try {
      const rows = (await pool.query(LIST_SQL)).rows || [];
      const ids = rows.map((r) => Number(r.id));
      const acts = ids.length ? ((await pool.query("SELECT review_id, at, by_name, by_role, via, action, outcome, note FROM review_actions WHERE review_id = ANY($1::bigint[]) ORDER BY at, id", [ids])).rows || []) : [];
      const by = new Map();
      for (const x of acts) { const k = Number(x.review_id); if (!by.has(k)) by.set(k, []); by.get(k).push(x); }
      return c.json({ ok: true, reviews: rows.map((r) => publicReview(r, by.get(Number(r.id)) || [])), counts: await counts(), outcomes: OUTCOMES,
        role: a.user.role, canReopen: a.user.role === "manager" });
    } catch (e) { log.error("[portal-reviews] list:", e.message); return unavailable(c); }
  });

  /* العدّاد الخفيف (البوابة بتسأله كل ٣٠ ث والشاشة ظاهرة) — 403 للكاشير من غير الإعداد ⇒ التاب مابيظهرش عنده */
  app.get("/api/portal/reviews/counts", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    if (!(await ready())) return unavailable(c);
    try { return c.json({ ok: true, counts: await counts() }); }
    catch (e) { log.error("[portal-reviews] counts:", e.message); return unavailable(c); }
  });

  /* فتح الشاشة = اللي كان «جديد» اتشاف (عدّاد الجديد بيصفر عند الكل) */
  app.post("/api/portal/reviews/seen", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const b = await body(c);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100);
    if (!ids.length) return c.json({ ok: true, seen: 0 });
    if (!(await ready())) return unavailable(c);
    const r = await pool.query(`UPDATE reviews SET portal_seen_at=NOW(), portal_seen_by=$2 WHERE id = ANY($1::bigint[]) AND portal_seen_at IS NULL AND rating < 4 RETURNING id`, [ids, who(a.user)]);
    if (r.rowCount) say("review_update", { ids: (r.rows || []).map((x) => Number(x.id)), seen: true });
    return c.json({ ok: true, seen: r.rowCount || 0 });
  });

  app.post("/api/portal/reviews/:id/close", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const id = idOf(c); if (!id) return c.json({ ok: false, error: "bad_id" }, 400);
    if (!(await ready())) return unavailable(c);
    if (!(await lowRow(id))) return c.json({ ok: false, error: "not_found", message: "التقييم مش موجود أو مش تقييم واطي" }, 404);
    const b = await body(c);
    const r = await closeReview(pool, { id, outcome: b.outcome, note: b.note, by: who(a.user), role: a.user.role, via: "portal" });
    audit(a.user, "review_close", r.ok, { id, outcome: b.outcome || null, error: r.ok ? null : r.error });
    if (!r.ok) return c.json(r, r.error === "not_found" ? 404 : 400);
    for (const hid of r.handoversAcked || []) say("wa_handover_ack", { id: hid, by: r.by });
    say("review_update", { id, status: r.status, outcome: r.outcome, by: r.by });
    return c.json({ ok: true, id, status: r.status, outcome: r.outcome, counts: await counts().catch(() => null) });
  });

  app.post("/api/portal/reviews/:id/note", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const id = idOf(c); if (!id) return c.json({ ok: false, error: "bad_id" }, 400);
    const note = clip((await body(c)).note, 500);
    if (!note) return c.json({ ok: false, error: "empty", message: "اكتب الملاحظة" }, 400);
    if (!(await ready())) return unavailable(c);
    if (!(await lowRow(id))) return c.json({ ok: false, error: "not_found", message: "التقييم مش موجود أو مش تقييم واطي" }, 404);
    await logAction(pool, { id, action: "note", note, by: who(a.user), role: a.user.role });
    await pool.query("UPDATE reviews SET portal_seen_at=COALESCE(portal_seen_at, NOW()), portal_seen_by=COALESCE(portal_seen_by, $2) WHERE id=$1", [id, who(a.user)]);
    say("review_update", { id, note: true });
    return c.json({ ok: true, id });
  });

  /* «اتصل» / «واتساب» اتداس — بيتسجّل في السجل عشان اللوحة تعرف إن حد كلّم العميل (الاتصال نفسه من موبايل المدير) */
  app.post("/api/portal/reviews/:id/contact", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    const id = idOf(c); if (!id) return c.json({ ok: false, error: "bad_id" }, 400);
    const via = (await body(c)).via;
    if (!["call", "wa"].includes(via)) return c.json({ ok: false, error: "bad_via" }, 400);
    if (!(await ready())) return unavailable(c);
    if (!(await lowRow(id))) return c.json({ ok: false, error: "not_found" }, 404);
    await logAction(pool, { id, action: via, by: who(a.user), role: a.user.role });
    await pool.query("UPDATE reviews SET portal_seen_at=COALESCE(portal_seen_at, NOW()), portal_seen_by=COALESCE(portal_seen_by, $2) WHERE id=$1", [id, who(a.user)]);
    return c.json({ ok: true, id });
  });

  /* اتقفل بالغلط ⇒ يرجع مفتوح (المدير بس) */
  app.post("/api/portal/reviews/:id/reopen", async (c) => {
    const a = await access(c); if (a.res) return a.res;
    if (a.user.role !== "manager") return c.json({ ok: false, error: "forbidden", message: "الرجوع للمدير بس" }, 403);
    const id = idOf(c); if (!id) return c.json({ ok: false, error: "bad_id" }, 400);
    if (!(await ready())) return unavailable(c);
    if (!(await lowRow(id))) return c.json({ ok: false, error: "not_found" }, 404);
    await pool.query("UPDATE reviews SET resolved=FALSE, resolved_by=NULL, resolved_at=NULL, resolution_note=NULL, outcome=NULL, outcome_at=NULL, outcome_by=NULL, outcome_via=NULL WHERE id=$1", [id]);
    await logAction(pool, { id, action: "reopen", by: who(a.user), role: a.user.role });
    audit(a.user, "review_reopen", true, { id });
    say("review_update", { id, status: "new" });
    return c.json({ ok: true, id, status: "new" });
  });

  return { counts, access };
}
