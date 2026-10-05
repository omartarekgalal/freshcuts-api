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

   ── قرارات عمر (٥/١٠ — قبل النشر) ─────────────────────────────────────────
   • صالة بس، والعميل لازم يكون على الطاولة: مفيش أي تحويل لاستلام/تيك أواي.
     لو الأكل جهز والطاولة فاضية، الطلب يفضل طلب صالة على الكاونتر (البوابة
     بتعرضه في شريط الطاولات) والكاشير يكلّم العميل.
   • سياج جغرافي (geofence): وقت الدفع ووقت «نادي الويتر» المتجر بيبعت موقع
     المتصفح، والسيرفر هو اللي بيحسب المسافة من نقطة الفرع (نفس نقطة التوصيل
     TABSENSE_STORE_LAT/LNG، أو geoLat/geoLng من اللوحة لو اتحددت). مسموح لو
     المسافة − min(الدقة، ١٠٠) ≤ نصف القطر (افتراضي ١٥٠ م). من غير موقع ⇒
     مرفوض. الإحداثيات نفسها **مابتتخزنش** — على الطلب بنسجّل المسافة + نجح/فشل
     بس. فيه مفتاح طوارئ في اللوحة يقفل السياج (geoEnabled).
   • جلسات الطاولة: مسح QR بمفتاح صح ⇒ جلسة على السيرفر (رقم عشوائي، مربوطة
     بالطاولة + الجهاز). المتجر بيحفظ الجلسة مش رقم الطاولة. الجلسة بتخلص لما:
     (أ) الفريق يدوس «الطاولة فضيت» في البوابة (كل جلسات الطاولة)، (ب) يعدّي
     sessionIdleMin (افتراضي ٩٠) من آخر طلب/مسح، (ج) السياج يفشل وقت الدفع،
     (د) تدوير مفتاح الطاولة أو إيقافها. بعدها الموبايل ده لازم يمسح تاني.

   الإعدادات (settings.tables — بتتكتب من مسارها بس، مش من الـPUT الكامل):
     { enabled, count, maxNo, requireKey, maxOpenPerTable, openWindowMin, callsEnabled,
       geoEnabled, geoRadiusM, geoLat, geoLng, sessionIdleMin }
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import { isOpenNow } from "./carts.js";
import { riyadhHour } from "./bizday.js";
import { STORE_LAT, STORE_LNG } from "./tsstore.js";

export const TABLE_DEFAULTS = Object.freeze({
  enabled: true, count: 12, maxNo: 99,
  requireKey: true,       // من غير مفتاح الـQR مفيش طلب طاولة
  maxOpenPerTable: 5,     // طلبات مدفوعة على نفس الطاولة في الشبّاك ده
  openWindowMin: 90,
  callsEnabled: true,     // زرار «نادي الويتر»
  geoEnabled: true,       // السياج الجغرافي (مفتاح طوارئ في اللوحة)
  geoRadiusM: 150,
  geoLat: null, geoLng: null,   // فاضي = نقطة التوصيل (TABSENSE_STORE_LAT/LNG)
  sessionIdleMin: 90,     // الجلسة بتخلص بعد كده من آخر طلب/مسح
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
    geoEnabled: t.geoEnabled !== false,
    geoRadiusM: int(t.geoRadiusM, TABLE_DEFAULTS.geoRadiusM, 30, 2000),
    geoLat: coord(t.geoLat, 90),
    geoLng: coord(t.geoLng, 180),
    sessionIdleMin: int(t.sessionIdleMin, TABLE_DEFAULTS.sessionIdleMin, 15, 360),
  };
}
function coord(v, lim) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= lim && n !== 0 ? n : null;
}

/* نقطة الفرع للسياج: من اللوحة لو اتحددت، وإلا نفس نقطة التوصيل. */
export function branchPoint(cfg) {
  if (cfg && cfg.geoLat != null && cfg.geoLng != null) return { lat: cfg.geoLat, lng: cfg.geoLng, source: "settings" };
  return { lat: STORE_LAT(), lng: STORE_LNG(), source: "delivery" };
}

export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* السياج: {ok, error?, distanceM, accuracyM, skipped?}. الإحداثيات بتتقري
   هنا بس ومابترجعش ولا بتتخزن — اللي بيطلع المسافة والنتيجة. */
export const GEO_ACC_CAP_M = 100;
export function geoVerdict(geo, cfg, point = branchPoint(cfg)) {
  if (!cfg || cfg.geoEnabled === false) return { ok: true, skipped: true, distanceM: null, accuracyM: null };
  const lat = Number(geo && geo.lat), lng = Number(geo && geo.lng);
  if (!geo || typeof geo !== "object" || !Number.isFinite(lat) || !Number.isFinite(lng)
      || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    return { ok: false, error: "geo_required", distanceM: null, accuracyM: null };
  }
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    return { ok: false, error: "geo_unconfigured", distanceM: null, accuracyM: null };
  }
  let acc = Number(geo.accuracy);
  if (!Number.isFinite(acc) || acc < 0) acc = 0;   // من غير دقة = أشد حساب
  const d = distanceM(point.lat, point.lng, lat, lng);
  const ok = d - Math.min(acc, GEO_ACC_CAP_M) <= cfg.geoRadiusM;
  return { ok, error: ok ? null : "geo_far", distanceM: Math.round(d), accuracyM: Math.round(acc) };
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

/* طلب طاولة (من ٥/١٠) = جلسة طاولة صالحة (مش رقم من المتصفح). رقم الطاولة
   نفسه بيتجاب من الجلسة على السيرفر. */
export function tableSessionForCheckout(body, option, { scheduled = false } = {}) {
  if (option !== "pickup" || scheduled) return null;
  return cleanSession(body && body.table_session);
}

/* البوابة الواحدة لطلب الطاولة ونداء الويتر: جلسة صالحة + السياج.
   فشل السياج وقت الدفع بيقفل الجلسة (endOnFar). */
export async function tableGate(pool, { session, device, geo }, cfg, { endOnFar = false, requireViaKey = false } = {}) {
  const s = await resolveTableSession(pool, session, device, cfg);
  if (!s.ok) return { ok: false, error: "table_invalid", reason: s.reason };
  if (requireViaKey && !s.viaKey) return { ok: false, error: "table_invalid", reason: "no_key_session" };
  const g = geoVerdict(geo, cfg);
  if (!g.ok) {
    if (endOnFar && g.error === "geo_far") await endTableSession(pool, cleanSession(session), "geofence");
    return { ok: false, error: g.error, reason: g.error, table: s.table, distanceM: g.distanceM };
  }
  return { ok: true, table: s.table, geo: g };
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
  ALTER TABLE table_qr ADD COLUMN IF NOT EXISTS freed_at TIMESTAMPTZ;
  CREATE TABLE IF NOT EXISTS table_sessions (
    id TEXT PRIMARY KEY,
    table_no INT NOT NULL,
    device_hash TEXT NOT NULL,
    via_key BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    orders INT NOT NULL DEFAULT 0,
    ended_at TIMESTAMPTZ,
    end_reason TEXT,
    ended_by TEXT
  );
  CREATE INDEX IF NOT EXISTS table_sessions_open_idx ON table_sessions(table_no) WHERE ended_at IS NULL;
`;

/* ── جلسات الطاولة ──────────────────────────────────────────────────────────
   الجلسة = رقم عشوائي ١٢٨ بت (٢٢ حرف). الجهاز = رقم عشوائي من المتصفح
   (localStorage)، بنخزّن الـsha256 بتاعه بس. مفيش أي بيانات شخصية هنا. */
export const SESSION_RE = /^[A-Za-z0-9_-]{22}$/;
export const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const newSessionId = () => crypto.randomBytes(16).toString("base64url");
export const cleanSession = (v) => (typeof v === "string" && SESSION_RE.test(v.trim()) ? v.trim() : null);
export const deviceHash = (v) => {
  const s = typeof v === "string" ? v.trim() : "";
  return DEVICE_RE.test(s) ? crypto.createHash("sha256").update("fc-table:" + s).digest("hex") : null;
};

/* مسح صح ⇒ جلسة. نفس الجهاز على نفس الطاولة وجلسته لسه مفتوحة = نفس الجلسة
   (وبنجدّد last_at). جهاز تاني على نفس الطاولة (عيلة بكذا موبايل) = جلسة لوحده. */
export async function openTableSession(pool, n, device, cfg, { viaKey = true } = {}) {
  const dh = deviceHash(device);
  if (!n || !dh) return null;
  const cur = await pool.query(
    `UPDATE table_sessions SET last_at=NOW()
      WHERE id = (SELECT id FROM table_sessions
                   WHERE table_no=$1 AND device_hash=$2 AND ended_at IS NULL
                     AND last_at > NOW() - make_interval(mins => $3::int)
                   ORDER BY last_at DESC LIMIT 1)
      RETURNING id`, [n, dh, cfg.sessionIdleMin]);
  if (cur.rows[0]) return cur.rows[0].id;
  const id = newSessionId();
  await pool.query("INSERT INTO table_sessions(id, table_no, device_hash, via_key) VALUES ($1,$2,$3,$4)", [id, n, dh, viaKey]);
  return id;
}

/* {ok, table, viaKey, reason}. الجلسة اللي عدّى عليها sessionIdleMin بتتقفل هنا. */
export async function resolveTableSession(pool, sid, device, cfg) {
  const id = cleanSession(sid);
  if (!id) return { ok: false, reason: "no_session" };
  if (!cfg || cfg.enabled === false) return { ok: false, reason: "disabled" };
  const dh = deviceHash(device);
  if (!dh) return { ok: false, reason: "no_device" };
  let row;
  try {
    const r = await pool.query(
      `SELECT s.table_no, s.device_hash, s.via_key, s.ended_at, s.end_reason,
              (s.last_at <= NOW() - make_interval(mins => $2::int)) AS idle,
              q.active
         FROM table_sessions s LEFT JOIN table_qr q ON q.table_no = s.table_no
        WHERE s.id = $1`, [id, cfg.sessionIdleMin]);
    row = r.rows[0];
  } catch {
    return { ok: false, reason: "db_error" };
  }
  if (!row) return { ok: false, reason: "unknown_session" };
  if (row.device_hash !== dh) return { ok: false, reason: "device" };
  if (row.ended_at) return { ok: false, reason: row.end_reason || "ended", table: row.table_no };
  if (row.idle) {
    await endTableSession(pool, id, "idle");
    return { ok: false, reason: "idle", table: row.table_no };
  }
  if (row.active === false || row.active === null || row.active === undefined) {
    return { ok: false, reason: "inactive", table: row.table_no };
  }
  return { ok: true, table: row.table_no, viaKey: row.via_key !== false };
}

export async function endTableSession(pool, sid, reason, by = null) {
  try {
    await pool.query("UPDATE table_sessions SET ended_at=NOW(), end_reason=$2, ended_by=$3 WHERE id=$1 AND ended_at IS NULL",
      [sid, String(reason).slice(0, 20), by ? String(by).slice(0, 60) : null]);
  } catch { /* مانوقفش الرد بسبب قفل جلسة */ }
}

/* بعد طلب ناجح لحد جلسة الدفع: آخر نشاط = دلوقتي (الـ٩٠ دقيقة بتبدأ من هنا). */
export async function touchTableSession(pool, sid) {
  try { await pool.query("UPDATE table_sessions SET last_at=NOW(), orders=orders+1 WHERE id=$1 AND ended_at IS NULL", [sid]); }
  catch { /* عدّاد بس */ }
}

/* «الطاولة فضيت»: كل الجلسات المفتوحة على الطاولة بتخلص + الطلبات القديمة
   تنزل من شريط البوابة (freed_at) + نداءاتها المفتوحة تتقفل. */
export async function freeTable(pool, n, by = null) {
  const who = by ? String(by).slice(0, 60) : null;
  const r = await pool.query(
    "UPDATE table_sessions SET ended_at=NOW(), end_reason='freed', ended_by=$2 WHERE table_no=$1 AND ended_at IS NULL", [n, who]);
  await pool.query("UPDATE table_qr SET freed_at=NOW() WHERE table_no=$1", [n]);
  await pool.query("UPDATE table_calls SET done_at=NOW(), done_by=$2 WHERE table_no=$1 AND done_at IS NULL", [n, who]);
  return r.rowCount || 0;
}

/* شريط الطاولات في البوابة (صافي للاختبار): طاولة فيها جلسة مفتوحة أو طلب
   من بعد آخر «فضيت». الطلب الجاهز والطاولة فاضية يفضل ظاهر هنا لحد ما حد
   يدوس «فضيت» — مفيش تحويل لاستلام. */
export function liveTables({ sessions = [], orders = [], freed = [] } = {}) {
  const by = new Map();
  const get = (n) => {
    if (!by.has(n)) by.set(n, { table: n, sessions: 0, since: null, lastAt: null, orders: 0, ready: 0, total: 0, lastOrderAt: null, orderNos: [] });
    return by.get(n);
  };
  const freedAt = new Map(freed.map((f) => [Number(f.table_no), f.freed_at ? new Date(f.freed_at).getTime() : 0]));
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  const minIso = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
  const maxIso = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
  for (const s of sessions) {
    const t = get(Number(s.table_no));
    t.sessions += Number(s.sessions) || 0;
    t.since = minIso(t.since, iso(s.since));
    t.lastAt = maxIso(t.lastAt, iso(s.last_at));
  }
  for (const o of orders) {
    const n = Number(o.table_no);
    const at = new Date(o.created_at).getTime();
    if (at <= (freedAt.get(n) || 0)) continue;
    const t = get(n);
    t.orders++;
    t.total = Math.round((t.total + (Number(o.total) || 0)) * 100) / 100;
    if (o.pos_ready_at) t.ready++;
    t.since = minIso(t.since, iso(o.created_at));
    t.lastOrderAt = maxIso(t.lastOrderAt, iso(o.created_at));
    if (t.orderNos.length < 6) t.orderNos.push(String(o.order_no || ""));
  }
  return [...by.values()].filter((t) => t.sessions || t.orders).sort((a, b) => a.table - b.table);
}

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
  table_invalid: "جلسة الطاولة خلصت أو رمزها اتغيّر — امسح الـQR اللي على الطاولة تاني، أو اطلب من الكاشير.",
  table_busy: "الطاولة دي عليها طلبات كتير دلوقتي — لو محتاج حاجة كلّم الكاشير.",
  geo_required: "لازم تفعّل الموقع عشان نتأكد إنك في المطعم — أو اطلب من الكاشير",
  geo_far: "شكلك مش جوّه المطعم — طلب الطاولة بيشتغل من على الطاولة بس. لو إنت قاعد فعلاً فعّل «الموقع الدقيق» وامسح الـQR تاني، أو اطلب من الكاشير.",
  geo_unconfigured: "طلب الطاولة متوقف مؤقتاً — اطلب من الكاشير.",
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

  /* ═══ عام: المسح — المفتاح صح ⇒ جلسة طاولة (الشريط مابيظهرش من غيرها) ═══
     الرد فيه رقم الجلسة بس؛ المفتاح مابيتحفظش في المتصفح بعد كده. */
  app.post("/api/tables/scan", async (c) => {
    const ip = ipOf(c);
    if (limited(`scan:${ip}`, 60)) return bad(c, "rate_limited", 429);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json"); }
    const settings = await getSettingsData().catch(() => ({}));
    const cfg = tableCfg(settings);
    const n = parseTable(b.table, cfg);
    const v = await verifyTableKey(pool, n, b.key, cfg);
    if (!v.ok) return c.json({ ok: false, error: "table_invalid", message: TABLE_MSG.table_invalid });
    if (!deviceHash(b.device)) return bad(c, "bad_device");
    await ensure();
    let session;
    try { session = await openTableSession(pool, n, b.device, cfg, { viaKey: v.reason === "key" }); }
    catch (e) { console.error("[tables] session:", e.message); return c.json({ ok: false, error: "session_failed" }); }
    // نفس الجهاز/الـIP على نفس الطاولة = مسحة واحدة كل ٣٠ دقيقة (مفيش أي بيانات شخصية بتتخزن)
    if (!limited(`scanc:${ip}:${n}`, 1, 30 * 60_000)) {
      pool.query("INSERT INTO table_scans(table_no) VALUES ($1)", [n]).catch(() => {});
    }
    return c.json({
      ok: true, table: n, session, idleMin: cfg.sessionIdleMin,
      calls: cfg.callsEnabled, geo: cfg.geoEnabled, open: isOpenNow(settings.hours),
    });
  });

  /* ═══ عام: الجلسة لسه شغّالة؟ (المتجر بيسأل وقت فتح الصفحة — مابيجدّدهاش) ═══ */
  app.post("/api/tables/session", async (c) => {
    const ip = ipOf(c);
    if (limited(`sess:${ip}`, 300)) return bad(c, "rate_limited", 429);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json"); }
    const cfg = await cfgNow();
    await ensure().catch(() => {});
    const s = await resolveTableSession(pool, b.session, b.device, cfg);
    if (!s.ok) return c.json({ ok: false, error: "table_invalid", reason: s.reason, message: TABLE_MSG.table_invalid });
    return c.json({ ok: true, table: s.table, idleMin: cfg.sessionIdleMin, calls: cfg.callsEnabled && s.viaKey, geo: cfg.geoEnabled });
  });

  /* ═══ عام: «نادي الويتر» من الطاولة → إشعار البوابة (جلسة بمفتاح + السياج) ═══ */
  app.post("/api/tables/call", async (c) => {
    const ip = ipOf(c);
    if (limited(`call:${ip}`, 12)) return bad(c, "rate_limited", 429);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json"); }
    const settings = await getSettingsData().catch(() => ({}));
    const cfg = tableCfg(settings);
    if (!cfg.callsEnabled) return bad(c, "calls_disabled", 403);
    if (!isOpenNow(settings.hours)) return bad(c, "closed", 409, { message: "المطعم مقفول دلوقتي" });
    await ensure();
    // النداء دايماً من جلسة اتفتحت بمفتاح الـQR، حتى لو الطلبات في الوضع القديم
    const g = await tableGate(pool, { session: b.session, device: b.device, geo: b.geo }, cfg, { requireViaKey: true });
    if (!g.ok) return bad(c, g.error, g.error === "table_invalid" ? 403 : 409, { reason: g.reason });
    const n = g.table;
    const kind = Object.prototype.hasOwnProperty.call(CALL_KINDS, b.kind) ? b.kind : "waiter";
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

  /* ═══ البوابة: شريط الطاولات (جلسات مفتوحة + طلبات من بعد آخر «فضيت») + النداءات ═══ */
  app.get("/api/tables/live", async (c) => {
    const a = await portalAuth(c); if (a.res) return a.res;
    await ensure();
    const cfg = await cfgNow();
    // الجلسات اللي عدّى عليها الوقت بتتقفل هنا (مفيش cron)
    await pool.query(
      `UPDATE table_sessions SET ended_at=NOW(), end_reason='idle'
        WHERE ended_at IS NULL AND last_at <= NOW() - make_interval(mins => $1::int)`, [cfg.sessionIdleMin]).catch(() => {});
    const [sessions, orders, freed, calls] = await Promise.all([
      pool.query(`SELECT table_no, count(*)::int AS sessions, min(created_at) AS since, max(last_at) AS last_at
                    FROM table_sessions WHERE ended_at IS NULL GROUP BY 1`).then((r) => r.rows).catch(() => []),
      pool.query(`SELECT order_no, NULLIF(to_jsonb(o)->>'table_no','')::int AS table_no, total, created_at, pos_ready_at
                    FROM shop_orders o
                   WHERE NULLIF(to_jsonb(o)->>'table_no','') IS NOT NULL AND ${PAID_SQL.replace(/status/g, "o.status")}
                     AND o.created_at > NOW() - interval '6 hours'
                   ORDER BY o.created_at`).then((r) => r.rows).catch(() => []),
      pool.query("SELECT table_no, freed_at FROM table_qr WHERE freed_at IS NOT NULL").then((r) => r.rows).catch(() => []),
      pool.query(`SELECT id, table_no, kind, created_at FROM table_calls
                   WHERE done_at IS NULL AND created_at > NOW() - make_interval(mins => $1::int) ORDER BY created_at`, [CALL_OPEN_MIN])
        .then((r) => r.rows).catch(() => []),
    ]);
    return c.json({
      ok: true, idleMin: cfg.sessionIdleMin, tables: liveTables({ sessions, orders, freed }),
      calls: calls.map((x) => ({
        id: Number(x.id), table: x.table_no, kind: x.kind,
        label: (CALL_KINDS[x.kind] || CALL_KINDS.waiter).label, icon: (CALL_KINDS[x.kind] || CALL_KINDS.waiter).icon,
        at: x.created_at,
      })),
    });
  });

  /* «الطاولة فضيت»: كل جلسات الطاولة بتخلص — الموبايلات اللي كانت عليها لازم تمسح تاني */
  app.post("/api/tables/:n/free", async (c) => {
    const a = await portalAuth(c); if (a.res) return a.res;
    const n = parseTable(c.req.param("n"), { ...(await cfgNow()), enabled: true });
    if (!n) return bad(c, "bad_table");
    await ensure();
    const ended = await freeTable(pool, n, a.user?.name || a.user?.role || "portal");
    console.log(`[tables] table ${n} freed by ${String(a.user?.name || "?").slice(0, 40)} — ${ended} session(s) ended`);
    return c.json({ ok: true, table: n, ended });
  });

  /* ═══ اللوحة (#store/settings/tables) — قسم «الإعدادات» عبر requireAdmin ═══ */
  app.get("/api/tables/admin", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = await cfgNow();
    const list = await rows();
    const pt = branchPoint(cfg);
    return c.json({ ok: true, config: cfg, branch: { lat: pt.lat, lng: pt.lng, source: pt.source }, tables: list.map(view), missing: Array.from({ length: cfg.count }, (_, i) => i + 1).filter((n) => !list.some((r) => r.table_no === n)) });
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
      await pool.query("UPDATE table_sessions SET ended_at=NOW(), end_reason='rotated' WHERE ended_at IS NULL").catch(() => {});
      note(c, `🍽 طاولات: تدوير كل المفاتيح (${list.length}) — لازم تطبع الستاندات من جديد`);
    } else {
      const n = parseTable(b.table, { ...(await cfgNow()), enabled: true });
      if (!n) return bad(c, "bad_table");
      const r = await pool.query("UPDATE table_qr SET key=$2, rotated_at=NOW() WHERE table_no=$1 RETURNING table_no", [n, newTableKey()]);
      if (!r.rowCount) return bad(c, "unknown_table", 404);
      // الجلسات اللي اتفتحت بالمفتاح القديم بتخلص كمان (الستاند اتسرق/اتصوّر)
      await pool.query("UPDATE table_sessions SET ended_at=NOW(), end_reason='rotated' WHERE table_no=$1 AND ended_at IS NULL", [n]).catch(() => {});
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
    if (!b.active) await pool.query("UPDATE table_sessions SET ended_at=NOW(), end_reason='disabled' WHERE table_no=$1 AND ended_at IS NULL", [n]).catch(() => {});
    note(c, `🍽 طاولة ${n}: ${b.active ? "اتفعّلت" : "اتوقفت"}`);
    return c.json({ ok: true, tables: (await rows()).map(view) });
  });

  /* الإعدادات: بنكتب settings.tables بس (jsonb_set) — مش الـPUT الكامل */
  const NUM_KEYS = ["count", "maxNo", "maxOpenPerTable", "openWindowMin", "geoRadiusM", "sessionIdleMin"];
  app.post("/api/tables/admin/config", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json"); }
    const cur = (await getSettingsData().catch(() => ({}))).tables || {};
    const next = { ...cur };
    for (const k of ["enabled", "requireKey", "callsEnabled", "geoEnabled"]) if (typeof b[k] === "boolean") next[k] = b[k];
    for (const k of NUM_KEYS) if (b[k] !== undefined) next[k] = Number(b[k]);
    // نقطة الفرع: فاضي/null = نفس نقطة التوصيل
    for (const k of ["geoLat", "geoLng"]) {
      if (b[k] === null || b[k] === "") next[k] = null;
      else if (b[k] !== undefined) next[k] = Number(b[k]);
    }
    const clean = tableCfg({ tables: next });
    // رقم برّه الحدود = رفض صريح، مش تصحيح بالسكات
    for (const k of NUM_KEYS) {
      if (b[k] !== undefined && clean[k] !== Number(b[k])) return bad(c, "bad_" + k);
    }
    for (const k of ["geoLat", "geoLng"]) {
      if (b[k] !== undefined && b[k] !== null && b[k] !== "" && clean[k] !== Number(b[k])) return bad(c, "bad_" + k);
    }
    if ((clean.geoLat == null) !== (clean.geoLng == null)) return bad(c, "bad_geo_point");
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

  return { verify: (n, key, cfg) => verifyTableKey(pool, n, key, cfg), busy: (n, cfg) => tableBusy(pool, n, cfg), ensure };
}
