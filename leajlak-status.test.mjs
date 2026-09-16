/* حالات لاجلك الحقيقية اللي ظهرت على طلبات فعلية — أي حالة جديدة تتضاف هنا.
     node --test leajlak-status.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "./couriers.js";

const stage = (status) => PROVIDERS.leajlak.parseWebhook({ id: "W1", status }).status;

test("«Start Ride» (16 سبتمبر) = الكابتن اتحرك ولسه ما استلمش ⇒ assigned", () => {
  assert.equal(stage("Start Ride"), "assigned");
});
test("الحالات المعروفة من قبل لسه زي ما هي", () => {
  assert.equal(stage("New Order"), "pending");
  assert.equal(stage("Order Accept"), "assigned");
  assert.equal(stage("Shipped"), "picked");
  assert.equal(stage("Delivered"), "delivered");
});
