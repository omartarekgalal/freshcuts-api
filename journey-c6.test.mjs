// C6 — "opened checkout" over-count: menu-level address / geo / login events
// must never raise a session to the checkout step.
import test from "node:test";
import assert from "node:assert/strict";
import * as J from "./journey.js";

const SID = "sabcdefgh123", DEV = "dabcdefgh123";
/* run storefront batches through the real parser, then fold them the way
   applyEvents does: GREATEST(max, max >= 3 ? ifOpen : ifClosed) */
function session(...batches) {
  let max = 0, seq = 0;
  for (const evs of batches) {
    const p = J.parseBatch(JSON.stringify({
      sessionId: SID, anonId: DEV,
      events: evs.map(([n, props]) => ({ n, t: Date.now(), seq: ++seq, p: props || {} })),
    }));
    assert.equal(p.events.length, evs.length, "every event accepted");
    const { ifOpen, ifClosed } = J.batchMaxSteps(p.events);
    max = Math.max(max, max >= 3 ? ifOpen : ifClosed);
  }
  return max;
}

test("C6: address_step_open is never a funnel step, whatever sheet emitted it", () => {
  for (const via of ["editor", "list", "legacy"]) assert.equal(J.stepOf("address_step_open", { via }), null, via);
  assert.equal(J.stepOf("address_step_open", { via: "editor", ctx: "checkout" }), null);
});

test("C6: isMenuCtx — provisional location and the menu chip", () => {
  assert.ok(J.isMenuCtx({ prov: true }));
  assert.ok(J.isMenuCtx({ ctx: "menu" }));
  assert.ok(J.isMenuCtx({ mode: "prov" }));
  for (const s of ["prov_auto", "prov_intro", "prov_chip"]) assert.ok(J.isMenuCtx({ surface: s }), s);
  assert.ok(!J.isMenuCtx({ surface: "co2_edit" }));
  assert.ok(!J.isMenuCtx({ ctx: "checkout", mode: "delivery" }));
  assert.ok(!J.isMenuCtx({ prov: null }));
  assert.ok(!J.isMenuCtx(null));
  // an explicit menu context kills the step on every address / OTP event
  for (const n of ["address_set", "address_pick", "address_new", "pickup_selected", "otp_verified", "otp_ok"]) {
    assert.equal(J.stepOf(n, { deliverable: true, ctx: "menu" }), null, n);
  }
  // login_start carries prov:true when the location is still provisional — it IS checkout
  assert.equal(J.stepOf("login_start", { mode: "delivery", prov: true }), 3);
});

test("C6: guest taps the menu 'deliver to' chip (prov editor) — stays below checkout", () => {
  const max = session(
    [["session_start"], ["geo_prompt", { surface: "prov_auto" }], ["geo_granted", { surface: "prov_auto", auto: true }],
     ["address_set", { deliverable: true, prov: true, ctx: "menu" }]],
    [["offer_view", { kind: "offer" }], ["item_add"], ["cart_open", { cart_count: 1, cart_subtotal: 96 }]],
    [["address_step_open", { via: "editor" }], ["geo_granted", { surface: "prov_chip" }], ["address_seeded", { src: "geo" }],
     // old storefront: the editor sheet is "a checkout sheet", so ctx says checkout
     ["address_set", { deliverable: true, prov: true, ctx: "checkout" }], ["sheet_close", { sheet: "co2EditSheet", reason: "x" }]],
  );
  assert.equal(max, 2);
});

test("C6: logged-in customer picks / adds / logs in from the menu chip — stays below checkout", () => {
  // old storefront sends no context at all on these events
  assert.equal(session(
    [["session_start"], ["item_add"]],
    [["address_step_open", { via: "list" }], ["address_set", { deliverable: true, ctx: "checkout" }],
     ["address_pick", { deliverable: true, saved: true, n: 2 }]],
  ), 2);
  assert.equal(session(
    [["session_start"]],
    [["address_step_open", { via: "list" }], ["otp_gate_shown"], ["otp_requested", { result: "sms" }], ["otp_verified"],
     ["address_step_open", { via: "editor" }], ["address_new", { deliverable: true, account: true }]],
  ), 0);
  assert.equal(session([["session_start"], ["offer_view"], ["address_step_open", { via: "legacy" }], ["pickup_selected"]]), 1);
});

test("C6: a real checkout still counts, step by step", () => {
  assert.equal(session([["session_start"], ["item_add"], ["cart_open"], ["checkout_view", { cart_count: 1 }]]), 3);
  assert.equal(session([["session_start"], ["item_add"]], [["login_start", { mode: "delivery", prov: true, items: 1 }]]), 3);
  assert.equal(session(
    [["session_start"], ["item_add"], ["login_start", { mode: "delivery" }]],
    [["otp_gate_shown"], ["otp_verified"], ["otp_ok", { via: "checkout" }]],
  ), 4);
  assert.equal(session(
    [["session_start"], ["item_add"], ["login_start", { mode: "delivery" }]],
    [["otp_ok", { via: "checkout" }], ["address_step_open", { via: "list" }], ["address_pick", { deliverable: true, after_login: true }]],
  ), 5);
  // proof and the soft step inside one batch
  assert.equal(session([["item_add"], ["checkout_view"], ["address_set", { deliverable: true, ctx: "checkout" }]]), 5);
  assert.equal(session([["item_add"], ["checkout_view"], ["address_new", { deliverable: false }]]), 3);
  assert.equal(session([["item_add"], ["checkout_view"]], [["payment_sheet_open"]]), 6);
});

test("C6: order matters inside a batch — a menu pick BEFORE opening checkout is not step 5", () => {
  assert.equal(session([["item_add"], ["address_pick", { deliverable: true }], ["checkout_view"]]), 3);
  // and once checkout is open, an explicit menu context still does not count
  assert.equal(session([["item_add"], ["checkout_view"]], [["address_pick", { deliverable: true, ctx: "menu" }]]), 3);
});

test("C6: batchMaxSteps / isCheckoutProof basics", () => {
  assert.deepEqual(J.batchMaxSteps([]), { ifOpen: 0, ifClosed: 0 });
  assert.deepEqual(J.batchMaxSteps([{ name: "otp_verified", step: 4 }]), { ifOpen: 4, ifClosed: 0 });
  assert.deepEqual(J.batchMaxSteps([{ name: "item_add", step: 2 }, { name: "sheet_close", step: null }]), { ifOpen: 2, ifClosed: 2 });
  // server events: a created order / payment proves checkout by itself
  assert.deepEqual(J.batchMaxSteps([{ name: "checkout_result", step: 6 }]), { ifOpen: 6, ifClosed: 6 });
  assert.deepEqual(J.batchMaxSteps([{ name: "order_paid", step: 7 }]), { ifOpen: 7, ifClosed: 7 });
  assert.ok(J.isCheckoutProof("checkout_view", 3) && J.isCheckoutProof("login_start", 3) && J.isCheckoutProof("order_created", 6));
  assert.ok(!J.isCheckoutProof("address_step_open", null) && !J.isCheckoutProof("address_pick", 5) && !J.isCheckoutProof("otp_ok", 4));
  assert.ok(J.isSoftStep("address_pick") && !J.isSoftStep("checkout_view") && !J.isSoftStep("item_add"));
});

test("C6: the repair query is bounded, idempotent and never touches orders", () => {
  const q = J.REPAIR_SQL;
  assert.match(q, /max_step BETWEEN 3 AND 5/);            // repaired rows (<= 2) stop matching
  assert.match(q, /NOT s\.paid AND s\.order_no IS NULL/);
  assert.match(q, /CURRENT_DATE - \$1::int/);
  assert.match(q, /NOT EXISTS[\s\S]+'checkout_view','login_start'[\s\S]+e\.step >= 6/);
  assert.equal(J.REPAIR_DAYS, 30);
});
