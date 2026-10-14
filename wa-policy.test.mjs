/* سياسة رسايل الطلب على واتساب (wapolicy.js، ١٤/١٠) — دوال صافية. node --test wa-policy.test.mjs
   المسارات الحقيقية (الإرسال، التقييم، التقرير، الزر في البوت) في wabotrun.test.mjs / wa-switches.test.mjs / wa-sb2.test.mjs / tracketa.test.mjs. */
import test from "node:test";
import assert from "node:assert/strict";
import { WA_POLICY_DEFAULTS, waPolicyCfg, followLinkOf, followText, FOLLOW_RE, closedWindowStage, reviewDecision, orderMessagesReport } from "./wapolicy.js";

test("config: every rule ON by default; bad values fall back (never a wild number / number)", () => {
  assert.deepEqual(waPolicyCfg({}), { ...WA_POLICY_DEFAULTS });
  const c = waPolicyCfg({ waBot: { closedPolicy: false, reviewPaidGapMin: 999, followNumber: "+966 50 000 0001" } });
  assert.deepEqual([c.closedPolicy, c.reviewPaidGapMin, c.followNumber], [false, 30, "966500000001"]);
  assert.equal(waPolicyCfg({ waBot: { followNumber: "abc" } }).followNumber, "966546715683");
  assert.equal(waPolicyCfg({ waBot: { reviewPaidGapMin: 0 } }).reviewPaidGapMin, 0);
});

test("follow link: only while the bot is live for customers, the switch is on and the order is still open; ar + en prefilled text the bot recognises", () => {
  const live = { waBot: { mode: "live" } };
  const f = followLinkOf({ settings: live, orderNo: "W1790012345678", status: "accepted" });
  assert.equal(f.url, "https://wa.me/966546715683?text=" + encodeURIComponent("تابع طلبي W1790012345678"));
  assert.equal(f.textEn, "Track my order W1790012345678");
  assert.ok(FOLLOW_RE.test(followText("W1790012345678")) && FOLLOW_RE.test(followText("W1790012345678", "en")));
  for (const st of ["delivered", "rejected_refunded", "expired", "pending_payment"]) assert.equal(followLinkOf({ settings: live, orderNo: "W1790012345678", status: st }), null, st);
  assert.equal(followLinkOf({ settings: { waBot: { mode: "test" } }, orderNo: "W1790012345678", status: "accepted" }), null);
  assert.equal(followLinkOf({ settings: { waBot: { mode: "live", followLink: false } }, orderNo: "W1790012345678", status: "accepted" }), null);
  assert.equal(followLinkOf({ settings: live, orderNo: "12345", status: "accepted" }), null, "POS-only orders (not W…) have no bot lookup");
  assert.equal(followLinkOf({ settings: { waBot: { mode: "live", followNumber: "0500000001" } }, orderNo: "W1790012345678", status: "on_the_way" }).url.startsWith("https://wa.me/966500000001?"), true);
});

test("closed window: preparing is the only stage left out; received / on the way / delivered / refunds go", () => {
  const c = waPolicyCfg({});
  assert.deepEqual(closedWindowStage("accepted", c), { send: false, reason: "skip_preparing" });
  for (const st of ["pos_created", "on_the_way", "delivered", "rejected_refunded", "refund_failed", "pickup_ready"]) assert.deepEqual(closedWindowStage(st, c), { send: true }, st);
  assert.deepEqual(closedWindowStage("accepted", { ...c, closedSkipPreparing: false }), { send: true });
  assert.deepEqual(closedWindowStage("accepted", { ...c, closedPolicy: false }), { send: true });
});

test("review: merged into a delivered message that carries the buttons; else wait the paid gap; else send", () => {
  const c = waPolicyCfg({}), now = Date.parse("2026-10-14T18:00:00Z"), ago = (m) => new Date(now - m * 60_000).toISOString();
  assert.deepEqual(reviewDecision({ sent: [{ template: "fc_order_delivered_v2", stage: "delivered", at: ago(40) }], cfg: c, now }), { send: false, reason: "merged_delivered" });
  assert.deepEqual(reviewDecision({ sent: [{ template: null, source: "window", stage: "delivered", at: ago(40) }], cfg: c, now }), { send: false, reason: "merged_delivered" });
  const d = reviewDecision({ sent: [{ template: "fc_order_delivered", stage: "delivered", at: ago(10) }], cfg: c, now });
  assert.deepEqual([d.send, d.defer, d.reason, d.until], [false, true, "paid_gap", ago(-20)]);
  assert.deepEqual(reviewDecision({ sent: [{ template: "fc_order_delivered", stage: "delivered", at: ago(31) }], cfg: c, now }), { send: true });
  assert.deepEqual(reviewDecision({ sent: [], cfg: c, now }), { send: true });
  assert.deepEqual(reviewDecision({ sent: [{ template: "fc_order_delivered_v2", at: ago(1) }], cfg: { ...c, mergeDeliveredReview: false, reviewPaidGapMin: 0 }, now }), { send: true });
  assert.deepEqual(reviewDecision({ sent: [{ template: "fc_order_delivered_v2", at: ago(1) }], cfg: { ...c, closedPolicy: false }, now }), { send: true });
});

test("daily report: per order paid / free / left out, totals, SAR paid and saved at the utility rate — the order …1663 case (4 paid + review) vs the policy", () => {
  const before = orderMessagesReport([
    { order_no: "W1", stage: "pos_created", template: "fc_order_received_v2" }, { order_no: "W1", stage: "accepted", template: "fc_order_preparing_v2" },
    { order_no: "W1", stage: "on_the_way", template: "fc_order_on_the_way_courier" }, { order_no: "W1", stage: "delivered", template: "fc_order_delivered_v2" },
    { order_no: "W1", stage: "review", template: "fc_review_request_v2" }], [], 0.04);
  assert.deepEqual([before.orders, before.paid, before.free, before.paid_per_order, before.paid_sar], [1, 5, 0, 5, 0.2]);
  const after = orderMessagesReport([
    { order_no: "W1", stage: "pos_created", template: "fc_order_received_v2" }, { order_no: "W1", stage: "on_the_way", template: "fc_order_on_the_way_courier" },
    { order_no: "W1", stage: "delivered", template: "fc_order_delivered_v2" }, { order_no: "W2", stage: "pos_created", template: "fc_order_received_v2" },
    { order_no: "W2", stage: "accepted", template: null, source: "window" }, { order_no: "W2", stage: "on_the_way", template: null, source: "window" }],
    [{ order_no: "W1", stage: "accepted", reason: "skip_preparing" }, { order_no: "W1", stage: "review", reason: "review_merged" }], 0.04);
  assert.deepEqual([after.orders, after.paid, after.free, after.policy_skipped, after.paid_per_order, after.paid_sar, after.saved_sar], [2, 4, 2, 2, 2, 0.16, 0.16]);
  assert.deepEqual(after.list.find((o) => o.order_no === "W1").stages.map((s) => s.kind), ["paid", "paid", "paid", "skipped", "skipped"]);
  assert.deepEqual(orderMessagesReport([], []).orders, 0);
});
