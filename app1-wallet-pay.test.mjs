// APP1-N: native Apple Pay / Google Pay route (copied harness from shop-pay-routes.test.mjs)
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


/* APP1-N (21/10): POST /api/shop/wallet-pay — Apple Pay (PassKit) / Google Pay token from the app → UpdateSession → ExecutePayment → confirmOrder. */
const TOKEN = { paymentData: { data: "x", signature: "y", header: { publicKeyHash: "h", ephemeralPublicKey: "e", transactionId: "t" }, version: "EC_v1" }, paymentMethod: { displayName: "Visa 1234", network: "Visa", type: "debit" }, transactionIdentifier: "t" };
function walletBuild({ row = ORDER(), enabled = true, paid = true, updThrows = false, slowUpd = 0 } = {}) {
  const calls = { upd: [], exec: [], status: [] };
  let state = { ...row };
  const handler = (sql, vals) => {
    if (/^SELECT \* FROM shop_orders WHERE order_no=\$1/.test(sql)) return { rows: [state], rowCount: 1 };
    if (/UPDATE shop_orders SET status='paid'/.test(sql)) { if (state.status !== "pending_payment") return { rows: [], rowCount: 0 }; state = { ...state, status: "paid" }; return { rows: [{ order_no: state.order_no }], rowCount: 1 }; }
    return null;
  };
  const s = build({ handler, settings: { shop: { nativeWalletPay: enabled } }, env: { STOREFRONT_PUBLIC_URL: "https://freshcuts.sa" }, deps: { pay: {
    configured: () => true,
    updateSession: async (a) => { calls.upd.push(a); if (slowUpd) await new Promise((r) => setTimeout(r, slowUpd)); if (updThrows) throw new Error("MyFatoorah UpdateSession: Invalid token"); return { SessionId: "S-UPDATED", CountryCode: "SAU" }; },
    executePayment: async (a) => { calls.exec.push(a); return { InvoiceId: 555, PaymentURL: "https://pay.example/x" }; },
    paymentStatus: async (a) => { calls.status.push(a); return { isPaid: paid, invoiceStatus: paid ? "Paid" : "Pending", orderNo: state.order_no, paymentId: 9, gateway: "ap", raw: {} }; },
  } } });
  return { s, calls, state: () => state };
}
const wallet = (s, body) => s.app.routes["POST /api/shop/wallet-pay"](fakeCtx({ body }));

test("wallet-pay: off by default (settings.shop.nativeWalletPay) ⇒ 403, MyFatoorah never called", async () => {
  const { s, calls } = walletBuild({ enabled: null });
  try {
    const r = await wallet(s, { orderNo: "W1790000000001", tokenType: "applepay", token: TOKEN });
    assert.equal(r.status, 403); assert.equal(r.body.error, "wallet_disabled");
    assert.equal(calls.upd.length + calls.exec.length, 0);
  } finally { s.restore(); }
});

test("wallet-pay: Apple Pay token → UpdateSession on the order's session → ExecutePayment with the UPDATED session → confirmed paid", async () => {
  const { s, calls, state } = walletBuild();
  try {
    const r = await wallet(s, { orderNo: "W1790000000001", tokenType: "applepay", token: TOKEN });
    assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.orderNo, "W1790000000001");
    assert.deepEqual(calls.upd[0], { sessionId: "S-STORED", token: JSON.stringify(TOKEN), tokenType: "applepay" });
    assert.equal(calls.exec[0].sessionId, "S-UPDATED");
    assert.equal(calls.exec[0].amount, 86.5);
    assert.equal(calls.status[0].key, "555");
    assert.equal(state().status, "paid");
  } finally { s.restore(); }
});

test("wallet-pay: an order already paid is never charged again (no MyFatoorah call)", async () => {
  const { s, calls } = walletBuild({ row: ORDER({ status: "paid" }) });
  try {
    const r = await wallet(s, { orderNo: "W1790000000001", tokenType: "applepay", token: TOKEN });
    assert.equal(r.status, 200); assert.equal(r.body.already, true);
    assert.equal(calls.upd.length + calls.exec.length, 0);
  } finally { s.restore(); }
});

test("wallet-pay: a double tap while the first is running ⇒ in_progress, one charge", async () => {
  const { s, calls } = walletBuild({ slowUpd: 30 });
  try {
    const [a, b] = await Promise.all([wallet(s, { orderNo: "W1790000000001", tokenType: "applepay", token: TOKEN }), wallet(s, { orderNo: "W1790000000001", tokenType: "applepay", token: TOKEN })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(calls.exec.length, 1);
  } finally { s.restore(); }
});

test("wallet-pay: refused token ⇒ 402 wallet_token_refused, no ExecutePayment; unpaid ⇒ 402 with the redirect link", async () => {
  const w1 = walletBuild({ updThrows: true });
  try {
    const r = await wallet(w1.s, { orderNo: "W1790000000001", tokenType: "googlepay", token: "{}" });
    assert.equal(r.status, 402); assert.equal(r.body.error, "wallet_token_refused"); assert.equal(w1.calls.exec.length, 0);
  } finally { w1.s.restore(); }
  const w2 = walletBuild({ paid: false });
  try {
    const r = await wallet(w2.s, { orderNo: "W1790000000001", tokenType: "applepay", token: TOKEN });
    assert.equal(r.status, 402); assert.equal(r.body.error, "needs_redirect"); assert.equal(r.body.paymentUrl, "https://pay.example/x");
  } finally { w2.s.restore(); }
});

test("wallet-pay: bad input is a clean 400/404", async () => {
  const { s } = walletBuild();
  try {
    assert.equal((await wallet(s, { orderNo: "W1790000000001", tokenType: "card", token: TOKEN })).status, 400);
    assert.equal((await wallet(s, { orderNo: "W1790000000001", tokenType: "applepay", token: "" })).status, 400);
  } finally { s.restore(); }
});
