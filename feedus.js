// feedus.js — headless connector to the FeedUs merchant dashboard (app.feedus.io).
//
// Why: FeedUs is the aggregator middleware sitting between the delivery apps
// (Keeta / HungerStation / Ninja / Jahez …) and the TabSense POS. TabSense
// records those orders as `order_type=External` but DROPS the originating app
// name — its dashboard never exposes `orders_external.source_channel`. FeedUs's
// own "POS order logs" page does expose it, together with the TabSense order id
// (`tenant_order_id: "freshcuts-2149"`), so this is the only place the two ids
// meet.
//
// Same shape as tabsense.js: cookie session, HTML scraping, no deps.

const BASE = (process.env.FEEDUS_BASE || "https://app.feedus.io").replace(/\/$/, "");
const EMAIL = process.env.FEEDUS_EMAIL || "";
const PASSWORD = process.env.FEEDUS_PASSWORD || "";
// The POS integration id in FeedUs (TabSense = 23 for Fresh Cuts; the number in
// the /pos-logs/<id> URL reachable from POS → Tabsense → gear icon).
const POS_ID = process.env.FEEDUS_POS_ID || "23";
// TabSense tenant prefix used in `tenant_order_id` ("freshcuts-2149").
const TENANT = process.env.TABSENSE_STORE || "freshcuts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THROTTLE_MS = Number(process.env.FEEDUS_THROTTLE_MS || 400);

const ENABLED = !!(EMAIL && PASSWORD);

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
  };
}

// The login page carries TWO forms — the login form (#login_form → /post-login)
// and a logout form. Pull the token out of the login form specifically.
function findLoginForm(html) {
  for (const part of html.split(/<form/i).slice(1)) {
    const end = part.search(/<\/form>/i);
    const chunk = "<form" + (end > -1 ? part.slice(0, end) : part);
    if (!/name="password"/.test(chunk)) continue;
    return {
      action: (chunk.match(/action="([^"]*)"/) || [])[1] || `${BASE}/post-login`,
      token: (chunk.match(/name="_token"[^>]*value="([^"]+)"/) ||
              chunk.match(/value="([^"]+)"[^>]*name="_token"/) || [])[1] || null,
    };
  }
  return null;
}

let _session = null;
let _loginInFlight = null;

async function doLogin() {
  if (!ENABLED) throw new Error("FEEDUS_EMAIL / FEEDUS_PASSWORD not set");
  const jar = makeJar();
  const page = await fetch(`${BASE}/login`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "manual",
  });
  jar.absorb(page);
  const html = await page.text();
  const form = findLoginForm(html);
  if (!form?.token) throw new Error("feedus login: login form / CSRF _token not found");

  const body = new URLSearchParams({ _token: form.token, email: EMAIL, password: PASSWORD, remember: "on" });
  const res = await fetch(form.action.startsWith("http") ? form.action : BASE + form.action, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
      Referer: `${BASE}/login`,
      Cookie: jar.header(),
    },
    body,
    redirect: "manual",
  });
  jar.absorb(res);
  if (res.status === 200) {
    const txt = await res.text();
    if (/name="password"/.test(txt) && /name="email"/.test(txt)) {
      throw new Error("feedus login: credentials rejected");
    }
  } else if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") || "";
    if (/\/login/.test(loc)) throw new Error("feedus login: bounced back to /login (bad credentials?)");
    // Follow up to 3 redirects so every session cookie lands in the jar.
    let next = loc;
    for (let i = 0; i < 3 && next; i++) {
      const follow = await fetch(next.startsWith("http") ? next : BASE + next, {
        headers: { "User-Agent": UA, Cookie: jar.header(), Accept: "text/html" },
        redirect: "manual",
      });
      jar.absorb(follow);
      next = follow.status >= 300 && follow.status < 400 ? follow.headers.get("location") : null;
      if (next && /\/login/.test(next)) throw new Error("feedus login: redirected back to /login");
    }
  }
  return { jar, createdAt: Date.now() };
}

async function getSession(force = false) {
  if (force) _session = null;
  const MAX_AGE = 20 * 60 * 1000;
  if (_session && Date.now() - _session.createdAt < MAX_AGE) return _session;
  if (_loginInFlight) return _loginInFlight;
  _loginInFlight = doLogin()
    .then((s) => { _session = s; return s; })
    .finally(() => { _loginInFlight = null; });
  return _loginInFlight;
}

async function authGet(path, { json = false } = {}) {
  const run = async (s) => fetch(path.startsWith("http") ? path : BASE + path, {
    headers: {
      "User-Agent": UA,
      Cookie: s.jar.header(),
      Accept: json ? "application/json, text/javascript, */*" : "text/html",
      ...(json ? { "X-Requested-With": "XMLHttpRequest" } : {}),
    },
    redirect: "manual",
  });
  let s = await getSession();
  let res = await run(s);
  const bouncedToLogin = res.status >= 300 && res.status < 400 && /\/login/.test(res.headers.get("location") || "");
  if (res.status === 401 || res.status === 419 || bouncedToLogin) {
    s = await getSession(true);
    res = await run(s);
  }
  return res;
}

// ─── POS order logs: the TabSense-order-id ⇄ delivery-app mapping ─────────────
// Each table row carries the row cells (provider, ids, time, status) AND the
// full JSON payload FeedUs pushed to TabSense, HTML-escaped inside the modal.
// The payload holds `tenant_order_id` ("freshcuts-2149") — the TabSense order id.
function parsePosLogsPage(html) {
  const out = [];
  const chunks = html.split(/<tr[\s>]/i).slice(1);
  for (const chunk of chunks) {
    const cells = [...chunk.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((m) => m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
    if (cells.length < 9) continue;
    const tenantRaw = (chunk.match(/tenant_order_id\\?&quot;:\\?&quot;([^\\&"]+)/) ||
                       chunk.match(/tenant_order_id"?:"?([\w-]+)/) || [])[1];
    const channel = (chunk.match(/source_channel\\?&quot;:\\?&quot;([^\\&"]+)/) ||
                     chunk.match(/source_channel"?:"?([\w ]+)/) || [])[1];
    // Row layout: # | ID | Feedus Order ID | Pos Order ID | Provider Order ID |
    //             Provider | Location | Brand | Date Time | Status
    const provider = (channel || cells[5] || "").trim();
    if (!tenantRaw || !provider) continue;
    const prefix = `${TENANT}-`;
    const tabsenseOrderId = tenantRaw.startsWith(prefix) ? tenantRaw.slice(prefix.length) : tenantRaw;
    out.push({
      tabsenseOrderId,
      tenantOrderId: tenantRaw,
      provider,
      feedusId: cells[1] || "",
      feedusOrderId: cells[2] || "",
      posOrderRef: cells[3] || "",
      providerOrderId: cells[4] || "",
      location: cells[6] || "",
      brand: cells[7] || "",
      dateTime: cells[8] || "",
      status: cells[9] || "",
    });
  }
  return out;
}

// Walk the POS logs newest-first. Stops early once `stopAfterKnown` consecutive
// rows are already-known TabSense order ids (cheap incremental sync).
async function fetchPosLogs({ pages = 3, posId = POS_ID, isKnown = null, stopAfterKnown = 15 } = {}) {
  const out = [];
  let knownStreak = 0;
  for (let page = 1; page <= pages; page++) {
    if (page > 1) await sleep(THROTTLE_MS);
    const res = await authGet(`/pos-logs/${posId}?page=${page}`);
    if (!res.ok) throw new Error(`fetchPosLogs: HTTP ${res.status}`);
    const rows = parsePosLogsPage(await res.text());
    if (!rows.length) break;
    for (const r of rows) {
      out.push(r);
      if (isKnown && isKnown(r.tabsenseOrderId)) knownStreak++; else knownStreak = 0;
    }
    if (isKnown && knownStreak >= stopAfterKnown) break;
  }
  return out;
}

// ─── Sales orders (JSON API behind the v2 dashboard) ─────────────────────────
// Rich per-order rows: provider, customer name, item names, amounts, delivery
// type. No TabSense id here — use fetchPosLogs for the id mapping.
async function fetchSalesOrders(startDate, endDate, { perPage = 100, maxPages = 20 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(THROTTLE_MS);
    const qs = new URLSearchParams({
      start_date: startDate, end_date: endDate,
      order_by: "CreatedDate", page: String(page), per_page: String(perPage),
    });
    const res = await authGet(`/api/react/dashboard/sales/orders?${qs}`, { json: true });
    if (!res.ok) throw new Error(`fetchSalesOrders: HTTP ${res.status}`);
    const body = await res.json();
    const rows = body?.data?.data || [];
    for (const r of rows) {
      out.push({
        id: r.id,
        orderId: String(r.order_id ?? ""),
        dateTime: r.date_time,
        brand: r.brand, location: r.location,
        provider: r.provider,
        customer: (r.customer || "").trim(),
        paymentMethod: r.payment_method,
        status: r.status,
        amountWithVat: Number(r.amount_with_vat) || 0,
        amountWithoutVat: Number(r.amount_without_vat) || 0,
        vat: Number(r.vat) || 0,
        items: r.item_names_arabic || "",
        deliveryType: r.delivery_type,
        scheduled: r.is_scheduled,
      });
    }
    const last = body?.data?.pagination?.last_page || 1;
    if (page >= last) break;
  }
  return out;
}

// ─── Per-order detail: the ONLY place the customer's phone exists ────────────
// The v2 React dashboard has no phone in any of its 72 column definitions —
// clicking an order id opens a legacy server-rendered page instead, and that
// page carries the name, the mobile and the free-text address. `id` here is the
// internal numeric id from the sales JSON, NOT the aggregator's order_id.
//
// The numbers are real subscriber MSISDNs, not a privacy relay: a 45-order
// sample held 40 distinct values spread across the genuine Saudi prefixes
// (50/53/55 STC, 54/56 Mobily, 58/59 Zain) — a relay collapses onto one.
// HungerStation masks both fields at source ('**********'); Ninja sends a name
// with an empty mobile.
function cellAfter(html, label) {
  // <td>Customer Name </td><td><strong>: Walid Banah </strong></td>
  const re = new RegExp(
    `<td[^>]*>\\s*${label}\\s*(?:</td>)\\s*<td[^>]*>\\s*(?:<strong[^>]*>)?\\s*:?\\s*([^<]*)`,
    "i"
  );
  const m = html.match(re);
  return m ? m[1].replace(/&nbsp;/g, " ").trim() : "";
}

async function fetchOrderDetail(internalId) {
  const res = await authGet(`/order/view?id=${encodeURIComponent(internalId)}`);
  if (!res.ok) throw new Error(`fetchOrderDetail(${internalId}): HTTP ${res.status}`);
  const html = await res.text();
  const masked = (v) => !v || /^\*+$/.test(v.replace(/\s/g, ""));
  const name = cellAfter(html, "Customer Name");
  const mobile = cellAfter(html, "Customer Mobile");
  const notesM = html.match(/Customer Order Notes\s*:?\s*<\/?[^>]*>?([^<]{0,300})/i);
  return {
    internalId: String(internalId),
    provider: cellAfter(html, "Provider"),
    orderId: cellAfter(html, "Order ID"),
    orderDate: cellAfter(html, "Order Date"),
    orderTime: cellAfter(html, "Order Time"),
    customerName: masked(name) ? "" : name,
    customerMobile: masked(mobile) ? "" : mobile.replace(/[^\d+]/g, ""),
    notes: (notesM ? notesM[1] : "").trim(),
  };
}

async function ping() {
  await getSession(true);
  const rows = await fetchPosLogs({ pages: 1 });
  return { ok: true, rows: rows.length, sample: rows[0] || null };
}

export { ENABLED, getSession, fetchPosLogs, fetchSalesOrders, fetchOrderDetail, parsePosLogsPage, ping, BASE, POS_ID };
