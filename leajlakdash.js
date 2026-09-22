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

import { ljStageOf, isLjStatus } from "./couriers.js";

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

/* ── قراءة جدول الطلبات ──────────────────────────────────────────────────
   فخّ حقيقي في الـHTML بتاعهم (مثبت على اللايف ٢٢/٩): الـ<thead> فيه ١٢
   عمود، والصف في الـ<tbody> فيه **١٤ خلية** — فيه عمودين زياده من غير
   عنوان (اسم العميل ونوع الخدمة «Fast») مدسوسين قبل التاريخ:

     thead : # | Order ID | Client ID | Shop | Area | Zone | Amount | Del. Charge | Order Date | Status | Captain | Action
     tbody : # | Order ID | Client ID | Shop | Area | Zone | Amount | Del. Charge | «اسم العميل» | «Fast» | Order Date | Status | Captain | Action

   يعني القراءة بالترتيب الرقمي بتدّي الكابتن = التاريخ والحالة = «Fast»،
   والقراءة بعناوين الـthead بتدّي نفس الغلط لأن العناوين نفسها ناقصة.

   فبنثبّت من الناحيتين: أول ٨ خلايا بتطابق العناوين من البداية، وآخر ٤
   (تاريخ/حالة/كابتن/إجراء) بتتقرا **من النهاية** — والزيادة بتقع في
   النص وبتتجاهل. وبعدين بنتحقق: التاريخ لازم يبقى تاريخ، والحالة لازم
   تبقى حالة نعرفها، والكابتن لازم يبقى اسم. أي حاجة مش منطقية بترجع
   فاضية مع تحذير صريح بدل ما نخزّن قيمة غلط. */

const strip = (h) => String(h || "")
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/\s+/g, " ").trim();

export const looksDate = (v) => /^\d{4}-\d{2}-\d{2}/.test(String(v || "").trim());
export const looksMoney = (v) => /^[\d.,]+\s*(SAR|ر\.?س)?$/i.test(String(v || "").trim()) && /\d/.test(String(v || ""));
export const looksStatus = (v) => isLjStatus(v);
/* اسم كابتن: فيه حروف، ومش تاريخ ولا فلوس ولا حالة معروفة. */
export const looksName = (v) => {
  const t = String(v || "").trim();
  if (!t || t.length > 120) return false;
  if (looksDate(t) || looksMoney(t) || looksStatus(t)) return false;
  return /[A-Za-z\u0600-\u06FF]/.test(t);
};

export function parseTable(html) {
  const src = String(html || "");
  const th = /<thead[\s\S]*?<\/thead>/i.exec(src);
  const headers = th ? [...th[0].matchAll(/<th[\s\S]*?<\/th>/gi)].map((m) => strip(m[0])) : [];
  const tb = /<tbody[\s\S]*?<\/tbody>/i.exec(src);
  const rows = [];
  for (const m of (tb ? tb[0] : "").matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...m[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((c) => strip(c[0]));
    if (cells.length < 8) continue;
    const href = /href="([^"]*orders-client\/(\d+))"/i.exec(m[0]);
    rows.push({ cells, theirNo: href ? href[2] : null });
  }
  return { headers, rows };
}

/* متوافق مع الاستدعاء القديم */
export const parseRows = (html) => parseTable(html).rows;

const num = (s) => {
  const v = Number(String(s || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(v) ? v : null;
};
const VAT = 1.15;
const r2 = (n) => Math.round(n * 100) / 100;

export function rowToOrder(row, wantNo) {
  const c = row.cells;
  const warnings = [];

  /* رقم طلبنا: بندوّر عليه بشكله (W + أرقام) مش بمكانه. */
  const ci = c.findIndex((x) => /^#?W\d{6,}$/.test(String(x || "").trim()));
  const clientId = String((ci >= 0 ? c[ci] : c[2]) || "").replace(/^#/, "").trim();
  if (wantNo && clientId !== String(wantNo)) return null;

  /* المرساة = خلية الحالة، لأنها الحقل الوحيد اللي ليه قيم معروفة مقفولة.
     بندوّر عليها من آخر الصف (اللي بعدها الكابتن والإجراء، ومش حالات)،
     فأي أعمدة زياده — قبلها أو بعدها — مابتزحلقش حاجة.
       … | Order Date | **Status** | Captain | Action                       */
  let si = -1;
  for (let i = c.length - 1; i > Math.max(ci, 0); i--) { if (looksStatus(c[i])) { si = i; break; } }

  let rawStatus = null, captain = null, date = null;
  if (si < 0) {
    warnings.push("مفيش حالة معروفة في الصف — جدول لاجلك اتغيّر");
  } else {
    rawStatus = c[si];
    const next = c[si + 1];
    // الكابتن بعد الحالة على طول. فاضية = الطلب لسه من غير كابتن (مش غلط).
    if (looksName(next)) captain = next;
    else if (String(next || "").trim()) warnings.push(`اسم الكابتن مش منطقي: "${String(next).slice(0, 40)}"`);
    // التاريخ أقرب خلية تاريخ قبل الحالة
    for (let i = si - 1; i >= 0; i--) { if (looksDate(c[i])) { date = c[i]; break; } }
  }
  if (!date) {
    const i = c.findIndex(looksDate);
    if (i >= 0) date = c[i]; else warnings.push("مفيش تاريخ في الصف");
  }

  /* المبالغ: أول خليتين فيهم عملة — الإجمالي بتاعنا الأول، وبعده التوصيل
     (ترتيب عناوينهم). دي كمان بالمحتوى مش بالمكان. */
  const money = c.map((x, i) => ({ x, i })).filter((o) => /SAR|ر\.?س/i.test(o.x) && looksMoney(o.x));
  let amount = null, feeEx = null;
  if (money.length >= 2) { amount = num(money[0].x); feeEx = num(money[1].x); }
  else { warnings.push("أعمدة المبالغ اتغيّرت"); amount = num(c[6]); feeEx = num(c[7]); }

  const theirNo = row.theirNo || (/(\d{4,})/.exec(String(c[1] || "")) || [])[1] || null;
  if (!theirNo) warnings.push("مفيش رقم طلب عندهم في الصف");

  return {
    theirNo, orderNo: clientId,
    shop: c[3] || null, area: c[4] || null, zone: c[5] || null,
    amount, feeEx, feeIncl: feeEx != null ? r2(feeEx * VAT) : null,
    date: date || null, rawStatus, captain, warnings,
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
  /* آخر حالة في السجل = حالة الطلب دلوقتي. والكابتن = الاسم اللي سجّل
     أكتر محطّات سواقة (الديسباتشر بيسجّل «Assigned By/Order Accept» بس).
     دول مصدر تاني للحالة والكابتن لو جدول القايمة اتقرا غلط. */
  const last = rows.length ? rows[rows.length - 1] : null;
  const DRIVER_STAGES = new Set(["arrived", "picked", "reached_destination", "delivered"]);
  const tally = new Map();
  for (const r of rows) {
    if (!r.by || !DRIVER_STAGES.has(LOG_STAGE[key(r.status)])) continue;
    tally.set(r.by, (tally.get(r.by) || 0) + 1);
  }
  let captain = null, best = 0;
  for (const [name, k] of tally) if (k > best && looksName(name)) { captain = name; best = k; }
  const warnings = [];
  if (!rows.length) warnings.push("صفحة تفاصيل لاجلك من غير سجل محطّات");
  return { log: rows, times, feeEx: fee ? Number(fee[1]) : null,
           lastStatus: last ? last.status : null, captain, warnings };
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
    const { headers, rows } = parseTable(r.text);
    for (const row of rows) {
      const o = rowToOrder(row, no);
      if (!o) continue;
      /* الجدول بتاعهم اتغيّر شكله قبل كده من غير ما يقولوا (١٢ عنوان و١٤
         خلية). فأي قراءة مش منطقية بتتصرّخ في اللوج وبتتعلّم على الشحنة
         بدل ما نخزّن اسم كابتن طلع تاريخ. */
      if (o.warnings && o.warnings.length) {
        try {
          log.error(`[leajlakdash] قراءة جدول لاجلك مشكوك فيها لطلب ${no}: ${o.warnings.join(" · ")} `
            + `(عناوين ${headers.length} / خلايا ${row.cells.length})`);
        } catch { /* اللوج مايوقفش الاسترجاع */ }
      }
      return { found: true, ...o, headerCount: headers.length, cellCount: row.cells.length };
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
        /* الحالة والكابتن من صفحة التفاصيل أدق: سجل المحطّات هو نفسه
           اللي بنبني منه الأوقات، فلو القايمة اتقرت غلط ده بيصلّحها. */
        rawStatus: o.rawStatus || d?.lastStatus || null,
        captain: o.captain || d?.captain || null,
        driver: (o.captain || d?.captain)
          ? { name: o.captain || d.captain, phone: null, source: "leajlak" } : null,
        feeEx: d?.feeEx ?? o.feeEx, feeIncl: o.feeIncl,
        times: d?.times || {}, logCount: d?.log?.length || 0,
        warnings: [...(o.warnings || []), ...(d?.warnings || [])],
        headerCount: o.headerCount ?? null, cellCount: o.cellCount ?? null,
        tried: [{ path: "/orders-client?q=", status: 200, matched: true }],
      };
    } catch (e) {
      return { found: false, via: "dashboard", error: String(e.message || e).slice(0, 200), code: e.code || null, tried: [] };
    }
  }

  return { configured, missing, login, findOrder, orderDetail, lookup,
           _reset: () => { cookies = jar(); loggedAt = 0; } };
}
