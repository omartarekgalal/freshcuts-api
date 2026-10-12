/* مسارات الدفع في shop.js من أولها لآخرها — node --test shop-pay-routes.test.mjs

   السبب (حادثة ١٢/١٠): تعديل C1a حط ‎...(couponIgnored ? {couponIgnored} : {})‎ في رد ‎POST /api/shop/execute‎ والمتغيّر مش
   معرّف في المسار ده ⇒ ReferenceError بعد نجاح ماي فاتورة ⇒ 500 لكل محاولة دفع (٠٢:٢٠ → ١٣:٣١). ولا اختبار كان بينادي
   المسار ده، و‎node --check‎ مابيمسكش معرّف ناقص، واختبار C1 كان بيدوّر على النص في الملف كله.

   هنا المسارات بتتنادى فعلاً (handler حقيقي، قاعدة وهمية، ماي فاتورة وهمية) لحد سطر الرد الناجح:
     • execute: نجاح (شكل الرد بالحرف + الفاتورة اتحفظت)، وكل فرع رفض
     • checkout: نجاح عادي، ونجاح بكود توصيل مجاني على استلام ⇒ couponIgnored في رد **الشيك أوت**
   مفيش شبكة ولا دفع ولا SMS. */
import test from "node:test";
import assert from "node:assert/strict";
import { register as registerShop } from "./shop.js";

const jb = (v) => JSON.stringify(v);
const normPhone = (p) => String(p || "").replace(/\D/g, "").slice(-9);
const tick = () => new Promise((r) => setImmediate(r));

function fakeApp() {
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
}
let ipSeq = 0;
function fakeCtx({ body, bodyThrows = false, headers = {} } = {}) {
  const h = { "cf-connecting-ip": `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`, ...headers };
  return {
    req: { header: (n) => h[String(n).toLowerCase()], json: async () => { if (bodyThrows) throw new SyntaxError("bad"); return body; }, param: () => undefined, query: () => undefined },
    json: (obj, status = 200) => ({ body: obj, status }),
  };
}
function build({ handler = () => null, settings = {}, deps = {}, env = {} } = {}) {
  const prev = {};
  for (const [k, v] of Object.entries({ SHOP_SWEEP_SECONDS: "0", ...env })) { prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const queries = [];
  const pool = { query: async (sql, vals) => { queries.push({ sql: String(sql), vals }); return (await handler(String(sql), vals)) || { rows: [], rowCount: 0 }; } };
  const payCalls = [];
  const app = fakeApp();
  registerShop(app, { pool, requireAdmin: async () => null, requireCashierOrAdmin: async () => null, getSettingsData: async () => settings, jb, normPhone }, {
    pay: { configured: () => true, initiateSession: async () => ({ SessionId: "S-1", CountryCode: "SAU" }),
      executePayment: async (a) => { payCalls.push(a); return { PaymentURL: "https://pay.example/3ds/abc", InvoiceId: 7788991 }; } },
    delivery: { quote: async () => ({ deliverable: true, fee: 0 }), shipmentOf: async () => null, cancelShipment: async () => null, dispatchGate: async () => ({ mode: "manual" }), canAutoDispatch: async () => false },
    emitOrder: () => {}, journey: () => ({ emit: () => {} }),
    ...deps,
  });
  const restore = () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return { app, queries, payCalls, restore };
}
const ORDER = (x = {}) => ({ order_no: "W1790000000001", status: "pending_payment", total: "86.50", mf_session_id: "S-STORED", customer: { name: "أحمد", phone: "0512345678" }, ...x });
const orderDb = (row) => (sql) => (/^SELECT \* FROM shop_orders WHERE order_no=\$1/.test(sql) ? { rows: row ? [row] : [], rowCount: row ? 1 : 0 } : /^UPDATE shop_orders SET mf_invoice_id/.test(sql.trim()) ? { rows: [], rowCount: 1 } : null);
const execute = (s, body, o = {}) => s.app.routes["POST /api/shop/execute"](fakeCtx({ body, ...o }));

/* ═══ execute ═══ */
test("execute: MyFatoorah accepts ⇒ 200 with exactly {ok, paymentUrl, invoiceId}; the invoice is saved on the order", async () => {
  const s = build({ handler: orderDb(ORDER()), env: { STOREFRONT_PUBLIC_URL: "https://freshcuts.sa" } });
  try {
    const res = await execute(s, { orderNo: "W1790000000001", sessionId: "S-FROM-FORM" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, paymentUrl: "https://pay.example/3ds/abc", invoiceId: 7788991 });
    assert.equal(JSON.stringify(Object.keys(res.body)), '["ok","paymentUrl","invoiceId"]', "nothing else rides on this answer");
    assert.equal(s.payCalls.length, 1);
    assert.deepEqual(s.payCalls[0], { sessionId: "S-FROM-FORM", amount: 86.5, orderNo: "W1790000000001", customerName: "أحمد", customerMobile: "0512345678",
      callbackUrl: "https://freshcuts.sa/pay/success?on=W1790000000001", errorUrl: "https://freshcuts.sa/pay/error?on=W1790000000001" });
    const up = s.queries.find((q) => /UPDATE shop_orders SET mf_invoice_id/.test(q.sql));
    assert.deepEqual(up.vals, ["W1790000000001", "7788991"]);
  } finally { s.restore(); }
});

test("execute: the stored session is used when the form sends none; InvoiceURL is the fallback link; a missing invoice id is saved as null", async () => {
  const s = build({ handler: orderDb(ORDER()), deps: { pay: { configured: () => true, executePayment: async (a) => { s.payCalls.push(a); return { InvoiceURL: "https://pay.example/inv/9" }; } } } });
  try {
    const res = await execute(s, { orderNo: "W1790000000001" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, paymentUrl: "https://pay.example/inv/9", invoiceId: undefined });
    assert.equal(s.payCalls[0].sessionId, "S-STORED");
    assert.deepEqual(s.queries.find((q) => /UPDATE shop_orders SET mf_invoice_id/.test(q.sql)).vals, ["W1790000000001", null]);
  } finally { s.restore(); }
});

test("execute: every refusal is a clean JSON answer — never a thrown error", async () => {
  const none = build({ handler: orderDb(null) });
  try {
    const r = await execute(none, { orderNo: "W0000000000000" });
    assert.equal(r.status, 404); assert.deepEqual(r.body, { ok: false, error: "order_not_found" });
    assert.equal(none.payCalls.length, 0, "MyFatoorah is not called for an unknown order");
    const bad = await execute(none, null, { bodyThrows: true });
    assert.equal(bad.status, 400); assert.deepEqual(bad.body, { ok: false, error: "bad json" });
  } finally { none.restore(); }
  for (const st of ["paid", "accepted", "expired", "delivered"]) {
    const done = build({ handler: orderDb(ORDER({ status: st })) });
    try {
      const r = await execute(done, { orderNo: "W1790000000001" });
      assert.equal(r.status, 409); assert.deepEqual(r.body, { ok: false, error: "already_processed" });
      assert.equal(done.payCalls.length, 0);
    } finally { done.restore(); }
  }
  const down = build({ handler: orderDb(ORDER()), deps: { pay: { configured: () => true, executePayment: async () => { throw new Error("MF down"); } } } });
  try {
    const r = await execute(down, { orderNo: "W1790000000001" });
    assert.equal(r.status, 502); assert.deepEqual(r.body, { ok: false, error: "execute_failed", detail: "MF down" });
    assert.equal(down.queries.filter((q) => /UPDATE shop_orders SET mf_invoice_id/.test(q.sql)).length, 0);
  } finally { down.restore(); }
});

test("execute: the same IP is slowed down with a 429, not an error", async () => {
  const s = build({ handler: orderDb(null) });
  try {
    let last = null;
    for (let i = 0; i < 80; i++) last = await execute(s, { orderNo: "W0" }, { headers: { "cf-connecting-ip": "10.77.77.77" } });
    assert.equal(last.status, 429); assert.deepEqual(last.body, { ok: false, error: "rate_limited" });
  } finally { s.restore(); }
});

/* ═══ checkout: couponIgnored في مكانه ═══ */
const BUNDLE_LINE = { product_id: 501, quantity: 1, unit_amount: 50 * 1e9, bundle: "b96", bundle_line: 1, bundle_name: "بوكس", tax_id: 1 };
const okBundles = () => ({ expandBundle: async () => ({ ok: true, lines: [{ ...BUNDLE_LINE }] }) });
const verified = (phone = "512345678") => () => ({ customerOf: async () => ({ phone_norm: phone }), customerDiscount: async () => null });
const CART = { option: "pickup", items: [{ bundle: "b96", quantity: 1, choices: {} }], customer: { name: "Test Customer", phone: "0512345678" } };
const KEYS = ["ok", "orderNo", "total", "subtotal", "deliveryFee", "tip", "discount", "coupon", "discountSource", "feeInPos", "currency", "sessionId", "countryCode", "resumeKey", "trackKey"];
/* كود توصيل مجاني صِرف (FIRST) صالح في الجدول */
const couponDb = (sql) => {
  if (/INSERT INTO shop_orders/.test(sql)) return { rows: [{ created_at: new Date("2026-10-13T10:00:00Z") }], rowCount: 1 };
  if (/FROM shop_coupons/.test(sql)) return { rows: [{ code: "FIRST", active: true, percent: 0, free_delivery: true, min_total: 0, max_uses: null, used_count: 0, once_per_customer: false, first_order_only: false, expires_at: null, starts_at: null, phone_norm: null }], rowCount: 1 };
  return null;
};

test("checkout (pickup) without a code: the old answer, key for key — no couponIgnored", async () => {
  const s = build({ handler: couponDb, deps: { bundles: okBundles, accounts: verified() } });
  try {
    const res = await s.app.routes["POST /api/shop/checkout"](fakeCtx({ body: CART }));
    await tick();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body), KEYS);
  } finally { s.restore(); }
});

test("checkout (pickup) with a free-delivery code: the order goes through without it, and THIS answer says the code was ignored", async () => {
  const s = build({ handler: couponDb, deps: { bundles: okBundles, accounts: verified() } });
  try {
    const res = await s.app.routes["POST /api/shop/checkout"](fakeCtx({ body: { ...CART, coupon: "first" } }));
    await tick();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.coupon, null, "the code is not recorded on a pickup order (it would be burnt)");
    assert.equal(res.body.discount, 0);
    assert.deepEqual(Object.keys(res.body), [...KEYS, "couponIgnored"], "the extra key comes last and only when a code was ignored");
    assert.equal(res.body.couponIgnored.code, "FIRST");
    assert.ok(res.body.couponIgnored.reason, "it says why: " + JSON.stringify(res.body.couponIgnored));
    const ins = s.queries.find((q) => /INSERT INTO shop_orders/.test(q.sql));
    assert.ok(ins, "the order was created");
  } finally { s.restore(); }
});

/* ── DR1: الحساب التجريبي للمالك ── */
test("checkout dryRun (owner): the same totals as a real checkout, but no payment session, no order row, no OTP needed; not the owner ⇒ 403; a real checkout is unchanged", async () => {
  let sessions = 0;
  const pay = { configured: () => true, initiateSession: async () => { sessions++; return { SessionId: "S-1", CountryCode: "SAU" }; }, executePayment: async () => ({}) };
  const real = build({ handler: couponDb, deps: { bundles: okBundles, accounts: verified(), pay } });
  let realBody;
  try { const r = await real.app.routes["POST /api/shop/checkout"](fakeCtx({ body: CART })); await tick(); assert.equal(r.status, 200); realBody = r.body; } finally { real.restore(); }
  assert.equal(sessions, 1);
  sessions = 0;
  /* no customer session at all (accounts returns nobody): a dry run does not need the OTP */
  const s = build({ handler: couponDb, deps: { bundles: okBundles, accounts: () => ({ customerOf: async () => null, customerDiscount: async () => null }), pay, isOwner: async () => true } });
  try {
    const r = await s.app.routes["POST /api/shop/checkout"](fakeCtx({ body: { ...CART, dryRun: true } }));
    await tick();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dryRun, true);
    assert.equal(r.body.total, realBody.total, "same total as the real checkout of the same basket");
    assert.equal(r.body.deliveryFee, realBody.deliveryFee); assert.equal(r.body.discount, realBody.discount);
    assert.equal(r.body.extra, 0, "nothing in the total beyond menu prices, delivery, tip and discount");
    assert.equal(r.body.explained, r.body.total);
    assert.ok(!("sessionId" in r.body) && !("orderNo" in r.body));
    assert.equal(sessions, 0, "no payment session");
    assert.ok(!s.queries.some((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q.sql)), "nothing written: " + s.queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q.sql)).map((q) => q.sql.slice(0, 40)).join(" | "));
  } finally { s.restore(); }
  const n = build({ handler: couponDb, deps: { bundles: okBundles, accounts: verified(), pay, isOwner: async () => false } });
  try {
    const r = await n.app.routes["POST /api/shop/checkout"](fakeCtx({ body: { ...CART, dryRun: true } }));
    assert.equal(r.status, 403); assert.equal(r.body.error, "owner_only"); assert.equal(sessions, 0);
  } finally { n.restore(); }
  /* a refusal inside a dry run is a plain answer marked dryRun */
  const f = build({ handler: couponDb, deps: { bundles: okBundles, accounts: verified(), pay, isOwner: async () => true } });
  try {
    const r = await f.app.routes["POST /api/shop/checkout"](fakeCtx({ body: { option: "delivery", items: CART.items, customer: CART.customer, dryRun: true } }));
    assert.equal(r.status, 400); assert.equal(r.body.error, "address_required"); assert.equal(r.body.dryRun, true);
  } finally { f.restore(); }
});

