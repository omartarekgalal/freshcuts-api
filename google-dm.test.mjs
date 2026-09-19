// Data Manager payload (١٩/٩): الطلبات لجوجل بتروح events:ingest بدل uploadClickConversions.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createGoogleAdapter } from "./google.js";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const mk = () => createGoogleAdapter({
  httpJson: async () => ({ ok: false, status: 0 }),
  hashEmail: (e) => (e ? sha(String(e).trim().toLowerCase()) : null),
  hashPhonePlus: (d) => (d ? sha("+" + d) : null),
  googleDateTime: (d) => d.toISOString(),
});

test("buildBatch → events:ingest with HEX phone, transactionId, IN_STORE, value SAR", () => {
  process.env.GOOGLE_ADS_CUSTOMER_ID = "878-265-9560";
  process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "";
  process.env.GOOGLE_ADS_CONVERSION_ACTION_ID = "7717198051";
  process.env.GOOGLE_DM_CHANNEL_VAR = "order_channel";
  delete process.env.GOOGLE_MERCHANT_ID;
  const g = mk();
  const call = g.buildBatch([
    { orderId: "A1", eventTime: new Date("2026-09-18T20:00:00Z"), value: 57.5, currency: "SAR", phoneDigits: "966500000000",
      actionSource: "physical_store", contentCategory: "delivery:keeta", contents: [{ id: "18", matched: true, quantity: 1, unitPrice: 57.5 }] },
    { orderId: "A2", eventTime: new Date(), value: 10, currency: "SAR" },            // no identity → dropped
    { orderId: "A3", eventTime: new Date(), value: 20, currency: "SAR", gclid: "Cj0", actionSource: "website" },
  ]);
  assert.equal(call.url, "https://datamanager.googleapis.com/v1/events:ingest");
  assert.equal(call._dm, true);
  assert.deepEqual(call.body.destinations, [{ operatingAccount: { accountType: "GOOGLE_ADS", accountId: "8782659560" }, productDestinationId: "7717198051" }]);
  assert.equal(call.body.encoding, "HEX");
  assert.equal(call.body.events.length, 2);
  const [a, c] = call.body.events;
  assert.equal(a.transactionId, "A1");
  assert.equal(a.eventSource, "IN_STORE");
  assert.equal(a.conversionValue, 57.5);
  assert.equal(a.currency, "SAR");
  assert.equal(a.eventTimestamp, "2026-09-18T20:00:00.000Z");
  assert.deepEqual(a.userData, { userIdentifiers: [{ phoneNumber: sha("+966500000000") }] });
  assert.deepEqual(a.customVariables, [{ variable: "order_channel", value: "delivery:keeta" }]);
  assert.equal(a.cartData, undefined, "no Merchant Center → no cartData");
  assert.deepEqual(c.adIdentifiers, { gclid: "Cj0" });
  assert.equal(c.eventSource, "WEB");
});

test("cartData carries only catalog (feed.csv) ids when a Merchant Center id is set", () => {
  process.env.GOOGLE_MERCHANT_ID = "123";
  const g = mk();
  const ev = g.dmEvent({ orderId: "B", eventTime: new Date(), value: 5, phoneDigits: "966500000001",
    contents: [{ id: "18", matched: true, quantity: 2, unitPrice: 2.5 }, { id: "n:ملوخيه", matched: false, quantity: 1, unitPrice: 5 }] });
  assert.deepEqual(ev.cartData, { merchantId: "123", items: [{ merchantProductId: "18", quantity: "2", unitPrice: 2.5 }] });
  delete process.env.GOOGLE_MERCHANT_ID;
});

test("scope refusal is permanent (rows stay eligible) and latches readiness", () => {
  const g = mk();
  const r = g.readBatchResult({ ok: false, status: 403, json: { error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes.", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } } }, 3);
  assert.equal(r.ok, false);
  assert.equal(r.permanent, true);
  assert.equal(g.lastReadiness().code, "DM_SCOPE_MISSING");
});
