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
// صفحة الموافقة (تسجيل الدخول) ممكن تكون على هوست غير الـtoken. في الإنتاج:
// authorize على app.tabsense.ai، والـtoken/API على thirdparty-api.tabsense.ai.
// بترجع لـAPP_BASE لو مش محددة (زي الساندبوكس حيث الهوست واحد).
const AUTHZ_BASE = () => env("TSP_AUTHZ_BASE", "").replace(/\/+$/, "") || APP_BASE();
const STORE = () => env("TSP_STORE", "freshcuts");
const CLIENT_ID = () => env("TSP_CLIENT_ID");
const CLIENT_SECRET = () => env("TSP_CLIENT_SECRET");
const UNIQUE_ID = () => env("TSP_UNIQUE_ID");   // بعض التركيبات بتطلبه في الـtoken
// الـcallback لازم يطابق اللي تاب سينس مسجّلينه للتطبيق. عمر بعتلهم
// freshcutspos.o2m8.me/oauth/callback، فبنخلّي نفس الدومين يوصل لتطبيقنا
// (wildcard DNS) ونستقبله على المسار /oauth/callback تحت.
const CALLBACK = () => env("TSP_CALLBACK", "https://freshcutspos.o2m8.me/oauth/callback");

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

/* ═══════════════════════════════════════════════════════════════════════════
   سطر الشراء على API الشركاء — دالة صافية عشان تتجرّب أوفلاين.

   الباج اللي اتصلّح هنا (2026-09-12): الوزن (ثلث/نصف/كيلو) كان **بيضيع**.
   العميل يختار «كيلو» على المتجر، السعر ينزل صح، لكن سطر نقطة البيع بينزل
   من غير وزن — وتذكرة المطبخ ماتقولش كيلو. السبب إننا كنا بنبني السطر من
   غير `variant_option` خالص.

   المجسّ على **الإنتاج** (2026-09-12) أثبت:
     • `variant_option:{id:49}` على منتج ٩٤  → بيرجع {"id":"Z5yoQN6g6j","name":"كيلو"}
     • من غيره                                → بيرجع variant_option: null
     • الـid الرقمي بتاعنا (٤٤…٧٠) **مقبول** وبيتحوّل عندهم للـid المقنّع.
       اتأكدنا من ١٢ اختيار (٤ منتجات × ٣ أوزان) — كلهم طابقوا الاسم الصح.

   `lineNote` بينزل في meta.notes بتاع السطر (اتأكدنا إنه بيرجع في الحساب)،
   وبنستخدمه عشان الكاشير يشوف إن السطر ده جزء من باقة.
═══════════════════════════════════════════════════════════════════════════ */
const sarToUnitAmount = (v) => Math.round(Number(v || 0) * 100);

export function partnerPurchase(it, defaultTax) {
  // الوزن لازم يكون رقم صحيح موجب — أي حاجة تانية (٠/فاضي/نص) مابتتبعتش
  // خالص، عشان صنف من غير وزن يفضل يشتغل بالظبط زي النهارده.
  const vo = Number(it.variantOptionId);
  const hasVariant = Number.isInteger(vo) && vo > 0;
  const note = it.lineNote ? String(it.lineNote).slice(0, 100) : null;
  return {
    product_id: it.partnerProductId,
    quantity: Number(it.quantity) || 1,
    tax_id: it.taxId || (defaultTax && defaultTax.id),
    unit_amount: sarToUnitAmount(it.unitPrice),
    modifiers: [],
    ...(hasVariant ? { variant_option: { id: vo } } : {}),
    ...(note ? { meta: { notes: note } } : {}),
  };
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
    return `${AUTHZ_BASE()}/3rdparty/v1/oauth/authorize?${q.toString()}`;
  }

  /* بوست على نقطة التوكن — بنجرّب APP_BASE (auth_base_url) الأول، ولو فشلت
     نجرّب AUTHZ_BASE، عشان اختلاف الهوستات بين البيئات مايوقّعناش. */
  async function postToken(body, label) {
    const hosts = [...new Set([APP_BASE(), AUTHZ_BASE()])];
    let lastErr;
    for (const h of hosts) {
      try {
        return await httpJson(`${h}/${STORE()}/v1/oauth/token`, { method: "POST", body, label });
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
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
    const tok = await postToken(body, "oauth exchange");
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
    const tok = await postToken(body, "oauth refresh");
    await saveTokens(tok);
    return tok;
  }

  /* تجديد واحد في نفس اللحظة (16 سبتمبر): createExternalOrder بيبعت ٣ نداءات مع
     بعض (branches/order-options/taxes)، والتوكن كان منتهي، فالتلاتة جددوا بنفس
     الـrefresh_token. واحد نجح والباقي اترفض «The refresh token is invalid»،
     والطلب W1789555412320 نزل من مسار المتجر العادي بدل طلب مدفوع مسبقاً.
     دلوقتي أي نداء بيلاقي تجديد شغّال بيستنى نفس الوعد. */
  let _refreshing = null;

  /* توكن صالح دايماً: بيجدّد لوحده قبل انتهاء الصلاحية بدقيقة. */
  async function accessToken({ minValidMs = 60_000 } = {}) {
    const r = await pool.query("SELECT access_token, refresh_token, expires_at FROM tsp_tokens WHERE id=1");
    const row = r.rows[0];
    if (!row || !row.access_token) return null;
    const soon = new Date(Date.now() + minValidMs);
    if (row.expires_at && new Date(row.expires_at) <= soon) {
      if (!row.refresh_token) return row.access_token; // مفيش refresh — نرجّع الحالي ونسيب النداء يفشل لو انتهى
      if (!_refreshing) {
        _refreshing = (async () => {
          const lock = await pool.connect();
          try {
            // قفل على مستوى الداتابيز: وقت النشر بيبقى فيه حاويتين شغالين مع بعض،
            // والقفل اللي جوّه العملية لوحده مش كفاية.
            await lock.query("SELECT pg_advisory_lock(815501)");
            const cur = (await lock.query(
              "SELECT access_token, refresh_token, expires_at FROM tsp_tokens WHERE id=1")).rows[0];
            if (cur && cur.expires_at && new Date(cur.expires_at) > soon) return cur.access_token; // حد تاني جدّد خلاص
            return (await refresh((cur && cur.refresh_token) || row.refresh_token)).access_token;
          }
          catch (e) {
            console.error("[tspartner] refresh failed:", e.message);
            // يمكن تجديد تاني سبقنا وحفظ توكن جديد — نقرا الأحدث بدل القديم المنتهي
            const again = (await pool.query("SELECT access_token FROM tsp_tokens WHERE id=1")).rows[0];
            return (again && again.access_token) || row.access_token;
          } finally {
            _refreshing = null;
            try { await lock.query("SELECT pg_advisory_unlock(815501)"); } catch { /* الاتصال اتقفل = القفل اتفك */ }
            lock.release();
          }
        })();
      }
      return _refreshing;
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
       items:[{ productId | partnerProductId, taxId?, quantity, unitPrice(بالريال),
                variantOptionId?(رقم الوزن ٤٤…٧٠), lineNote? }],
     }
  */
  const sarToUnit = sarToUnitAmount;

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
      options: Array.isArray(ol) ? ol : [],
      option: (Array.isArray(ol) && ol.find((o) => o.default)) || ol[0],
      taxes: tl,
      defaultTax: (Array.isArray(tl) && tl.find((t) => t.default)) || tl[0],
    };
    return _cat;
  }

  // يختار خيار الطلب الصح حسب نوعه عشان التقارير تطلع مظبوطة:
  // delivery→«توصيل Delivery» · pickup/takeaway→«Take away» · dine_in→«Dine in».
  function optionFor(cat, kind) {
    const opts = cat.options || [];
    const pat = kind === "pickup" || kind === "takeaway" ? /take.?away|سفري/i
      : kind === "dine_in" || kind === "dinein" ? /dine|محلي/i
      : /deliver|توصيل/i; // الافتراضي توصيل
    return opts.find((o) => pat.test(o.name || "")) || cat.option;
  }

  // كاش كل منتجات الشريك (فهرس بالـtenant_product_id) — 5 دقايق.
  // per_page الأقصى 100؛ 200 بيرجّع صفر (اتأكدنا على الإنتاج).
  let _prod = { at: 0, byTenant: new Map() };
  async function loadProducts() {
    if (_prod.at && Date.now() - _prod.at < 300_000 && _prod.byTenant.size) return _prod;
    const byTenant = new Map();
    let page = 1;
    while (page <= 20) {
      const r = await api(`/products?per_page=100&page=${page}`);
      const list = r.data || [];
      for (const p of list) byTenant.set(String(p.tenant_product_id), p);
      if (!r.links || !r.links.next || list.length === 0) break;
      page++;
    }
    _prod = { at: Date.now(), byTenant };
    return _prod;
  }

  /* كاش وسائل الدفع (بالاسم → الـid) — ساعة. تاب سينس بتعرّف الوسيلة بالـid،
     فبنبعت الاسم والـid مع بعض في meta عشان الوسيلة تنزل تلقائياً على الطلب
     (الأسماء زي "e-Apple Pay Credit" مطابقة لقائمتهم بالظبط). */
  let _pm = { at: 0, byName: new Map() };
  async function loadPaymentMethods() {
    if (_pm.at && Date.now() - _pm.at < 3600_000 && _pm.byName.size) return _pm;
    const byName = new Map();
    try {
      const r = await api("/payment-methods");
      for (const m of (r.data || r || [])) if (m && m.name) byName.set(String(m.name).toLowerCase(), m.id);
      _pm = { at: Date.now(), byName };
    } catch (e) { console.error("[tspartner] payment-methods load failed:", e.message); }
    return _pm;
  }
  async function paymentMethodId(name) {
    if (!name) return null;
    const pm = await loadPaymentMethods();
    return pm.byName.get(String(name).toLowerCase()) || null;
  }

  /* تسوية الطلب تلقائياً (يلغي تحصيل الكاشير) عبر POST /orders/:id/checkout.
     تاب سينس بيسوّي على طريقة الدفع المخصصة لتطبيقنا "FreshCuts" (زي ما فيد اس
     بيسوّي على "Feedus"). دلوقتي الطريقة دي **غير مفعّلة** عندهم فالنداء بيرجّع
     403 والطلب بيفضل مستحق (الكاشير يقدر يسوّيه يدوي مؤقتاً). أول ما تاب سينس
     يفعّلوا طريقة "FreshCuts" النداء ده هيسوّي كل طلب تلقائياً من غير أي تدخّل.
     amount بالريال (نفس وحدة due اللي بيرجّعها إنشاء الطلب). */
  async function settleOrder(orderId, amount) {
    try {
      const r = await api(`/orders/${orderId}/checkout`, { method: "POST", body: { amount: Number(amount) } });
      console.log(`[tspartner] auto-settled ${orderId} (${amount})`);
      return { settled: true, raw: r };
    } catch (e) {
      console.warn(`[tspartner] auto-checkout ${orderId} pending (${e.status || "?"}): ${e.message}` +
        (e.resp ? " " + JSON.stringify(e.resp).slice(0, 160) : ""));
      return { settled: false, error: e.message, status: e.status || null };
    }
  }

  // يطابق منتج المتجر بمنتج الشريك: tenant_product_id = "{store}-{internalId}"
  async function resolvePartnerProduct(ref) {
    const { byTenant } = await loadProducts();
    return byTenant.get(`${STORE()}-${ref}`) || byTenant.get(String(ref)) || null;
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
      purchases.push(partnerPurchase({ ...it, partnerProductId: pid, taxId: ptax }, cat.defaultTax));
    }
    if (!purchases.length) throw new Error("order has no items");

    // خيار الطلب حسب اختيار العميل (توصيل/سفري/محلي) — مهم للتقارير في تاب سينس.
    const opt = optionFor(cat, order.orderOption);

    const calc = await api("/orders/calculation", {
      method: "POST",
      body: { order_option_id: opt.id, branch_id: cat.branch.id, multiply_factor: 100, purchases },
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

    // وسيلة الدفع: بنبعت الاسم زي ما هو + الـid المقابل من قائمة الشريك، عشان
    // الوسيلة تنزل تلقائياً على الطلب من غير تدخّل الكاشير.
    const payName = order.paymentMethod || "visa";
    const payId = await paymentMethodId(payName).catch(() => null);

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
        external_payment_method: payName,
        external_payment_method_id: payId || undefined,
        payment_method_id: payId || undefined,
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
    // نحاول نسوّي الطلب فوراً (تلقائي). لو طريقة "FreshCuts" لسه غير مفعّلة
    // بيرجع settled:false والطلب يفضل مستحق — بيتسوّى أول ما تاب سينس يفعّلوها.
    const settle = await settleOrder(created.id, created.due);
    /* tenant_order_id = "<store>-<id>" والـid ده هو بالظبط ts_orders.order_id.
       `created.id` المقنّع مالوش أي علاقة بيه، فمن غيره مفيش ربط بين مرآة
       الطلب في نقطة البيع وطلب الموقع (التقارير وملف العميل بيضيعوا). */
    const tenantOrderId = (String(created.tenant_order_id || "").match(/(\d+)\s*$/) || [])[1] || null;
    return { id: created.id, tenantOrderId, external: created.orders_external, total: created.due, linkedCustomer, settled: settle.settled, raw: created };
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

  /* الـcallback المسجّل عند تاب سينس على دومين freshcutspos.o2m8.me
     (اللي بيوصل لتطبيقنا عبر wildcard DNS). نفس منطق oauth-callback فوق. */
  const successHtml = `<div dir="rtl" style="font-family:sans-serif;padding:40px;text-align:center;background:#0c1c12;color:#d6f5e0;min-height:90vh">
    <h1 style="font-size:56px;margin:0">✅</h1>
    <h2>اتربط متجرك بتاب سينس بنجاح</h2>
    <p style="color:#9ccbad">تقدر تقفل الصفحة دي وترجع للوحة التحكم.</p></div>`;
  app.get("/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const oerr = c.req.query("error");
    if (oerr) return c.html(`<div dir="rtl" style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>❌ الربط اترفض</h2><p>${String(oerr).slice(0, 200)}</p></div>`);
    if (!code) return c.html(`<div dir="rtl" style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>⚠️ مفيش كود</h2></div>`);
    try {
      await exchangeCode(code, CALLBACK());
      return c.html(successHtml);
    } catch (e) {
      console.error("[tspartner] /oauth/callback exchange failed:", e.message, e.resp ? JSON.stringify(e.resp).slice(0, 300) : "");
      return c.html(`<div dir="rtl" style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>❌ تعذّر إتمام الربط</h2><p>${String(e.message).slice(0, 200)}</p>
        <p style="color:#888;font-size:12px">${e.resp ? String(JSON.stringify(e.resp)).slice(0, 200) : ""}</p></div>`, 502);
    }
  });

  /* استقبال إشعارات تاب سينس بحالة الطلبات (order-paid/updated/refunded…).
     المسجّل عندهم: freshcutspos.o2m8.me/webhooks/. بنسجّل ونرجّع 200 دايماً
     عشان مايعيدوش الإرسال. الربط بحالة shop_orders بيتبني بعد أول payload حقيقي. */
  const webhook = async (c) => {
    let body = null;
    try { body = await c.req.json(); } catch { try { body = await c.req.text(); } catch {} }
    try {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS tsp_webhooks (id BIGSERIAL PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), event TEXT, payload JSONB)`);
      const ev = (body && (body.event || body.type || body.event_type)) || null;
      await pool.query("INSERT INTO tsp_webhooks(event, payload) VALUES ($1,$2)", [ev, jb(body)]);
      console.log(`[tspartner] webhook: ${ev || "?"} ${JSON.stringify(body).slice(0, 200)}`);
    } catch (e) { console.error("[tspartner] webhook store failed:", e.message); }
    return c.json({ ok: true });
  };
  app.post("/webhooks/", webhook);
  app.post("/webhooks", webhook);

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

  /* تجديد استباقي (16 سبتمبر): التوكن مايستناش لحد ما عميل يدفع عشان يتجدد —
     التجديد وقت الدفع هو اللي وقّع طلب W1789555412320. كل ٢٠ دقيقة: لو فاضل
     أقل من ٦ ساعات على الانتهاء، بنجدّد دلوقتي (نفس مسار التجديد الواحد). */
  async function keepTokenFresh() {
    try {
      const r = (await pool.query(
        "SELECT expires_at, refresh_token IS NOT NULL AS has_refresh FROM tsp_tokens WHERE id=1")).rows[0];
      if (!r || !r.has_refresh || !r.expires_at) return;
      if (new Date(r.expires_at).getTime() - Date.now() > 6 * 3600_000) return;
      await accessToken({ minValidMs: 6 * 3600_000 });
      const after = (await pool.query("SELECT expires_at FROM tsp_tokens WHERE id=1")).rows[0];
      console.log(`[tspartner] proactive refresh → expires ${after && after.expires_at && new Date(after.expires_at).toISOString()}`);
    } catch (e) {
      console.error("[tspartner] proactive refresh failed:", e.message);
    }
  }
  if (process.env.TSP_KEEPALIVE !== "0") {
    setTimeout(() => { keepTokenFresh(); }, 30_000);
    setInterval(() => { keepTokenFresh(); }, 20 * 60_000);
  }

  return { api, accessToken, status, authorizeUrl, exchangeCode, refresh, createExternalOrder, catalog, keepTokenFresh };
}
