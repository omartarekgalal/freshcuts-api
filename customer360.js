/* ═══════════════════════════════════════════════════════════════════════════
   CUSTOMER 360 — ملف العميل الكامل + سجل الرسايل + قايمة الإيقاف (١٩/٩)

   طلب عمر: «أدوّر على عميل بالاسم/الجوال/رقم الطلب وأفتح ملفه كامل» — كل
   طلباته من كل القنوات، أول/آخر طلب، التكرار، متوسط الطلب، أكلاته المفضّلة،
   عناوينه، كوبوناته، رحلته على الموقع، سلاته المتروكة، كل رسالة اتبعتتله،
   إيقافه للرسايل، تقييماته، وملاحظات الفريق.

   الهوية = الجوال بعد التطبيع (identity.js). الربط:
   • نقطة البيع: order_sources.phone_norm أو ts_customers عن طريق customer_id.
   • الموقع: shop_orders.phone_norm (+ deviceId في customer).
   • الرحلة: journey_sessions.phone_norm (بعد الـOTP) — والجلسات المجهولة
     القديمة لنفس الجهاز بتتربط وقت العرض: anon_id من journey_identities،
     shop_carts.device_id، shop_orders.customer.deviceId، push_subs.device_id،
     والجلسات اللي اتعرّفت قبل كده (anon_id بتاعها).
   • طلب الموقع اللي نزل نقطة البيع كـExternal (شريك تاب سينس) بيتعدّ مرة
     واحدة: نفس الجوال + فرق الإجمالي < ١٫٥ ر.س + في خلال −١ → +٦ ساعات
     من طلب الموقع (matchWebToPos) — نفس القاعدة في SQL قائمة (quickStats).

   الجوال مخفي دايماً (٠٥•••••٨٢)؛ «إظهار» للمالك بس وبيتسجّل في cms_audit.
   الرابط بين الشاشات «ref» — بصمة HMAC مش الرقم — فالجوال مايظهرش في الـURL.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import {
  normPhone, maskPhone, FIRST_ORDER_CTE, SHOP_NOT_ORDER_STATUSES, shopPaidSql, bizDaySql, isNewCustomer,
  IDENTITY_RULES_AR,
} from "./identity.js";
import { initSmsLog, SMS_KINDS, partsOf } from "./smslog.js";
import { staffPhoneSet, itemFamily } from "./smsrules.js";
import { plausibleName } from "./accounts.js";

export const MATCH_TOTAL_TOL = 1.5;      // ر.س — تقريب تاب سينس
export const MATCH_BEFORE_MS = 3600_000; // ساعة قبل طلب الموقع
export const MATCH_AFTER_MS = 6 * 3600_000;
export const SMS_PART_PRICE = 0.075;     // ر.س للجزء — من فواتير تقنيات (٢ جزء = ٠٫١٥)

const APPS = ["keeta", "hungerstation", "ninja", "jahez", "toyou", "mrsool", "careem", "feedus"];
export const CHANNEL_LABELS = {
  inhouse: "المطعم (صالة/استلام)", website: "متجرنا (الموقع)", keeta: "كيتا", hungerstation: "هنقرستيشن",
  ninja: "نينجا", jahez: "جاهز", toyou: "تو يو", mrsool: "مرسول", careem: "كريم", feedus: "فيدأس",
  external: "تطبيق توصيل (غير محدد)",
};
const STEP_LABELS = ["دخل الموقع", "فتح عرض أو صنف", "أضاف للسلة", "فتح إتمام الطلب", "حدّد عنوان", "أكّد جواله", "وصل للدفع", "دفع"];

/* ── تصنيف الأصناف: مشاوي/وجبات مقابل بوكسات (بيتزا/كريب/باستا/حواوشي)… ── */
const CATS = [
  { id: "meal", label: "وجبات", words: ["وجبة", "وجبه"] },
  { id: "grill", label: "مشاوي بالوزن", words: ["مشوي", "بالوزن", "كفتة", "كفته", "طرب", "ريش", "كباب", "شيش", "مشكل", "على الفحم", "كبدة", "كبده", "شقف", "فراخ مشوية"] },
  { id: "pizza", label: "بيتزا", words: ["بيتزا"] },
  { id: "crepe", label: "كريب", words: ["كريب"] },
  { id: "pasta", label: "مكرونة وباستا", words: ["باستا", "مكرونة", "مكرونه", "بشاميل", "الفريدو", "ماك اند تشيز", "نجرسكو", "كريمي مشروم"] },
  { id: "hawawshi", label: "حواوشي", words: ["حواوشي"] },
  { id: "burger", label: "برجر", words: ["برجر", "برقر", "تشيكن ساندوتش"] },
  { id: "drinks", label: "مشروبات", words: ["مياه", "مشروب", "غازي", "عصير", "بيبسي", "كولا", "سفن", "ميرندا"] },
  { id: "sides", label: "إضافات", words: ["رز", "ارز", "أرز", "سلطة", "سلطه", "طحينة", "طحينه", "بطاطس", "خبز", "عيش", "صوص"] },
];
export function itemCategory(name) {
  const n = String(name || "");
  for (const c of CATS) if (c.words.some((w) => n.includes(w))) return c.id;
  return "other";
}
export const CATEGORY_LABELS = Object.fromEntries([...CATS.map((c) => [c.id, c.label]), ["other", "أخرى"]]);

/* قناة طلب نقطة البيع */
export function posChannel(o) {
  const t = String(o.order_type || "").toLowerCase();
  if (t.includes("qr-menu")) return "website";
  const note = String(o.source_note || "").trim().toLowerCase();
  const payKey = Object.keys(o.payments || {}).map((k) => k.toLowerCase()).find((k) => APPS.includes(k));
  if (APPS.includes(note)) return note;
  if (t.includes("external") || payKey) return payKey || "external";
  return "inhouse";
}
export const isVoid = (o) => /void|refund/i.test(String(o.order_type || ""));

/* طلب الموقع ↔ نسخته في نقطة البيع (Partner External / QR). بيرجّع
   Map(posOrderId → webOrderNo). أقرب وقت يكسب، وكل طلب نقطة بيع لمرة واحدة. */
export function matchWebToPos(webOrders, posOrders) {
  const out = new Map();
  const used = new Set();
  for (const w of [...webOrders].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    const wt = new Date(w.at).getTime();
    if (w.posOrderId && posOrders.some((p) => String(p.id) === String(w.posOrderId) && !used.has(p.id))) {
      used.add(String(w.posOrderId)); out.set(String(w.posOrderId), w.orderNo); continue;
    }
    let best = null, bestD = Infinity;
    for (const p of posOrders) {
      if (used.has(p.id) || p.void) continue;
      if (p.channel === "inhouse") continue;
      const d = new Date(p.at).getTime() - wt;
      if (d < -MATCH_BEFORE_MS || d > MATCH_AFTER_MS) continue;
      if (Math.abs(Number(p.total) - Number(w.total)) >= MATCH_TOTAL_TOL) continue;
      if (Math.abs(d) < bestD) { best = p; bestD = Math.abs(d); }
    }
    if (best) { used.add(best.id); out.set(best.id, w.orderNo); }
  }
  return out;
}

/* ملخص الطلبات (من غير I/O) — للملف وللاختبارات */
export function summarize(orders, now = new Date()) {
  const real = orders.filter((o) => !o.void && !o.dupOf);
  const sorted = [...real].sort((a, b) => new Date(a.at) - new Date(b.at));
  const spend = real.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const first = sorted[0] || null, last = sorted[sorted.length - 1] || null;
  const DAY = 86400_000;
  let avgGapDays = null;
  if (sorted.length >= 2) avgGapDays = Math.round(((new Date(last.at) - new Date(first.at)) / DAY / (sorted.length - 1)) * 10) / 10;
  const ch = new Map();
  for (const o of real) {
    const x = ch.get(o.channel) || { id: o.channel, label: CHANNEL_LABELS[o.channel] || o.channel, orders: 0, spend: 0 };
    x.orders++; x.spend += Number(o.total) || 0; ch.set(o.channel, x);
  }
  return {
    orders: real.length,
    spend: Math.round(spend * 100) / 100,
    aov: real.length ? Math.round((spend / real.length) * 100) / 100 : null,
    firstOrderAt: first?.at || null, firstChannel: first?.channel || null,
    lastOrderAt: last?.at || null, lastChannel: last?.channel || null,
    daysSinceLast: last ? Math.floor((now - new Date(last.at)) / DAY) : null,
    avgGapDays,
    channels: [...ch.values()].map((x) => ({ ...x, spend: Math.round(x.spend * 100) / 100 })).sort((a, b) => b.orders - a.orders),
    voided: orders.filter((o) => o.void).length,
  };
}

export function favorites(orders) {
  const items = new Map(), cats = new Map();
  let fam = { grill: 0, box: 0 };
  for (const o of orders) {
    if (o.void || o.dupOf) continue;
    for (const it of o.items || []) {
      const name = String(it.name || "").trim();
      if (!name) continue;
      const q = Number(it.qty) || 1;
      const x = items.get(name) || { name, qty: 0, orders: 0, category: itemCategory(name) };
      x.qty += q; x.orders++; items.set(name, x);
      const c = x.category;
      cats.set(c, (cats.get(c) || 0) + q);
      const f = itemFamily(name);
      if (f === "grill" || f === "box") fam[f] += q;
    }
  }
  const total = [...cats.values()].reduce((a, b) => a + b, 0);
  const lean = fam.grill > fam.box * 1.5 ? "grill" : fam.box > fam.grill * 1.5 ? "box" : (fam.grill + fam.box ? "mixed" : null);
  return {
    items: [...items.values()].sort((a, b) => b.qty - a.qty).slice(0, 12),
    categories: [...cats.entries()].map(([id, qty]) => ({ id, label: CATEGORY_LABELS[id] || id, qty, share: total ? Math.round((qty / total) * 1000) / 1000 : 0 }))
      .sort((a, b) => b.qty - a.qty),
    lean, leanLabel: lean === "grill" ? "بيحب المشاوي والوجبات" : lean === "box" ? "بيحب البوكسات (بيتزا/كريب/باستا/حواوشي)" : lean === "mixed" ? "مشكّل" : null,
  };
}

/* ── ref: بصمة الجوال (مش الرقم) ── */
const REF_SECRET = () => process.env.C360_REF_SECRET || process.env.ADMIN_TOKEN || "c360";
export const refOf = (pn) => (pn ? "c" + crypto.createHmac("sha256", REF_SECRET()).update(String(pn)).digest("hex").slice(0, 15) : null);

/* مجموعة الطلبات لقايمة جوالات (عدد/قيمة/أول/آخر) بنفس قاعدة منع التكرار */
export const QUICK_STATS_SQL = `
  WITH ts AS (
    SELECT COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) AS pn, o.order_id, o.order_date AS at, o.total
      FROM ts_orders o
      LEFT JOIN order_sources s ON s.order_id = o.order_id
      LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
     WHERE (s.phone_norm = ANY($1::text[]) OR tc.phone_norm = ANY($1::text[]))
       AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
  ), web AS (
    SELECT so.phone_norm AS pn, so.created_at AS at, so.total FROM shop_orders so
     WHERE so.phone_norm = ANY($1::text[]) AND ${shopPaidSql("so")}
       AND NOT EXISTS (SELECT 1 FROM ts t WHERE t.pn = so.phone_norm
                        AND abs(t.total - so.total) < ${MATCH_TOTAL_TOL}
                        AND t.at BETWEEN so.created_at - interval '1 hour' AND so.created_at + interval '6 hours')
  ), allo AS (SELECT pn, at, total FROM ts WHERE pn = ANY($1::text[]) UNION ALL SELECT pn, at, total FROM web)
  SELECT pn, count(*)::int AS orders, COALESCE(sum(total),0)::float AS spend, min(at) AS first_at, max(at) AS last_at
    FROM allo GROUP BY pn`;

/* كل الأسماء اللي شفناها لكل جوال — للبحث بالاسم */
const PEOPLE_SQL = `
  people AS (
    SELECT phone_norm AS pn, name, 'tabsense' AS src FROM ts_customers WHERE COALESCE(phone_norm,'') <> ''
    UNION ALL SELECT phone_norm, name, 'account' FROM acct_customers WHERE COALESCE(phone_norm,'') <> ''
    UNION ALL SELECT phone_norm, customer->>'name', 'web' FROM shop_orders WHERE COALESCE(phone_norm,'') <> ''
    UNION ALL SELECT phone_norm, customer_name, 'cashier' FROM order_sources WHERE COALESCE(phone_norm,'') <> ''
    UNION ALL SELECT phone_norm, name, 'review' FROM reviews WHERE COALESCE(phone_norm,'') <> ''
  )`;

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const digitsOf = (q) => String(q || "").replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d))).replace(/\D/g, "");

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const whoami = deps.whoami || (async () => null);

  /* ── الجداول ── */
  const ready = (async () => {
    await initSmsLog(pool);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS c360_refs (ref TEXT PRIMARY KEY, phone_norm TEXT UNIQUE NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS c360_notes (
        id BIGSERIAL PRIMARY KEY, phone_norm TEXT NOT NULL, body TEXT NOT NULL,
        author TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ);
      CREATE INDEX IF NOT EXISTS c360_notes_phone_idx ON c360_notes(phone_norm, created_at DESC);
      CREATE TABLE IF NOT EXISTS c360_tags (
        phone_norm TEXT PRIMARY KEY, tags TEXT[] NOT NULL DEFAULT '{}', updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS cms_migrations (id TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    `);
    await backfillSmsLog().catch((e) => console.error("[c360] sms backfill:", e.message));
  })().then(() => console.log("[c360] ready")).catch((e) => console.error("[c360] init failed:", e.message));

  /* سجل الرسايل اتعمل ١٩/٩ — اللي اتبعت قبل كده بيتنقل مرة واحدة من سجلات
     (v2: يغطي الفجوة بين تجربة v1 على الإنتاج والنشر — src_key بيمنع التكرار)
     كل موديول (الحملات مش منهم: بتتقرا حيّة من cms_campaign_sends). */
  async function backfillSmsLog() {
    const m = await pool.query(`INSERT INTO cms_migrations(id) VALUES ('sms_log_backfill_v2') ON CONFLICT DO NOTHING RETURNING at`);
    if (!m.rowCount) return;
    const cut = m.rows[0].at;
    const q = (sql) => pool.query(sql, [cut]).then((r) => r.rowCount).catch((e) => { console.error("[c360] backfill part:", e.message); return 0; });
    let n = 0;
    for (const step of [1, 2]) {
      n += await q(`INSERT INTO sms_log (at, phone_norm, kind, sender, ref, parts, cost, status, msg_id, origin, src_key)
        SELECT step${step}_at, phone_norm, 'cart_recovery', 'AD', code || ':${step}', NULL, step${step}_cost, 'sent', step${step}_msg_id, 'backfill', 'cart:' || id || ':${step}'
          FROM cart_recovery WHERE step${step}_channel = 'sms' AND step${step}_at < $1 ON CONFLICT (src_key) DO NOTHING`);
    }
    n += await q(`INSERT INTO sms_log (at, phone_norm, kind, ref, status, origin, src_key)
      SELECT sent_at, phone_norm, CASE WHEN order_no LIKE 'TEST-%' THEN 'test' ELSE 'review_invite' END, order_no, 'sent', 'backfill', 'rinv:' || order_no
        FROM review_invites WHERE channel = 'sms' AND sent_at IS NOT NULL AND sent_at < $1 ON CONFLICT (src_key) DO NOTHING`);
    n += await q(`INSERT INTO sms_log (at, phone_norm, kind, ref, status, error, origin, src_key)
      SELECT e.at, so.phone_norm, 'order_status', e.order_no || ':' || COALESCE(e.data->>'stage',''),
             CASE WHEN e.ok THEN 'sent' ELSE 'failed' END, e.data->>'error', 'backfill', 'ose:' || e.id
        FROM shop_order_events e JOIN shop_orders so ON so.order_no = e.order_no
       WHERE e.name = 'notify_sent' AND e.channel = 'sms' AND e.at < $1 ON CONFLICT (src_key) DO NOTHING`);
    n += await q(`INSERT INTO sms_log (at, phone_norm, kind, ref, status, origin, src_key)
      SELECT notified_at, phone_norm, 'waitlist', 'wait:' || id, 'sent', 'backfill', 'wait:' || id
        FROM open_waitlist WHERE channel = 'sms' AND notified_at IS NOT NULL AND notified_at < $1 ON CONFLICT (src_key) DO NOTHING`);
    console.log(`[c360] sms_log backfilled ${n} rows`);
  }

  async function remember(pns) {
    const list = [...new Set(pns.filter(Boolean))];
    if (!list.length) return;
    await ready;
    await pool.query(
      `INSERT INTO c360_refs(ref, phone_norm) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT DO NOTHING`,
      [list.map(refOf), list]).catch(() => {});
  }
  async function pnOfRef(ref) {
    if (!/^c[0-9a-f]{15}$/.test(String(ref || ""))) return null;
    await ready;
    return (await pool.query("SELECT phone_norm FROM c360_refs WHERE ref=$1", [ref])).rows[0]?.phone_norm || null;
  }
  async function isOwner(c) {
    try { const u = await whoami(c); return Boolean(u && u.role === "owner"); } catch { return false; }
  }
  async function quickStats(pns) {
    const list = [...new Set(pns.filter(Boolean))];
    if (!list.length) return new Map();
    const r = await pool.query(QUICK_STATS_SQL, [list]);
    return new Map(r.rows.map((x) => [x.pn, x]));
  }
  async function namesOf(pns) {
    const list = [...new Set(pns.filter(Boolean))];
    const out = new Map();
    if (!list.length) return out;
    const r = await pool.query(`WITH ${PEOPLE_SQL}
      SELECT pn, array_agg(DISTINCT btrim(name)) FILTER (WHERE COALESCE(btrim(name),'') <> '') AS names,
             array_agg(DISTINCT src) AS srcs
        FROM people WHERE pn = ANY($1::text[]) GROUP BY pn`, [list]);
    for (const x of r.rows) {
      const names = (x.names || []).filter(plausibleName);
      out.set(x.pn, { name: names[0] || null, names, sources: x.srcs || [] });
    }
    return out;
  }
  const bad = (c, error, status = 400) => c.json({ ok: false, error }, status);

  /* ═══ 🔎 البحث: اسم / جوال / رقم طلب ═══════════════════════════════════ */
  app.get("/api/cms/customers/search", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const raw = String(c.req.query("q") || "").trim().slice(0, 60);
    if (raw.length < 2) return c.json({ ok: true, results: [] });
    const hits = new Map(); // pn → matched
    const add = (pn, how) => { if (pn && !hits.has(pn)) hits.set(pn, how); };
    const dg = digitsOf(raw);
    const orderNo = /^w\d{4,}$/i.test(raw.replace(/\s/g, "")) ? raw.replace(/\s/g, "").toUpperCase() : null;
    if (orderNo) {
      for (const r of (await pool.query("SELECT phone_norm FROM shop_orders WHERE order_no=$1", [orderNo])).rows) add(r.phone_norm, "order");
    } else if (dg.length >= 3 && dg.length === raw.replace(/[\s+\-]/g, "").length) {
      const full = normPhone(dg);
      if (full) add(full, "phone");
      // رقم فاتورة/طلب نقطة البيع (٣–٦ أرقام)
      if (dg.length <= 7) {
        const r = await pool.query(
          `SELECT COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) AS pn FROM ts_orders o
             LEFT JOIN order_sources s ON s.order_id=o.order_id LEFT JOIN ts_customers tc ON tc.customer_id=o.customer_id
            WHERE o.order_id=$1 OR o.receipt=$1 LIMIT 5`, [dg]);
        for (const x of r.rows) add(x.pn, "pos_order");
      }
      if (!full && dg.length >= 4) {
        const tail = dg.replace(/^(00966|966|0)/, "");
        const r = await pool.query(`WITH ${PEOPLE_SQL} SELECT DISTINCT pn FROM people WHERE pn LIKE '%' || $1 || '%' LIMIT 20`, [tail]);
        for (const x of r.rows) add(x.pn, "phone");
      }
    } else {
      const words = raw.split(/\s+/).filter(Boolean).slice(0, 4);
      const conds = words.map((_, i) => `name ILIKE '%' || $${i + 1} || '%'`).join(" AND ");
      const r = await pool.query(`WITH ${PEOPLE_SQL} SELECT pn, count(*) AS n FROM people WHERE ${conds} GROUP BY pn ORDER BY n DESC LIMIT 25`, words);
      for (const x of r.rows) add(x.pn, "name");
    }
    const pns = [...hits.keys()];
    await remember(pns);
    const [stats, names] = await Promise.all([quickStats(pns), namesOf(pns)]);
    const results = pns.map((pn) => {
      const st = stats.get(pn) || {}, nm = names.get(pn) || {};
      return {
        ref: refOf(pn), name: nm.name || null, phoneMasked: maskPhone(pn), matched: hits.get(pn),
        orders: st.orders || 0, spend: Math.round((st.spend || 0) * 100) / 100, lastOrderAt: st.last_at || null,
        sources: nm.sources || [],
      };
    }).sort((a, b) => b.orders - a.orders || String(b.lastOrderAt || "").localeCompare(String(a.lastOrderAt || "")));
    return c.json({ ok: true, results });
  });

  /* ═══ 👤 الملف الكامل ═══════════════════════════════════════════════════ */
  app.get("/api/cms/customers/360/:ref", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const pn = await pnOfRef(c.req.param("ref"));
    if (!pn) return bad(c, "not_found", 404);
    try {
      return c.json({ ok: true, ...(await buildProfile(pn)), canReveal: await isOwner(c) });
    } catch (e) {
      console.error("[c360] profile failed:", e.message);
      return c.json({ ok: false, error: String(e.message).slice(0, 200) }, 500);
    }
  });

  app.get("/api/cms/customers/360/:ref/reveal", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "إظهار الرقم للمالك بس" }, 403);
    const pn = await pnOfRef(c.req.param("ref"));
    if (!pn) return bad(c, "not_found", 404);
    const u = await whoami(c).catch(() => null);
    pool.query(`INSERT INTO cms_audit(actor_id, actor_name, role, method, path, section, note) VALUES ($1,$2,$3,'GET',$4,'customers',$5)`,
      [u?.id || null, u?.name || "المالك", u?.role || "owner", "/api/cms/customers/360/:ref/reveal", `reveal ${maskPhone(pn)}`]).catch(() => {});
    return c.json({ ok: true, phone: "0" + pn });
  });

  /* أحداث جلسة من جلسات العميل ده بس */
  app.get("/api/cms/customers/360/:ref/session/:sid", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const pn = await pnOfRef(c.req.param("ref"));
    if (!pn) return bad(c, "not_found", 404);
    const sid = String(c.req.param("sid") || "").slice(0, 80);
    const anons = await anonIdsOf(pn);
    const s = (await pool.query(
      `SELECT session_id FROM journey_sessions WHERE session_id=$1 AND (phone_norm=$2 OR anon_id = ANY($3::text[]))`, [sid, pn, anons])).rows[0];
    if (!s) return bad(c, "not_found", 404);
    const ev = (await pool.query(
      `SELECT COALESCE(client_ts, at) AS at, source, name, step, path, props FROM journey_events
        WHERE session_id=$1 ORDER BY COALESCE(client_ts, at), id LIMIT 300`, [sid])).rows;
    return c.json({ ok: true, events: ev.map((e) => ({ ...e, props: trimProps(e.props) })) });
  });

  /* ملاحظات وتاجات الفريق (الكتابة = «تعديل» على العملاء) */
  app.post("/api/cms/customers/360/:ref/notes", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const pn = await pnOfRef(c.req.param("ref"));
    if (!pn) return bad(c, "not_found", 404);
    const b = await c.req.json().catch(() => ({}));
    const body = String(b.body || "").trim().slice(0, 1000);
    if (!body) return bad(c, "empty");
    const u = await whoami(c).catch(() => null);
    const r = await pool.query(`INSERT INTO c360_notes(phone_norm, body, author) VALUES ($1,$2,$3) RETURNING id, body, author, created_at`,
      [pn, body, u?.name || "فريق"]);
    return c.json({ ok: true, note: r.rows[0] });
  });
  app.delete("/api/cms/customers/360/:ref/notes/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const pn = await pnOfRef(c.req.param("ref"));
    if (!pn) return bad(c, "not_found", 404);
    await pool.query("UPDATE c360_notes SET deleted_at=NOW() WHERE id=$1 AND phone_norm=$2", [Number(c.req.param("id")) || 0, pn]);
    return c.json({ ok: true });
  });
  app.put("/api/cms/customers/360/:ref/tags", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const pn = await pnOfRef(c.req.param("ref"));
    if (!pn) return bad(c, "not_found", 404);
    const b = await c.req.json().catch(() => ({}));
    const tags = [...new Set((Array.isArray(b.tags) ? b.tags : []).map((t) => String(t).trim().slice(0, 30)).filter(Boolean))].slice(0, 20);
    const u = await whoami(c).catch(() => null);
    await pool.query(`INSERT INTO c360_tags(phone_norm, tags, updated_by) VALUES ($1,$2,$3)
      ON CONFLICT (phone_norm) DO UPDATE SET tags=EXCLUDED.tags, updated_by=EXCLUDED.updated_by, updated_at=NOW()`, [pn, tags, u?.name || "فريق"]);
    return c.json({ ok: true, tags });
  });

  function trimProps(p) {
    if (!p || typeof p !== "object") return p || null;
    const out = {};
    for (const [k, v] of Object.entries(p).slice(0, 12)) {
      if (/phone|mobile|jawal|otp|code|token/i.test(k)) continue;
      out[k] = typeof v === "string" ? v.slice(0, 120) : v;
    }
    return out;
  }

  /* الأجهزة (anon_id) المربوطة بالجوال: OTP، السلة، طلب الموقع، الإشعارات، وجلسات اتعرّفت */
  async function anonIdsOf(pn) {
    const r = await pool.query(`
      SELECT DISTINCT a FROM (
        SELECT anon_id AS a FROM journey_identities WHERE phone_norm=$1
        UNION SELECT anon_id FROM journey_sessions WHERE phone_norm=$1
        UNION SELECT device_id FROM shop_carts WHERE phone_norm=$1
        UNION SELECT customer->>'deviceId' FROM shop_orders WHERE phone_norm=$1
        UNION SELECT device_id FROM push_subs WHERE phone_norm=$1
      ) x WHERE COALESCE(a,'') <> ''`, [pn]);
    return r.rows.map((x) => x.a);
  }

  async function buildProfile(pn) {
    const Q = (sql, p = [pn]) => pool.query(sql, p).then((r) => r.rows).catch((e) => { console.error("[c360] q:", e.message); return []; });
    const anons = await anonIdsOf(pn).catch(() => []);
    const settings = await getSettingsData().catch(() => ({}));
    const [pos, web, names, firstRow, acct, tsc, sessions, carts, recoveries, logSms, campSms, optout, optHist,
      reviews, invites, notes, tags, loyalty, promo, push] = await Promise.all([
      Q(`SELECT o.order_id, o.receipt, o.order_date, o.calendar_day::text AS day, o.order_type, o.order_option, o.total,
                o.discount_incl, o.payments, s.source, s.source_note, s.customer_name,
                COALESCE((SELECT json_agg(json_build_object('name', i.name, 'qty', i.qty, 'amount', i.amount) ORDER BY i.idx)
                            FROM ts_order_items i WHERE i.order_id = o.order_id), '[]'::json) AS items
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
          WHERE s.phone_norm = $1 OR tc.phone_norm = $1
          ORDER BY o.order_date DESC LIMIT 400`),
      Q(`SELECT order_no, status, option, total, subtotal, delivery_fee, discount_amount, coupon, items, address, customer,
                pos_order_id, created_at, is_test, attrib_source, journey_sid, ${bizDaySql("created_at")}::text AS day
           FROM shop_orders WHERE phone_norm = $1 ORDER BY created_at DESC LIMIT 200`),
      namesOf([pn]),
      Q(`WITH ${FIRST_ORDER_CTE} SELECT first_day::text AS first_day FROM firsts WHERE pn=$1`),
      Q(`SELECT name, addresses, created_at, last_login_at, discount_percent, discount_label FROM acct_customers WHERE phone_norm=$1`),
      Q(`SELECT customer_id, name, points, registered_at, first_order_at FROM ts_customers WHERE phone_norm=$1`),
      Q(`SELECT session_id, anon_id, started_at, last_seen_at, landing_path, referrer_host, utm_source, utm_medium, utm_campaign,
                utm_content, link_slug, coupon_param, channel, device, in_app, max_step, last_event, cart_max, order_no, paid, revenue,
                is_qa, is_staff, events, (phone_norm = $1) AS by_phone
           FROM journey_sessions WHERE phone_norm = $1 OR anon_id = ANY($2::text[])
          ORDER BY started_at DESC LIMIT 60`, [pn, anons]),
      Q(`SELECT device_id, stage, max_stage, item_count, subtotal, option, items, created_at, updated_at, recovered_order, rec_step, rec_note,
                (phone_norm = $1) AS by_phone
           FROM shop_carts WHERE phone_norm = $1 OR device_id = ANY($2::text[]) ORDER BY updated_at DESC LIMIT 30`, [pn, anons]),
      Q(`SELECT code, subtotal, item_count, started_at, step1_channel, step1_at, step2_channel, step2_at, opened_at, open_count,
                order_no, order_total, recovered_at FROM cart_recovery WHERE phone_norm = $1 ORDER BY started_at DESC LIMIT 20`),
      Q(`SELECT id, at, kind, sender, ref, body, parts, cost, status, msg_id, error, origin FROM sms_log WHERE phone_norm=$1 ORDER BY at DESC LIMIT 200`),
      Q(`SELECT cs.campaign_id, cm.name AS campaign_name, cm.message, cs.status, cs.msg_id, cs.parts, cs.cost, cs.error, cs.created_at
           FROM cms_campaign_sends cs LEFT JOIN cms_campaigns cm ON cm.id = cs.campaign_id
          WHERE cs.phone_norm=$1 ORDER BY cs.created_at DESC LIMIT 100`),
      Q(`SELECT opted_out_at, optout_source, optout_reason, optout_by FROM cms_contacts WHERE phone_norm=$1`),
      Q(`SELECT action, source, reason, actor, created_at FROM cms_optout_log WHERE phone_norm=$1 AND action <> 'view' ORDER BY created_at DESC LIMIT 30`),
      Q(`SELECT id, rating, comment, categories, code_label, channel, order_no, went_google, resolved, resolution_note, created_at,
                is_test, hidden_at FROM reviews
          WHERE phone_norm=$1 OR order_no IN (SELECT order_no FROM shop_orders WHERE phone_norm=$1)
          ORDER BY created_at DESC LIMIT 30`),
      Q(`SELECT order_no, sent_at, opened_at, rating, went_google, skip_reason FROM review_invites
          WHERE phone_norm=$1 OR order_no IN (SELECT order_no FROM shop_orders WHERE phone_norm=$1) ORDER BY created_at DESC LIMIT 30`),
      Q(`SELECT id, body, author, created_at FROM c360_notes WHERE phone_norm=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`),
      Q(`SELECT tags FROM c360_tags WHERE phone_norm=$1`),
      Q(`SELECT reward_no, coupon, created_at FROM cms_loyalty WHERE phone_norm=$1 ORDER BY created_at DESC`),
      Q(`SELECT code_key, order_id, redeemed_at, utm_source, utm_campaign FROM promo_redemptions WHERE phone_norm=$1 ORDER BY redeemed_at DESC LIMIT 30`),
      Q(`SELECT count(*)::int AS n FROM push_subs WHERE phone_norm=$1 AND NOT disabled`),
    ]);

    /* الطلبات: نقطة البيع + الموقع، ومنع التكرار */
    const posOrders = pos.map((o) => ({
      key: "p" + o.order_id, source: "pos", id: String(o.order_id), receipt: o.receipt, at: o.order_date, day: o.day,
      channel: posChannel(o), void: isVoid(o), orderType: o.order_type, option: o.order_option,
      total: Math.round((Number(o.total) || 0) * 100) / 100, discount: Math.round((Number(o.discount_incl) || 0) * 100) / 100,
      items: (o.items || []).map((i) => ({ name: i.name, qty: Number(i.qty) || 1, amount: Number(i.amount) || 0 })),
      payments: Object.keys(o.payments || {}),
    }));
    const notOrder = new Set(SHOP_NOT_ORDER_STATUSES);
    const webAll = web.map((o) => ({
      key: "w" + o.order_no, source: "web", orderNo: o.order_no, posOrderId: o.pos_order_id, at: o.created_at, day: o.day,
      channel: "website", status: o.status, option: o.option, isTest: o.is_test,
      paid: !o.is_test && !notOrder.has(o.status),
      total: Number(o.total) || 0, discount: Number(o.discount_amount) || 0, coupon: o.coupon || null,
      deliveryFee: Number(o.delivery_fee) || 0, attribSource: o.attrib_source, journeySid: o.journey_sid,
      items: (Array.isArray(o.items) ? o.items : []).map((i) => ({
        name: i.name || i.product_name || `صنف ${i.product_id ?? ""}`, qty: Number(i.quantity ?? i.qty) || 1,
        amount: i.unit_amount && i.mf ? Math.round((Number(i.unit_amount) / Number(i.mf)) * 1.15 * 100) / 100 : null,
      })),
    }));
    const webPaid = webAll.filter((o) => o.paid);
    const dupMap = matchWebToPos(webPaid, posOrders);
    for (const p of posOrders) if (dupMap.has(p.id)) p.dupOf = dupMap.get(p.id);
    const webByNo = new Map(webAll.map((w) => [w.orderNo, w]));
    for (const [pid, wno] of dupMap) { const w = webByNo.get(wno); if (w) w.posOrderId = w.posOrderId || pid; }
    const orders = [...webPaid, ...posOrders.filter((p) => !p.dupOf)].sort((a, b) => new Date(b.at) - new Date(a.at));
    const summary = summarize(orders);
    const firstDay = firstRow[0]?.first_day || null;
    const today = new Date(Date.now() + 3 * 3600_000 - 4 * 3600_000).toISOString().slice(0, 10);
    summary.firstOrderDay = firstDay;
    summary.isNewToday = isNewCustomer(firstDay, today);
    summary.status = !summary.orders ? "no_orders" : summary.orders === 1 ? "one_time"
      : summary.daysSinceLast != null && summary.daysSinceLast > 21 ? "lapsed" : "repeat";
    summary.unpaidAttempts = webAll.filter((o) => !o.paid && !o.isTest).length;
    const webFirst = webPaid.length ? webPaid[webPaid.length - 1] : null;
    summary.firstWebOrderAt = webFirst?.at || null;
    summary.existingBeforeWeb = Boolean(webFirst && firstDay && firstDay < webFirst.day);

    /* العناوين */
    const addresses = [];
    const seenAddr = new Set();
    for (const a of (acct[0]?.addresses || [])) {
      const k = [a.area, a.street, a.building].join("|");
      if (seenAddr.has(k)) continue; seenAddr.add(k);
      addresses.push({ label: a.label || null, area: a.area, street: a.street, building: a.building, floor: a.floor, landmark: a.landmark,
        isDefault: Boolean(a.is_default), usedAt: a.used_at || null, source: "account", hasPin: Boolean(a.latitude) });
    }
    for (const o of web) {
      const a = o.address; if (!a || typeof a !== "object") continue;
      const k = [a.area, a.street, a.building].join("|");
      if (seenAddr.has(k)) continue; seenAddr.add(k);
      addresses.push({ label: a.label || null, area: a.area || a.district || null, street: a.street || null, building: a.building || null,
        floor: a.floor || null, landmark: a.landmark || null, usedAt: o.created_at, source: "order", hasPin: Boolean(a.latitude || a.lat) });
    }

    /* الكوبونات */
    const coupons = [
      ...webAll.filter((o) => o.coupon).map((o) => ({ code: o.coupon, at: o.at, orderNo: o.orderNo, discount: o.discount, paid: o.paid, source: "website" })),
      ...promo.map((p) => ({ code: p.code_key, at: p.redeemed_at, orderNo: p.order_id, source: "promo", utm: p.utm_source || null })),
    ];

    /* الرحلة */
    const sess = sessions.map((s) => ({
      sessionId: s.session_id, startedAt: s.started_at, lastSeenAt: s.last_seen_at, channel: s.channel,
      source: s.utm_source || s.referrer_host || null, medium: s.utm_medium || null, campaign: s.utm_campaign || null,
      content: s.utm_content || null, linkSlug: s.link_slug || null, coupon: s.coupon_param || null,
      device: s.device, inApp: s.in_app, landing: s.landing_path, maxStep: s.max_step, maxStepLabel: STEP_LABELS[Math.min(Number(s.max_step) || 0, 7)],
      droppedAt: s.paid ? null : (STEP_LABELS[Math.min((Number(s.max_step) || 0) + 1, 7)] || null),
      lastEvent: s.last_event, cartMax: Number(s.cart_max) || 0, orderNo: s.order_no, paid: s.paid, revenue: Number(s.revenue) || 0,
      events: s.events, linkedBy: s.by_phone ? "phone" : "device", isQa: s.is_qa, isStaff: s.is_staff,
    }));

    /* الرسايل: السجل الموحّد + الحملات */
    const staff = staffPhoneSet(settings || {});
    const sms = [
      ...logSms.map((m) => ({
        id: "s" + m.id, at: m.at, kind: m.kind === "other" && staff.has(pn) ? "staff" : m.kind,
        ref: m.ref, body: m.body, parts: m.parts, cost: m.cost == null ? null : Number(m.cost),
        costEst: m.cost == null ? (Number(m.parts) || 1) * SMS_PART_PRICE : null,
        status: m.status, msgId: m.msg_id, error: m.error, origin: m.origin, sender: m.sender,
      })),
      ...campSms.filter((m) => m.status !== "holdout").map((m) => ({
        id: `c${m.campaign_id}-${new Date(m.created_at).getTime()}`, at: m.created_at, kind: "campaign",
        ref: `campaign:${m.campaign_id}`, campaignId: m.campaign_id, campaignName: m.campaign_name, body: m.message,
        bodyIsTemplate: true, parts: m.parts, cost: m.cost == null ? null : Number(m.cost), status: m.status === "sent" ? "sent" : "failed",
        msgId: m.msg_id, error: m.error, origin: "campaigns", sender: "AD",
      })),
    ].map((m) => ({ ...m, kindLabel: SMS_KINDS[m.kind] || m.kind })).sort((a, b) => new Date(b.at) - new Date(a.at));
    const holdouts = campSms.filter((m) => m.status === "holdout").map((m) => ({ campaignId: m.campaign_id, campaignName: m.campaign_name, at: m.created_at }));

    const nm = names.get(pn) || {};
    const bestName = (acct[0] && plausibleName(acct[0].name) && acct[0].name) || (tsc[0] && plausibleName(tsc[0].name) && tsc[0].name) || nm.name || null;

    return {
      ref: refOf(pn),
      identity: {
        name: bestName, names: nm.names || [], sources: nm.sources || [], phoneMasked: maskPhone(pn),
        tsCustomerId: tsc[0]?.customer_id || null, tsPoints: tsc[0]?.points ?? null,
        tsRegisteredAt: tsc[0]?.registered_at || null,
        account: acct[0] ? { createdAt: acct[0].created_at, lastLoginAt: acct[0].last_login_at,
          discountPercent: acct[0].discount_percent == null ? null : Number(acct[0].discount_percent), discountLabel: acct[0].discount_label } : null,
        pushSubs: push[0]?.n || 0, devices: anons.length, isStaff: staff.has(pn),
      },
      summary,
      orders: orders.slice(0, 150),
      voidedOrders: posOrders.filter((p) => p.void).map((p) => ({ id: p.id, at: p.at, total: p.total, orderType: p.orderType })),
      unpaidAttempts: webAll.filter((o) => !o.paid).slice(0, 20).map((o) => ({ orderNo: o.orderNo, at: o.at, status: o.status, total: o.total, isTest: o.isTest })),
      favorites: favorites(orders),
      addresses,
      coupons, loyalty: loyalty.map((l) => ({ rewardNo: l.reward_no, coupon: l.coupon, at: l.created_at })),
      journey: { sessions: sess, devices: anons.length },
      carts: carts.map((k) => ({ stage: k.stage, maxStage: k.max_stage, items: k.item_count, subtotal: Number(k.subtotal) || 0, option: k.option,
        itemNames: (Array.isArray(k.items) ? k.items : []).slice(0, 8).map((i) => i.name || i.title || "").filter(Boolean),
        createdAt: k.created_at, updatedAt: k.updated_at, recoveredOrder: k.recovered_order, recStep: k.rec_step, recNote: k.rec_note,
        linkedBy: k.by_phone ? "phone" : "device" })),
      recoveries: recoveries.map((r) => ({ code: r.code, subtotal: Number(r.subtotal) || 0, items: r.item_count, startedAt: r.started_at,
        step1: r.step1_channel ? { channel: r.step1_channel, at: r.step1_at } : null, step2: r.step2_channel ? { channel: r.step2_channel, at: r.step2_at } : null,
        openedAt: r.opened_at, opens: r.open_count, orderNo: r.order_no, orderTotal: r.order_total == null ? null : Number(r.order_total), recoveredAt: r.recovered_at })),
      sms, smsTotals: {
        count: sms.length, sent: sms.filter((m) => m.status === "sent").length,
        cost: Math.round(sms.reduce((s, m) => s + (m.cost ?? m.costEst ?? 0), 0) * 100) / 100,
        estimated: sms.some((m) => m.cost == null),
      }, holdouts,
      optout: {
        optedOut: Boolean(optout[0]?.opted_out_at), at: optout[0]?.opted_out_at || null, source: optout[0]?.optout_source || null,
        reason: optout[0]?.optout_reason || null, by: optout[0]?.optout_by || null,
        history: optHist.map((h) => ({ action: h.action, source: h.source, reason: h.reason, actor: h.actor, at: h.created_at })),
      },
      reviews: reviews.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment, categories: r.categories, label: r.code_label, channel: r.channel,
        orderNo: r.order_no, wentGoogle: r.went_google, resolved: r.resolved, resolutionNote: r.resolution_note, at: r.created_at,
        hidden: Boolean(r.is_test || r.hidden_at) })),
      reviewInvites: invites.map((i) => ({ orderNo: i.order_no, sentAt: i.sent_at, openedAt: i.opened_at, rating: i.rating, wentGoogle: i.went_google, skip: i.skip_reason })),
      notes, tags: tags[0]?.tags || [],
      rules: IDENTITY_RULES_AR,
    };
  }

  /* ═══ ✉️ سجل الرسايل ═══════════════════════════════════════════════════ */
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  app.get("/api/cms/customers/sms-log", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const q = (k) => c.req.query(k);
    const tab = q("tab") === "otp" ? "otp" : "all";
    const settings = await getSettingsData().catch(() => ({}));
    const staff = [...staffPhoneSet(settings || {})];
    const where = [], p = [staff];
    const P = (v) => { p.push(v); return `$${p.length}`; };
    where.push(tab === "otp" ? "u.kind = 'otp'" : "u.kind <> 'otp'");
    if (q("kind") && SMS_KINDS[q("kind")]) where.push(`u.kind = ${P(q("kind"))}`);
    if (/^\d+$/.test(q("campaign") || "")) where.push(`u.campaign_id = ${P(Number(q("campaign")))}`);
    if (q("status") === "sent" || q("status") === "failed") where.push(`u.status = ${P(q("status"))}`);
    if (isDate(q("from"))) where.push(`u.at >= (${P(q("from"))}::date::timestamp AT TIME ZONE 'Asia/Riyadh')`);
    if (isDate(q("to"))) where.push(`u.at < ((${P(q("to"))}::date + 1)::timestamp AT TIME ZONE 'Asia/Riyadh')`);
    const term = String(q("q") || "").trim().slice(0, 40);
    if (term) {
      const dg = digitsOf(term);
      if (dg.length >= 4 && dg.length === term.replace(/[\s+\-]/g, "").length) {
        const full = normPhone(dg);
        where.push(full ? `u.pn = ${P(full)}` : `u.pn LIKE '%' || ${P(dg.replace(/^(00966|966|0)/, ""))} || '%'`);
      } else {
        const r = await pool.query(`WITH ${PEOPLE_SQL} SELECT DISTINCT pn FROM people WHERE name ILIKE '%' || $1 || '%' LIMIT 200`, [term]);
        where.push(`u.pn = ANY(${P(r.rows.map((x) => x.pn))}::text[])`);
      }
    }
    const limit = Math.min(200, Math.max(10, Number(q("limit")) || 100));
    const offset = Math.max(0, Number(q("offset")) || 0);
    const U = `
      u AS (
        SELECT 's' || l.id AS rid, l.at, l.phone_norm AS pn,
               CASE WHEN l.kind = 'other' AND l.phone_norm = ANY($1::text[]) THEN 'staff' ELSE l.kind END AS kind,
               l.sender, l.ref, l.body, COALESCE(l.parts, 1) AS parts, l.cost, l.status, l.msg_id, l.error, l.origin,
               NULL::int AS campaign_id, NULL::text AS campaign_name
          FROM sms_log l
        UNION ALL
        SELECT 'c' || cs.campaign_id || '-' || floor(extract(epoch from cs.created_at) * 1000)::bigint || '-' || right(cs.phone_norm, 3),
               cs.created_at, cs.phone_norm, 'campaign', 'AD', 'campaign:' || cs.campaign_id, cm.message, COALESCE(cs.parts, 1), cs.cost,
               CASE WHEN cs.status = 'sent' THEN 'sent' ELSE 'failed' END, cs.msg_id, cs.error, 'campaigns', cs.campaign_id, cm.name
          FROM cms_campaign_sends cs LEFT JOIN cms_campaigns cm ON cm.id = cs.campaign_id
         WHERE cs.status <> 'holdout'
      )`;
    const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows, tot, byKind, camps] = await Promise.all([
      pool.query(`WITH ${U} SELECT * FROM u ${W} ORDER BY u.at DESC LIMIT ${limit} OFFSET ${offset}`, p),
      pool.query(`WITH ${U} SELECT count(*)::int AS n, COALESCE(sum(parts),0)::int AS parts,
                    COALESCE(sum(cost),0)::float AS cost,
                    COALESCE(sum(CASE WHEN cost IS NULL THEN parts * ${SMS_PART_PRICE} END),0)::float AS cost_est,
                    count(*) FILTER (WHERE status='failed')::int AS failed
                    FROM u ${W}`, p),
      pool.query(`WITH ${U} SELECT kind, count(*)::int AS n, COALESCE(sum(COALESCE(cost, parts * ${SMS_PART_PRICE})),0)::float AS cost
                    FROM u ${W} GROUP BY 1 ORDER BY 2 DESC`, p),
      pool.query(`SELECT id, name, sent_at, status FROM cms_campaigns ORDER BY id DESC LIMIT 50`),
    ]);
    const pns = rows.rows.map((r) => r.pn).filter(Boolean);
    await remember(pns);
    const names = await namesOf(pns);
    const t = tot.rows[0];
    return c.json({
      ok: true, tab, kinds: SMS_KINDS, partPrice: SMS_PART_PRICE,
      totals: { count: t.n, parts: t.parts, cost: Math.round(t.cost * 100) / 100, costEstimated: Math.round(t.cost_est * 100) / 100, failed: t.failed },
      byKind: byKind.rows.map((r) => ({ kind: r.kind, label: SMS_KINDS[r.kind] || r.kind, count: r.n, cost: Math.round(r.cost * 100) / 100 })),
      campaigns: camps.rows.map((x) => ({ id: x.id, name: x.name, sentAt: x.sent_at, status: x.status })),
      rows: rows.rows.map((r) => ({
        id: r.rid, at: r.at, kind: r.kind, kindLabel: SMS_KINDS[r.kind] || r.kind, ref: r.ref,
        campaignId: r.campaign_id, campaignName: r.campaign_name, sender: r.sender,
        cref: refOf(r.pn), phoneMasked: maskPhone(r.pn), name: names.get(r.pn)?.name || null,
        body: r.body, bodyIsTemplate: r.kind === "campaign", parts: r.parts,
        cost: r.cost == null ? null : Number(r.cost), costEst: r.cost == null ? Math.round(Number(r.parts || 1) * SMS_PART_PRICE * 1000) / 1000 : null,
        status: r.status, msgId: r.msg_id, error: r.error, origin: r.origin,
      })),
      limit, offset,
      note: "تقنيات مابتدّيش تقارير تسليم — «اتبعتت» = تقنيات قبلت الرسالة. التكلفة الفعلية من رد تقنيات؛ «تقديري» = الأجزاء × ٠٫٠٧٥ ر.س.",
    });
  });

  /* ═══ 🔕 قايمة الإيقاف (بالأسماء والطلبات) ════════════════════════════ */
  app.get("/api/cms/customers/optouts", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const cur = (await pool.query(
      `SELECT phone_norm, opted_out_at, optout_source, optout_reason, optout_by FROM cms_contacts
        WHERE opted_out_at IS NOT NULL ORDER BY opted_out_at DESC LIMIT 1000`)).rows;
    const hist = (await pool.query(
      `SELECT phone_norm, action, source, reason, actor, created_at FROM cms_optout_log
        WHERE action <> 'view' ORDER BY created_at DESC LIMIT 400`)).rows;
    const pns = [...new Set([...cur.map((x) => x.phone_norm), ...hist.map((x) => x.phone_norm)])];
    await remember(pns);
    const [stats, names] = await Promise.all([quickStats(cur.map((x) => x.phone_norm)), namesOf(pns)]);
    // آخر رسالة قبل الإيقاف — غالباً هي اللي خلّته يوقف
    const trig = new Map();
    if (cur.length) {
      const r = await pool.query(
        `SELECT DISTINCT ON (cc.phone_norm) cc.phone_norm, x.kind, x.label, x.at FROM cms_contacts cc
           JOIN LATERAL (
             SELECT 'campaign' AS kind, cm.name AS label, cs.created_at AS at FROM cms_campaign_sends cs
               LEFT JOIN cms_campaigns cm ON cm.id = cs.campaign_id
              WHERE cs.phone_norm = cc.phone_norm AND cs.status = 'sent' AND cs.created_at <= cc.opted_out_at
             UNION ALL
             SELECT l.kind, l.ref, l.at FROM sms_log l WHERE l.phone_norm = cc.phone_norm AND l.at <= cc.opted_out_at AND l.status = 'sent'
           ) x ON TRUE
          WHERE cc.opted_out_at IS NOT NULL ORDER BY cc.phone_norm, x.at DESC`);
      for (const x of r.rows) trig.set(x.phone_norm, { kind: x.kind, kindLabel: SMS_KINDS[x.kind] || x.kind, label: x.label, at: x.at });
    }
    const histBy = new Map();
    for (const h of hist) {
      const a = histBy.get(h.phone_norm) || []; a.push({ action: h.action, source: h.source, reason: h.reason, actor: h.actor, at: h.created_at });
      histBy.set(h.phone_norm, a);
    }
    const row = (pn) => ({ ref: refOf(pn), phoneMasked: maskPhone(pn), name: names.get(pn)?.name || null });
    return c.json({
      ok: true,
      current: cur.map((x) => {
        const st = stats.get(x.phone_norm) || {};
        return { ...row(x.phone_norm), at: x.opted_out_at, source: x.optout_source || "link", reason: x.optout_reason || null, by: x.optout_by || null,
          orders: st.orders || 0, spend: Math.round((st.spend || 0) * 100) / 100, lastOrderAt: st.last_at || null,
          trigger: trig.get(x.phone_norm) || null, history: histBy.get(x.phone_norm) || [] };
      }),
      // اللي أوقفوا ورجعوا (بطلبهم أو تصليح باج ١٧/٩) — للشفافية
      past: [...histBy.entries()].filter(([pn]) => !cur.some((x) => x.phone_norm === pn)).slice(0, 200)
        .map(([pn, h]) => ({ ...row(pn), history: h })),
    });
  });

  /* ═══ 📐 مراجعة «العميل الجديد»: القاعدة الموحّدة مقابل القواعد القديمة ═══ */
  app.get("/api/cms/customers/identity-audit", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const to = isDate(c.req.query("to")) ? c.req.query("to") : new Date(Date.now() - 3600_000).toISOString().slice(0, 10);
    const from = isDate(c.req.query("from")) ? c.req.query("from") : new Date(Date.parse(to) - 29 * 86400_000).toISOString().slice(0, 10);
    try {
      return c.json({ ok: true, from, to, rules: IDENTITY_RULES_AR, ...(await identityAudit(pool, from, to)) });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message).slice(0, 200) }, 500);
    }
  });

  console.log("[c360] routes registered");
  return { buildProfile, quickStats, refOf, pnOfRef, remember };
}

/* الأرقام اللي بتشرح الفرق — بتتحسب على نفس الفترة بكل قاعدة */
export async function identityAudit(pool, from, to) {
  const NV = (a) => `(${a}.order_type IS NULL OR (${a}.order_type NOT ILIKE '%void%' AND ${a}.order_type NOT ILIKE '%refund%'))`;
  const r = (await pool.query(`
    WITH ${FIRST_ORDER_CTE},
    tsid AS (
      SELECT o.calendar_day AS d, COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) AS pn
        FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
       WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${NV("o")}),
    shid AS (SELECT ${bizDaySql("so.created_at")} AS d, so.phone_norm AS pn FROM shop_orders so
              WHERE ${shopPaidSql("so")} AND ${bizDaySql("so.created_at")} BETWEEN $1::date AND $2::date),
    allid AS (SELECT * FROM tsid UNION SELECT * FROM shid),
    -- القاعدة القديمة في المؤشرات (قبل ١٩/٩): كاش نقطة البيع + registered_at
    oldf AS (
      SELECT pn, min(fd) AS first_day FROM (
        SELECT fs.phone_norm AS pn, fo.calendar_day AS fd FROM order_sources fs JOIN ts_orders fo ON fo.order_id = fs.order_id WHERE fs.phone_norm <> '' AND ${NV("fo")}
        UNION ALL SELECT fc.phone_norm, fo.calendar_day FROM ts_orders fo JOIN ts_customers fc ON fc.customer_id = fo.customer_id WHERE COALESCE(fc.phone_norm,'') <> '' AND ${NV("fo")}
        UNION ALL SELECT fc.phone_norm, ${bizDaySql("COALESCE(fc.first_order_at, fc.registered_at)")} FROM ts_customers fc WHERE COALESCE(fc.phone_norm,'') <> ''
      ) x GROUP BY 1),
    webf AS (SELECT phone_norm AS pn, min(${bizDaySql("created_at")}) AS wd FROM shop_orders so WHERE ${shopPaidSql("so")} AND phone_norm IS NOT NULL GROUP BY 1)
    SELECT
      (SELECT count(DISTINCT a.pn) FROM allid a JOIN firsts f ON f.pn = a.pn WHERE f.first_day BETWEEN $1::date AND $2::date)::int AS unified_new,
      (SELECT count(DISTINCT pn) FROM allid WHERE pn IS NOT NULL)::int AS identified_customers,
      (SELECT count(*) FROM tsid WHERE pn IS NULL)::int AS unidentified_orders,
      (SELECT count(DISTINCT t.pn) FROM tsid t JOIN oldf f ON f.pn = t.pn WHERE f.first_day BETWEEN $1::date AND $2::date)::int AS old_pos_rule_new,
      (SELECT count(*) FROM ts_customers WHERE registered_at::date BETWEEN $1::date AND $2::date)::int AS registrations_rule_new,
      (SELECT count(*) FROM ts_customers tc WHERE registered_at::date BETWEEN $1::date AND $2::date
          AND NOT EXISTS (SELECT 1 FROM firsts f WHERE f.pn = tc.phone_norm AND f.first_day <= $2::date))::int AS registrations_without_order,
      (SELECT count(*) FROM webf WHERE wd BETWEEN $1::date AND $2::date)::int AS website_rule_new,
      (SELECT count(*) FROM webf w JOIN firsts f ON f.pn = w.pn WHERE w.wd BETWEEN $1::date AND $2::date AND f.first_day < w.wd)::int AS website_new_but_existing,
      (SELECT count(*) FROM acct_customers a WHERE ${bizDaySql("a.created_at")} BETWEEN $1::date AND $2::date)::int AS site_signups,
      (SELECT count(*) FROM acct_customers a JOIN firsts f ON f.pn = a.phone_norm
         WHERE ${bizDaySql("a.created_at")} BETWEEN $1::date AND $2::date AND f.first_day < ${bizDaySql("a.created_at")})::int AS signups_already_customers,
      (SELECT count(*) FROM acct_customers a WHERE ${bizDaySql("a.created_at")} BETWEEN $1::date AND $2::date
          AND NOT EXISTS (SELECT 1 FROM firsts f WHERE f.pn = a.phone_norm))::int AS signups_never_ordered`, [from, to])).rows[0];
  return {
    unifiedNew: r.unified_new, identifiedCustomers: r.identified_customers, unidentifiedOrders: r.unidentified_orders,
    legacy: {
      posOnlyRule: r.old_pos_rule_new,
      registrationsRule: r.registrations_rule_new, registrationsWithoutOrder: r.registrations_without_order,
      websiteOnlyRule: r.website_rule_new, websiteNewButExisting: r.website_new_but_existing,
    },
    signups: { total: r.site_signups, alreadyCustomers: r.signups_already_customers, neverOrdered: r.signups_never_ordered },
  };
}
