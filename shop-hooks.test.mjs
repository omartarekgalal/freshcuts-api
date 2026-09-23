/* نقاط ربط shop.js (W1-02) — node --test shop-hooks.test.mjs

   من غير تغيير سلوك: كل فرع خطأ في /api/shop/checkout بيرجّع نفس الـJSON
   والـstatus (snapshot)، والأحداث (order_status/payment_check/order_paid/
   pos_push/pos_ready/order_expired/sla_alert) بتطلع fire-and-forget ومابترميش.
   كل حاجة وهمية: قاعدة بيانات، دفع، شريك، توصيل — مفيش شبكة ولا SMS. */
import test from "node:test";
import assert from "node:assert/strict";
import { register as registerShop, makeOrderEmitter, PARTNER_FAILED_EVENT } from "./shop.js";
import { resumeKey } from "./resume-key.js";

const jb = (v) => JSON.stringify(v);
const normPhone = (p) => String(p || "").replace(/\D/g, "").slice(-9);

function fakeApp() {
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
}

function fakeCtx({ body, bodyThrows = false, headers = {} } = {}) {
  const h = { "cf-connecting-ip": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers };
  return {
    req: {
      header: (n) => h[String(n).toLowerCase()],
      json: async () => { if (bodyThrows) throw new SyntaxError("bad"); return body; },
      param: () => undefined, query: () => undefined,
    },
    json: (obj, status = 200) => ({ body: obj, status }),
  };
}

function build({ handler = () => null, settings = {}, deps = {}, env = {} } = {}) {
  const prev = {};
  for (const [k, v] of Object.entries({ SHOP_SWEEP_SECONDS: "0", ...env })) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const queries = [];
  const pool = {
    query: async (sql, vals) => {
      queries.push({ sql: String(sql), vals });
      return (await handler(String(sql), vals)) || { rows: [], rowCount: 0 };
    },
  };
  const events = [];
  const journeyEvents = [];
  const app = fakeApp();
  const api = registerShop(app, {
    pool, requireAdmin: async () => null, requireCashierOrAdmin: async () => null,
    getSettingsData: async () => settings, jb, normPhone,
  }, {
    pay: { configured: () => true, initiateSession: async () => ({ SessionId: "S-1", CountryCode: "SAU" }) },
    delivery: {
      quote: async () => ({ deliverable: true, fee: 0 }), shipmentOf: async () => null,
      cancelShipment: async () => null, dispatchGate: async () => ({ mode: "manual" }),
      canAutoDispatch: async () => false,
    },
    emitOrder: (name, opts) => { events.push({ name, ...opts }); },
    journey: () => ({ emit: (name, props) => journeyEvents.push({ name, ...props }) }),
    ...deps,
  });
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  return { api, app, pool, queries, events, journeyEvents, restore };
}

const tick = () => new Promise((r) => setImmediate(r));

/* ═══ ١) setStatus ═══════════════════════════════════════════════════════ */

test("setStatus بيطلق order_status مرة واحدة، والـSQL زي ما هو", async () => {
  const s = build();
  try {
    s.queries.length = 0;
    await s.api.setStatus("W1", "accepted", { note: "n1", from: "pos_created" });
    const st = s.events.filter((e) => e.name === "order_status");
    assert.equal(st.length, 1);
    assert.equal(st[0].orderNo, "W1");
    assert.deepEqual(st[0].data, { from: "pos_created", to: "accepted", note: "n1" });
    const upd = s.queries.filter((q) => /^\s*UPDATE shop_orders SET status=\$2/.test(q.sql));
    assert.equal(upd.length, 1);
    assert.equal(upd[0].sql, "UPDATE shop_orders SET status=$2, history = history || $3::jsonb, updated_at=NOW() WHERE order_no=$1");
    // from مش معروف → null
    await s.api.setStatus("W1", "delivered");
    assert.deepEqual(s.events.filter((e) => e.name === "order_status")[1].data, { from: null, to: "delivered", note: null });
  } finally { s.restore(); }
});

test("setStatus مابيطلقش لو الـUPDATE وقع", async () => {
  const s = build({ handler: (sql) => { if (/UPDATE shop_orders SET status=\$2/.test(sql)) throw new Error("db down"); } });
  try {
    await assert.rejects(s.api.setStatus("W1", "accepted"), /db down/);
    assert.equal(s.events.filter((e) => e.name === "order_status").length, 0);
  } finally { s.restore(); }
});

test("مستمع بيرمي (sync أو async) مابيوقّعش setStatus", async () => {
  for (const emitOrder of [() => { throw new Error("boom"); }, async () => { throw new Error("boom async"); }]) {
    const s = build({ deps: { emitOrder } });
    try {
      await s.api.setStatus("W1", "accepted");
      await tick();
    } finally { s.restore(); }
  }
});

test("api بيصدّر setStatus وgetOrderRow", async () => {
  const s = build({ handler: (sql) => /SELECT \* FROM shop_orders WHERE order_no/.test(sql) ? { rows: [{ order_no: "W7" }], rowCount: 1 } : null });
  try {
    assert.equal(typeof s.api.setStatus, "function");
    assert.deepEqual(await s.api.getOrderRow("W7"), { order_no: "W7" });
  } finally { s.restore(); }
});

test("من غير deps.emitOrder: الحدث بيوصل لناقل order-events الحقيقي", async () => {
  const bus = await import("./order-events.js");
  const got = [];
  const unsub = bus.subscribe((evt) => got.push(evt), "order_status");
  const s = build({ deps: { emitOrder: undefined } });
  try {
    await s.api.setStatus("W555", "accepted", { from: "pos_created" });
    await tick();
    const mine = got.filter((e) => e.orderNo === "W555");
    assert.equal(mine.length, 1);
    assert.equal(mine[0].data.to, "accepted");
  } finally { unsub(); s.restore(); }
});

test("makeOrderEmitter: override بيرمي أو بيرفض → مفيش استثناء", async () => {
  makeOrderEmitter(() => { throw new Error("x"); })("order_paid", { orderNo: "W1" });
  makeOrderEmitter(() => Promise.reject(new Error("y")))("order_paid", { orderNo: "W1" });
  await tick();
  assert.ok([null, "partner_failed"].includes(PARTNER_FAILED_EVENT()));
});

/* ═══ ٢) checkout: snapshot لكل فرع خطأ ════════════════════════════════════ */

const BUNDLE_LINE = { product_id: 501, quantity: 1, unit_amount: 50 * 1e9, bundle: "b96", bundle_line: 1, bundle_name: "بوكس", tax_id: 1 };
const okBundles = () => ({ expandBundle: async () => ({ ok: true, lines: [{ ...BUNDLE_LINE }] }) });
const verified = (phone = "512345678") => () => ({ customerOf: async () => ({ phone_norm: phone }), customerDiscount: async () => null });
const CART = { option: "pickup", items: [{ bundle: "b96", quantity: 1, choices: {} }], customer: { name: "Test Customer", phone: "0512345678" } };

async function checkout(opts, ctxOpts) {
  const s = build(opts);
  try {
    const res = await s.app.routes["POST /api/shop/checkout"](fakeCtx(ctxOpts));
    await tick();
    return { res, s };
  } finally { s.restore(); }
}

const CASES = [
  {
    name: "payments_not_configured",
    opts: { deps: { pay: { configured: () => false } } }, ctx: { body: CART },
    expect: { status: 503, body: { ok: false, error: "payments_not_configured" } },
  },
  {
    name: "store_closed",
    opts: { settings: { hours: { enabled: true, days: {} } } }, ctx: { body: CART },
    expect: { status: 409, body: { ok: false, error: "store_closed", message: "المطعم مغلق حالياً 🌙 — تقدر تجهّز سلتك وتطلب أول ما نفتح." } },
  },
  { name: "bad json", ctx: { bodyThrows: true }, code: "bad_json", expect: { status: 400, body: { ok: false, error: "bad json" } } },
  { name: "empty_cart", ctx: { body: { items: [] } }, expect: { status: 400, body: { ok: false, error: "empty_cart" } } },
  {
    name: "bundles_unavailable", ctx: { body: CART },
    expect: { status: 503, body: { ok: false, error: "bundles_unavailable" } },
  },
  {
    name: "bundle_expand_failed",
    opts: { deps: { bundles: () => ({ expandBundle: async () => { throw new Error("x"); } }) } }, ctx: { body: CART },
    expect: { status: 422, body: { ok: false, error: "bundle_expand_failed", bundle: "b96" } },
  },
  {
    name: "bundle_<x>",
    opts: { deps: { bundles: () => ({ expandBundle: async () => ({ ok: false, error: "bad_choice" }) }) } }, ctx: { body: CART },
    code: "bundle_bad_choice",
    expect: { status: 422, body: { ok: false, error: "bundle_bad_choice", bundle: "b96", detail: { ok: false, error: "bad_choice" } } },
  },
  {
    name: "dine_in_only",
    ctx: { body: { ...CART, items: [{ product_id: 121, quantity: 1 }] } },
    expect: { status: 422, body: { ok: false, error: "dine_in_only", items: [121] } },
  },
  {
    name: "invalid_phone", opts: { deps: { bundles: okBundles } },
    ctx: { body: { ...CART, customer: { phone: "123" } } },
    expect: { status: 400, body: { ok: false, error: "invalid_phone" } },
  },
  {
    name: "invalid_name (فاضي — الاسم مطلوب من غير شروط)", code: "invalid_name", opts: { deps: { bundles: okBundles } },
    ctx: { body: { ...CART, customer: { name: "   ", phone: "0512345678" } } },
    expect: { status: 400, body: { ok: false, error: "invalid_name", reason: "name_required",
      message: "اكتب اسمك", message_en: "Please enter your name",
      detail: "اكتب اسمك" } },
  },
  {
    name: "address_required", opts: { deps: { bundles: okBundles } },
    ctx: { body: { ...CART, option: "delivery" } },
    expect: { status: 400, body: { ok: false, error: "address_required" } },
  },
  {
    name: "otp_required (مش متحقق)", code: "otp_required", opts: { deps: { bundles: okBundles } }, ctx: { body: CART },
    expect: { status: 401, body: { ok: false, error: "otp_required" } },
  },
  {
    name: "otp_required (جوال تاني)", code: "otp_required", opts: { deps: { bundles: okBundles, accounts: verified("599999999") } }, ctx: { body: CART },
    expect: { status: 401, body: { ok: false, error: "otp_required" } },
  },
  {
    name: "coupon_not_found", opts: { deps: { bundles: okBundles, accounts: verified() } },
    ctx: { body: { ...CART, coupon: "NOPE" } },
    expect: { status: 422, body: { ok: false, error: "coupon_not_found", coupon: { ok: false, error: "not_found" } } },
  },
  {
    name: "not_deliverable",
    opts: { deps: { bundles: okBundles, accounts: verified(),
      delivery: { quote: async () => ({ deliverable: false, reason: "too_far" }), dispatchGate: async () => ({ mode: "manual" }) } } },
    ctx: { body: { ...CART, option: "delivery", address: { latitude: 21.5, longitude: 39.2 } } },
    expect: { status: 422, body: { ok: false, error: "not_deliverable", quote: { deliverable: false, reason: "too_far" } } },
  },
  {
    name: "payment_init_failed",
    opts: { deps: { bundles: okBundles, accounts: verified(),
      pay: { configured: () => true, initiateSession: async () => { throw new Error("MF down"); } } } },
    ctx: { body: CART },
    expect: { status: 502, body: { ok: false, error: "payment_init_failed", detail: "MF down" } },
  },
];

for (const cs of CASES) {
  test(`checkout snapshot: ${cs.name}`, async () => {
    const { res, s } = await checkout(cs.opts, cs.ctx);
    assert.equal(res.status, cs.expect.status);
    assert.deepEqual(res.body, cs.expect.body);
    // نفس ترتيب المفاتيح كمان (الـJSON نفسه)
    assert.equal(JSON.stringify(res.body), JSON.stringify(cs.expect.body));
    const jr = s.journeyEvents.filter((e) => e.name === "checkout_result");
    assert.equal(jr.length, 1);
    assert.equal(jr[0].ok, false);
    assert.equal(jr[0].error_code, cs.code || cs.name);
    assert.equal(jr[0].http_status, cs.expect.status);
    assert.equal(typeof jr[0].ms, "number");
    // مفيش طلب اتعمل
    assert.equal(s.queries.filter((q) => /INSERT INTO shop_orders/.test(q.sql)).length, 0);
  });
}

test("checkout snapshot: rate_limited (الطلب رقم ٦١ من نفس الـIP)", async () => {
  const s = build({ deps: { pay: { configured: () => false } } });
  try {
    const h = { "cf-connecting-ip": "203.0.113.77" };
    let res;
    for (let i = 0; i < 61; i++) res = await s.app.routes["POST /api/shop/checkout"](fakeCtx({ body: CART, headers: h }));
    assert.deepEqual(res, { body: { ok: false, error: "rate_limited" }, status: 429 });
    const last = s.journeyEvents.at(-1);
    assert.equal(last.error_code, "rate_limited");
    assert.equal(last.http_status, 429);
  } finally { s.restore(); }
});

test("journey بيرمي → الرد نفسه مايتغيّرش", async () => {
  const { res } = await checkout({ deps: { journey: () => ({ emit: () => { throw new Error("journey down"); } }) } },
    { body: { items: [] } });
  assert.deepEqual(res, { body: { ok: false, error: "empty_cart" }, status: 400 });
});

test("checkout ناجح: resumeKey/trackKey + checkout_result + حفظ journey_sid/client/app_version", async () => {
  const createdAt = new Date("2026-09-16T10:00:00.000Z");
  const opts = {
    env: { SHOP_RESUME_SECRET: "unit-test-secret" },
    handler: (sql) => (/INSERT INTO shop_orders/.test(sql) ? { rows: [{ created_at: createdAt }], rowCount: 1 } : null),
    deps: { bundles: okBundles, accounts: verified() },
  };
  const s = build(opts);
  try {
    const res = await s.app.routes["POST /api/shop/checkout"](fakeCtx({
      body: { ...CART, journey_sid: "j_abc-1", client: "android", app_version: "1.0.3" },
    }));
    await tick();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const orderNo = res.body.orderNo;
    const k = resumeKey({ orderNo, createdAt }, "unit-test-secret");
    assert.equal(res.body.resumeKey, k);
    assert.equal(res.body.trackKey, k);
    assert.equal(k.length, 24);
    // المفاتيح القديمة كلها لسه موجودة بنفس الترتيب، والجداد في الآخر
    assert.deepEqual(Object.keys(res.body), ["ok", "orderNo", "total", "subtotal", "deliveryFee", "tip", "discount", "coupon",
      "discountSource", "feeInPos", "currency", "sessionId", "countryCode", "resumeKey", "trackKey"]);
    const ins = s.queries.find((q) => /INSERT INTO shop_orders/.test(q.sql));
    assert.match(ins.sql, /RETURNING created_at/);
    const upd = s.queries.find((q) => /SET journey_sid=\$2, client=\$3, app_version=\$4/.test(q.sql));
    // + attrib_source: مافيش utm ولا click id ولا جلسة في الموك → "direct"،
    //   والـattribution مااتغيّرتش فبنبعت null عشان COALESCE يسيبها زي ما هي
    assert.deepEqual(upd.vals, [orderNo, "j_abc-1", "android", "1.0.3", "direct", null]);
    const jr = s.journeyEvents.filter((e) => e.name === "checkout_result");
    assert.equal(jr.length, 1);
    assert.equal(jr[0].ok, true);
    assert.equal(jr[0].order_no, orderNo);
    assert.equal(jr[0].journey_sid, "j_abc-1");
    assert.equal(jr[0].has_bundle, true);
  } finally { s.restore(); }
});

test("checkout ناجح من غير SHOP_RESUME_SECRET: resumeKey=null، وفشل حفظ meta مايوقعش الطلب", async () => {
  const s = build({
    env: { SHOP_RESUME_SECRET: undefined },
    handler: (sql) => {
      if (/INSERT INTO shop_orders/.test(sql)) return { rows: [{ created_at: new Date() }], rowCount: 1 };
      if (/SET journey_sid=/.test(sql)) throw new Error('column "journey_sid" does not exist');
      return null;
    },
    deps: { bundles: okBundles, accounts: verified() },
  });
  try {
    const res = await s.app.routes["POST /api/shop/checkout"](fakeCtx({ body: CART }));
    await tick();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.resumeKey, null);
    assert.equal(res.body.trackKey, null);
  } finally { s.restore(); }
});

/* ═══ ٣) confirmOrder + createPosOrder ════════════════════════════════════ */

function orderDb(initial) {
  const db = { ...initial };
  const handler = (sql, vals) => {
    if (/^\s*SELECT \* FROM shop_orders WHERE order_no/i.test(sql)) return { rows: [{ ...db }], rowCount: 1 };
    if (/SET status='paid'/.test(sql)) {
      if (db.status !== "pending_payment") return { rows: [], rowCount: 0 };
      db.status = "paid"; return { rows: [{ order_no: db.order_no }], rowCount: 1 };
    }
    if (/^\s*UPDATE shop_orders SET status=\$2/i.test(sql)) {
      db.status = vals[1];
      const m = sql.match(/, (\w+)=\$(\d+)/g) || [];
      for (const x of m) { const [, col, idx] = x.match(/, (\w+)=\$(\d+)/); db[col] = vals[Number(idx) - 1]; }
      return { rowCount: 1 };
    }
    if (/pos_attempts=pos_attempts\+1/.test(sql)) { db.pos_attempts = (db.pos_attempts || 0) + 1; return { rowCount: 1 }; }
    if (/UPDATE shop_orders SET alerts/.test(sql)) return { rows: [{ order_no: db.order_no }], rowCount: 1 };
    return null;
  };
  return { db, handler };
}

const PENDING = {
  order_no: "W100", status: "pending_payment", option: "pickup", mf_invoice_id: "INV-1", total: 96, tip: 0,
  items: [{ product_id: 501, quantity: 1, unit_amount: 50 * 1e9 }], customer: { name: "Test Customer", phone: "+966512345678" },
  phone_norm: "512345678", created_at: new Date().toISOString(), pos_attempts: 0,
};

test("confirmOrder: payment_check (via) + order_paid + pos_push (شريك ناجح) + order_status", async () => {
  const { db, handler } = orderDb(PENDING);
  const s = build({
    handler, env: { TSP_AUTO_ORDER: "1" },
    deps: {
      pay: { configured: () => true, paymentStatus: async () => ({ isPaid: true, invoiceStatus: "Paid", orderNo: "W100",
        paymentId: "P1", gateway: "MADA", raw: { InvoiceTransactions: [{ TransactionStatus: "Succss", ErrorCode: "" }] } }) },
      tsp: () => ({ status: async () => ({ connected: true }), createExternalOrder: async () => ({ id: 777, total: 96 }) }),
    },
  });
  try {
    const res = await s.api.confirmOrder({ orderNo: "W100", via: "browser" });
    assert.equal(res.ok, true);
    assert.equal(db.status, "pos_created");
    const names = s.events.map((e) => e.name);
    assert.deepEqual(names, ["payment_check", "order_paid", "pos_push", "order_status"]);
    const pc = s.events[0];
    assert.equal(pc.ok, true);
    assert.deepEqual(pc.data, { via: "browser", is_paid: true, invoice_status: "Paid", mf_tx_status: "Succss", mf_error_code: "" });
    assert.equal(s.events[1].data.via, "browser");
    assert.deepEqual(s.events[2].data, { ok: true, path: "partner", attempt: 1, outcome: "pos_created", fallback: false, pos_order_id: "777" });
    assert.deepEqual(s.events[3].data, { from: "paid", to: "pos_created", note: null });
  } finally { s.restore(); }
});

test("confirmOrder مش مدفوع: payment_check بس، ومفيش order_paid", async () => {
  const { handler } = orderDb(PENDING);
  const s = build({ handler, deps: { pay: { configured: () => true,
    paymentStatus: async () => ({ isPaid: false, invoiceStatus: "Pending", raw: {} }) } } });
  try {
    const res = await s.api.confirmOrder({ orderNo: "W100" });
    assert.deepEqual(res, { ok: false, status: "unpaid", invoiceStatus: "Pending" });
    assert.deepEqual(s.events.map((e) => e.name), ["payment_check"]);
    assert.equal(s.events[0].ok, false);
    assert.equal(s.events[0].data.via, null);
  } finally { s.restore(); }
});

test("confirmOrder: GetPaymentStatus بيرمي → نفس الاستثناء + payment_check ok:false", async () => {
  const { handler } = orderDb(PENDING);
  const s = build({ handler, deps: { pay: { configured: () => true, paymentStatus: async () => { throw new Error("MF 500"); } } } });
  try {
    await assert.rejects(s.api.confirmOrder({ orderNo: "W100", via: "sweep" }), /MF 500/);
    assert.equal(s.events.length, 1);
    assert.equal(s.events[0].name, "payment_check");
    assert.equal(s.events[0].data.error, "MF 500");
  } finally { s.restore(); }
});

test("createPosOrder: الشريك رفض (مش قابل للإعادة) → pos_push ok:false + حدث فشل الشريك + paid_pos_failed", async () => {
  const { db, handler } = orderDb({ ...PENDING, status: "paid" });
  const s = build({
    handler, env: { TSP_AUTO_ORDER: "1" },
    deps: { tsp: () => ({ status: async () => ({ connected: true }),
      createExternalOrder: async () => { throw Object.assign(new Error("422 invalid product"), { status: 422 }); } }) },
  });
  try {
    await s.api.createPosOrder("W100");
    assert.equal(db.status, "paid_pos_failed");
    const names = s.events.map((e) => e.name);
    const failedEvt = PARTNER_FAILED_EVENT();
    // partner_fallback ممنوع يتستعار لفشل الشريك (مفيش مسار بديل)
    assert.notEqual(failedEvt, "partner_fallback");
    assert.deepEqual(names, failedEvt ? ["pos_push", failedEvt, "order_status"] : ["pos_push", "order_status"]);
    assert.equal(s.events[0].ok, false);
    assert.equal(s.events[0].data.attempt, 1);
    assert.equal(s.events[0].data.fallback, false);
    assert.equal(s.events[0].data.error, "422 invalid product");
    if (failedEvt) {
      assert.equal(s.events[1].data.partner_failed, true);
      assert.equal(s.events[1].data.outcome, "paid_pos_failed");
    }
    assert.equal(s.events.at(-1).data.to, "paid_pos_failed");
  } finally { s.restore(); }
});

test("createPosOrder: إعادة الكنس بنفس الخطأ على طلب paid_pos_failed → مفيش أحداث مكررة", async () => {
  const { db, handler } = orderDb({ ...PENDING, status: "paid_pos_failed", last_pos_error: "422 invalid product" });
  const s = build({
    handler, env: { TSP_AUTO_ORDER: "1" },
    deps: { tsp: () => ({ status: async () => ({ connected: true }),
      createExternalOrder: async () => { throw Object.assign(new Error("422 invalid product"), { status: 422 }); } }) },
  });
  try {
    await s.api.createPosOrder("W100");
    assert.equal(db.status, "paid_pos_failed");
    assert.deepEqual(s.events, []);
    // خطأ جديد مختلف → pos_push واحد بس (من غير حدث فشل ولا order_status)
    const s2 = build({
      handler, env: { TSP_AUTO_ORDER: "1" },
      deps: { tsp: () => ({ status: async () => ({ connected: true }),
        createExternalOrder: async () => { throw Object.assign(new Error("500 server"), { status: 500 }); } }) },
    });
    try {
      await s2.api.createPosOrder("W100");
      assert.deepEqual(s2.events.map((e) => e.name), ["pos_push"]);
    } finally { s2.restore(); }
  } finally { s.restore(); }
});

test("createPosOrder مسار المتجر + باقة: pos_push ok:false (من غير شبكة)", async () => {
  const { db, handler } = orderDb({ ...PENDING, status: "paid", items: [{ ...BUNDLE_LINE }] });
  const s = build({ handler, env: { TSP_AUTO_ORDER: undefined } });
  try {
    await s.api.createPosOrder("W100");
    assert.equal(db.status, "paid_pos_failed");
    assert.deepEqual(s.events.map((e) => e.name), ["pos_push", "order_status"]);
    assert.equal(s.events[0].data.error, "bundle_needs_partner");
    assert.equal(s.events[0].data.path, "store");
  } finally { s.restore(); }
});

/* ═══ ٤) sweep + watchdog ════════════════════════════════════════════════ */

test("sweep: pos_ready من ويب هوك الشريك + order_expired + sla_alert", async () => {
  const hookPayload = { event: "order-updated", resource: { order: { id: 88 }, statuses_slugs: { approval_status: "pickup_ready" } } };
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const s = build({
    env: { TSP_AUTO_ORDER: undefined },
    handler: (sql) => {
      if (/pos_ready_at IS NULL\s+AND status IN/.test(sql)) return { rows: [{ order_no: "W1", pos_order_id: "88", branch_id: "1" }], rowCount: 1 };
      if (/FROM tsp_webhooks/.test(sql)) {
        assert.match(sql, /jsonb_build_object\('statuses_slugs',\s+payload->'resource'->'statuses_slugs'\)\) AS payload/);
        return { rows: [{ payload: hookPayload }], rowCount: 1 };
      }
      if (/SET status='expired'/.test(sql)) {
        assert.match(sql, /RETURNING order_no, mf_invoice_id/);
        return { rows: [{ order_no: "W2", mf_invoice_id: "INV-9" }, { order_no: "W3", mf_invoice_id: null }], rowCount: 2 };
      }
      if (/WHERE status NOT IN \('pending_payment','expired','delivered','rejected_refunded'\)/.test(sql)) {
        return { rows: [{ order_no: "W4", status: "paid", option: "delivery", created_at: tenMinAgo, updated_at: tenMinAgo, alerts: {} }], rowCount: 1 };
      }
      return null;
    },
  });
  try {
    await s.api.sweep();
    await tick();
    const ready = s.events.filter((e) => e.name === "pos_ready");
    assert.equal(ready.length, 1);
    assert.equal(ready[0].orderNo, "W1");
    assert.deepEqual(ready[0].data, { source: "pos", by: null, approval: "pickup_ready" });
    const readyUpd = s.queries.find((q) => /pos_approval=\$2, pos_ready_at = COALESCE/.test(q.sql));
    assert.deepEqual(readyUpd.vals, ["W1", "pickup_ready"]);

    const exp = s.events.filter((e) => e.name === "order_expired");
    assert.deepEqual(exp.map((e) => [e.orderNo, e.data.executed]), [["W2", true], ["W3", false]]);

    const sla = s.events.filter((e) => e.name === "sla_alert");
    assert.equal(sla.length, 1);
    assert.equal(sla[0].orderNo, "W4");
    assert.equal(sla[0].data.code, "pos_stuck");
    assert.equal(sla[0].data.level, 2);
    assert.equal(sla[0].data.notified, true);
  } finally { s.restore(); }
});

test("watchdog: إنذار اتبعت قبل كده → مفيش sla_alert تاني", async () => {
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const s = build({
    handler: (sql) => /WHERE status NOT IN \('pending_payment','expired','delivered','rejected_refunded'\)/.test(sql)
      ? { rows: [{ order_no: "W4", status: "paid", created_at: tenMinAgo, updated_at: tenMinAgo, alerts: { "pos_stuck:2": "x" } }], rowCount: 1 }
      : null,
  });
  try {
    await s.api.watchdog();
    assert.equal(s.events.filter((e) => e.name === "sla_alert").length, 0);
  } finally { s.restore(); }
});

/* 📅 الطلب المسبق — حادثة W1790115558483 (٢٣ سبتمبر ٢٠٢٦) */
test("watchdog: الطلب المسبق مابيتسحبش قبل موعده، وعمره ما يترد تلقائي", async () => {
  const placed = new Date(Date.now() - 40 * 60_000).toISOString();
  const tomorrow = new Date(Date.now() + 34 * 3600_000).toISOString();
  let refunded = false;
  const s = build({
    handler: (sql) => {
      if (/WHERE status NOT IN \('pending_payment','expired','delivered','rejected_refunded'\)/.test(sql)) {
        // لو الصف عدّى من الفلتر غلطاً، الحزام التاني لازم يمسكه
        return { rows: [{ order_no: "W-PRE", status: "pos_created", option: "delivery",
          created_at: placed, updated_at: placed, scheduled_for: tomorrow, alerts: {} }], rowCount: 1 };
      }
      if (/refund_attempts = refund_attempts \+ 1/.test(sql)) { refunded = true; }
      return null;
    },
    deps: { pay: { configured: () => true, initiateSession: async () => ({}),
      makeRefund: async () => { refunded = true; return { RefundId: "R1" }; } } },
  });
  try {
    await s.api.watchdog();
    await tick();
    const q = s.queries.find((x) => /WHERE status NOT IN \('pending_payment','expired','delivered','rejected_refunded'\)/.test(x.sql));
    assert.match(q.sql, /scheduled_for IS NULL OR scheduled_for <= NOW\(\)/,
      "الاستعلام لازم يستبعد الطلب اللي لسه مجاش موعده");
    assert.match(q.sql, /scheduled_for IS NOT NULL AND scheduled_for > NOW\(\) - INTERVAL '24 hours'/,
      "وفي نفس الوقت يفضل شايفه في موعده حتى لو اتطلب من أكتر من ٢٤ ساعة");
    assert.match(q.sql, /pos_ready_at, scheduled_for/, "لازم يقرا scheduled_for عشان slaCheck يشوفه");
    assert.equal(refunded, false, "مفيش استرجاع تلقائي لطلب له موعد");
    assert.equal(s.events.filter((e) => e.name === "sla_alert").length, 0);
  } finally { s.restore(); }
});
