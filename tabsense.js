// tabsense.js — headless connector to the TabSense dashboard.
//
// TabSense exposes no partner API, so we drive the same HTTP endpoints the
// dashboard uses: cookie-based session login, DataTables JSON for listings,
// the promocode detail page for per-code redemption, and the promocode
// bulk-create form for uploading new code batches.
//
// Pure session client — no DB, no app deps. Node 22 globals only
// (fetch/FormData/Blob + undici's headers.getSetCookie()).

const BASE = (process.env.TABSENSE_BASE || "https://app.tabsense.ai").replace(/\/$/, "");
const STORE = process.env.TABSENSE_STORE || "freshcuts";
const EMAIL = process.env.TABSENSE_EMAIL || "";
const PASSWORD = process.env.TABSENSE_PASSWORD || "";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const dash = (p) => `${BASE}/${STORE}/dashboard${p}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Gentle spacing between sequential dashboard reads to stay well under the
// 60 req/min rate limit when sweeping many promocode batches.
const THROTTLE_MS = Number(process.env.TABSENSE_THROTTLE_MS || 200);

// ─── Cookie jar ───────────────────────────────────────────────────────────────
function makeJar() {
  const jar = new Map();
  return {
    absorb(res) {
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const line of set) {
        const [pair] = line.split(";");
        const i = pair.indexOf("=");
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() {
      return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    },
    has(name) { return jar.has(name); },
  };
}

function matchToken(html) {
  // Laravel blade: <input type="hidden" name="_token" value="...">
  const m = html.match(/name="_token"[^>]*value="([^"]+)"/) ||
            html.match(/value="([^"]+)"[^>]*name="_token"/) ||
            html.match(/<meta name="csrf-token" content="([^"]+)"/);
  return m ? m[1] : null;
}

// ─── Session ───────────────────────────────────────────────────────────────────
// A session is { jar, createdAt }. Cached module-level; re-created on demand.
let _session = null;
let _loginInFlight = null;

async function doLogin() {
  if (!EMAIL || !PASSWORD) throw new Error("TABSENSE_EMAIL / TABSENSE_PASSWORD not set");
  const jar = makeJar();

  const page = await fetch(dash("/login"), {
    headers: { "User-Agent": UA, "Accept": "text/html" },
    redirect: "manual",
  });
  jar.absorb(page);
  const html = await page.text();
  const token = matchToken(html);
  if (!token) throw new Error("login: CSRF _token not found on login page");

  const body = new URLSearchParams({
    _token: token,
    email: EMAIL,
    password: PASSWORD,
    keep_me_login: "1",
  });

  let res = await fetch(dash("/login"), {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/html",
      "Referer": dash("/login"),
      "Cookie": jar.header(),
    },
    body,
    redirect: "manual",
  });
  jar.absorb(res);

  // Follow one redirect (to dashboard) to settle the authenticated session cookie.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (loc) {
      const url = loc.startsWith("http") ? loc : BASE + loc;
      const follow = await fetch(url, {
        headers: { "User-Agent": UA, "Cookie": jar.header(), "Accept": "text/html" },
        redirect: "manual",
      });
      jar.absorb(follow);
      const t = follow.headers.get("location") || url;
      if (/\/login/.test(t)) throw new Error("login: bounced back to /login (bad credentials?)");
    }
  } else if (res.status === 200) {
    // Some setups return 200 with the login form again on failure.
    const txt = await res.text();
    if (/name="password"/.test(txt) && /name="email"/.test(txt)) {
      throw new Error("login: credentials rejected");
    }
  }

  return { jar, createdAt: Date.now() };
}

// Return a live session, logging in (once, de-duped) if needed.
async function getSession(force = false) {
  if (force) _session = null;
  const MAX_AGE = 20 * 60 * 1000; // re-login every 20 min
  if (_session && Date.now() - _session.createdAt < MAX_AGE) return _session;
  if (_loginInFlight) return _loginInFlight;
  _loginInFlight = doLogin()
    .then((s) => { _session = s; return s; })
    .finally(() => { _loginInFlight = null; });
  return _loginInFlight;
}

// GET with the session cookie; one automatic re-login on auth bounce.
async function authGet(path, { json = false } = {}) {
  const run = async (s) => {
    const url = path.startsWith("http") ? path : dash(path);
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Cookie": s.jar.header(),
        "Accept": json ? "application/json, text/javascript, */*" : "text/html",
        ...(json ? { "X-Requested-With": "XMLHttpRequest" } : {}),
      },
      redirect: "manual",
    });
    return res;
  };
  let s = await getSession();
  let res = await run(s);
  if (res.status === 401 || res.status === 419 || (res.status >= 300 && res.status < 400 && /\/login/.test(res.headers.get("location") || ""))) {
    s = await getSession(true);
    res = await run(s);
  }
  // Rate limited: honour Retry-After (or back off) and retry once.
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after")) || 0;
    await sleep(ra > 0 ? Math.min(ra * 1000, 15000) : 3000);
    res = await run(s);
  }
  return res;
}

// ─── Read: promocode batches ────────────────────────────────────────────────────
// Returns [{ id, name, type, promotion, uses:{used,total}, status }]
async function listPromocodeBatches() {
  const cols = ["id", "code", "type", "promotion.name", "uses", "status", "actions"];
  const qs = new URLSearchParams();
  qs.set("draw", "1");
  cols.forEach((c, i) => { qs.set(`columns[${i}][data]`, c); });
  qs.set("order[0][column]", "0");
  qs.set("order[0][dir]", "desc");
  qs.set("start", "0");
  qs.set("length", "1000");
  qs.set("search[value]", "");

  const res = await authGet(`/promocodes?${qs.toString()}`, { json: true });
  if (!res.ok) throw new Error(`listPromocodeBatches: HTTP ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data.data) ? data.data : [];
  return rows.map((r) => {
    // id may be a plain number or embedded in the actions HTML (/promocodes/{id})
    let id = r.id;
    if (id == null || typeof id === "object") {
      const blob = JSON.stringify(r);
      const m = blob.match(/\/promocodes\/(\d+)/);
      id = m ? Number(m[1]) : null;
    }
    return {
      id,
      name: stripTags(String(r.code ?? "")),
      type: stripTags(String(r.type ?? "")),
      promotion: r["promotion.name"] ?? r.promotion?.name ?? "",
      uses: parseUses(r.uses),
      status: stripTags(String(r.status ?? "")),
    };
  }).filter((b) => b.id != null);
}

function stripTags(s) { return String(s).replace(/<[^>]*>/g, "").trim(); }
function parseUses(v) {
  const m = String(v ?? "").match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { used: Number(m[1]), total: Number(m[2]) } : { used: 0, total: 0 };
}

// ─── Read: per-code redemption inside a batch ───────────────────────────────────
// The detail page renders a table of <code>CODE</code> + a "used / limit" cell.
// Returns [{ code, used, limit, redeemed }]
async function fetchBatchCodes(batchId) {
  const res = await authGet(`/promocodes/${batchId}`);
  if (!res.ok) throw new Error(`fetchBatchCodes(${batchId}): HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  // Each row: ... <code ...>CODE</code> ... <span class="badge ...">Active/Expired</span> ... N / M ...
  const re = /<code[^>]*>([^<]+)<\/code>([\s\S]*?)(?:<\/tr>)/g;
  let m;
  while ((m = re.exec(html))) {
    const code = m[1].trim();
    const cell = m[2];
    const uses = cell.match(/(\d+)\s*\/\s*(\d+)/);
    const used = uses ? Number(uses[1]) : (/badge-danger|Expired|منتهي/.test(cell) ? 1 : 0);
    const limit = uses ? Number(uses[2]) : 1;
    out.push({ code, used, limit, redeemed: used > 0 });
  }
  return out;
}

// Collect EVERY code string that already exists on TabSense (across all batches).
// Used as an idempotency guard before uploading: if a batch's codes are already
// present, we must not re-upload (would create a duplicate batch on TabSense).
async function fetchExistingCodeSet() {
  const batches = await listPromocodeBatches();
  const set = new Set();
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS);
    try {
      const codes = await fetchBatchCodes(batches[i].id);
      for (const c of codes) set.add(c.code);
    } catch (e) {
      // Fail closed: if we can't read a batch, propagate so the caller can
      // decide NOT to upload (avoids duplicates on partial reads).
      throw new Error(`fetchExistingCodeSet: batch ${batches[i].id} read failed: ${e.message}`);
    }
  }
  return set;
}

// Collect every redeemed (used>0) code across all promocode batches.
// Returns { codes: [string], batches: n, scanned: n }
async function fetchAllRedeemedCodes() {
  const batches = await listPromocodeBatches();
  const redeemed = [];
  let scanned = 0;
  for (const b of batches) {
    // Skip batches with zero uses to save requests.
    if (b.uses && b.uses.used === 0) { scanned++; continue; }
    if (scanned > 0) await sleep(THROTTLE_MS);
    try {
      const codes = await fetchBatchCodes(b.id);
      for (const c of codes) if (c.redeemed) redeemed.push(c.code);
    } catch (e) {
      // Non-fatal: one bad batch shouldn't abort the whole sweep.
      console.error(`[tabsense] batch ${b.id} scan failed:`, e.message);
    }
    scanned++;
  }
  return { codes: redeemed, batches: batches.length, scanned };
}

// ─── Write: upload a unique-code batch ──────────────────────────────────────────
// opts: { promotionId, batchName, startDate, endDate, usageLimit=1, codes:[string] }
// Uploads codes as a one-column CSV to the promocode bulk-create form.
async function uploadCodeBatch(opts) {
  const { promotionId, batchName, startDate, endDate, usageLimit = 1, codes } = opts;
  if (!promotionId) throw new Error("uploadCodeBatch: promotionId required");
  if (!Array.isArray(codes) || codes.length === 0) throw new Error("uploadCodeBatch: no codes");

  // Fetch the create page to learn the form action + a fresh _token.
  const s = await getSession();
  const pageRes = await authGet(`/promocodes/create`);
  const page = await pageRes.text();
  const token = matchToken(page);
  if (!token) throw new Error("uploadCodeBatch: CSRF token not found on create page");
  const action = findPromocodeFormAction(page) || dash("/promocodes");

  const csv = "Code\r\n" + codes.map((c) => String(c).trim()).filter(Boolean).join("\r\n") + "\r\n";

  const fd = new FormData();
  fd.append("_token", token);
  fd.append("promotion_id", String(promotionId));
  if (startDate) fd.append("start_date", startDate);
  if (endDate) fd.append("end_date", endDate);
  fd.append("type", "2"); // 2 = unique (one-time) codes
  fd.append("usage_limit", String(usageLimit));
  fd.append("batch_name", batchName || "Ambassador Batch");
  fd.append("file", new Blob([csv], { type: "text/csv" }), "codes.csv");

  const res = await fetch(action.startsWith("http") ? action : BASE + action, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Cookie": s.jar.header(),
      "Accept": "text/html,application/json",
      "Referer": dash("/promocodes/create"),
    },
    body: fd,
    redirect: "manual",
  });

  const ok = res.status === 200 || (res.status >= 300 && res.status < 400);
  if (!ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`uploadCodeBatch: HTTP ${res.status} ${txt.slice(0, 300)}`);
  }
  return { ok: true, uploaded: codes.length, status: res.status };
}

function findPromocodeFormAction(html) {
  // Find the <form> that contains the promocode field "batch_name" and return its action.
  const forms = html.split(/<form/i);
  for (let i = 1; i < forms.length; i++) {
    const chunk = "<form" + forms[i];
    if (/name="batch_name"|name="promotion_id"/.test(chunk)) {
      const m = chunk.match(/action="([^"]+)"/);
      if (m) return m[1];
    }
  }
  return null;
}

// Find the <form> action whose body contains a field matching `fieldRe`.
function findFormAction(html, fieldRe) {
  const forms = html.split(/<form/i);
  for (let i = 1; i < forms.length; i++) {
    const chunk = "<form" + forms[i];
    if (fieldRe.test(chunk)) {
      const m = chunk.match(/action="([^"]+)"/);
      if (m) return m[1];
    }
  }
  return null;
}

// ─── List promotions (for discount% → promotion mapping) ────────────────────────
// Returns [{ id, name }] parsed from the create page's promotion dropdown.
async function listPromotions() {
  const res = await authGet(`/promocodes/create`);
  const html = await res.text();
  // Isolate the promotion_id select, then read its options.
  const sel = html.match(/name="promotion_id"[\s\S]*?<\/select>/);
  const scope = sel ? sel[0] : html;
  const out = [];
  const re = /<option[^>]*value="(\d+)"[^>]*>([^<]+)<\/option>/g;
  let m;
  while ((m = re.exec(scope))) out.push({ id: Number(m[1]), name: m[2].trim() });
  return out;
}

// ─── Promotions: full list + create + activate/deactivate + delete ───────────────
// Rich list from the promotions DataTables endpoint. Returns
// [{ id, name, type, startDate, endDate, active }]
async function listPromotionsFull() {
  const cols = ["id", "name", "promotion_type", "start_date", "end_date", "start_time", "applies_on_days", "active", "actions"];
  const qs = new URLSearchParams();
  qs.set("draw", "1");
  cols.forEach((c, i) => qs.set(`columns[${i}][data]`, c));
  qs.set("order[0][column]", "0");
  qs.set("order[0][dir]", "desc");
  qs.set("start", "0");
  qs.set("length", "1000");
  qs.set("search[value]", "");
  const res = await authGet(`/promotions?${qs.toString()}`, { json: true });
  if (!res.ok) throw new Error(`listPromotionsFull: HTTP ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data.data) ? data.data : [];
  return rows.map((r) => ({
    id: Number(r.id),
    // The name cell appends a priority-indicator <div>; keep only the leading text.
    name: stripTags(String(r.name ?? "").split("<")[0]).trim(),
    type: stripTags(String(r.promotion_type ?? "")),
    startDate: stripTags(String(r.start_date ?? "")),
    endDate: stripTags(String(r.end_date ?? "")),
    // The `active` cell is a checkbox; "checked" means active.
    active: /checked/i.test(String(r.active ?? "")),
  })).filter((p) => Number.isFinite(p.id));
}

// Create a SIMPLIFIED percentage/fixed promotion that requires a promo code
// (so it only applies when an ambassador code is entered — the natural pairing
// for the ambassador system). Returns { ok, id, name }.
// opts: { name, localName?, startDate, endDate, value, discountType=2(%)|1(fixed),
//         branches=[1], orderOptions=[1,2,3], paymentMethods=[], applyOn=3(order),
//         enablePromocode=true, customerTargetType=1(all), priority?, active? }
async function createPromotion(opts) {
  const {
    name, localName = "", startDate, endDate, value,
    discountType = 2, branches = [1], orderOptions = [1, 2, 3],
    paymentMethods = [], applyOn = 3, enablePromocode = true,
    customerTargetType = 1, priority = "",
  } = opts || {};
  if (!name || !startDate || !endDate || value == null) {
    throw new Error("createPromotion: name, startDate, endDate, value are required");
  }
  const s = await getSession();
  const pageRes = await authGet(`/promotions/create`);
  const page = await pageRes.text();
  const token = matchToken(page);
  if (!token) throw new Error("createPromotion: CSRF token not found");
  const action = findFormAction(page, /name="promotion_type"/) || dash("/promotions");

  const body = new URLSearchParams();
  body.append("_token", token);
  body.append("name", name);
  if (localName) body.append("local_name", localName);
  body.append("start_date", startDate);
  body.append("end_date", endDate);
  for (const b of branches) body.append("branches[]", String(b));
  for (const o of orderOptions) body.append("order_options[]", String(o));
  for (const p of paymentMethods) body.append("payment_methods[]", String(p));
  if (priority) body.append("priority", String(priority));
  body.append("promotion_type", "3");          // simplified
  body.append("discount_type", String(discountType)); // 2=percent, 1=fixed
  body.append("value", String(value));
  body.append("apply_on", String(applyOn));     // 3 = whole order
  if (enablePromocode) body.append("enable_promocode", "1");
  body.append("customer_target_type", String(customerTargetType)); // 1=all

  const res = await fetch(action.startsWith("http") ? action : BASE + action, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Cookie": s.jar.header(),
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/html,application/json",
      "Referer": dash("/promotions/create"),
    },
    body,
    redirect: "manual",
  });
  // Laravel redirects (302) to /promotions on success; 200 with the form back = validation error.
  if (res.status === 200) {
    const txt = await res.text().catch(() => "");
    if (/is-invalid|alert-danger|The .* field is required|whoops/i.test(txt)) {
      throw new Error(`createPromotion: rejected (validation). ${txt.slice(0, 200)}`);
    }
  } else if (!(res.status >= 300 && res.status < 400)) {
    const txt = await res.text().catch(() => "");
    throw new Error(`createPromotion: HTTP ${res.status} ${txt.slice(0, 200)}`);
  }
  // Resolve the new promotion's id by name (newest match).
  const list = await listPromotionsFull();
  const match = list.filter((p) => p.name === name).sort((a, b) => b.id - a.id)[0];
  return { ok: true, id: match?.id ?? null, name };
}

// Toggle a promotion's active flag (GET endpoint used by the dashboard switch).
// Returns the raw JSON ({ status }) from TabSense.
async function togglePromotionActive(id) {
  const res = await authGet(`/promotions/${id}/toggle-active`, { json: true });
  if (!res.ok) throw new Error(`togglePromotionActive(${id}): HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

// Ensure a promotion ends up in the desired active state (reads current, toggles if needed).
async function setPromotionActive(id, desired) {
  const list = await listPromotionsFull();
  const cur = list.find((p) => p.id === Number(id));
  if (!cur) throw new Error(`setPromotionActive: promotion ${id} not found`);
  if (cur.active === !!desired) return { ok: true, active: cur.active, changed: false };
  await togglePromotionActive(id);
  return { ok: true, active: !!desired, changed: true };
}

// Delete a promotion (Laravel destroy via POST _method=DELETE).
async function deletePromotion(id) {
  const s = await getSession();
  const pageRes = await authGet(`/promotions`);
  const token = matchToken(await pageRes.text());
  const body = new URLSearchParams();
  if (token) body.append("_token", token);
  body.append("_method", "DELETE");
  const res = await fetch(dash(`/promotions/${id}`), {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Cookie": s.jar.header(),
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/html,application/json",
      "Referer": dash("/promotions"),
    },
    body,
    redirect: "manual",
  });
  const ok = res.status === 200 || (res.status >= 300 && res.status < 400);
  return { ok, status: res.status };
}

async function ping() {
  await getSession(true);
  const b = await listPromocodeBatches();
  return { ok: true, batches: b.length };
}

export {
  getSession,
  listPromocodeBatches,
  fetchBatchCodes,
  fetchAllRedeemedCodes,
  fetchExistingCodeSet,
  uploadCodeBatch,
  listPromotions,
  listPromotionsFull,
  createPromotion,
  togglePromotionActive,
  setPromotionActive,
  deletePromotion,
  ping,
  BASE,
  STORE,
};
