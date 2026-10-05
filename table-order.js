/* ═══════════════════════════════════════════════════════════════════════════
   TABLE ORDER — «اطلب وادفع من طاولتك» (QR الطاولات، أكتوبر ٢٠٢٦).

   الفكرة: طلب الطاولة = طلب «استلام» عادي في كل دورة متجرنا (مفيش عنوان ولا
   مندوب ولا رسوم توصيل)، + رقم طاولة. الفرق كله في ٣ أماكن بس:
     ١. نقطة البيع: خيار الطلب «Dine in» بدل «Take away»، والملاحظات أولها
        «🍽 طاولة N» — API الشركاء مافيهوش طاولات (tables = 404، order_type 1
        مرفوض)، فالرقم بيوصل للكاشير والمطبخ في الملاحظة. اتأكدنا إن الطلب
        بيوصل كـExternal/Dine in (نفس شكل طلبات كيتا الصالة).
     ٢. شاشة المطبخ: سطر «🍽 طاولة N» (الواجهة بتعرض o.table أصلاً).
     ٣. البوابة: شارة طاولة على الكارت.

   ── الأمان (مراجعة ٥/١٠) ────────────────────────────────────────────────
   الرقم لوحده مابقاش كفاية: أي حد كان يقدر يكتب ?t=7 من بيته ويبعت طلب
   «صالة» الويتر يقدّمه لحد غريب على طاولة ٧، أو يفتح أصناف «الصالة بس».
   دلوقتي كل طاولة ليها **مفتاح عشوائي** (٦٤ بت، جدول table_qr) مطبوع جوّه الـQR
   بس: freshcuts.sa/l/table-7?tk=<المفتاح>. السيرفر بيقارن (timingSafeEqual):
     • مفتاح صح + الطاولة مفعّلة ⇒ طلب طاولة.
     • غلط/ناقص/الطاولة موقوفة ⇒ table_invalid (409) قبل أي جلسة دفع، والمتجر
       بيقول للعميل «امسح الـQR اللي على الطاولة تاني».
   تدوير مفتاح طاولة (ستاند اتسرق أو اتصوّر) أو إيقافها = من اللوحة
   (#store/settings/tables)، والستاندات التانية ماتتأثرش.
   حد أقصى لطلبات الطاولة المفتوحة (maxOpenPerTable في openWindowMin دقيقة)
   ضد الإغراق، وأصناف «الصالة بس» مسموحة لطلب طاولة متأكد بس.

   الإعدادات (settings.tables — بتتكتب من مسارها بس، مش من الـPUT الكامل):
     { enabled, count, maxNo, requireKey, maxOpenPerTable, openWindowMin, callsEnabled }
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import { isOpenNow } from "./carts.js";
import { riyadhHour } from "./bizday.js";

export const TABLE_DEFAULTS = Object.freeze({
  enabled: true, count: 12, maxNo: 99,
  requireKey: true,       // من غير مفتاح الـQR مفيش طلب طاولة
  maxOpenPerTable: 5,     // طلبات مدفوعة على نفس الطاولة في الشبّاك ده
  openWindowMin: 90,
  callsEnabled: true,     // زرار «نادي الويتر»
});

export function tableCfg(settings) {
  const t = (settings && typeof settings === "object" && settings.tables) || {};
  const int = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
  };
  return {
    enabled: t.enabled !== false,
    count: int(t.count, TABLE_DEFAULTS.count, 1, 999),
    maxNo: int(t.maxNo, TABLE_DEFAULTS.maxNo, 1, 999),
    requireKey: t.requireKey !== false,
    maxOpenPerTable: int(t.maxOpenPerTable, TABLE_DEFAULTS.maxOpenPerTable, 1, 50),
    openWindowMin: int(t.openWindowMin, TABLE_DEFAULTS.openWindowMin, 15, 360),
    callsEnabled: t.callsEnabled !== false,
  };
}

/* "7" · 7 · "table-7" · "t7" · "طاولة ٧" → 7. غير كده null. */
export function parseTable(raw, cfg = TABLE_DEFAULTS) {
  if (!cfg || cfg.enabled === false) return null;
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  if (typeof raw === "object") return null;
  let s = String(raw).trim().slice(0, 20)
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const m = s.match(/^(?:table-|t|طاولة\s*)?(\d{1,3})$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const max = Number(cfg.maxNo) || TABLE_DEFAULTS.maxNo;
  return n >= 1 && n <= max ? n : null;
}

/* طلب طاولة = استلام عادي وقت ما يتطلب (الطلب المسبق مالوش معنى على طاولة).
   ده **التحليل** بس — التحقق من المفتاح في verifyTableKey (محتاج الداتابيز). */
export function tableForCheckout(body, option, { scheduled = false, settings = null } = {}) {
  if (option !== "pickup" || scheduled) return null;
  return parseTable(body && body.table, tableCfg(settings));
}

/* ── المفتاح ─────────────────────────────────────────────────────────────── */
export const KEY_RE = /^[A-Za-z0-9_-]{8,32}$/;
export const cleanKey = (raw) => {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return KEY_RE.test(s) ? s : null;
};
/* ٨ بايت = ٦٤ بت عشوائي → ١١ حرف base64url. التخمين أونلاين بيعدّي على OTP
   ودفع لكل محاولة — يعني عملياً مستحيل. */
export const newTableKey = () => crypto.randomBytes(8).toString("base64url");

export function keyMatches(row, key) {
  const k = cleanKey(key);
  if (!row || row.active === false || !k || typeof row.key !== "string") return false;
  const a = Buffer.from(row.key), b = Buffer.from(k);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* الرابط اللي بيتطبع في الـQR. /l/table-N بيعدّ المسح في «روابط الحملات»،
   والـstorefront بيعدّي tk لصفحة الهبوط (CLICK_PASSTHRU في server.py). */
export const tableLink = (base, n, key) =>
  `${String(base || "https://freshcuts.sa").replace(/\/+$/, "")}/l/table-${n}?tk=${encodeURIComponent(key)}`;

/* ── تنضيف أي نص من العميل رايح لنقطة البيع/المطبخ/الرسايل ────────────────
   بيشيل: حروف التحكم (سطور جديدة ⇒ مسافة)، اتجاه النص (RLO/LRO/isolates —
   كانت ممكن تقلب «طاولة 7» لـ«7 ةلواط» أو تخبّي جزء من الملاحظة)، والمسافات
   الصفرية، وعلامة 🍽 في الأول (عشان ملاحظة عميل ماتتقريش «🍽 طاولة 3» وهي
   طلب استلام). */
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_RE = /[؜​-‏‪-‮⁠-⁩﻿]/g;
export function cleanCustomerText(raw, max = 200) {
  if (raw === null || raw === undefined) return "";
  let s = String(raw).slice(0, max * 4)
    .replace(CTRL_RE, " ")
    .replace(BIDI_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  s = s.replace(/^(?:🍽️?\s*)+/u, "").trim();
  return Array.from(s).slice(0, max).join("");
}

export const tableLabel = (n) => (n ? `طاولة ${n}` : null);

/* أول الملاحظات في نقطة البيع — الكاشير والعدّاء يشوفوه قبل أي حاجة. */
export const tableNote = (n) => `🍽 ${tableLabel(n)} — يتقدّم على الطاولة`;

export function posOptionOf(row) {
  return row && Number(row.table_no) > 0 ? "dine_in" : row && row.option;
}

/* صفحة التتبع: طلب الطاولة مايقولش «جاهز للاستلام من الفرع». */
export function tableTrackLabel(row, { ready = false } = {}) {
  const n = row && Number(row.table_no) > 0 ? Number(row.table_no) : null;
  if (!n || row.option !== "pickup") return null;
  if (row.status === "delivered") return { label: `بالهنا والشفا 🌟 — طاولة ${n}`, step: 5 };
  if (ready) return { label: `طلبك جاهز وجاي لطاولتك 🍽 (طاولة ${n})`, step: 4 };
  if (["paid", "pos_created", "accepted"].includes(row.status)) {
    return { label: `بنجهّز طلبك — هيتقدّم على طاولة ${n} 👨‍🍳`, step: 2 };
  }
  return null;
}

/* ── نداء الويتر ─────────────────────────────────────────────────────────── */
export const CALL_KINDS = Object.freeze({
  waiter: { label: "محتاج الويتر", icon: "🙋" },
  water: { label: "مية", icon: "💧" },
  napkins: { label: "مناديل", icon: "🧻" },
});
export const CALL_COOLDOWN_MS = 2 * 60_000;
export const CALL_OPEN_MIN = 30;

export function callPushPayload(n, kind, baseUrl = "") {
  const k = CALL_KINDS[kind] || CALL_KINDS.waiter;
  return {
    kind: "table_call", orderNo: null, url: baseUrl, tag: `table-call-${n}`, renotify: true,
    urgency: "high", ttl: 300, requireInteraction: false,
    title: `${k.icon} طاولة ${n} — ${k.label}`, body: "العميل طلب من الـQR — روح للطاولة ودوس «تم» في البوابة",
  };
}

/* ── التحليلات (صافية للاختبار) ──────────────────────────────────────────── */
export function summarizeTables({ orders = [], scans = [], calls = [], count = 12 } = {}) {
  const by = new Map();
  const get = (n) => {
    if (!by.has(n)) by.set(n, { table: n, scans: 0, orders: 0, revenue: 0, aov: 0, conversion: null, calls: 0, avgResponseSec: null, _resp: [] });
    return by.get(n);
  };
  for (let n = 1; n <= count; n++) get(n);
  for (const s of scans) get(Number(s.table_no)).scans += Number(s.scans) || 0;
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, revenue: 0 }));
  const items = new Map();
  for (const o of orders) {
    const t = get(Number(o.table_no));
    const total = Number(o.total) || 0;
    t.orders++; t.revenue += total;
    const h = Number.isInteger(o.hour) ? o.hour : riyadhHour(o.created_at);
    if (hours[h]) { hours[h].orders++; hours[h].revenue += total; }
    for (const it of Array.isArray(o.items) ? o.items : []) {
      const name = String(it?.name || it?.product_id || "").trim();
      if (!name || it?.bundle_tag === "fee") continue;
      const q = Number(it.quantity ?? it.qty ?? 1) || 1;
      items.set(name, (items.get(name) || 0) + q);
    }
  }
  for (const c of calls) {
    const t = get(Number(c.table_no));
    t.calls++;
    if (c.done_at && c.created_at) t._resp.push((new Date(c.done_at) - new Date(c.created_at)) / 1000);
  }
  const tables = [...by.values()].sort((a, b) => a.table - b.table).map(({ _resp, ...t }) => ({
    ...t,
    revenue: Math.round(t.revenue * 100) / 100,
    aov: t.orders ? Math.round((t.revenue / t.orders) * 100) / 100 : 0,
    conversion: t.scans ? Math.round((t.orders / t.scans) * 1000) / 10 : null,
    avgResponseSec: _resp.length ? Math.round(_resp.reduce((a, x) => a + x, 0) / _resp.length) : null,
  }));
  const tot = tables.reduce((a, t) => ({ scans: a.scans + t.scans, orders: a.orders + t.orders, revenue: a.revenue + t.revenue, calls: a.calls + t.calls }),
    { scans: 0, orders: 0, revenue: 0, calls: 0 });
  return {
    totals: { ...tot, revenue: Math.round(tot.revenue * 100) / 100,
      aov: tot.orders ? Math.round((tot.revenue / tot.orders) * 100) / 100 : 0,
      conversion: tot.scans ? Math.round((tot.orders / tot.scans) * 1000) / 10 : null },
    tables,
    hours: hours.filter((h) => h.orders),
    topItems: [...items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, qty]) => ({ name, qty })),
  };
}

/* ── الداتابيز ───────────────────────────────────────────────────────────── */
export const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS table_qr (
    table_no INT PRIMARY KEY CHECK (table_no BETWEEN 1 AND 999),
    key TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    rotated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS table_scans (
    id BIGSERIAL PRIMARY KEY,
    table_no INT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS table_scans_at_idx ON table_scans(at);
  CREATE TABLE IF NOT EXISTS table_calls (
    id BIGSERIAL PRIMARY KEY,
    table_no INT NOT NULL,
    kind TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    done_at TIMESTAMPTZ,
    done_by TEXT
  );
  CREATE INDEX IF NOT EXISTS table_calls_open_idx ON table_calls(created_at) WHERE done_at IS NULL;
`;

/* حالات «مدفوع فعلاً» — نفس قاعدة cms.js PAID_ONLINE */
const PAID_SQL = "status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed')";

/* {ok, reason}. requireKey مقفول (وضع قديم) ⇒ الرقم لوحده كفاية. */
export async function verifyTableKey(pool, n, key, cfg) {
  if (!n) return { ok: false, reason: "no_table" };
  if (!cfg || cfg.enabled === false) return { ok: false, reason: "disabled" };
  if (cfg.requireKey === false) return { ok: true, reason: "no_key_mode" };
  if (!cleanKey(key)) return { ok: false, reason: "no_key" };
  try {
    const r = await pool.query("SELECT table_no, key, active FROM table_qr WHERE table_no=$1", [n]);
    const row = r.rows[0];
    if (!row) return { ok: false, reason: "unknown_table" };
    if (row.active === false) return { ok: false, reason: "inactive" };
    return keyMatches(row, key) ? { ok: true, reason: "key" } : { ok: false, reason: "bad_key" };
  } catch (e) {
    return { ok: false, reason: "db_error" };
  }
}

/* الطاولة عليها طلبات مدفوعة كتير في آخر openWindowMin؟ (ضد الإغراق) */
export async function tableBusy(pool, n, cfg) {
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM shop_orders
        WHERE table_no=$1 AND ${PAID_SQL} AND NOT COALESCE(is_test,false)
          AND created_at > NOW() - make_interval(mins => $2::int)`, [n, cfg.openWindowMin]);
    return (r.rows[0]?.n || 0) >= cfg.maxOpenPerTable;
  } catch {
    return false; // العمود لسه ماتضافش؟ مانوقفش طلب بسبب عدّاد
  }
}

export const TABLE_MSG = Object.freeze({
  table_invalid: "رمز الطاولة مش صالح أو اتغيّر — امسح الـQR اللي على الطاولة تاني، أو اطلب استلام عادي.",
  table_busy: "الطاولة دي عليها طلبات كتير دلوقتي — لو محتاج حاجة كلّم الكاشير.",
});

/* ── المسارات ─────────────────────────────────────────────────────────────── */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, auditNote } = ctx;
  const note = (c, s) => (typeof auditNote === "function" ? auditNote(c, s).catch?.(() => {}) : null);
  const STORE = () => (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
  const PORTAL_URL = () => (process.env.PORTAL_PUBLIC_URL || "https://freshcuts-invite.o2m8.me/portal/");
  const ipOf = (c) => String(c.req.header("cf-connecting-ip") || (c.req.header("x-forwarded-for") || "").split(",")[0] || "?").trim().slice(0, 64);
  const bad = (c, error, status = 400, extra = {}) => c.json({ ok: false, error, message: TABLE_MSG[error] || undefined, ...extra }, status);

  let ready = null;
  const ensure = () => (ready ||= pool.query(TABLE_DDL).catch((e) => { ready = null; throw e; }));
  ensure().catch((e) => console.error("[tables] schema:", e.message));

  const cfgNow = async () => tableCfg(await getSettingsData().catch(() => ({})));

  /* محدِّد بسيط في الذاكرة: key → {start, n} لكل ساعة */
  const buckets = new Map();
  const limited = (key, max, windowMs = 3600_000) => {
    const now = Date.now(), s = buckets.get(key);
    if (!s || now - s.start > windowMs) { buckets.set(key, { start: now, n: 1 }); return false; }
    s.n++;
    if (buckets.size > 20000) buckets.clear();
    return s.n > max;
  };

  async function rows() {
    await ensure();
    return (await pool.query("SELECT table_no, key, active, rotated_at, created_at FROM table_qr ORDER BY table_no")).rows;
  }
  async function ensureTables(nums) {
    await ensure();
    for (const n of nums) {
      await pool.query("INSERT INTO table_qr(table_no, key) VALUES ($1,$2) ON CONFLICT (table_no) DO NOTHING", [n, newTableKey()]);
    }
  }
  const view = (r) => ({
    table: r.table_no, active: r.active, rotatedAt: r.rotated_at, createdAt: r.created_at,
    link: tableLink(STORE(), r.table_no, r.key),
  });

  /* ═══ عام: المتجر بيتأكد من المفتاح وقت المسح (الشريط مابيظهرش من غيره) ═══ */
  app.post("/api/tables/scan", async (c) => {
    const ip = ipOf(c);
    if (limited(`scan:${ip}`, 60)) return bad(c, "rate_limited", 429);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json"); }
    const cfg = await cfgNow();
    const n = parseTable(b.table, cfg);
    const v = await verifyTableKey(pool, n, b.key, cfg);
    if (!v.ok) return c.json({ ok: false, error: "table_invalid", message: TABLE_MSG.table_invalid });
    // نفس الجهاز/الـIP على نفس الطاولة = مسحة واحدة كل ٣٠ دقيقة (مفيش أي بيانات شخصية بتتخزن)
    if (!limited(`scanc:${ip}:${n}`, 1, 30 * 60_000)) {
      pool.query("INSERT INTO table_scans(table_no) VALUES ($1)", [n]).catch(() => {});
    }
    return c.json({ ok: true, table: n, calls: cfg.callsEnabled, open: isOpenNow((await getSettingsData().catch(() => ({}))).hours) });
  });

  /* ═══ عام: «نادي الويتر» من الطاولة → إشعار البوابة ═══ */
  app.post("/api/tables/call", async (c) => {
    const ip = ipOf(c);
    if (limited(`call:${ip}`, 12)) return bad(c, "rate_limited", 429);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json"); }
    const settings = await getSettingsData().catch(() => ({}));
    const cfg = tableCfg(settings);
    if (!cfg.callsEnabled) return bad(c, "calls_disabled", 403);
    if (!isOpenNow(settings.hours)) return bad(c, "closed", 409, { message: "المطعم مقفول دلوقتي" });
    const n = parseTable(b.table, cfg);
    const v = await verifyTableKey(pool, n, b.key, { ...cfg, requireKey: true }); // النداء دايماً بمفتاح
    if (!v.ok) return bad(c, "table_invalid", 403);
    const kind = Object.prototype.hasOwnProperty.call(CALL_KINDS, b.kind) ? b.kind : "waiter";
    await ensure();
    const open = await pool.query(
      `SELECT id FROM table_calls WHERE table_no=$1 AND kind=$2 AND done_at IS NULL
          AND created_at > NOW() - make_interval(secs => $3::int) LIMIT 1`, [n, kind, CALL_COOLDOWN_MS / 1000]);
    if (open.rows[0]) return c.json({ ok: true, already: true, id: open.rows[0].id });
    const ins = await pool.query("INSERT INTO table_calls(table_no, kind) VALUES ($1,$2) RETURNING id", [n, kind]);
    try {
      const push = deps.portal?.()?.push;
      if (push?.sendToSubs) push.sendToSubs(callPushPayload(n, kind, PORTAL_URL())).catch?.(() => {});
    } catch { /* الإشعار مايوقعش النداء — البوابة بتستطلع كمان */ }
    return c.json({ ok: true, id: ins.rows[0].id });
  });

  /* ═══ البوابة: النداءات المفتوحة + «تم» ═══ */
  const portalAuth = async (c) => {
    const p = deps.portal?.();
    if (!p?.requirePortal) return { res: c.json({ ok: false, error: "unavailable" }, 503) };
    return p.requirePortal(c);
  };
  app.get("/api/tables/calls", async (c) => {
    const a = await portalAuth(c); if (a.res) return a.res;
    await ensure();
    const r = await pool.query(
      `SELECT id, table_no, kind, created_at FROM table_calls
        WHERE done_at IS NULL AND created_at > NOW() - make_interval(mins => $1::int)
        ORDER BY created_at`, [CALL_OPEN_MIN]);
    return c.json({ ok: true, calls: r.rows.map((x) => ({
      id: Number(x.id), table: x.table_no, kind: x.kind,
      label: (CALL_KINDS[x.kind] || CALL_KINDS.waiter).label, icon: (CALL_KINDS[x.kind] || CALL_KINDS.waiter).icon,
      at: x.created_at,
    })) });
  });
  app.post("/api/tables/calls/:id/done", async (c) => {
    const a = await portalAuth(c); if (a.res) return a.res;
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) return bad(c, "bad_id");
    await ensure();
    await pool.query("UPDATE table_calls SET done_at=NOW(), done_by=$2 WHERE id=$1 AND done_at IS NULL",
      [id, String(a.user?.name || "").slice(0, 60) || null]);
    return c.json({ ok: true });
  });

  /* ═══ اللوحة (#store/settings/tables) — قسم «الإعدادات» عبر requireAdmin ═══ */
  app.get("/api/tables/admin", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = await cfgNow();
    const list = await rows();
    return c.json({ ok: true, config: cfg, tables: list.map(view), missing: Array.from({ length: cfg.count }, (_, i) => i + 1).filter((n) => !list.some((r) => r.table_no === n)) });
  });

  /* إنشاء مفاتيح للطاولات الناقصة (١..count + أرقام إضافية زي ٩٩ للتجربة) */
  app.post("/api/tables/admin/ensure", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    const cfg = await cfgNow();
    const extra = (Array.isArray(b.numbers) ? b.numbers : []).map((x) => parseTable(x, cfg)).filter(Boolean);
    const nums = [...new Set([...Array.from({ length: cfg.count }, (_, i) => i + 1), ...extra])].slice(0, 200);
    await ensureTables(nums);
    note(c, `🍽 طاولات: مفاتيح للطاولات ${nums.join("،")}`);
    return c.json({ ok: true, tables: (await rows()).map(view) });
  });

  /* تدوير مفتاح طاولة (أو الكل) — الستاند القديم بيبطل فوراً */
  app.post("/api/tables/admin/rotate", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json"); }
    await ensure();
    if (b.all === true) {
      const list = await rows();
      for (const r of list) await pool.query("UPDATE table_qr SET key=$2, rotated_at=NOW() WHERE table_no=$1", [r.table_no, newTableKey()]);
      note(c, `🍽 طاولات: تدوير كل المفاتيح (${list.length}) — لازم تطبع الستاندات من جديد`);
    } else {
      const n = parseTable(b.table, { ...(await cfgNow()), enabled: true });
      if (!n) return bad(c, "bad_table");
      const r = await pool.query("UPDATE table_qr SET key=$2, rotated_at=NOW() WHERE table_no=$1 RETURNING table_no", [n, newTableKey()]);
      if (!r.rowCount) return bad(c, "unknown_table", 404);
      note(c, `🍽 طاولة ${n}: مفتاح جديد — الستاند القديم بطّل`);
    }
    return c.json({ ok: true, tables: (await rows()).map(view) });
  });

  app.post("/api/tables/admin/active", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json"); }
    const n = parseTable(b.table, { ...(await cfgNow()), enabled: true });
    if (!n || typeof b.active !== "boolean") return bad(c, "bad_input");
    await ensure();
    const r = await pool.query("UPDATE table_qr SET active=$2 WHERE table_no=$1 RETURNING table_no", [n, b.active]);
    if (!r.rowCount) return bad(c, "unknown_table", 404);
    note(c, `🍽 طاولة ${n}: ${b.active ? "اتفعّلت" : "اتوقفت"}`);
    return c.json({ ok: true, tables: (await rows()).map(view) });
  });

  /* الإعدادات: بنكتب settings.tables بس (jsonb_set) — مش الـPUT الكامل */
  app.post("/api/tables/admin/config", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json"); }
    const cur = (await getSettingsData().catch(() => ({}))).tables || {};
    const next = { ...cur };
    for (const k of ["enabled", "requireKey", "callsEnabled"]) if (typeof b[k] === "boolean") next[k] = b[k];
    for (const k of ["count", "maxNo", "maxOpenPerTable", "openWindowMin"]) if (b[k] !== undefined) next[k] = Number(b[k]);
    const clean = tableCfg({ tables: next });
    // رقم برّه الحدود = رفض صريح، مش تصحيح بالسكات
    for (const k of ["count", "maxNo", "maxOpenPerTable", "openWindowMin"]) {
      if (b[k] !== undefined && clean[k] !== Number(b[k])) return bad(c, "bad_" + k);
    }
    if (clean.count > clean.maxNo) return bad(c, "count_over_max");
    await pool.query(
      `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{tables}', $1::jsonb, true), updated_at=NOW() WHERE id=1`,
      [JSON.stringify(clean)]);
    note(c, `🍽 إعدادات الطاولات: ${JSON.stringify(clean).slice(0, 300)}`);
    return c.json({ ok: true, config: clean });
  });

  app.get("/api/tables/admin/stats", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(180, Math.max(1, Number(c.req.query("days")) || 30));
    const cfg = await cfgNow();
    await ensure();
    const [orders, scans, calls] = await Promise.all([
      pool.query(
        `SELECT NULLIF(to_jsonb(o)->>'table_no','')::int AS table_no, o.total, o.items, o.created_at
           FROM shop_orders o
          WHERE NULLIF(to_jsonb(o)->>'table_no','') IS NOT NULL AND ${PAID_SQL.replace(/status/g, "o.status")}
            AND NOT COALESCE(o.is_test,false) AND o.created_at > NOW() - make_interval(days => $1::int)`, [days])
        .then((r) => r.rows).catch(() => []),
      pool.query(`SELECT table_no, count(*)::int AS scans FROM table_scans WHERE at > NOW() - make_interval(days => $1::int) GROUP BY 1`, [days])
        .then((r) => r.rows).catch(() => []),
      pool.query(`SELECT table_no, created_at, done_at FROM table_calls WHERE created_at > NOW() - make_interval(days => $1::int)`, [days])
        .then((r) => r.rows).catch(() => []),
    ]);
    return c.json({ ok: true, days, ...summarizeTables({ orders, scans, calls, count: cfg.count }) });
  });

  return { verify: (n, key, cfg) => verifyTableKey(pool, n, key, cfg), busy: (n, cfg) => tableBusy(pool, n, cfg) };
}
