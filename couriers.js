/* ═══════════════════════════════════════════════════════════════════════════
   COURIERS — طبقة مزوّدي التوصيل.

   طلب عمر (2026-08-24): «في احتمال ما نكملش مع Flying Arrow ونشتغل مع شركة
   تانية — عايزين نكون جاهزين في الحالتين».

   فالمزوّد بقى قطعة قابلة للتبديل، مش كود مدفون. كل مزوّد بيقدّم نفس
   الأربع عمليات، والباقي في السيستم ما يعرفش ولا يهمّه إحنا مع مين:

     dispatch(order, cfg)     → { ref, orderNumber, cost, driver, status, raw }
     track(shipment)          → { status, driver, cost, raw }
     cancel(shipment, reason) → { fee, refund, raw }
     parseWebhook(body)       → { orderNo, status, driver, cost }  أو null

   الـ`status` الراجع من هنا **موحّد** مش بلغة المزوّد:
     pending → assigned → picked → delivered | cancelled
   الترجمة من مصطلحات كل شركة بتحصل جوّه المزوّد نفسه، فلو بدّلنا شركة
   الحالات اللي بيشوفها العميل ما تتغيّرش ولا حرف.

   الفروق الحقيقية بين الاتنين — وهي سبب وجود الطبقة دي أصلاً:
     • Flying Arrow: مفتاح ثابت، نقطة الاستلام إحداثيات مع كل طلب، التتبع
       برقمهم هم، ولازم city_id و service_vehicle_id.
     • Leajlak (4U): Bearer token، نقطة الاستلام محل مسجّل عندهم (shop_id)،
       والتتبع والإلغاء **برقم طلبنا إحنا**، ومفيش مدينة ولا نوع مركبة.
═══════════════════════════════════════════════════════════════════════════ */

const env = (k, d) => (process.env[k] || d || "").toString().trim();

/* رقم سعودي بصيغة E.164 — Flying Arrow بتطلبها كده. */
export const e164 = (v) => {
  const d = String(v || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
  return /^5\d{8}$/.test(d) ? `+966${d}` : String(v || "");
};
/* Leajlak بتكتب الأرقام من غير + في أمثلتها (9663361163). */
export const msisdn = (v) => {
  const d = String(v || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
  return /^5\d{8}$/.test(d) ? `966${d}` : String(v || "").replace(/\D/g, "");
};

/* الحالات الموحّدة اللي السيستم كله بيتكلم بيها */
export const STAGES = ["pending", "assigned", "picked", "delivered", "cancelled"];

async function httpJson(url, { method = "GET", headers = {}, body, label = "courier" } = {}) {
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
  try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
  if (!resp.ok) {
    throw Object.assign(new Error(`${label}: ${data.message || data.error || resp.status}`),
      { code: "COURIER_ERROR", status: resp.status, resp: data });
  }
  return data;
}

/* عنوان مقروء لسائق: الشارع → المبنى → الدور → علامة مميزة → الحي */
export function readableAddress(addr) {
  return [
    addr.street,
    addr.building && `مبنى ${addr.building}`,
    addr.floor,
    addr.landmark && `بجوار ${addr.landmark}`,
    addr.area && `حي ${addr.area}`,
  ].filter(Boolean).join("، ") || "موقع العميل";
}

const PREPAID_NOTE = "الطلب مدفوع مسبقاً — لا يُحصَّل من العميل";

/* ═══ Flying Arrow ═══════════════════════════════════════════════════════ */
const FA_BASE = () => env("FLYINGARROW_BASE", "https://flyingarrow-backend.com/api/v1/integration").replace(/\/+$/, "");
const FA_KEY = () => env("FLYINGARROW_API_KEY", "");

const FA_STATUS = {
  created: "pending", pending: "pending", confirmed: "pending",
  driver_assigned: "assigned", assigned: "assigned", accepted: "assigned",
  pickup_completed: "picked", picked_up: "picked", in_transit: "picked", on_the_way: "picked",
  delivered: "delivered", completed: "delivered",
  cancelled: "cancelled", canceled: "cancelled",
};

const flyingarrow = {
  id: "flyingarrow",
  label: "Flying Arrow",
  configured: () => Boolean(FA_KEY()),
  missing: () => (FA_KEY() ? [] : ["FLYINGARROW_API_KEY"]),
  needsRef: true,   // اللوحة بتعرض قوايم المدينة والمركبة

  call(path, opts = {}) {
    return httpJson(`${FA_BASE()}${path}`, {
      ...opts, headers: { "X-API-Key": FA_KEY() }, label: `FlyingArrow ${path}`,
    });
  },

  async reference() {
    const [cities, vehicles] = await Promise.all([
      this.call("/cities"), this.call("/service-vehicles"),
    ]);
    return {
      cities: (cities?.data?.cities || []).map((c) => ({ id: c.id, name: c.name_ar || c.name_en })),
      vehicles: (vehicles?.data?.service_vehicles || []).map((v) => ({
        id: v.id, name: v.name_ar || v.name_en,
        basePrice: v.base_price != null ? Number(v.base_price) : null,
        perKm: v.price_per_km != null ? Number(v.price_per_km) : null,
      })),
    };
  },

  async dispatch(order, cfg) {
    const addr = order.address || {};
    const created = await this.call("/orders", {
      method: "POST",
      body: {
        // 8 = «التوصيل المبرد والساخن» (سيدان). الدباب (3) بيترفض على حسابنا
        // بـ VEHICLE_TYPE_NOT_ALLOWED — الحساب مخصص للسيدان.
        service_vehicle_id: Number(cfg.faVehicleId || 8),
        city_id: Number(cfg.faCityId || 20),
        payment_method: cfg.faPaymentMethod || "wallet",
        external_order_id: order.order_no,
        webhook_url: cfg.webhookUrl,
        notes: String(order.notes || "").slice(0, 200) || PREPAID_NOTE,
        locations: [
          {
            type: "pickup",
            address: cfg.pickupAddress || "فريش كتس — جدة",
            lat: cfg.storeLat, lng: cfg.storeLng,
            contact_name: cfg.pickupContactName || "فريش كتس",
            contact_phone: e164(cfg.pickupContactPhone || ""),
          },
          {
            type: "dropoff",
            address: readableAddress(addr),
            lat: Number(addr.latitude), lng: Number(addr.longitude),
            contact_name: order.customer?.name || "العميل",
            contact_phone: e164(order.customer?.phone || ""),
          },
        ],
      },
    });
    const o = created?.data?.order || {};
    return {
      ref: o.id != null ? String(o.id) : null,
      orderNumber: o.order_number || null,
      cost: o.pricing?.total != null ? Number(o.pricing.total) : null,
      driver: o.driver || null,
      status: FA_STATUS[(o.status && o.status.value) || "created"] || "pending",
      raw: created,
    };
  },

  async track(sh) {
    if (!sh.provider_ref) return null;
    const r = await this.call(`/orders/${encodeURIComponent(sh.provider_ref)}`);
    const o = r?.data?.order;
    if (!o) return null;
    return {
      status: FA_STATUS[(o.status && o.status.value) || ""] || null,
      driver: o.driver || null,
      cost: o.total_amount != null ? Number(o.total_amount) : null,
      raw: o,
    };
  },

  async cancel(sh, reason) {
    const r = await this.call(`/orders/${encodeURIComponent(sh.provider_ref)}/cancel`, {
      method: "POST", body: { reason: String(reason || "cancelled by restaurant").slice(0, 200) },
    });
    return {
      fee: r?.data?.cancellation_fee != null ? Number(r.data.cancellation_fee) : null,
      refund: r?.data?.refund_amount != null ? Number(r.data.refund_amount) : null,
      raw: r,
    };
  },

  parseWebhook(b) {
    const ev = String(b.event || b.status || "").replace(/^order\./, "");
    if (!ev) return null;
    const inner = (b.data && b.data.order) || {};
    /* مهم: GET /orders/{id} عندهم بيرجّع external_order_id = null حتى لما
       نبعته — يعني مش مضمون إن الويبهوك هيحمل رقمنا. فبنرجع لرقمهم
       (order_id / data.order.id) كمفتاح احتياطي، وdelivery.js بيدوّر بيه
       في provider_ref. من غير ده، ويبهوك من غير رقمنا كان هيتضاع بالكامل
       والعميل يفضل شايف حالة قديمة. */
    const orderNo = b.external_order_id || inner.external_order_id || null;
    const ref = b.order_id ?? inner.id ?? null;
    if (!orderNo && ref == null) return null;
    return {
      orderNo: orderNo != null ? String(orderNo) : null,
      ref: ref != null ? String(ref) : null,
      status: FA_STATUS[ev] || null,
      rawStatus: ev,
      driver: b.driver || inner.driver || null,
      cost: inner.total_amount != null ? Number(inner.total_amount) : null,
    };
  },
};

/* ═══ Leajlak (4U Logistic) ══════════════════════════════════════════════
   حاجتان في تصميمهم بتغيّرا شكل الربط:
   • نقطة الاستلام مش في الطلب — هي محل مسجّل عندهم بـ shop_id، فلازم
     المحل يتسجّل مرة واحدة من لوحتهم (أو POST /api/partner/shops).
   • التتبع والإلغاء **برقم طلبنا إحنا**، فمش مستنيين رقم منهم عشان نعرف
     نتتبع — وده فعلياً أمتن من Flying Arrow. */
/* وثيقتهم بتقول «Base_URL/orders» وده مضلّل: المسار الحقيقي تحت
   /api/partner. الدليل — /api/partner/orders بيقرا التوكن ويرد برسالة
   الحساب، بينما /orders على الجذر بيرد «Unauthenticated» يعني التوكن ما
   وصلوش أصلاً. */
const LJ_BASE = () => env("LEAJLAK_BASE", "https://app.leajlak.com/api/partner").replace(/\/+$/, "");
const LJ_TOKEN = () => env("LEAJLAK_TOKEN", "");
const LJ_SHOP = () => env("LEAJLAK_SHOP_ID", "");
const LJ_WH_SECRET = () => env("LEAJLAK_WEBHOOK_SECRET", "");

/* حالاتهم نصية زي ما هي في وثيقتهم («New Order» / «Order Accept»)، فبنطبّع
   أي صيغة (مسافات/شرط سفلي/حالة أحرف) قبل المقارنة. */
const LJ_STATUS = {
  neworder: "pending", new: "pending", pending: "pending", created: "pending",
  orderaccept: "assigned", orderaccepted: "assigned", accepted: "assigned",
  assigned: "assigned", riderassigned: "assigned", driverassigned: "assigned",
  orderpicked: "picked", picked: "picked", pickedup: "picked",
  intransit: "picked", ontheway: "picked", ordertransit: "picked",
  delivered: "delivered", completed: "delivered", ordercompleted: "delivered", orderdelivered: "delivered",
  cancelled: "cancelled", canceled: "cancelled", ordercancelled: "cancelled", rejected: "cancelled",
};
const ljNorm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

const leajlak = {
  id: "leajlak",
  label: "Leajlak (4U)",
  configured: () => Boolean(LJ_TOKEN() && LJ_SHOP()),
  missing: () => [!LJ_TOKEN() && "LEAJLAK_TOKEN", !LJ_SHOP() && "LEAJLAK_SHOP_ID"].filter(Boolean),
  needsRef: false,

  call(path, opts = {}) {
    return httpJson(`${LJ_BASE()}${path}`, {
      ...opts, headers: { Authorization: `Bearer ${LJ_TOKEN()}` }, label: `Leajlak ${path}`,
    });
  },

  /* مالهمش قوايم مدن ولا مركبات. بنتأكد من التوكن بسؤال عن طلب مش موجود:
     ٤٠٤ = التوكن سليم والمسار شغال؛ ٤٠١ = التوكن غلط. */
  async reference() {
    /* مالهمش قوايم مدن ولا مركبات، فبنسأل عن طلب مش موجود ونقرا الرد:
         404  → التوكن سليم والمسار سليم (دي الحالة الصحية)
         401 «Client is not active…» → التوكن سليم بس الحساب لسه مش مفعّل
         401 «Unauthenticated»       → التوكن مرفوض أو المسار غلط
       التفرقة دي مهمة: «فعّلوا حسابنا» شغل مختلف تماماً عن «التوكن غلط». */
    try {
      await this.call(`/orders/${encodeURIComponent("healthcheck-000")}`);
    } catch (e) {
      const msg = String((e.resp && e.resp.message) || e.message || "");
      if (e.status === 401 && /not active|suspended/i.test(msg)) {
        throw Object.assign(new Error("الحساب عند لاجلك لسه غير مفعّل — كلّمهم يفعّلوه"),
          { status: 401, resp: e.resp, code: "CLIENT_INACTIVE" });
      }
      if (e.status && e.status !== 404) throw e;
    }
    return {
      cities: [], vehicles: [],
      note: "Leajlak ما بيوفّرش قوائم مدن أو مركبات — الاستلام من المحل المسجّل بـ shop_id.",
    };
  },

  /* سرّ الويبهوك: لوحتهم بتطلب مفتاح سرّي مع الرابط. مش موثّق فين بيحطوه
     بالظبط، فبندوّر عليه في الأماكن المعتادة ونقبل أي واحد يطابق. لو
     ما حددناش سرّ أصلاً بنعدّي — عشان تفعيل التحقق ما يكسرش الاستقبال. */
  verifyWebhook(headers, body) {
    const secret = LJ_WH_SECRET();
    if (!secret) return true;
    const h = (k) => String(headers[k] || headers[k.toLowerCase()] || "");
    const candidates = [
      h("x-webhook-secret"), h("x-secret"), h("x-api-key"),
      h("authorization").replace(/^Bearer\s+/i, ""),
      String(body.secret || ""), String(body.webhook_secret || ""), String(body.key || ""),
    ];
    return candidates.some((v) => v && v === secret);
  },

  async dispatch(order, cfg) {
    const addr = order.address || {};
    const created = await this.call("/orders", {
      method: "POST",
      body: {
        id: String(order.order_no),
        shop_id: String(cfg.ljShopId || LJ_SHOP()),
        delivery_details: {
          name: order.customer?.name || "العميل",
          phone: msisdn(order.customer?.phone || ""),
          coordinate: { latitude: Number(addr.latitude), longitude: Number(addr.longitude) },
          address: readableAddress(addr),
        },
        order: {
          // 0 = مدفوع مسبقاً. العميل دفع لنا أونلاين فالكابتن ما بيحصّلش.
          payment_type: 0,
          total: Number(order.total) || 0,
          notes: String(order.notes || "").slice(0, 200) || PREPAID_NOTE,
        },
      },
    });
    const d = created?.data || created || {};
    return {
      // التتبع عندهم برقمنا، فبنخزّن رقمنا كمرجع تشغيلي — كده track/cancel
      // بيشتغلوا حتى لو ردهم ما فيهوش رقم مرجعي أصلاً.
      ref: String(order.order_no),
      orderNumber: d.dsp_order_id != null ? String(d.dsp_order_id) : null,
      cost: d.total != null ? Number(d.total) : null,
      driver: d.driver || null,
      status: LJ_STATUS[ljNorm(d.status)] || "pending",
      raw: created,
    };
  },

  async track(sh) {
    const r = await this.call(`/orders/${encodeURIComponent(sh.provider_ref || sh.shop_order_no)}`);
    const d = r?.data || r || {};
    if (!d.status && !d.driver) return null;
    return {
      status: LJ_STATUS[ljNorm(d.status)] || null,
      driver: d.driver || null,
      cost: d.total != null ? Number(d.total) : null,
      raw: d,
    };
  },

  async cancel(sh, reason) {
    // وثيقتهم بتسمّي العملية CANCEL وصفحتها اسمها DeleteOrder — يعني DELETE
    // هو الأرجح. بنجرّبها، ولو الخادم رفض الفعل نرجع لـ POST /cancel بدل ما
    // نسيب شحنة شغالة ونتفرج عليها.
    const path = `/orders/${encodeURIComponent(sh.provider_ref || sh.shop_order_no)}`;
    const body = { reason: String(reason || "cancelled by restaurant").slice(0, 200) };
    try {
      return { fee: null, refund: null, raw: await this.call(path, { method: "DELETE", body }) };
    } catch (e) {
      if (e.status !== 405 && e.status !== 404) throw e;
      return { fee: null, refund: null, raw: await this.call(`${path}/cancel`, { method: "POST", body }) };
    }
  },

  parseWebhook(b) {
    // ويبهوكهم بيرجّع رقم طلبنا في `id`، ومرجعهم في dsp_order_id.
    const orderNo = b.id || b.client_order_id || b.external_order_id || null;
    const ref = b.dsp_order_id ?? null;
    if (!orderNo && ref == null) return null;
    const raw = b.status || b.event || "";
    return {
      orderNo: orderNo != null ? String(orderNo) : null,
      ref: ref != null ? String(ref) : null,
      status: LJ_STATUS[ljNorm(raw)] || null,
      rawStatus: String(raw),
      driver: b.driver || null,
      cost: b.total != null ? Number(b.total) : null,
    };
  },
};

export const PROVIDERS = { flyingarrow, leajlak };

/* المزوّد الفعّال. الإعدادات هي المرجع والمتغيّر البيئي احتياطي.

   لو المختار ناقص مفاتيحه بنرجّعه برضه بدل ما نبدّل لغيره: التبديل الصامت
   معناه إننا نبعت طلب حقيقي لشركة عمر مش مختارها. الشاشة بتقول ناقصه إيه،
   والإرسال بيقف بخطأ واضح — وده أأمن بكتير من نجاح في المكان الغلط. */
export function activeProvider(settings) {
  const want = String((settings && settings.delivery && settings.delivery.provider)
    || env("COURIER_PROVIDER", "flyingarrow")).toLowerCase();
  return PROVIDERS[want] || PROVIDERS.flyingarrow;
}
