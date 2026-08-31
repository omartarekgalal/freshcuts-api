/* ═══════════════════════════════════════════════════════════════════════════
   TABSENSE PARTNER — الربط الرسمي كتطبيق شريك (زي Feedus).

   ده الحل النهائي لمشكلة إقفال الدفع: بدل ما نبعت الطلب على API المتجر
   (اللي بينزّله غير مدفوع)، بنبعته على **API الشركاء** (third-party) اللي
   بيقبل `already_paid: true` — فالطلب بينزل External **ومدفوع** ومعاه رسوم
   التوصيل، والكاشير يقفله عادي، والفلوس تفضل في بوابتنا (زي كريم/فيدس).

   المصادقة OAuth2 (authorization_code):
     ١. عمر بيفتح رابط الموافقة مرة واحدة ويسجّل دخول → بيرجع code.
     ٢. بنبادل الـcode بـ access_token + refresh_token على:
        {APP_BASE}/{store}/v1/oauth/token
     ٣. بنجدّد بالـrefresh_token تلقائياً قبل ما ينتهي.
   API الشركاء على: {API_BASE}/tp/api/v1/...

   البيئة حالياً **sandbox** (TSP_ENV). الإنتاج بيتفعّل بتغيير المفاتيح
   والـbase من دعم تاب سينس — الكود واحد.

   Env: TSP_CLIENT_ID, TSP_CLIENT_SECRET, TSP_APP_BASE, TSP_API_BASE,
        TSP_STORE, TSP_ENV, TSP_UNIQUE_ID (لو طلبوه), PUBLIC_API_URL.
═══════════════════════════════════════════════════════════════════════════ */

const env = (k, d) => (process.env[k] || d || "").toString().trim();

const APP_BASE = () => env("TSP_APP_BASE", "https://sandbox-app.tabsense.ai").replace(/\/+$/, "");
const API_BASE = () => env("TSP_API_BASE", "https://sandbox-api.tabsense.ai").replace(/\/+$/, "");
const STORE = () => env("TSP_STORE", "freshcuts");
const CLIENT_ID = () => env("TSP_CLIENT_ID");
const CLIENT_SECRET = () => env("TSP_CLIENT_SECRET");
const UNIQUE_ID = () => env("TSP_UNIQUE_ID");   // بعض التركيبات بتطلبه في الـtoken
const CALLBACK = () => `${env("PUBLIC_API_URL", "https://freshcuts-api.o2m8.me")}/api/tabsense/oauth-callback`;

async function httpJson(url, { method = "GET", headers = {}, body, label = "tsp" } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } finally { clearTimeout(t); }
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
  if (!resp.ok) {
    const msg = (data.meta && data.meta.error_message) || data.message || data.error || resp.status;
    throw Object.assign(new Error(`${label}: ${msg}`), { code: "TSP_ERROR", status: resp.status, resp: data });
  }
  return data;
}

export function register(app, ctx) {
  const { pool, requireAdmin, jb } = ctx;

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tsp_tokens (
        id INT PRIMARY KEY DEFAULT 1,
        env TEXT,
        access_token TEXT,
        refresh_token TEXT,
        expires_at TIMESTAMPTZ,
        scope TEXT,
        raw JSONB,
        connected_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tsp_tokens_single CHECK (id = 1)
      );
    `);
  }
  ensureSchema()
    .then(() => console.log("[tspartner] schema ready"))
    .catch((e) => console.error("[tspartner] schema failed:", e.message));

  /* رابط الموافقة — عمر بيفتحه مرة واحدة. state عشوائي بسيط للحماية. */
  function authorizeUrl() {
    const state = `fc${Date.now().toString(36)}`;
    const q = new URLSearchParams({
      client_id: CLIENT_ID(),
      redirect_uri: CALLBACK(),
      response_type: "code",
      state,
    });
    return `${APP_BASE()}/3rdparty/v1/oauth/authorize?${q.toString()}`;
  }

  async function saveTokens(tok) {
    const expiresIn = Number(tok.expires_in) || 3600;
    await pool.query(
      `INSERT INTO tsp_tokens(id, env, access_token, refresh_token, expires_at, scope, raw, connected_at, updated_at)
       VALUES (1,$1,$2,$3, NOW() + ($4 || ' seconds')::interval, $5, $6, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         env=$1, access_token=$2,
         refresh_token=COALESCE($3, tsp_tokens.refresh_token),
         expires_at=NOW() + ($4 || ' seconds')::interval,
         scope=$5, raw=$6,
         connected_at=COALESCE(tsp_tokens.connected_at, NOW()), updated_at=NOW()`,
      [env("TSP_ENV", "sandbox"), tok.access_token, tok.refresh_token || null,
       String(expiresIn), tok.scope || null, jb(tok)]);
  }

  /* بادل الـcode بتوكن. `unique_id` بيتبعت لو محدّد في البيئة. */
  async function exchangeCode(code, redirectUri) {
    const body = {
      grant_type: "authorization_code",
      client_id: CLIENT_ID(),
      client_secret: CLIENT_SECRET(),
      redirect_uri: redirectUri || CALLBACK(),
      code,
    };
    if (UNIQUE_ID()) body.unique_id = UNIQUE_ID();
    const tok = await httpJson(`${APP_BASE()}/${STORE()}/v1/oauth/token`,
      { method: "POST", body, label: "oauth exchange" });
    await saveTokens(tok);
    return tok;
  }

  async function refresh(refreshToken) {
    const body = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID(),
      client_secret: CLIENT_SECRET(),
    };
    if (UNIQUE_ID()) body.unique_id = UNIQUE_ID();
    const tok = await httpJson(`${APP_BASE()}/${STORE()}/v1/oauth/token`,
      { method: "POST", body, label: "oauth refresh" });
    await saveTokens(tok);
    return tok;
  }

  /* توكن صالح دايماً: بيجدّد لوحده قبل انتهاء الصلاحية بدقيقة. */
  async function accessToken() {
    const r = await pool.query("SELECT access_token, refresh_token, expires_at FROM tsp_tokens WHERE id=1");
    const row = r.rows[0];
    if (!row || !row.access_token) return null;
    const soon = new Date(Date.now() + 60_000);
    if (row.expires_at && new Date(row.expires_at) <= soon) {
      if (!row.refresh_token) return row.access_token; // مفيش refresh — نرجّع الحالي ونسيب النداء يفشل لو انتهى
      try { const tok = await refresh(row.refresh_token); return tok.access_token; }
      catch (e) { console.error("[tspartner] refresh failed:", e.message); return row.access_token; }
    }
    return row.access_token;
  }

  /* نداء موثّق على API الشركاء */
  async function api(path, { method = "GET", body } = {}) {
    const tok = await accessToken();
    if (!tok) throw Object.assign(new Error("not connected"), { code: "TSP_NOT_CONNECTED" });
    return httpJson(`${API_BASE()}/tp/api/v1${path}`, {
      method, body, headers: { Authorization: `Bearer ${tok}` }, label: `tp ${path}`,
    });
  }

  /* ── إنشاء طلب أونلاين مدفوع مسبقاً (يلغي تحصيل الكاشير) ─────────────────
     الوصفة مثبتة على الساندبوكس — شوف الذاكرة freshcuts-tabsense-partner-order.
     الطلب بينزل External + already_paid:true، الكاشير يقبله وبس، والفلوس
     تفضل في ماي فاتورة بتاعتنا. المبالغ بالريال × 100.

     order = {
       externalOrderNo, paymentMethod("visa"|"mada"|"applepay"...), notes,
       customer:{ name, phone, address:{ city, area, street, countryCode } },
       deliveryAddress:{ line, city, country, street, postalCode, extra },
       items:[{ productId | partnerProductId, taxId?, quantity, unitPrice(بالريال) }],
     }
  */
  const sarToUnit = (v) => Math.round(Number(v || 0) * 100);

  // كاش قايمة الشريك (فرع/خيار/ضرايب) — 5 دقايق
  let _cat = { at: 0 };
  async function catalog() {
    if (_cat.at && Date.now() - _cat.at < 300_000) return _cat;
    const [branches, options, taxes] = await Promise.all([
      api("/branches"), api("/order-options"), api("/taxes"),
    ]);
    const bl = branches.data || branches || [];
    const ol = options.data || options || [];
    const tl = taxes.data || taxes || [];
    _cat = {
      at: Date.now(),
      branch: bl[0],
      option: (Array.isArray(ol) && ol.find((o) => o.default)) || ol[0],
      taxes: tl,
      defaultTax: (Array.isArray(tl) && tl.find((t) => t.default)) || tl[0],
    };
    return _cat;
  }

  // يطابق منتج المتجر بمنتج الشريك: tenant_product_id = "{store}-{internalId}"
  async function resolvePartnerProduct(ref) {
    const want = `${STORE()}-${ref}`;
    let page = 1, found = null;
    while (page <= 10 && !found) {
      const r = await api(`/products?per_page=200&page=${page}`);
      const list = r.data || [];
      found = list.find((p) =>
        p.tenant_product_id === want ||
        String(p.tenant_product_id) === String(ref) ||
        String(p.id) === String(ref));
      if (found || !r.links || !r.links.next || list.length === 0) break;
      page++;
    }
    return found;
  }

  async function createExternalOrder(order) {
    const cat = await catalog();
    if (!cat.branch || !cat.option) throw new Error("partner catalog empty (branch/option)");
    const purchases = [];
    for (const it of order.items || []) {
      let pid = it.partnerProductId;
      let ptax = it.taxId;
      if (!pid) {
        const p = await resolvePartnerProduct(it.productId);
        if (!p) throw Object.assign(new Error(`product not in partner catalog: ${it.productId}`), { code: "TSP_NO_PRODUCT" });
        pid = p.id; ptax = ptax || p.tax_id;
      }
      purchases.push({
        product_id: pid,
        quantity: Number(it.quantity) || 1,
        tax_id: ptax || (cat.defaultTax && cat.defaultTax.id),
        unit_amount: sarToUnit(it.unitPrice),
        modifiers: [],
      });
    }
    if (!purchases.length) throw new Error("order has no items");

    const calc = await api("/orders/calculation", {
      method: "POST",
      body: { order_option_id: cat.option.id, branch_id: cat.branch.id, multiply_factor: 100, purchases },
    });
    const cd = calc.data || calc;

    const c = order.customer || {};
    const a = c.address || {};
    const da = order.deliveryAddress || {};
    const phone = c.phone || c.phone_number || null;
    // بيانات العميل بتتحط كمان في الـnotes عشان الكاشير يشوفها مهما حصل،
    // لأن ربط العميل عبر API الشريك ممكن يفشل لأرقام جديدة (شوف تحت).
    const contactNote = [c.name, phone].filter(Boolean).join(" · ");
    const notes = [order.notes, contactNote].filter(Boolean).join(" — ") || "طلب أونلاين";

    const buildBody = (withPhone) => ({
      ...cd,
      order_type: 6,
      timestamp: Math.floor(Date.now() / 1000),
      customer: {
        ...(cd.customer || {}),
        name: c.name || null,
        phone_number: withPhone ? phone : null,
        address: {
          ...((cd.customer && cd.customer.address) || {}),
          city: a.city || null, area: a.area || null,
          country_code: a.countryCode || "SA", street: a.street || null,
        },
      },
      meta: {
        version: 2,
        notes,
        external_order_no: String(order.externalOrderNo),
        source_channel: "freshcuts_online",
        external_payment_method: order.paymentMethod || "visa",
        already_paid: true,
        delivery_address: {
          address_line: da.line || null, city: da.city || null, country: da.country || "SA",
          street: da.street || null, postal_code: da.postalCode || null, extra_address_info: da.extra || null,
        },
      },
    });

    // إنشاء العميل عبر API الشريك بيعمل 500 لأرقام جوال جديدة (اتأكدنا على
    // الساندبوكس — شوف الذاكرة). فبنجرّب بالجوال؛ لو فشل، نعيد من غير جوال
    // عشان الطلب مايضيعش — الجوال محفوظ في الـnotes والمندوب بياخده من التوصيل.
    let created, linkedCustomer = Boolean(phone);
    try {
      const res = await api("/orders", { method: "POST", body: buildBody(Boolean(phone)) });
      created = res.data || res;
    } catch (e) {
      if (phone && (e.status === 500 || e.status >= 500)) {
        console.warn(`[tspartner] order ${order.externalOrderNo}: customer-link failed for phone, retrying without`);
        const res = await api("/orders", { method: "POST", body: buildBody(false) });
        created = res.data || res;
        linkedCustomer = false;
      } else {
        throw e;
      }
    }
    return { id: created.id, external: created.orders_external, total: created.due, linkedCustomer, raw: created };
  }

  async function status() {
    const r = await pool.query("SELECT env, expires_at, connected_at, scope FROM tsp_tokens WHERE id=1");
    const row = r.rows[0];
    return {
      configured: Boolean(CLIENT_ID() && CLIENT_SECRET()),
      env: env("TSP_ENV", "sandbox"),
      connected: Boolean(row && row.connected_at),
      connectedAt: row && row.connected_at,
      expiresAt: row && row.expires_at,
      store: STORE(),
    };
  }

  /* ── routes ─────────────────────────────────────────────────────────── */

  // اللوحة: يبدأ الربط — يرجّع الرابط اللي عمر يفتحه
  app.get("/api/tabsense/connect", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!CLIENT_ID() || !CLIENT_SECRET()) return c.json({ ok: false, error: "no_client" }, 503);
    return c.json({ ok: true, url: authorizeUrl(), callback: CALLBACK() });
  });

  // تاب سينس بيرجّع هنا بالـcode بعد الموافقة — عام (مفيش أدمن)، بنتحقق بالـcode
  app.get("/api/tabsense/oauth-callback", async (c) => {
    const code = c.req.query("code");
    const oerr = c.req.query("error");
    if (oerr) return c.html(`<div dir="rtl" style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>❌ الربط اترفض</h2><p>${String(oerr).slice(0, 200)}</p></div>`);
    if (!code) return c.html(`<div dir="rtl" style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>⚠️ مفيش كود</h2><p>افتح رابط الربط من اللوحة تاني.</p></div>`);
    try {
      await exchangeCode(code);
      return c.html(`<div dir="rtl" style="font-family:sans-serif;padding:40px;text-align:center;background:#0c1c12;color:#d6f5e0;min-height:90vh">
        <h1 style="font-size:56px;margin:0">✅</h1>
        <h2>اتربط متجرك بتاب سينس بنجاح</h2>
        <p style="color:#9ccbad">تقدر تقفل الصفحة دي وترجع للوحة التحكم.</p></div>`);
    } catch (e) {
      console.error("[tspartner] exchange failed:", e.message, e.resp ? JSON.stringify(e.resp).slice(0, 300) : "");
      return c.html(`<div dir="rtl" style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>❌ تعذّر إتمام الربط</h2><p>${String(e.message).slice(0, 200)}</p>
        <p style="color:#888;font-size:12px">${e.resp ? String(JSON.stringify(e.resp)).slice(0, 200) : ""}</p></div>`, 502);
    }
  });

  /* ربط عبر صفحة Postman: الـclient مسجّل عندهم على oauth.pstmn.io، فبنستخدمها
     — عمر يوافق، الصفحة بتعرض الكود، وبيتبادل هنا. */
  const PSTMN = "https://oauth.pstmn.io/v1/callback";
  app.get("/api/tabsense/connect-pstmn", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const q = new URLSearchParams({
      client_id: CLIENT_ID(), redirect_uri: PSTMN, response_type: "code",
      state: `fc${Date.now().toString(36)}`,
    });
    return c.json({ ok: true, url: `${APP_BASE()}/3rdparty/v1/oauth/authorize?${q.toString()}`, redirect_uri: PSTMN });
  });
  // تبادل يدوي: بنستقبل الكود اللي عمر نسخه من صفحة Postman
  app.post("/api/tabsense/exchange", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch {}
    const code = String(b.code || "").trim();
    if (!code) return c.json({ ok: false, error: "no_code" }, 400);
    try {
      const tok = await exchangeCode(code, b.redirect_uri || PSTMN);
      return c.json({ ok: true, expiresIn: tok.expires_in, hasRefresh: Boolean(tok.refresh_token) });
    } catch (e) {
      // 200 مقصود: كلاودفلير بيستبدل أي 5xx بصفحته، فالخطأ الحقيقي بيضيع
      return c.json({ ok: false, error: e.message, resp: e.resp || null });
    }
  });

  app.get("/api/tabsense/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, ...(await status()) });
  });

  // اختبار سريع بعد الربط: يجيب الفروع ووسائل الدفع من API الشركاء
  app.get("/api/tabsense/probe", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const out = {};
    for (const [k, p] of [["branches", "/branches"], ["paymentMethods", "/payment-methods"],
                          ["orderOptions", "/order-options"], ["taxes", "/taxes"]]) {
      try { out[k] = (await api(p)).data ?? (await api(p)); }
      catch (e) { out[k] = { error: e.message, status: e.status || null }; }
    }
    return c.json({ ok: true, ...out });
  });

  // اختبار الطلب المدفوع من اللوحة — بينشئ طلب تجريبي على الشريك ويعرض نتيجته
  app.post("/api/tabsense/test-order", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const cat = await catalog();
      const prods = (await api("/products?per_page=1")).data || [];
      if (!prods.length) return c.json({ ok: false, error: "no_products" });
      const out = await createExternalOrder({
        externalOrderNo: "FC-TEST-" + Date.now(),
        paymentMethod: "visa",
        notes: "اختبار الربط من اللوحة",
        customer: { name: "عميل اختبار", phone: "+966546715683",
          address: { city: "جدة", area: "السلامة", street: "شارع الاختبار" } },
        deliveryAddress: { line: "حي السلامة، جدة", city: "جدة" },
        items: [{ partnerProductId: prods[0].id, taxId: cat.defaultTax && cat.defaultTax.id, quantity: 1, unitPrice: 10 }],
      });
      return c.json({ ok: true, orderId: out.id, total: out.total, external: out.external });
    } catch (e) {
      return c.json({ ok: false, error: e.message, resp: e.resp || null });
    }
  });

  return { api, accessToken, status, authorizeUrl, exchangeCode, refresh, createExternalOrder, catalog };
}
