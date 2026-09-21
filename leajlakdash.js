/* ═══════════════════════════════════════════════════════════════════════════
   LEAJLAK DASHBOARD — الطريق الوحيد اللي بيلاقي طلب برقمنا إحنا.

   ليه الملف ده موجود أصلاً (٢١ سبتمبر ٢٠٢٦):
   طلب W1790011118692 راح للاجلك فعلاً الساعة 17:33 UTC، وكابتن استلمه
   ووصّله — وإحنا ماسجّلناش الشحنة لأن الحاوية ماتت في نصّ الإرسال وقت
   نشر جديد. لما حاولنا نسترجعه من API الشركاء طلعت الحقيقة المرّة:

     POST /api/partner/orders  برقمنا  → «an order is already exist in our system»
     GET  /api/partner/orders/<رقمنا>  → 404 «There is no order with this order id»
     GET  /api/partner/orders/3263217  → 404  (رقمهم الداخلي مابيشتغلش كمان)
     مفيش قايمة ولا بحث في API الشركاء أصلاً (كله 422).

   يعني الـAPI بتاعهم **بيمنع التكرار برقمنا وبيرفض يدوّر بيه** — وده
   بيخلّي أي طلب بيضيع منّا ضايع للأبد من ناحية الـAPI.

   لكن **لوحتهم** بتلاقيه في ثانية: صفحة Laravel عادية بجلسة، وفيها
   GET /orders-client?q=<رقمنا> بترجّع صف فيه رقمهم الداخلي والحالة
   والكابتن ورسوم التوصيل، و GET /orders-client/<رقمهم> فيها سجل
   المحطّات بالدقيقة. فده مصدر الاسترجاع.

   ملاحظة أمان: بيانات الدخول بتيجي من متغيّرات البيئة بس
   (LEAJLAK_DASH_EMAIL / LEAJLAK_DASH_PASSWORD) — عمر بيحطّهم في Coolify
   بنفسه، وعمرهم ما بيتكتبوا في لوج ولا بيرجعوا في أي رد.
   من غيرهم الموديول بيقول `configured:false` والسيستم بيرجع للتنبيه
   الصريح للمدير بدل ما يخمّن.
═══════════════════════════════════════════════════════════════════════════ */

const DASH_BASE = (env) => String(env.LEAJLAK_DASH_BASE || "https://app.leajlak.com").replace(/\/+$/, "");

/* جرّة كوكيز صغيرة — fetch مابيحتفظش بالجلسة لوحده. */
function jar() {
  const store = new Map();
  return {
    put(res) {
      const list = typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);
      for (const raw of list || []) {
        const [pair] = String(raw).split(";");
        const i = pair.indexOf("=");
        if (i > 0) store.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get size() { return store.size; },
    clear() { store.clear(); },
  };
}

const CSRF_RE = /name="_token"\s+value="([^"]+)"|value="([^"]+)"\s+name="_token"/;
const csrfOf = (html) => { const m = CSRF_RE.exec(String(html || "")); return m ? (m[1] || m[2]) : null; };

/* نص خلية من HTML من غير DOM: بنشيل الوسوم ونفكّ أشهر الكيانات. */
const strip = (h) => String(h || "")
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/\s+/g, " ").trim();

export function parseRows(html) {
  const body = /<tbody[\s\S]*?<\/tbody>/i.exec(String(html || ""));
  if (!body) return [];
  const out = [];
  for (const m of body[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...m[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((c) => strip(c[0]));
    if (cells.length < 10) continue;
    const href = /href="([^"]*orders-client\/(\d+))"/i.exec(m[0]);
    out.push({ cells, theirNo: href ? href[2] : (/(\d{4,})/.exec(cells[1] || "") || [])[1] || null });
  }
  return out;
}

const num = (s) => {
  const v = Number(String(s || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(v) ? v : null;
};
const VAT = 1.15;
const r2 = (n) => Math.round(n * 100) / 100;

/* صف القايمة → شكل موحّد. الأعمدة (اتأكدنا منها على اللايف ٢١/٩):
   # | Order ID | Client ID | Shop | Area | Zone | Amount | Del. Charge | Date | Status | Captain | Action */
export function rowToOrder(row, wantNo) {
  const c = row.cells;
  const clientId = String(c[2] || "").replace(/^#/, "").trim();
  if (wantNo && clientId !== String(wantNo)) return null;
  const feeEx = num(c[7]);
  return {
    theirNo: row.theirNo,
    orderNo: clientId,
    shop: c[3] || null,
    area: c[4] || null,
    zone: c[5] || null,
    amount: num(c[6]),
    feeEx,
    feeIncl: feeEx != null ? r2(feeEx * VAT) : null,
    date: c[8] || null,
    rawStatus: c[9] || null,
    captain: c[10] || null,
  };
}

/* «2026-09-21 08:33 PM» بتوقيت الرياض → ISO UTC. لوحتهم بتوقيت الرياض
   (مثبت: طلب أنشأناه 17:33 UTC ظهر عندهم 08:33 PM). */
export function riyadhToIso(s) {
  const m = /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(String(s || ""));
  if (!m) return null;
  let h = Number(m[4]) % 12;
  if (/PM/i.test(m[6])) h += 12;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h - 3, Number(m[5]), 0);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/* جدول «Logs from Order …» في صفحة التفاصيل → محطّات بالوقت */
const LOG_STAGE = {
  neworder: "created", assignedto: "assigned", orderaccept: "assigned", startride: "assigned",
  reachedshop: "arrived", orderpicked: "picked", shipped: "picked",
  reacheddestination: "reached_destination", delivered: "delivered", cancelled: "cancelled", canceled: "cancelled",
};
const key = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

export function parseDetail(html) {
  const rows = [];
  for (const tb of String(html || "").matchAll(/<tbody[\s\S]*?<\/tbody>/gi)) {
    for (const tr of tb[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [...tr[0].matchAll(/<td[\s\S]*?<\/td>/gi)].map((c) => strip(c[0]));
      if (cells.length === 4 && riyadhToIso(cells[3])) {
        rows.push({ status: cells[0], by: cells[2] || null, at: riyadhToIso(cells[3]) });
      }
    }
  }
  const times = {};
  for (const r of rows) {
    const st = LOG_STAGE[key(r.status)];
    if (st && !times[st]) times[st] = r.at;
  }
  const fee = /Delivery Charges[\s\S]{0,200}?([\d.]+)\s*SAR/i.exec(String(html || ""));
  return { log: rows, times, feeEx: fee ? Number(fee[1]) : null };
}

export function makeLeajlakDash({ env = process.env, log = console, fetchImpl = fetch } = {}) {
  const email = () => String(env.LEAJLAK_DASH_EMAIL || "").trim();
  const pass = () => String(env.LEAJLAK_DASH_PASSWORD || "");
  const base = () => DASH_BASE(env);
  const configured = () => Boolean(email() && pass());
  const missing = () => [!email() && "LEAJLAK_DASH_EMAIL", !pass() && "LEAJLAK_DASH_PASSWORD"].filter(Boolean);

  let cookies = jar();
  let loggedAt = 0;
  let loggingIn = null;
  const SESSION_MS = 20 * 60_000;

  async function call(path, { method = "GET", form, redirect = "follow" } = {}) {
    const headers = { "User-Agent": "Mozilla/5.0 freshcuts-ops", Accept: "text/html,application/xhtml+xml" };
    if (cookies.size) headers.Cookie = cookies.header();
    let body;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    let res;
    try {
      res = await fetchImpl(`${base()}${path}`, { method, headers, body, redirect, signal: ctl.signal });
    } finally { clearTimeout(t); }
    cookies.put(res);
    return { status: res.status, location: res.headers.get("location"), text: await res.text() };
  }

  /* تسجيل الدخول: Laravel عادي — بنجيب _token من صفحة الدخول مع الكوكي،
     وبنبعت POST. النجاح = تحويل (302) بعيد عن /login. مفيش أي طباعة
     لبيانات الدخول ولا في اللوج ولا في الأخطاء. */
  async function login() {
    if (!configured()) {
      throw Object.assign(new Error(`لوحة لاجلك مش متظبطة (${missing().join(", ")})`), { code: "DASH_UNCONFIGURED", missing: missing() });
    }
    cookies = jar();
    const page = await call("/login");
    const token = csrfOf(page.text);
    if (!token) throw Object.assign(new Error("صفحة دخول لاجلك اتغيّرت — مفيش _token"), { code: "DASH_LOGIN_SHAPE" });
    const res = await call("/login", {
      method: "POST", redirect: "manual",
      form: { _token: token, email: email(), password: pass(), remember: "on" },
    });
    const ok = (res.status === 302 || res.status === 303) && !/\/login/.test(String(res.location || ""));
    if (!ok) {
      throw Object.assign(new Error("دخول لوحة لاجلك اترفض — راجع الإيميل/الباسورد في إعدادات التطبيق"),
        { code: "DASH_LOGIN_FAILED", status: res.status });
    }
    loggedAt = Date.now();
    return true;
  }

  async function ensureSession() {
    if (cookies.size && Date.now() - loggedAt < SESSION_MS) return;
    if (!loggingIn) loggingIn = login().finally(() => { loggingIn = null; });
    await loggingIn;
  }

  /* بيرجع الجلسة لو انتهت في نص الطلب (بيردّوا صفحة الدخول بـ200). */
  async function authed(path) {
    await ensureSession();
    let r = await call(path);
    if (/name="_token"/.test(r.text) && /type="password"/.test(r.text)) {
      loggedAt = 0;
      await ensureSession();
      r = await call(path);
    }
    return r;
  }

  /* الاستخدام الأساسي: «لاجلك بتقول الطلب موجود — فين هو؟» */
  async function findOrder(orderNo) {
    const no = String(orderNo || "").trim();
    if (!no) return { found: false };
    const r = await authed(`/orders-client?q=${encodeURIComponent(no)}`);
    if (r.status !== 200) return { found: false, status: r.status };
    const rows = parseRows(r.text);
    for (const row of rows) {
      const o = rowToOrder(row, no);
      if (o) return { found: true, ...o };
    }
    return { found: false, rowsSeen: rows.length };
  }

  async function orderDetail(theirNo) {
    const r = await authed(`/orders-client/${encodeURIComponent(String(theirNo))}`);
    if (r.status !== 200) return null;
    return parseDetail(r.text);
  }

  /* نفس شكل `provider.lookup` عشان delivery.js يتعامل مع الاتنين بنفس الكود.
     ملحوظة مهمة: اللوحة **مابتعرضش** الـdsp_order_id (الـUUID)، فالشحنة
     المسترجعة منها بيبقى مرجعها رقمهم الداخلي — التتبع بيكمّل من اللوحة
     مش من API الشركاء. */
  async function lookup(orderNo) {
    if (!configured()) return { found: false, unsupported: true, reason: "dash_unconfigured", missing: missing(), tried: [] };
    try {
      const o = await findOrder(orderNo);
      if (!o.found) return { found: false, via: "dashboard", tried: [{ path: "/orders-client?q=", status: o.status || 200, matched: false }] };
      const d = o.theirNo ? await orderDetail(o.theirNo).catch(() => null) : null;
      return {
        found: true, via: "dashboard", source: "dashboard",
        ref: null, providerOrderNo: o.theirNo,
        rawStatus: o.rawStatus, captain: o.captain,
        driver: o.captain ? { name: o.captain, phone: null, source: "leajlak" } : null,
        feeEx: d?.feeEx ?? o.feeEx, feeIncl: o.feeIncl,
        times: d?.times || {}, logCount: d?.log?.length || 0,
        tried: [{ path: "/orders-client?q=", status: 200, matched: true }],
      };
    } catch (e) {
      return { found: false, via: "dashboard", error: String(e.message || e).slice(0, 200), code: e.code || null, tried: [] };
    }
  }

  return { configured, missing, login, findOrder, orderDetail, lookup,
           _reset: () => { cookies = jar(); loggedAt = 0; } };
}
