/* ═══════════════════════════════════════════════════════════════════════════
   NINJA — the third delivery platform, and the only one that hands us a
   stable per-customer identifier.

   Registered by index.js via `register(app, ctx)`. Everything is admin-only.
   Every call against Ninja's own portal is a GET; nothing here creates,
   pauses, cancels, confirms, prices or configures anything on their side.

   ── Rules that shape every number in this file ────────────────────────────
   1. MONEY IS VAT-INCLUSIVE WHERE THE OWNER READS IT, VAT-EXCLUSIVE WHERE
      MARGIN IS COMPUTED. TabSense's gross/discount/net/tax EXCLUDE VAT;
      total/gross_incl/discount_incl INCLUDE it. Three of our seven Ninja
      orders carry `net = 0`, so the VAT-exclusive figures go through the same
      COALESCE fallback finance.js uses — never a bare `o.net`.
   2. VOIDS AND REFUNDS ARE NOT SALES. Same ILIKE guard as analytics.js.
   3. THE BUSINESS DAY IS `calendar_day`. TabSense rolls it at 04:00 Riyadh and
      we never re-derive it. Ninja's own `businessDay` is a DIFFERENT day
      boundary; where both appear they are labelled separately rather than
      silently reconciled.
   4. SEVEN ORDERS IS NOT A TREND. Every response carries a `sample` block and
      no endpoint hands back a growth rate, a forecast or a smoothed series.
   5. THE COMMISSION BAND IS PICKED BY THE ORDER'S OWN DAY. Ninja stepped
      10% → 16% on 2026-07-23. A flat rate would understate every order placed
      since by 60%. This is the single most important number on the page.
   6. FOOD COST IS MEASURED, NOT BLENDED. `item_costs` covers 100% of the line
      items on Ninja's orders, so `foodCostMeasuredShare` should read 1. The
      blended-rate fallback is still wired in and still reported, so the day an
      uncosted item appears the page says so instead of quietly guessing.

   ── What Ninja's portal actually gives us (probed 2026-08-02, read-only) ───
   • `/restaurants/orders` — per-order rows carrying a stable `userId` with NO
     name and NO phone. That is enough to measure REPEAT CUSTOMERS and nothing
     else; it can never support retargeting.
     BUT it only returns a rolling ~30-day window. Ninja forgets our June
     orders. So every portal read is accumulated into `ninja_orders`, and the
     repeat rate is computed off that growing cache — honest today, better
     every week.
   • `/restaurants/orders/report?startDate&endDate` — CSV in the response body,
     capped at ONE MONTH per call. Carries PREPARATION TIME per order, which
     exists nowhere else in this system, and reaches back past the 30-day
     window. No name, no phone, no userId.
   • `/restaurants/branches/{id}` — live store status, and the configured
     min/max prep time to hold the measured prep time against.
   • NO revenue, payout, invoice or settlement endpoint answers this login.
     `revenue_dashboard` is listed in our allowedActions but every path we
     tried 404s. So unlike Keeta, there is no measured-fee source for Ninja:
     every fee on this page is the CONTRACT'S model, and is labelled as one.
═══════════════════════════════════════════════════════════════════════════ */

import https from "node:https";
import { DEFAULT_RATES } from "./finance.js";

const TZ = "Asia/Riyadh";
const VAT_RATE = 0.15;
const DEFAULT_FOOD_COST_PCT = 0.43;      // only ever used for an UNCOSTED item

const NINJA_NOTE = "Ninja";

/* Voids/refunds never happened. Same predicate as analytics.js / finance.js. */
const SALES_ONLY = `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;
/* VAT-exclusive money with the rule-1 fallback chain baked into SQL, so no
   caller can forget that three of our Ninja rows have net = 0. */
const NET_EX = `COALESCE(NULLIF(o.net,0), NULLIF(o.total,0)/${1 + VAT_RATE}, 0)`;
const GROSS_EX = `COALESCE(NULLIF(o.gross,0), NULLIF(o.gross_incl,0)/${1 + VAT_RATE}, NULLIF(o.total,0)/${1 + VAT_RATE}, 0)`;
const LOCAL_HOUR = `(extract(hour from (o.order_date AT TIME ZONE '${TZ}'))::int)`;

/* ── numeric / date helpers ─────────────────────────────────────────────── */
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => Math.round(num(v) * 100) / 100;
const qty = (v) => Math.round(num(v) * 1000) / 1000;
const rate4 = (v) => (v === null || v === undefined ? null : Math.round(num(v) * 10000) / 10000);
/* Explicitly null (not 0, not Infinity) when there is nothing to divide by, so
   the UI renders "—" instead of a fabricated zero. */
const ratio = (a, b) => (num(b) === 0 ? null : rate4(num(a) / num(b)));

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayArg = (v, fallback) => (typeof v === "string" && DAY_RE.test(v) ? v : fallback);
const isoDay = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const shiftDay = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const spanDays = (from, to) =>
  Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1);
const daysUntil = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const median = (list) => {
  const s = list.map(num).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return money(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
};

/* ═══════════════════════════════════════════════════════════════════════════
   THE CONTRACT — subscription agreement dated 22/04/2026.

   The band table is imported from finance.js rather than retyped, so the P&L
   and this page can never quote different commission rates at each other.
   Anything here is overridable from `settings.financeRates.ninja` without a
   deploy, because a commercial agreement changes faster than this file does.

   THE CAVEAT IS PART OF THE DATA. Every page of our copy of this contract is
   watermarked "Incomplete", so `contract.caveats` ships in every response and
   the UI is expected to render it, not tuck it into a footnote.
═══════════════════════════════════════════════════════════════════════════ */
export const DEFAULT_CONTRACT = {
  reference: "اتفاقية اشتراك نينجا — 22/04/2026",
  signedOn: "2026-04-22",
  bands: (DEFAULT_RATES?.ninja?.bands || [
    { from: "2026-04-22", to: "2026-07-22", delivery: 0.10, pickup: 0.10, note: "رسوم خدمة ١٠٪ من ٢٢/٠٤/٢٠٢٦ حتى ٢٢/٠٧/٢٠٢٦" },
    { from: "2026-07-23", to: null, delivery: 0.16, pickup: 0.16, note: "رسوم خدمة ١٦٪ من ٢٣/٠٧/٢٠٢٦" },
  ]).map((b) => ({ ...b })),
  paymentFee: num(DEFAULT_RATES?.ninja?.paymentFeePct ?? 0.025),
  monthlySubscription: num(DEFAULT_RATES?.ninja?.monthlySubscriptionSar ?? 0),
  /* On WHAT amount the service fee is charged. Unlike Keeta — where the fee
     panel MEASURED it as the VAT-inclusive value after promotions — we have no
     Ninja settlement document and no portal endpoint that shows a fee. So this
     is an ASSUMPTION, it defaults to the VAT-exclusive net, and both readings
     are shipped side by side in /overview so the gap between them is visible
     rather than hidden inside one number. */
  feeBasis: "net_ex",
  caveats: Array.isArray(DEFAULT_RATES?.ninja?.caveats) && DEFAULT_RATES.ninja.caveats.length
    ? DEFAULT_RATES.ninja.caveats.slice()
    : ["نسختنا من عقد نينجا مكتوب على كل صفحة فيها «Incomplete» — البنود دي ممكن ما تكونش النهائية، راجعها قبل ما تبني عليها قرار."],
};

/** The day the service fee stepped 10% → 16%. The single most important date
 *  on this page, exported so the UI can key its countdown off one constant. */
export const RATE_STEP_DAY = "2026-07-23";

/** Merge the owner's settings over the shipped defaults. Only keys that are
 *  actually present and well-typed win, so a half-filled settings blob can
 *  never blank out a rate. */
export function resolveContract(settingsData) {
  const c = {
    ...DEFAULT_CONTRACT,
    bands: DEFAULT_CONTRACT.bands.map((b) => ({ ...b })),
    caveats: DEFAULT_CONTRACT.caveats.slice(),
  };
  const s = settingsData?.financeRates?.ninja || settingsData?.ninja;
  if (!s || typeof s !== "object") return c;

  if (Number.isFinite(Number(s.paymentFeePct))) c.paymentFee = Number(s.paymentFeePct);
  if (Number.isFinite(Number(s.paymentFee))) c.paymentFee = Number(s.paymentFee);
  if (Number.isFinite(Number(s.monthlySubscriptionSar))) c.monthlySubscription = Number(s.monthlySubscriptionSar);
  if (typeof s.feeBasis === "string" && ["net_ex", "total_incl"].includes(s.feeBasis)) c.feeBasis = s.feeBasis;
  if (Array.isArray(s.caveats) && s.caveats.length) {
    c.caveats = s.caveats.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  }
  if (Array.isArray(s.bands) && s.bands.length) {
    const bands = s.bands
      .filter((b) => b && DAY_RE.test(String(b.from)) && Number.isFinite(Number(b.delivery)))
      .map((b) => ({
        from: String(b.from),
        to: DAY_RE.test(String(b.to)) ? String(b.to) : null,
        delivery: Number(b.delivery),
        pickup: Number.isFinite(Number(b.pickup)) ? Number(b.pickup) : Number(b.delivery),
        note: typeof b.note === "string" ? b.note : "",
      }))
      .sort((a, b) => (a.from < b.from ? -1 : 1));
    if (bands.length) c.bands = bands;
  }
  return c;
}

/** The band covering `day`. Returns null for a day before the contract starts —
 *  an order predating it is NOT silently charged the first band's rate. */
export function bandOn(contract, day) {
  if (!day) return null;
  for (const b of contract.bands) {
    if (day >= b.from && (b.to === null || day <= b.to)) return b;
  }
  return null;
}

/** The band that follows `day`'s band, i.e. what the rate becomes next. */
function nextBandAfter(contract, day) {
  const cur = bandOn(contract, day);
  const idx = contract.bands.indexOf(cur);
  if (idx < 0) return contract.bands[0] || null;
  return contract.bands[idx + 1] || null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE PORTAL CLIENT.

   Ninja's gateway answers 500 to anything Node's global fetch sends — the
   sec-fetch-* / accept-encoding hints undici adds are enough to upset it —
   while a plain node:https request with the same token succeeds. portals.js
   keeps its own copy of this for the store-status tile; it is not exported, so
   this module carries its own rather than reaching into another agent's file.

   NOTHING BELOW MUTATES ANYTHING. Every request is a GET. The *_excel actions
   our login is entitled to are deliberately never called.
═══════════════════════════════════════════════════════════════════════════ */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const NINJA = {
  base: (process.env.NINJA_API_BASE || "https://food-vendor-portal.ananinja.com").replace(/\/+$/, ""),
  adminBase: (process.env.NINJA_ADMIN_BASE || "https://admin.ananinja.com").replace(/\/+$/, ""),
  branchId: process.env.NINJA_BRANCH_ID || "",
  restaurantId: process.env.NINJA_RESTAURANT_ID || "",
  jwt: process.env.NINJA_JWT || "",
  refresh: process.env.NINJA_REFRESH_TOKEN || "",
  _jwt: null,
};

const portalConfigured = () => !!(NINJA.branchId && (NINJA.jwt || NINJA.refresh));

function rawGet(url, headers = {}, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const req = https.request(
      { host: u.hostname, path: u.pathname + u.search, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("مهلة الاتصال بنينجا انتهت")));
    req.end();
  });
}

function jwtExpired(tok) {
  try {
    const p = JSON.parse(Buffer.from(String(tok).split(".")[1], "base64url").toString());
    return !p.exp || p.exp * 1000 < Date.now() + 60_000;
  } catch { return true; }
}

/** The access JWT lives 24h, the refresh token 7 days. The refresh call is a
 *  GET to a DIFFERENT host carrying the REFRESH token in the Authorization
 *  header — the same shape portals.js uses. The refresh token rotates on each
 *  call but the old one stays valid to its own expiry, so nothing is persisted. */
async function ninjaToken() {
  const current = NINJA._jwt || NINJA.jwt;
  if (current && !jwtExpired(current)) return current;
  if (!NINJA.refresh) throw new Error("انتهت صلاحية التوكن ومفيش refresh token — لازم تسجيل دخول جديد وتحديث NINJA_JWT");
  const r = await rawGet(`${NINJA.adminBase}/users/users/refresh`, {
    "User-Agent": UA,
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${NINJA.refresh}`,
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`فشل تحديث التوكن (HTTP ${r.status}) — سجّل دخول على بوابة نينجا وحدّث NINJA_JWT و NINJA_REFRESH_TOKEN`);
  }
  let tok = null;
  try {
    const j = JSON.parse(r.body);
    tok = j?.data?.attributes?.jwtToken || j.jwtToken || j.token || j.accessToken;
  } catch { /* fall through */ }
  if (!tok) throw new Error("رد التحديث مافيهوش توكن — سجّل دخول وحدّث NINJA_JWT");
  NINJA._jwt = tok;
  return tok;
}

/** One authenticated GET against the vendor portal. Returns the raw body and
 *  status; parsing is the caller's job because one endpoint answers CSV. */
async function portalRaw(path, timeoutMs) {
  const token = await ninjaToken();
  const res = await rawGet(NINJA.base + path, {
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    Origin: "https://restaurant-portal.ananinja.com",
  }, timeoutMs);
  if (res.status === 401 || res.status === 403) {
    NINJA._jwt = null;
    throw new Error("انتهت صلاحية التوكن — سجّل دخول على بوابة نينجا وحدّث NINJA_JWT");
  }
  return res;
}

async function portalJSON(path, timeoutMs) {
  const res = await portalRaw(path, timeoutMs);
  if (res.status < 200 || res.status >= 300) throw new Error(`نينجا ردت HTTP ${res.status} على ${path}`);
  try { return JSON.parse(res.body); } catch { throw new Error(`رد نينجا على ${path} مش JSON`); }
}

/** Best-effort read: a section that 404s must not sink the whole snapshot.
 *  Ninja's surface is uneven — half the paths in their own bundle are SPA
 *  routes with no API behind them — so a missing section is normal, not an
 *  outage, and is reported as `null` with its reason attached. */
async function portalTry(path, timeoutMs) {
  try { return { ok: true, data: await portalJSON(path, timeoutMs) }; }
  catch (e) { return { ok: false, reason: e.message }; }
}

const attrs = (row) => (row && row.attributes) ? { id: row.id, ...row.attributes } : (row || {});
const firstOf = (j) => {
  const d = j?.data;
  return Array.isArray(d) ? attrs(d[0]) : attrs(d);
};
const listOf = (j) => (Array.isArray(j?.data) ? j.data.map(attrs) : []);

/** Every order the portal will still admit to. It only keeps a rolling ~30-day
 *  window, so this is a SNAPSHOT, not a history — which is exactly why the
 *  caller writes it into `ninja_orders`. */
async function portalOrders(maxPages = 6, pageSize = 50) {
  const out = [];
  for (let p = 1; p <= maxPages; p++) {
    const j = await portalJSON(`/restaurants/orders?page%5Bnumber%5D=${p}&page%5Bsize%5D=${pageSize}`);
    const rows = listOf(j);
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

/* ── the CSV report ──────────────────────────────────────────────────────────
   GET /restaurants/orders/report?startDate&endDate answers 200 with CSV in the
   BODY (despite a JSON content-type). It is a plain read — no job is queued, no
   file is written on their side, nothing is emailed. It is the only source of
   PREPARATION TIME anywhere in this system, and it reaches back past the 30-day
   order window.

   Their gateway rejects any span longer than a month
   (`you_can_only_export_1_month_data`), so a range is walked in 28-day chunks. */
const REPORT_CHUNK_DAYS = 28;
const REPORT_MAX_CHUNKS = 8;   // ~7 months; a hard stop so a silly `from` cannot hammer them

/** Minimal RFC4180 parser — the Cancellation Reason column is free text and
 *  will contain a comma the day someone cancels with a sentence. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  const s = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); field = ""; if (row.some((x) => x !== "")) rows.push(row); row = []; }
    else field += ch;
  }
  row.push(field);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

/** "2026-07-04 14:26:20 +0300" → { iso, day } where `day` is the Riyadh
 *  CALENDAR day. Deliberately NOT our 04:00 business day: this timestamp comes
 *  from Ninja, and mixing their day boundary with ours is how a reconciliation
 *  invents a mismatch that is really a clock difference. */
function parseReportTime(s) {
  const t = String(s || "").trim();
  if (!t) return { iso: null, day: null };
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/);
  if (!m) return { iso: null, day: t.slice(0, 10) || null };
  const off = m[7] || "+0300";
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off.slice(0, 3)}:${off.slice(3)}`;
  return { iso, day: `${m[1]}-${m[2]}-${m[3]}` };
}

/** The report for one window, already shaped. Column order is read from the
 *  header row rather than assumed, so a new Ninja column cannot shift the data
 *  by one silently. */
async function portalReport(from, to) {
  const res = await portalRaw(
    `/restaurants/orders/report?startDate=${encodeURIComponent(from)}&endDate=${encodeURIComponent(to)}`
  );
  if (res.status === 422) {
    let detail = "";
    try { detail = JSON.parse(res.body)?.errors?.[0]?.detail || ""; } catch { /* ignore */ }
    throw new Error(`نينجا رفضت المدى (${detail || "422"})`);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`تقرير نينجا رد HTTP ${res.status}`);
  const rows = parseCSV(res.body);
  if (!rows.length) return [];
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (...names) => {
    for (const n of names) {
      const i = head.indexOf(n.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };
  const iId = col("id");
  const iStatus = col("status");
  const iTotal = col("total amount");
  const iPlaced = col("placed at");
  const iPicked = col("picked up at");
  const iPrep = col("preparation time (mins)", "preparation time");
  const iCancel = col("cancellation reason");
  const iBranch = col("branch name");
  const out = [];
  for (const r of rows.slice(1)) {
    if (iId < 0 || !String(r[iId] || "").trim()) continue;
    const placed = parseReportTime(r[iPlaced]);
    const picked = parseReportTime(r[iPicked]);
    out.push({
      externalId: String(r[iId]).trim(),
      status: iStatus >= 0 ? String(r[iStatus] || "").trim() : "",
      totalAmount: iTotal >= 0 ? money(String(r[iTotal] || "").replace(/[^\d.-]/g, "")) : 0,
      placedAt: placed.iso,
      placedDay: placed.day,
      pickedUpAt: picked.iso,
      prepMinutes: iPrep >= 0 && String(r[iPrep] || "").trim() !== "" ? num(r[iPrep]) : null,
      cancellationReason: iCancel >= 0 ? String(r[iCancel] || "").trim() : "",
      branchName: iBranch >= 0 ? String(r[iBranch] || "").trim() : "",
    });
  }
  return out;
}

/** Walk a range in ≤28-day chunks and merge. Duplicate ids across chunk edges
 *  are collapsed on `externalId`. */
async function portalReportRange(from, to) {
  const seen = new Map();
  let cursor = from, chunks = 0;
  while (cursor <= to && chunks < REPORT_MAX_CHUNKS) {
    const end = shiftDay(cursor, REPORT_CHUNK_DAYS - 1);
    const stop = end > to ? to : end;
    const part = await portalReport(cursor, stop);
    for (const r of part) if (!seen.has(r.externalId)) seen.set(r.externalId, r);
    cursor = shiftDay(stop, 1);
    chunks++;
  }
  return { rows: [...seen.values()], chunks, truncated: cursor <= to };
}

/* ═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, todayISO, daysAgoISO } = ctx;

  /* ── the portal-order cache ───────────────────────────────────────────────
     Ninja's order list forgets everything older than ~30 days, so a repeat
     rate read straight off the portal would silently shrink its own
     denominator every week. Accumulating the rows here makes the repeat rate
     honest today and strictly better over time. The table is ours, the DDL is
     idempotent, and registration order does not matter.                       */
  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ninja_orders (
        portal_order_id   TEXT PRIMARY KEY,
        external_id       TEXT NOT NULL DEFAULT '',
        user_id           TEXT NOT NULL DEFAULT '',
        branch_id         TEXT NOT NULL DEFAULT '',
        status            TEXT NOT NULL DEFAULT '',
        pos_status        TEXT NOT NULL DEFAULT '',
        business_day      DATE,
        placed_at         TIMESTAMPTZ,
        total_amount      NUMERIC NOT NULL DEFAULT 0,
        total_tax         NUMERIC NOT NULL DEFAULT 0,
        delivery_fee      NUMERIC NOT NULL DEFAULT 0,
        prep_minutes      NUMERIC,
        cancel_reason     TEXT NOT NULL DEFAULT '',
        raw               JSONB NOT NULL DEFAULT '{}',
        first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ninja_orders_user_idx ON ninja_orders(user_id);
      CREATE INDEX IF NOT EXISTS ninja_orders_day_idx  ON ninja_orders(business_day);
      CREATE UNIQUE INDEX IF NOT EXISTS ninja_orders_ext_idx
        ON ninja_orders(external_id) WHERE external_id <> '';
    `);
  }
  ensureSchema().catch((e) => console.error("[ninja] ensureSchema failed:", e.message));

  /** Today's BUSINESS day in Riyadh (04:00 rollover), straight from Postgres so
   *  the API container's clock can never shift it by a day. */
  async function bizToday() {
    try {
      const r = await pool.query(`SELECT ((now() AT TIME ZONE '${TZ}') - interval '4 hours')::date AS day`);
      return isoDay(r.rows[0].day);
    } catch { return todayISO(); }
  }

  const range = (c) => {
    const from = dayArg(c.req.query("from"), daysAgoISO(29));
    const to = dayArg(c.req.query("to"), todayISO());
    return from <= to ? { from, to } : { from: to, to: from };
  };

  /* The sample-size verdict, attached to every response. Below this line the
     module refuses to present per-day figures as anything but arithmetic. */
  const MIN_ORDERS_FOR_RATE = 30;
  const sampleBlock = (orders, activeDays) => ({
    orders,
    activeDays,
    minOrdersForRate: MIN_ORDERS_FOR_RATE,
    tooSmallForRate: orders < MIN_ORDERS_FOR_RATE,
    note: orders < MIN_ORDERS_FOR_RATE
      ? `عندنا ${orders} طلب نينجا بس على ${activeDays} يوم. أي «معدل» أو «اتجاه» مبني على العدد ده مش معناه حاجة — الأرقام معروضة كأرقام خام مش كمؤشر.`
      : "",
  });

  /* Customer identity — a standing fact, not a computation. The POS side of a
     Ninja order carries customer_name 'Ninja' and no phone at all; the only
     identity anywhere is the portal's opaque userId. */
  const IDENTITY = {
    posHasPhone: false,
    portalHasUserId: true,
    note: "نينجا ما بتدّينا اسم ولا رقم تليفون للعميل — لا في نقطة البيع ولا في البوابة. اللي بتدّيه هو رقم عميل ثابت (userId) من غير أي بيانات شخصية: ده يكفي نقيس بيه العميل الراجع، وما يكفيش أبدًا لإعادة استهداف بواتساب أو رسايل.",
  };

  /* ═════════════════════════════════════════════════════════════════════════
     THE ONE QUERY THE POS-SIDE ENDPOINTS READ FROM.

     One row per Ninja order carrying the VAT-exclusive money (rule-1 fallback
     applied IN SQL) and the per-item cost aggregates. The LATERAL makes the
     cost date-aware: for each line it picks the newest cost row that was
     ALREADY EFFECTIVE on that order's own day, so entering a cost tomorrow
     does not silently rewrite last month's margin.
     $1 = from, $2 = to.
  ═════════════════════════════════════════════════════════════════════════ */
  const ORDERS_SQL = `
    WITH ic AS (
      SELECT i.order_id, o2.calendar_day, i.name, i.qty, i.amount
        FROM ts_order_items i
        JOIN ts_orders o2 ON o2.order_id = i.order_id
        JOIN order_sources s2 ON s2.order_id = o2.order_id
       WHERE s2.source_note ILIKE $3
         AND o2.calendar_day BETWEEN $1::date AND $2::date
    ),
    items AS (
      SELECT ic.order_id,
             sum(ic.amount) AS item_value_incl,
             COALESCE(sum(c.cost * ic.qty) FILTER (WHERE c.cost IS NOT NULL), 0) AS measured_cost,
             COALESCE(sum(ic.amount)       FILTER (WHERE c.cost IS NOT NULL), 0) AS covered_value_incl,
             count(*)::int AS lines,
             count(*) FILTER (WHERE c.cost IS NULL)::int AS uncosted_lines
        FROM ic
        LEFT JOIN LATERAL (
          SELECT x.cost FROM item_costs x
           WHERE x.item_name = ic.name AND x.effective_from <= ic.calendar_day
           ORDER BY x.effective_from DESC LIMIT 1
        ) c ON true
       GROUP BY 1
    )
    SELECT o.order_id, o.receipt, o.calendar_day, o.order_date, o.order_type, o.order_option,
           ${LOCAL_HOUR}                      AS hour,
           o.total, o.gross_incl, o.discount_incl,
           ${NET_EX}                          AS net_ex,
           ${GROSS_EX}                        AS gross_ex,
           (o.net IS NULL OR o.net = 0)       AS net_estimated,
           COALESCE(it.measured_cost, 0)      AS measured_cost,
           COALESCE(it.covered_value_incl, 0) AS covered_value_incl,
           COALESCE(it.item_value_incl, 0)    AS item_value_incl,
           COALESCE(it.uncosted_lines, 0)     AS uncosted_lines,
           (it.lines IS NOT NULL)             AS has_items
      FROM ts_orders o
      JOIN order_sources s ON s.order_id = o.order_id
      LEFT JOIN items it ON it.order_id = o.order_id
     WHERE s.source_note ILIKE $3
       AND o.calendar_day BETWEEN $1::date AND $2::date
       AND ${SALES_ONLY}
     ORDER BY o.calendar_day, o.order_date, o.order_id`;

  /**
   * Full economics of ONE Ninja order. The single place the money model lives,
   * so /overview, /orders and /items can never disagree with each other.
   *
   * Two commission figures are always produced, never one:
   *   • `commission`      — on the contracted basis (`contract.feeBasis`)
   *   • `commissionAlt`   — on the other basis
   * because we have no Ninja settlement document and no portal fee endpoint.
   * With Keeta we could MEASURE which basis is charged; here we cannot, and a
   * single number would be a guess wearing a fact's clothes.
   */
  function orderEconomics(row, contract, foodCostPct) {
    const day = isoDay(row.calendar_day);
    const netEx = num(row.net_ex);
    const grossEx = num(row.gross_ex);
    const totalIncl = num(row.total);
    const discountEx = Math.max(grossEx - netEx, 0);

    const band = bandOn(contract, day);
    const rate = band ? num(band.delivery) : null;

    const base = contract.feeBasis === "total_incl" ? totalIncl : netEx;
    const altBase = contract.feeBasis === "total_incl" ? netEx : totalIncl;

    const commission = rate === null ? null : base * rate;
    const commissionAlt = rate === null ? null : altBase * rate;
    const paymentFee = base * num(contract.paymentFee);
    const platformCost = rate === null ? null : commission + paymentFee;

    /* FOOD COST — measured per item, with the blended rate used ONLY for the
       value no costed line covers. `foodCostMeasuredShare` is what stops the
       assumption being mistaken for a measurement. */
    const measuredCost = num(row.measured_cost);
    const coveredValueEx = num(row.covered_value_incl) / (1 + VAT_RATE);
    const uncoveredEx = Math.max(grossEx - coveredValueEx, 0);
    const estimatedCost = uncoveredEx * foodCostPct;
    const foodCost = measuredCost + estimatedCost;

    /* "Contribution" = what the order leaves behind BEFORE fixed overheads
       (rent, salaries, ads). Those are period costs, not per-order ones. */
    const contribution = platformCost === null ? null : netEx - foodCost - platformCost;

    return {
      orderId: row.order_id,
      receipt: row.receipt || "",
      day,
      hour: num(row.hour),
      orderType: row.order_type || "",
      orderOption: row.order_option || "",

      revenueIncl: money(totalIncl),
      revenueEx: money(netEx),
      grossEx: money(grossEx),
      discountEx: money(discountEx),
      netEstimated: !!row.net_estimated,

      band: band ? { from: band.from, to: band.to, rate: rate4(rate), note: band.note || "" } : null,
      commissionRate: rate4(rate),
      commissionBase: money(base),
      commission: commission === null ? null : money(commission),
      commissionAltBasis: commissionAlt === null ? null : money(commissionAlt),
      paymentFee: money(paymentFee),
      platformCost: platformCost === null ? null : money(platformCost),
      platformTakeRate: platformCost === null ? null : ratio(platformCost, totalIncl),

      foodCost: money(foodCost),
      foodCostMeasured: money(measuredCost),
      foodCostEstimated: money(estimatedCost),
      foodCostMeasuredShare: foodCost > 0 ? rate4(measuredCost / foodCost) : null,
      uncostedLines: num(row.uncosted_lines),
      hasItems: !!row.has_items,

      contribution: contribution === null ? null : money(contribution),
      contributionMargin: contribution === null ? null : ratio(contribution, netEx),
      losing: contribution !== null && contribution < 0,
    };
  }

  async function loadOrders(from, to, contract, foodCostPct) {
    const rows = (await pool.query(ORDERS_SQL, [from, to, NINJA_NOTE])).rows;
    return rows.map((r) => orderEconomics(r, contract, foodCostPct));
  }

  /** Lifetime footprint, ignoring the date filter. The window is for the UI;
   *  "how much Ninja have we ever done" must not change because someone picked
   *  last 7 days. */
  async function lifetime() {
    const r = (await pool.query(
      `SELECT count(*)::int AS orders,
              count(DISTINCT o.calendar_day)::int AS days,
              COALESCE(sum(o.total), 0) AS revenue,
              min(o.calendar_day) AS first_day,
              max(o.calendar_day) AS last_day
         FROM ts_orders o JOIN order_sources s ON s.order_id = o.order_id
        WHERE s.source_note ILIKE $1 AND ${SALES_ONLY}`,
      [NINJA_NOTE]
    )).rows[0];
    return {
      orders: num(r.orders),
      activeDays: num(r.days),
      revenue: money(r.revenue),
      firstDay: isoDay(r.first_day),
      lastDay: isoDay(r.last_day),
    };
  }

  const foodCostPctOf = (settings) => {
    const v = Number(settings?.financeRates?.foodCostPct ?? settings?.foodCostPct);
    return Number.isFinite(v) && v > 0 && v < 1 ? v : DEFAULT_FOOD_COST_PCT;
  };

  /** Roll a list of per-order economics into one block. Every sum is over the
   *  same order list, so no two figures can come from different filters. */
  function aggregate(list) {
    const a = {
      orders: list.length,
      revenueIncl: 0, revenueEx: 0, grossEx: 0, discountEx: 0,
      commission: 0, commissionAlt: 0, paymentFee: 0, platformCost: 0,
      foodCost: 0, foodCostMeasured: 0, contribution: 0,
      unpriced: 0, losing: 0, uncostedLines: 0, withItems: 0, netEstimated: 0,
    };
    for (const o of list) {
      a.revenueIncl += o.revenueIncl;
      a.revenueEx += o.revenueEx;
      a.grossEx += o.grossEx;
      a.discountEx += o.discountEx;
      a.foodCost += o.foodCost;
      a.foodCostMeasured += o.foodCostMeasured;
      a.paymentFee += o.paymentFee;
      if (o.uncostedLines) a.uncostedLines += o.uncostedLines;
      if (o.hasItems) a.withItems++;
      if (o.netEstimated) a.netEstimated++;
      if (o.commission === null) { a.unpriced++; continue; }
      a.commission += o.commission;
      a.commissionAlt += o.commissionAltBasis || 0;
      a.platformCost += o.platformCost;
      a.contribution += o.contribution;
      if (o.losing) a.losing++;
    }
    return {
      orders: a.orders,
      revenueIncl: money(a.revenueIncl),
      revenueEx: money(a.revenueEx),
      grossEx: money(a.grossEx),
      discountEx: money(a.discountEx),
      discountRatio: ratio(a.discountEx, a.grossEx),
      avgOrder: a.orders ? money(a.revenueIncl / a.orders) : null,
      medianOrder: median(list.map((o) => o.revenueIncl)),
      commission: money(a.commission),
      commissionAltBasis: money(a.commissionAlt),
      paymentFee: money(a.paymentFee),
      platformCost: money(a.platformCost),
      platformTakeRate: ratio(a.platformCost, a.revenueIncl),
      foodCost: money(a.foodCost),
      foodCostMeasured: money(a.foodCostMeasured),
      foodCostMeasuredShare: a.foodCost > 0 ? rate4(a.foodCostMeasured / a.foodCost) : null,
      foodCostRatio: ratio(a.foodCost, a.revenueEx),
      contribution: money(a.contribution),
      contributionMargin: ratio(a.contribution, a.revenueEx),
      contributionPerOrder: a.orders ? money(a.contribution / a.orders) : null,
      losingOrders: a.losing,
      unpricedOrders: a.unpriced,
      uncostedLines: a.uncostedLines,
      ordersWithItems: a.withItems,
      itemCoverage: ratio(a.withItems, a.orders),
      netEstimatedOrders: a.netEstimated,
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/ninja/overview?from&to
     What we sold, what the contract takes and under which clause, what the
     food cost, and what is left.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/ninja/overview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const { from, to } = range(c);
      const settings = await getSettingsData();
      const contract = resolveContract(settings);
      const foodCostPct = foodCostPctOf(settings);
      const today = await bizToday();

      const [orders, life] = await Promise.all([
        loadOrders(from, to, contract, foodCostPct),
        lifetime(),
      ]);
      const days = spanDays(from, to);
      const win = aggregate(orders);

      // Per-day rows: the real days, never a smoothed series (rule 4).
      const byDay = new Map();
      for (const o of orders) {
        if (!byDay.has(o.day)) byDay.set(o.day, []);
        byDay.get(o.day).push(o);
      }
      const daily = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([day, list]) => ({ day, ...aggregate(list) }));

      // Split the window by band, because a window that straddles 2026-07-23
      // contains two different contracts and one average rate would hide that.
      const byBand = new Map();
      for (const o of orders) {
        const key = o.band ? `${o.band.from}` : "out_of_contract";
        if (!byBand.has(key)) byBand.set(key, { band: o.band, list: [] });
        byBand.get(key).list.push(o);
      }
      const bands = [...byBand.values()]
        .sort((a, b) => ((a.band?.from || "") < (b.band?.from || "") ? -1 : 1))
        .map((g) => ({ band: g.band, ...aggregate(g.list) }));

      const curBand = bandOn(contract, today);
      const nextBand = nextBandAfter(contract, today);
      const stepDay = curBand?.to ? shiftDay(curBand.to, 1) : RATE_STEP_DAY;

      // What the SAME window would have cost under each band. Explicitly a
      // model — it reprices real orders, it does not forecast new ones.
      const repriced = contract.bands.map((b) => {
        const commission = win.orders
          ? orders.reduce((acc, o) => acc + o.commissionBase * num(b.delivery), 0) : 0;
        const platform = commission + win.paymentFee;
        return {
          from: b.from, to: b.to, rate: rate4(b.delivery), note: b.note || "",
          commission: money(commission),
          platformCost: money(platform),
          contribution: money(win.revenueEx - win.foodCost - platform),
          contributionMargin: ratio(win.revenueEx - win.foodCost - platform, win.revenueEx),
        };
      });

      return c.json({
        ok: true,
        from, to, days, today,
        window: {
          ...win,
          activeDays: daily.length,
          ordersPerDay: days > 0 ? Math.round((win.orders / days) * 100) / 100 : 0,
        },
        lifetime: {
          ...life,
          daysSinceFirstOrder: life.firstDay ? spanDays(life.firstDay, today) : 0,
          daysSinceLastOrder: life.lastDay ? daysUntil(life.lastDay, today) : null,
        },
        daily,
        bands,
        orders,
        sample: sampleBlock(life.orders, life.activeDays),
        identity: IDENTITY,
        contract: {
          reference: contract.reference,
          signedOn: contract.signedOn,
          bands: contract.bands,
          paymentFee: contract.paymentFee,
          monthlySubscription: contract.monthlySubscription,
          feeBasis: contract.feeBasis,
          feeBasisNote: contract.feeBasis === "total_incl"
            ? "بنحسب رسوم الخدمة على إجمالي الفاتورة شامل الضريبة."
            : "بنحسب رسوم الخدمة على صافي المبيعات قبل الضريبة. ده افتراض مش قياس — مفيش عندنا كشف تسوية من نينجا ولا نقطة في البوابة بتعرض الرسوم، عشان كده الرقم على الأساس التاني معروض جنبه.",
          feeBasisMeasured: false,
          caveats: contract.caveats,
        },
        rateStep: {
          day: stepDay,
          passed: daysUntil(today, stepDay) < 0,
          daysSince: daysUntil(stepDay, today),
          fromRate: curBand ? rate4(curBand.delivery) : null,
          previousRate: (() => {
            const i = contract.bands.indexOf(curBand);
            return i > 0 ? rate4(contract.bands[i - 1].delivery) : null;
          })(),
          nextRate: nextBand ? rate4(nextBand.delivery) : null,
          note: "أهم رقم في الصفحة دي: رسوم الخدمة طلعت من ١٠٪ لـ ١٦٪ يوم ٢٣/٠٧/٢٠٢٦ — أي طلب بعد التاريخ ده بيتحسب بـ ١٦٪.",
        },
        repriced: {
          basis: "نفس طلبات المدى المختار، متسعّرة بكل شريحة — إعادة تسعير لطلبات حقيقية، مش توقّع",
          bands: repriced,
        },
        assumptions: [
          contract.feeBasis === "total_incl"
            ? "أساس احتساب العمولة (شامل الضريبة) افتراض مش مقاس."
            : "أساس احتساب العمولة (صافي قبل الضريبة) افتراض مش مقاس — الرقم على الأساس التاني معروض جنبه.",
          "عمولة الدفع الإلكتروني ٢.٥٪ من العقد، ما اتأكدتش من كشف تسوية.",
          "مفيش أي مصدر عند نينجا بيقول الرسوم الفعلية — على عكس كيتا اللي بتعرض تفصيل الرسوم لكل طلب.",
          ...contract.caveats,
        ],
      });
    } catch (e) {
      console.error("[ninja] overview failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/ninja/orders?from&to
     Every Ninja order, one row each, with its own economics. Seven rows today
     — small enough to ship whole, which is the honest alternative to a chart.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/ninja/orders", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const { from, to } = range(c);
      const settings = await getSettingsData();
      const contract = resolveContract(settings);
      const orders = await loadOrders(from, to, contract, foodCostPctOf(settings));
      const life = await lifetime();
      return c.json({
        ok: true, from, to,
        orders,
        totals: aggregate(orders),
        sample: sampleBlock(life.orders, life.activeDays),
        contract: { bands: contract.bands, paymentFee: contract.paymentFee, feeBasis: contract.feeBasis, caveats: contract.caveats },
      });
    } catch (e) {
      console.error("[ninja] orders failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/ninja/items?from&to
     Which items make money ON THIS PLATFORM and which lose it.

     The platform take is apportioned to each line by its share of its own
     order's value, so a line's margin carries the commission that line
     actually caused. That is an allocation, and it is labelled as one.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/ninja/items", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const { from, to } = range(c);
      const settings = await getSettingsData();
      const contract = resolveContract(settings);

      const rows = (await pool.query(`
        WITH ic AS (
          SELECT i.order_id, o.calendar_day, i.name, i.qty, i.amount
            FROM ts_order_items i
            JOIN ts_orders o ON o.order_id = i.order_id
            JOIN order_sources s ON s.order_id = o.order_id
           WHERE s.source_note ILIKE $3
             AND o.calendar_day BETWEEN $1::date AND $2::date
             AND ${SALES_ONLY}
        )
        SELECT ic.name,
               sum(ic.qty)::float8    AS qty,
               sum(ic.amount)::float8 AS revenue_incl,
               COALESCE(sum(c.cost * ic.qty) FILTER (WHERE c.cost IS NOT NULL), 0)::float8 AS measured_cost,
               COALESCE(sum(ic.amount)       FILTER (WHERE c.cost IS NOT NULL), 0)::float8 AS covered_incl,
               count(DISTINCT ic.order_id)::int AS orders,
               min(ic.calendar_day)::text AS first_day,
               max(ic.calendar_day)::text AS last_day
          FROM ic
          LEFT JOIN LATERAL (
            SELECT x.cost FROM item_costs x
             WHERE x.item_name = ic.name AND x.effective_from <= ic.calendar_day
             ORDER BY x.effective_from DESC LIMIT 1
          ) c ON true
         GROUP BY 1
         ORDER BY revenue_incl DESC`, [from, to, NINJA_NOTE])).rows;

      // The blended platform take across the window, used to charge each line
      // its proportional share. One rate for the window, not per order — an
      // allocation, not a measurement.
      const orders = await loadOrders(from, to, contract, foodCostPctOf(settings));
      const win = aggregate(orders);
      const takeRate = win.revenueIncl > 0 ? num(win.platformCost) / num(win.revenueIncl) : 0;

      const items = rows.map((r) => {
        const revIncl = money(r.revenue_incl);
        const revEx = money(revIncl / (1 + VAT_RATE));
        const cost = money(r.measured_cost);
        const covered = ratio(r.covered_incl, r.revenue_incl);
        const platformShare = money(revIncl * takeRate);
        const contribution = money(revEx - cost - platformShare);
        return {
          name: r.name,
          qty: qty(r.qty),
          orders: num(r.orders),
          revenueIncl: revIncl,
          revenueEx: revEx,
          foodCost: cost,
          costCoverage: covered,
          fullyCosted: covered !== null && covered >= 0.999,
          platformShare,
          contribution,
          contributionMargin: ratio(contribution, revEx),
          foodCostRatio: ratio(cost, revEx),
          losing: contribution < 0,
          firstDay: isoDay(r.first_day),
          lastDay: isoDay(r.last_day),
        };
      });

      return c.json({
        ok: true, from, to,
        items,
        winners: items.filter((i) => !i.losing).slice(0, 8),
        losers: items.filter((i) => i.losing).sort((a, b) => a.contribution - b.contribution),
        allocation: {
          platformTakeRate: rate4(takeRate),
          note: "عمولة المنصة موزّعة على الأصناف بنسبة قيمة كل صنف من قيمة الطلبات — ده توزيع منطقي مش رقم مقاس لكل صنف على حدة.",
        },
        coverage: {
          itemsFullyCosted: items.filter((i) => i.fullyCosted).length,
          items: items.length,
          valueCovered: ratio(
            items.reduce((a, i) => a + (i.fullyCosted ? i.revenueIncl : 0), 0),
            items.reduce((a, i) => a + i.revenueIncl, 0)
          ),
        },
        totals: win,
        contract: { caveats: contract.caveats },
      });
    } catch (e) {
      console.error("[ninja] items failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ── portal-order cache writer ──────────────────────────────────────────── */
  async function cachePortalOrders(list) {
    let stored = 0;
    for (const o of list) {
      const id = String(o.id ?? o.orderId ?? "").trim();
      if (!id) continue;
      await pool.query(`
        INSERT INTO ninja_orders
          (portal_order_id, external_id, user_id, branch_id, status, pos_status,
           business_day, placed_at, total_amount, total_tax, delivery_fee, cancel_reason, raw, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::timestamptz,$9,$10,$11,$12,$13::jsonb,NOW())
        ON CONFLICT (portal_order_id) DO UPDATE SET
          external_id = EXCLUDED.external_id,
          user_id     = EXCLUDED.user_id,
          status      = EXCLUDED.status,
          pos_status  = EXCLUDED.pos_status,
          total_amount= EXCLUDED.total_amount,
          total_tax   = EXCLUDED.total_tax,
          delivery_fee= EXCLUDED.delivery_fee,
          cancel_reason = EXCLUDED.cancel_reason,
          raw         = EXCLUDED.raw,
          synced_at   = NOW()`,
        [
          id,
          String(o.externalId ?? o.ordersReferenceId ?? ""),
          String(o.userId ?? ""),
          String(o.branchId ?? ""),
          String(o.status ?? ""),
          String(o.posStatus ?? ""),
          isoDay(o.businessDay) || null,
          o.createdAt || null,
          num(o.totalAmount),
          num(o.totalTax),
          num(o.deliveryFeeAmount),
          String(o.cancellationReason ?? "") || "",
          JSON.stringify(o),
        ]
      );
      stored++;
    }
    return stored;
  }

  /** Attach preparation time from the CSV report onto cached rows, matched on
   *  the portal's own externalId. Rows the 30-day order list no longer returns
   *  are inserted from the report alone, which is how history older than the
   *  window still lands in the cache. */
  async function cacheReportRows(rows) {
    let updated = 0;
    for (const r of rows) {
      if (!r.externalId) continue;
      const res = await pool.query(
        `UPDATE ninja_orders SET prep_minutes = $2, synced_at = NOW() WHERE external_id = $1`,
        [r.externalId, r.prepMinutes]
      );
      if (res.rowCount === 0) {
        await pool.query(`
          INSERT INTO ninja_orders
            (portal_order_id, external_id, user_id, status, business_day, placed_at,
             total_amount, prep_minutes, cancel_reason, raw)
          VALUES ($1,$2,'',$3,$4::date,$5::timestamptz,$6,$7,$8,$9::jsonb)
          ON CONFLICT (portal_order_id) DO NOTHING`,
          [
            `report:${r.externalId}`, r.externalId, r.status, r.placedDay, r.placedAt,
            num(r.totalAmount), r.prepMinutes, r.cancellationReason || "", JSON.stringify(r),
          ]
        );
      }
      updated++;
    }
    return updated;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/ninja/portal?report=1&from&to
     What Ninja's own portal says right now: store state, prep-time promise vs
     reality, menu size, working hours, and the live order list.

     NEVER 500s on a portal problem. An unreachable platform is a fact about
     the platform, not an error in this API, so it answers
     { ok:true, portal:false, reason } and the page renders the reason.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/ninja/portal", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!portalConfigured()) {
      return c.json({
        ok: true, portal: false,
        reason: "بوابة نينجا مش مربوطة — الناقص NINJA_BRANCH_ID و NINJA_JWT (أو NINJA_REFRESH_TOKEN)",
        configured: false,
      });
    }
    const wantReport = c.req.query("report") === "1";
    const { from, to } = range(c);
    try {
      // The token first: if this fails nothing else can work, and the reason
      // ("log in again") is the only actionable thing on the page.
      await ninjaToken();

      const [branch, restaurant, working, menus, cats, products, sponsor, banners] = await Promise.all([
        portalTry(`/restaurants/branches/${encodeURIComponent(NINJA.branchId)}`),
        portalTry(`/restaurants/restaurants?page%5Bsize%5D=20`),
        portalTry(`/restaurants/working_times?page%5Bsize%5D=20`),
        portalTry(`/restaurants/menus?page%5Bsize%5D=20`),
        portalTry(`/restaurants/categories?page%5Bsize%5D=100`),
        portalTry(`/restaurants/products?page%5Bsize%5D=200`),
        portalTry(`/restaurants/sponsorship_programs?page%5Bsize%5D=50`),
        portalTry(`/restaurants/banners?page%5Bsize%5D=50`),
      ]);

      const b = branch.ok ? firstOf(branch.data) : {};
      const rst = restaurant.ok ? firstOf(restaurant.data) : {};
      const wt = working.ok ? listOf(working.data) : [];
      const productList = products.ok ? listOf(products.data) : [];
      const catList = cats.ok ? listOf(cats.data) : [];

      let orderRows = [], orderErr = null, stored = 0;
      try {
        orderRows = await portalOrders();
        stored = await cachePortalOrders(orderRows);
      } catch (e) { orderErr = e.message; }

      let report = null;
      if (wantReport) {
        try {
          const rr = await portalReportRange(from, to);
          const updated = await cacheReportRows(rr.rows);
          const preps = rr.rows.map((r) => r.prepMinutes).filter((v) => v !== null && v > 0);
          report = {
            available: true,
            from, to,
            chunks: rr.chunks,
            truncated: rr.truncated,
            rows: rr.rows,
            cached: updated,
            prepMinutes: {
              orders: preps.length,
              avg: preps.length ? Math.round((preps.reduce((a, v) => a + v, 0) / preps.length) * 10) / 10 : null,
              median: median(preps),
              max: preps.length ? Math.max(...preps) : null,
              configuredMin: num(b.minimumPreparationTime) || null,
              configuredMax: num(b.maximumPreparationTime) || null,
              overConfigured: preps.filter((v) => v > num(b.maximumPreparationTime || 0)).length,
              note: "وقت التحضير ده مقاس من بوابة نينجا نفسها (من لحظة الطلب لحد استلام المندوب) — مفيش مصدر تاني في النظام كله بيدّي الرقم ده.",
            },
            note: "تقرير نينجا بيرجع CSV جوه الرد نفسه، وبحد أقصى شهر للنداء الواحد — بنقسّم المدى لشرايح ٢٨ يوم.",
          };
        } catch (e) { report = { available: false, reason: e.message }; }
      }

      const slotText = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

      return c.json({
        ok: true,
        portal: true,
        configured: true,
        checkedAt: new Date().toISOString(),
        store: {
          branchId: String(b.id ?? NINJA.branchId),
          status: b.status || null,
          open: b.status === "available",
          statusLabel: b.status === "available" ? "المتجر مفتوح"
            : b.status === "busy" ? "مشغول مؤقتاً"
            : b.status === "closed" ? "المتجر مقفول"
            : `الحالة: ${b.status || "غير معروفة"}`,
          enabled: b.enabled ?? null,
          activationStatus: b.activationStatus || null,
          activationType: b.activationType || null,
          integrationProvider: b.integrationsProviderType || null,
          closedBy: b.closedBy || null,
          minPrepMinutes: num(b.minimumPreparationTime) || null,
          maxPrepMinutes: num(b.maximumPreparationTime) || null,
          phone: b.phoneNumber || null,
          reason: branch.ok ? null : branch.reason,
        },
        account: {
          restaurantId: String(rst.id ?? NINJA.restaurantId ?? ""),
          name: rst.slug || null,
          enabled: rst.enabled ?? null,
          activationStatus: rst.activationStatus || null,
          minimumOrderValue: rst.minimumOrderValue ?? null,
          menuPricesIncludeVat: rst.menuPricesIncludesVat ?? null,
          posAutoAccept: rst.posAutoAccept ?? null,
          compensationAppealEnabled: rst.compensationAppealEnabled ?? null,
          deliveryFee: rst.deliveryFee ?? null,
          reason: restaurant.ok ? null : restaurant.reason,
        },
        workingTimes: wt.map((w) => ({
          title: w.title || "",
          open24Hours: !!w.open24Hours,
          slots: (Array.isArray(w.timeSlots) ? w.timeSlots : []).map((s) => ({
            weekday: num(s.weekday),
            start: slotText(num(s.startMinutes)),
            end: slotText(num(s.endMinutes)),
            crossesMidnight: num(s.endMinutes) >= 1440,
          })),
        })),
        menu: {
          menus: menus.ok ? listOf(menus.data).length : null,
          categories: catList.length || null,
          products: productList.length || null,
          unavailableProducts: productList.filter((p) => p.available === false).length,
          withoutImage: productList.filter((p) => !(Array.isArray(p.imageUrls) && p.imageUrls.length)).length,
          topPriced: productList
            .map((p) => ({ name: p.nameAr || p.nameEn, price: money(p.price), available: p.available !== false }))
            .sort((a, b2) => b2.price - a.price).slice(0, 10),
          reason: products.ok ? null : products.reason,
        },
        marketing: {
          sponsorshipPrograms: sponsor.ok ? listOf(sponsor.data).length : null,
          banners: banners.ok ? listOf(banners.data).length : null,
          note: "لو الاتنين صفر يبقى مفيش أي ترويج مدفوع شغّال على نينجا دلوقتي.",
        },
        liveOrders: {
          available: !orderErr,
          reason: orderErr,
          count: orderRows.length,
          cached: stored,
          windowNote: "بوابة نينجا بترجّع آخر ٣٠ يوم بس من الطلبات — عشان كده بنخزّنها عندنا كل مرة، والتاريخ بيتراكم مع الوقت.",
          orders: orderRows.map((o) => ({
            portalOrderId: String(o.id ?? ""),
            externalId: String(o.externalId ?? ""),
            userId: String(o.userId ?? ""),
            status: o.status || "",
            posStatus: o.posStatus || "",
            businessDay: isoDay(o.businessDay),
            placedAt: o.createdAt || null,
            totalAmount: money(o.totalAmount),
            totalTax: money(o.totalTax),
            // The customer pays this; it is not a cost to us. Kept visible
            // because a SAR 15 delivery fee on a SAR 37 basket is the whole
            // reason a customer does or does not order again.
            customerDeliveryFee: money(o.deliveryFeeAmount),
            freeDelivery: num(o.deliveryFeeAmount) === 0,
            cancellationReason: o.cancellationReason || "",
          })),
        },
        report,
        limits: {
          noRevenueEndpoint: true,
          note: "مفيش عند نينجا أي نقطة بترجّع إيرادات أو تحويلات أو كشف تسوية للحساب ده — جرّبنا كل المسارات المعروفة وكلها 404. يعني على عكس كيتا، كل رسوم نينجا في الصفحة دي محسوبة من العقد مش مقاسة من كشف.",
        },
      });
    } catch (e) {
      // Read-only failure of an external platform is never our 500.
      console.error("[ninja] portal read failed:", e.message);
      return c.json({ ok: true, portal: false, configured: true, reason: e.message });
    }
  });

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/ninja/customers
     THE ONE THING NINJA GIVES US THAT THE OTHER TWO DO NOT: a stable per-
     customer id, so the repeat rate on this platform is MEASURABLE.

     It is measured off our accumulated cache, not off a live call, because the
     portal only admits to 30 days and a live-only repeat rate would silently
     reset its own denominator every month.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/ninja/customers", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const today = await bizToday();
      const rows = (await pool.query(`
        SELECT user_id,
               count(*)::int AS orders,
               COALESCE(sum(total_amount), 0)::float8 AS revenue,
               min(COALESCE(business_day, placed_at::date))::text AS first_day,
               max(COALESCE(business_day, placed_at::date))::text AS last_day
          FROM ninja_orders
         WHERE user_id <> ''
           AND lower(status) NOT LIKE '%cancel%'
         GROUP BY 1 ORDER BY orders DESC, revenue DESC`)).rows;

      const cust = rows.map((r) => ({
        userId: r.user_id,
        orders: num(r.orders),
        revenue: money(r.revenue),
        avgOrder: num(r.orders) ? money(num(r.revenue) / num(r.orders)) : null,
        firstDay: isoDay(r.first_day),
        lastDay: isoDay(r.last_day),
        repeat: num(r.orders) > 1,
      }));

      const customers = cust.length;
      const repeat = cust.filter((x) => x.repeat).length;
      const totalOrders = cust.reduce((a, x) => a + x.orders, 0);

      const cov = (await pool.query(`
        SELECT count(*)::int AS cached,
               count(*) FILTER (WHERE user_id <> '')::int AS with_user,
               min(COALESCE(business_day, placed_at::date))::text AS first_day,
               max(COALESCE(business_day, placed_at::date))::text AS last_day,
               max(synced_at) AS last_sync
          FROM ninja_orders`)).rows[0] || {};

      const posOrders = (await lifetime()).orders;

      return c.json({
        ok: true,
        today,
        measurable: true,
        customers,
        repeatCustomers: repeat,
        repeatRate: ratio(repeat, customers),
        orders: totalOrders,
        ordersPerCustomer: customers ? Math.round((totalOrders / customers) * 100) / 100 : null,
        list: cust,
        coverage: {
          cachedOrders: num(cov.cached),
          withUserId: num(cov.with_user),
          firstDay: isoDay(cov.first_day),
          lastDay: isoDay(cov.last_day),
          lastSync: cov.last_sync || null,
          posOrders,
          note: "المخزون ده بيتبني من كل مرة بنقرأ فيها بوابة نينجا. البوابة بتنسى الطلبات الأقدم من ٣٠ يوم، فالتغطية بتزيد كل ما نقرأ أكتر — ونسبة العميل الراجع محسوبة على المخزون ده، مش على كل تاريخ المطعم.",
        },
        sample: sampleBlock(totalOrders, 0),
        caveat: customers > 0 && customers < 30
          ? `نسبة العميل الراجع دي محسوبة على ${customers} عميل بس. الرقم صحيح حسابيًا، لكنه مش كفاية تبني عليه قرار لوحده.`
          : "",
        vsOtherPlatforms: {
          ninja: "userId ثابت من غير اسم ولا تليفون → العميل الراجع يتقاس، وإعادة الاستهداف مستحيلة.",
          keeta: "الطلبات بتوصل من FeedUs من غير هوية عميل ثابتة في البوابة → العميل الراجع مايتقاسش من كيتا نفسها.",
          hungerstation: "بتخفي الاسم والرقم من المصدر (كل الطلبات اسمها نجوم وتليفونها فاضي) → لا قياس ولا استهداف.",
          note: "نينجا هي المنصة الوحيدة من التلاتة اللي ممكن نقيس عليها ولاء العميل أصلًا.",
        },
        identity: IDENTITY,
      });
    } catch (e) {
      console.error("[ninja] customers failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/ninja/reconcile?from&to
     Ninja's order list against ours.

     This exists because the probe that built this module found a real SAR 142
     Ninja order that never reached TabSense. An order the platform bills us
     for and the POS never saw is invisible revenue AND invisible commission,
     so it is worth its own endpoint rather than a footnote.

     Matching is on AMOUNT + DAY (±1 day), because the two sides share no id:
     Ninja's externalId is not stored on our order rows.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/ninja/reconcile", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = range(c);
    try {
      const ours = (await pool.query(
        `SELECT o.order_id, o.receipt, o.calendar_day::text AS day, o.order_date,
                o.total::float8 AS total
           FROM ts_orders o JOIN order_sources s ON s.order_id = o.order_id
          WHERE s.source_note ILIKE $3
            AND o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
          ORDER BY o.order_date`,
        [from, to, NINJA_NOTE]
      )).rows.map((r) => ({
        orderId: r.order_id, receipt: r.receipt, day: isoDay(r.day),
        placedAt: r.order_date, total: money(r.total), matched: false,
      }));

      if (!portalConfigured()) {
        return c.json({
          ok: true, portal: false, from, to,
          reason: "بوابة نينجا مش مربوطة — مفيش جانب تاني نطابق عليه",
          ours,
        });
      }

      let theirs = [];
      try {
        const rr = await portalReportRange(from, to);
        await cacheReportRows(rr.rows);
        theirs = rr.rows.map((r) => ({ ...r, matched: false }));
      } catch (e) {
        return c.json({ ok: true, portal: false, from, to, reason: e.message, ours });
      }

      // Greedy match on amount within SAR 0.5 and day within ±1 — the two
      // sides use different day boundaries and TabSense stores fractional
      // riyals (287.0055 against Ninja's 287.0).
      for (const t of theirs) {
        if (/cancel/i.test(t.status)) continue;
        const hit = ours.find((o) =>
          !o.matched &&
          Math.abs(o.total - t.totalAmount) <= 0.5 &&
          t.placedDay && Math.abs(daysUntil(t.placedDay, o.day)) <= 1
        );
        if (hit) { hit.matched = true; t.matched = true; t.ourOrderId = hit.orderId; }
      }

      const missingFromPos = theirs.filter((t) => !t.matched && !/cancel/i.test(t.status));
      const missingFromNinja = ours.filter((o) => !o.matched);
      const theirRevenue = money(theirs.filter((t) => !/cancel/i.test(t.status)).reduce((a, t) => a + t.totalAmount, 0));
      const ourRevenue = money(ours.reduce((a, o) => a + o.total, 0));

      return c.json({
        ok: true, portal: true, from, to,
        ninja: {
          orders: theirs.filter((t) => !/cancel/i.test(t.status)).length,
          cancelled: theirs.filter((t) => /cancel/i.test(t.status)).length,
          revenue: theirRevenue,
          source: "GET /restaurants/orders/report (CSV، بحد أقصى شهر للنداء)",
        },
        pos: { orders: ours.length, revenue: ourRevenue, source: "ts_orders + order_sources" },
        matched: theirs.filter((t) => t.matched).length,
        missingFromPos: missingFromPos.map((t) => ({
          externalId: t.externalId, placedAt: t.placedAt, day: t.placedDay,
          total: t.totalAmount, status: t.status, prepMinutes: t.prepMinutes,
        })),
        missingFromNinja,
        gap: {
          orders: missingFromPos.length,
          revenue: money(missingFromPos.reduce((a, t) => a + t.totalAmount, 0)),
          shareOfNinjaRevenue: ratio(missingFromPos.reduce((a, t) => a + t.totalAmount, 0), theirRevenue),
          note: missingFromPos.length
            ? "الطلبات دي نينجا شايفاها وإحنا مش شايفينها في نقطة البيع — يعني إيراد وعمولة الاتنين خارج أي تقرير عندنا. الأصل إن الوسيط (FeedUs) يكون رحّلها."
            : "كل طلبات نينجا في المدى ده موجودة عندنا.",
        },
        method: "المطابقة بالمبلغ (فرق ≤ ٠.٥ ريال) واليوم (فرق ≤ يوم) — نينجا وإحنا مافيش بينّا رقم طلب مشترك مخزّن، وحدود اليوم عندنا (٤ الفجر) غير حدود اليوم عندهم.",
      });
    } catch (e) {
      console.error("[ninja] reconcile failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  console.log("[ninja] routes ready (/api/ninja/overview|orders|items|portal|customers|reconcile)");
}

export default { register };
