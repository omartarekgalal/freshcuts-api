import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOGUE, renderTemplate, savedText, missingRequired, unknownVars, previewOf } from "./smstemplates.js";
import { statusSmsText, statusTextFor } from "./notify.js";
import { cartSmsBody, cartMessages } from "./carts.js";
import { CUSTOMER_TEXT, customerText } from "./courierops.js";

const order = { order_no: "W1790012345678", option: "delivery", total: 96 };

test("من غير تعديل: كل رسايل الطلب بنفس نص الكود بالظبط", () => {
  for (const st of ["pos_created", "accepted", "courier_assigned", "on_the_way", "delivered", "rejected_refunded", "refund_failed"])
    assert.equal(statusTextFor(st, order, {}), statusSmsText(st, order), st);
  assert.equal(statusTextFor("pending_payment", order, {}), null);
  for (const k of ["external", "switched"]) assert.equal(customerText({}, k, "W1"), CUSTOMER_TEXT[k]("W1"));
  assert.equal(cartSmsBody(1, true, "L", "X", {}), cartSmsBody(1, true, "L", "X"));
  assert.ok(cartSmsBody(2, false, "L", "X", {}).startsWith(cartMessages.sms2(false)));
});

test("الافتراضي في الكتالوج = النص الفعلي (مفيش انجراف بين الاتنين)", () => {
  const vars = { order_no: order.order_no, track_url: `freshcuts.sa/track/${order.order_no}`, review_url: "https://g.page/r/CSG0gPAqlvHMEBM/review" };
  for (const st of ["pos_created", "accepted", "courier_assigned", "rejected_refunded", "refund_failed", "delivered"]) {
    const def = CATALOGUE.find((t) => t.id === `order.${st}`).def;
    assert.equal(def.replace(/\{([a-z_]+)\}/g, (m, k) => vars[k]), statusSmsText(st, order), st);
  }
  assert.equal(CATALOGUE.find((t) => t.id === "cart.sms1_first").def, cartMessages.sms1(true));
  assert.equal(CATALOGUE.find((t) => t.id === "cart.sms2").def, cartMessages.sms2(false));
  assert.equal(CATALOGUE.find((t) => t.id === "courier.external").def.replace("{order_no}", "W1"), CUSTOMER_TEXT.external("W1"));
});

test("التعديل بيتطبّق في كل مكان", () => {
  const s = { smsTemplates: { "order.accepted": "جاري التجهيز {order_no}", "cart.sms1": "سلتك مستنياك", "courier.switched": "بديل {order_no}" } };
  assert.equal(statusTextFor("accepted", order, s), `جاري التجهيز ${order.order_no}`);
  assert.ok(cartSmsBody(1, false, "LINK", "OPT", s).startsWith("سلتك مستنياك LINK\nOPT"));
  assert.equal(customerText(s, "switched", "W9"), "بديل W9");
});

test("قالب ناقص متغيّر إجباري ⇒ الافتراضي (رمز الدخول ورابط التتبع مايبوظوش)", () => {
  const s = { smsTemplates: { "account.otp": "رمزك", "order.on_the_way": "في الطريق" } };
  assert.match(renderTemplate(s, "account.otp", { code: "1234", minutes: 5 }).text, /1234/);
  assert.equal(renderTemplate(s, "account.otp", {}).custom, false);
  assert.equal(statusTextFor("on_the_way", order, s), statusSmsText("on_the_way", order));
  assert.deepEqual(missingRequired("account.otp", "رمزك"), ["code"]);
  assert.deepEqual(unknownVars("order.accepted", "{order_no} {name}"), ["name"]);
});

test("الرسايل اللي ليها مكان قديم بتتقرا منه", () => {
  assert.equal(savedText({ reviews: { askText: "قيّمنا {link}" } }, "review.invite"), "قيّمنا {link}");
  assert.equal(savedText({ openWait: { text: "فريش كاتس فتح! كمّل طلبك: {link}" } }, "waitlist.open"), null); // = الافتراضي
});

test("المعاينة بتحسب الذيل التلقائي", () => {
  const otp = previewOf("account.otp", CATALOGUE.find((t) => t.id === "account.otp").def);
  assert.match(otp.body, /#4821$/);
  assert.equal(otp.parts, 1);
  assert.match(previewOf("cart.sms1", "x").body, /freshcuts\.sa\/c\//);
});
