/* approvalFromWebhook (W1-02، ٠٧ §٣) — node --test approval.test.mjs

   الـfixtures دي **مبنية على نفس المسار** اللي الكنس كان بيقراه بالـSQL
   (payload->'resource'->'statuses_slugs'->>'approval_status' و
    payload->'resource'->'order'->>'id') — مش payload حقيقي منظّف؛ الـfixtures
   الحقيقية بتيجي في W5-04 (contracts/). لو المسار اتغيّر الاختبار ده يفشل. */
import test from "node:test";
import assert from "node:assert/strict";
import { approvalFromWebhook } from "./shop.js";

const hook = (event, approval, extra = {}) => ({
  event,
  resource: {
    order: { id: 123456, reference: "W1726480000000", total: 96 },
    statuses_slugs: { approval_status: approval, payment_status: "paid", ...extra },
  },
});

test("order-updated: accepted / pickup_ready / rejected", () => {
  assert.equal(approvalFromWebhook(hook("order-updated", "accepted")), "accepted");
  assert.equal(approvalFromWebhook(hook("order-updated", "pickup_ready")), "pickup_ready");
  assert.equal(approvalFromWebhook(hook("order-updated", "rejected")), "rejected");
});

test("order-paid: القيمة زي ما هي (من غير lowercasing — pos_approval بيتخزّن كده)", () => {
  assert.equal(approvalFromWebhook(hook("order-paid", "new")), "new");
  assert.equal(approvalFromWebhook(hook("order-paid", "Accepted")), "Accepted");
});

test("payload متخزّن كنص JSON بيتقري برضه", () => {
  assert.equal(approvalFromWebhook(JSON.stringify(hook("order-updated", "accepted"))), "accepted");
  assert.equal(approvalFromWebhook("{not json"), null);
});

test("المسار اتغيّر أو ناقص → null مش crash", () => {
  assert.equal(approvalFromWebhook(null), null);
  assert.equal(approvalFromWebhook(undefined), null);
  assert.equal(approvalFromWebhook(42), null);
  assert.equal(approvalFromWebhook({}), null);
  assert.equal(approvalFromWebhook({ resource: {} }), null);
  assert.equal(approvalFromWebhook({ resource: { statuses_slugs: {} } }), null);
  assert.equal(approvalFromWebhook({ resource: { statuses: { approval_status: "accepted" } } }), null);
  assert.equal(approvalFromWebhook({ data: { statuses_slugs: { approval_status: "accepted" } } }), null);
  assert.equal(approvalFromWebhook(hook("order-updated", "")), null);
  assert.equal(approvalFromWebhook(hook("order-updated", "   ")), null);
  assert.equal(approvalFromWebhook(hook("order-updated", { slug: "accepted" })), null);
});

test("السلوك في الكنس زي الـSQL القديم: 'ready' بيتلقط بعد lowercase", () => {
  const a = String(approvalFromWebhook(hook("order-updated", "Pickup_Ready")) || "").toLowerCase();
  assert.ok(a.includes("ready"));
  assert.equal(String(approvalFromWebhook({}) || "").toLowerCase(), "");
});
