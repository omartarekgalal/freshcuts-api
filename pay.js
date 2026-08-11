/* ═══════════════════════════════════════════════════════════════════════════
   PAY — MyFatoorah on OUR OWN merchant account (Omar's sa.myfatoorah.com).

   Until 2026-08-11 the storefront charged through TabSense's MyFatoorah
   merchant (stores/{s}/payments/*). Omar opened his own account so the money
   settles to him directly and the payment methods (mada / Visa / Apple Pay /
   STC Pay) are under his control. This module is the only place that talks
   to MyFatoorah; shop.js owns what a payment MEANS for an order.

   Flow (mirrors MyFatoorah's embedded integration, same UX as before so
   Apple Pay keeps working):
     InitiateSession → browser embeds payment form with SessionId
     → POST /api/shop/execute → ExecutePayment → 3DS PaymentURL redirect
     → customer returns; webhook + polling BOTH confirm via GetPaymentStatus.

   TRUST RULE: a webhook is a doorbell, not a verdict. Every state change is
   confirmed against GetPaymentStatus before shop.js acts — a forged or
   replayed webhook can never mark an order paid.

   Refunds: Omar's decision (2026-08-11) — a cashier rejecting a paid order
   refunds AUTOMATICALLY, no approval step. MakeRefund here; the trigger
   lives in shop.js's sweep.

   Env:
     MYFATOORAH_API_KEY      the SecretKey (live key in CREDENTIALS.md §14;
                             answers "token is not valid" until the account
                             finishes activation)
     MYFATOORAH_BASE         default https://api-sa.myfatoorah.com
                             (use https://apitest.myfatoorah.com + demo key
                             to develop before activation)
     MYFATOORAH_WEBHOOK_SECRET  from the portal's Webhook Settings page
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";

const env = (k, d) => (process.env[k] || d || "").toString().trim();
const MF_BASE = () => env("MYFATOORAH_BASE", "https://api-sa.myfatoorah.com").replace(/\/+$/, "");
const MF_KEY = () => env("MYFATOORAH_API_KEY");

export function configured() { return Boolean(MF_KEY()); }

async function mf(path, body) {
  if (!MF_KEY()) throw Object.assign(new Error("MYFATOORAH_API_KEY not set"), { code: "MF_UNCONFIGURED" });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  let resp;
  try {
    resp = await fetch(`${MF_BASE()}/v2/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MF_KEY()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: ctl.signal,
    });
  } finally { clearTimeout(t); }
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { IsSuccess: false, Message: text.slice(0, 300) }; }
  if (!data.IsSuccess) {
    const msg = data.Message || data.ValidationErrors?.map((e) => e.Error).join("; ") || `HTTP ${resp.status}`;
    throw Object.assign(new Error(`MyFatoorah ${path}: ${msg}`), { code: "MF_ERROR", resp: data, status: resp.status });
  }
  return data.Data;
}

/* ── the four calls shop.js needs ── */

export async function initiateSession(customerIdentifier) {
  // CustomerIdentifier ties saved cards to a customer later; phone_norm is
  // stable and non-PII beyond what MyFatoorah already gets at ExecutePayment.
  return mf("InitiateSession", customerIdentifier ? { CustomerIdentifier: customerIdentifier } : {});
}

export async function executePayment({ sessionId, amount, orderNo, customerName, customerMobile, callbackUrl, errorUrl }) {
  return mf("ExecutePayment", {
    SessionId: sessionId,
    InvoiceValue: Number(amount),
    DisplayCurrencyIso: "SAR",
    CustomerReference: orderNo,           // comes back in GetPaymentStatus + webhook → our join key
    CustomerName: customerName || undefined,
    CustomerMobile: customerMobile ? String(customerMobile).replace(/^\+?966/, "0").slice(-10) : undefined,
    MobileCountryCode: customerMobile ? "+966" : undefined,
    CallBackUrl: callbackUrl,
    ErrorUrl: errorUrl,
    Language: "ar",
  });
}

export async function paymentStatus({ key, keyType = "InvoiceId" }) {
  const d = await mf("GetPaymentStatus", { Key: String(key), KeyType: keyType });
  const txs = d.InvoiceTransactions || [];
  // MyFatoorah's success TransactionStatus is literally spelled "Succss".
  const paidTx = txs.find((t) => t.TransactionStatus === "Succss" || t.TransactionStatus === "Success");
  return {
    invoiceId: d.InvoiceId,
    invoiceStatus: d.InvoiceStatus,       // Pending | Paid | Canceled ...
    isPaid: d.InvoiceStatus === "Paid",
    orderNo: d.CustomerReference || null,
    paymentId: paidTx?.PaymentId || null,
    gateway: paidTx?.PaymentGateway || null,
    paidAmount: paidTx ? Number(paidTx.PaidCurrencyValue || paidTx.TransationValue || 0) : 0,
    raw: d,
  };
}

export async function makeRefund({ paymentId, amount, comment }) {
  return mf("MakeRefund", {
    KeyType: "PaymentId",
    Key: String(paymentId),
    RefundChargeOnCustomer: false,
    ServiceChargeOnCustomer: false,
    Amount: Number(amount),
    Comment: (comment || "FreshCuts auto refund").slice(0, 250),
  });
}

/* ── webhook signature (portal → Webhook Settings → secret key) ──────────────
   MyFatoorah signs: the event's Data fields sorted by name (case-insensitive),
   joined as "k=v" with ",", HMAC-SHA256 with the secret, base64. Nulls are
   empty strings. We verify when the secret is set; either way the event only
   ever triggers a GetPaymentStatus re-check, never a direct state change.   */
export function verifyWebhookSignature(dataObj, signatureHeader, secret) {
  if (!secret) return null; // unknown — no secret configured yet
  try {
    const joined = Object.keys(dataObj || {})
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((k) => `${k}=${dataObj[k] == null ? "" : dataObj[k]}`)
      .join(",");
    const mac = crypto.createHmac("sha256", secret).update(joined, "utf8").digest("base64");
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(String(signatureHeader || "")));
  } catch {
    return false;
  }
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, jb } = ctx;
  const shop = deps.shop || (() => null);   // late-bound: shop registers after us

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pay_webhook_log (
        id BIGSERIAL PRIMARY KEY,
        event TEXT,
        signature_ok BOOLEAN,
        body JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS pay_webhook_log_time_idx ON pay_webhook_log(created_at DESC);
    `);
  }
  ensureSchema()
    .then(() => console.log("[pay] schema ready"))
    .catch((e) => console.error("[pay] schema failed:", e.message));

  /* POST /api/pay/webhook — public endpoint MyFatoorah calls. Registered in
     the portal AFTER activation (task list). Always 200s fast; the actual
     confirmation runs through shop.confirmOrder → GetPaymentStatus. */
  app.post("/api/pay/webhook", async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch { /* keep {} — still log it */ }
    const sig = c.req.header("MyFatoorah-Signature") || "";
    const ok = verifyWebhookSignature(body?.Data || {}, sig, env("MYFATOORAH_WEBHOOK_SECRET"));
    await pool.query(
      "INSERT INTO pay_webhook_log(event, signature_ok, body) VALUES ($1,$2,$3)",
      [body?.EventType != null ? String(body.EventType) : null, ok, jb(body)]
    ).catch(() => {});
    const ref = body?.Data?.CustomerReference || null;
    const invoiceId = body?.Data?.InvoiceId || null;
    const api = shop();
    if (api && (ref || invoiceId)) {
      // fire-and-forget: the webhook must answer fast or MyFatoorah retries
      api.confirmOrder({ orderNo: ref, invoiceId }).catch((e) =>
        console.error("[pay] webhook confirm failed:", e.message));
    }
    return c.json({ ok: true });
  });

  /* GET /api/pay/health — the activation probe. InitiatePayment lists the
     enabled payment methods without creating anything; this is how we know
     the moment Omar's account goes live, and which methods he really has. */
  app.get("/api/pay/health", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!configured()) return c.json({ ok: false, configured: false, error: "MYFATOORAH_API_KEY not set" });
    try {
      const d = await mf("InitiatePayment", { InvoiceAmount: 100, CurrencyIso: "SAR" });
      const methods = (d.PaymentMethods || []).map((m) => ({
        id: m.PaymentMethodId, code: m.PaymentMethodCode, name: m.PaymentMethodEn,
        nameAr: m.PaymentMethodAr, serviceCharge: m.ServiceCharge, isEmbedded: m.IsEmbeddedSupported,
      }));
      return c.json({ ok: true, configured: true, base: MF_BASE(), methods });
    } catch (e) {
      return c.json({ ok: false, configured: true, base: MF_BASE(), error: e.message }, 502);
    }
  });

  /* GET /api/pay/webhook-log — the last events, for the dashboard's
     reconciliation screen and for debugging a payment that "vanished". */
  app.get("/api/pay/webhook-log", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      "SELECT id, event, signature_ok, body, created_at FROM pay_webhook_log ORDER BY id DESC LIMIT 100"
    )).rows;
    return c.json({ ok: true, events: rows });
  });

  return { initiateSession, executePayment, paymentStatus, makeRefund, configured };
}
