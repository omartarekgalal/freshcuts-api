/* رسايل الإدارة — 16 سبتمبر 2026.
     node --test staffalerts.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { normStaffPhone, staffPhones, staffConfig, newOrderText, slaAlertText, posFailedText, makeStaffNotifier } from "./staffalerts.js";

test("أرقام: 05 / 5 / 966 / +966 / 00966 كلها بتتوحد، والغلط بيتشال والمكرر كمان", () => {
  assert.equal(normStaffPhone("0544775082"), "544775082");
  assert.equal(normStaffPhone("+966 50 633 8246"), "506338246");
  assert.equal(normStaffPhone("00966544775082"), "544775082");
  assert.equal(normStaffPhone("12345"), null);
  assert.deepEqual(staffPhones("0506338246  0544775082, 0544775082"), ["506338246", "544775082"]);
});

test("الإعدادات: الإنجليزي افتراضي ورسالة الطلب الجديد شغّالة افتراضياً", () => {
  const c = staffConfig({ delivery: { alertPhones: ["0506338246"], newOrderPhones: "0544775082" } });
  assert.equal(c.lang, "en");
  assert.equal(c.newOrderSms, true);
  assert.deepEqual(c.newOrderPhones, ["544775082"]);
  assert.equal(staffConfig({ delivery: { newOrderSms: false, staffSmsLanguage: "ar" } }).lang, "ar");
});

const row = { order_no: "W1", option: "delivery", total: "124", pay_gateway: "Apple Pay",
  customer: { name: "Ahmed", phone: "0551234567" }, items: [{ quantity: 3 }, { quantity: 1 }] };

test("رسالة الطلب الجديد بالإنجليزي فيها الرقم والنوع والمبلغ والدفع والأصناف والعميل", () => {
  const t = newOrderText(row, "en");
  assert.match(t, /NEW ONLINE ORDER W1/);
  assert.match(t, /Delivery \| 124 SAR \| PAID \(Apple Pay\)/);
  assert.match(t, /4 items \| Ahmed 0551234567/);
  assert.doesNotMatch(t, /[؀-ۿ]/); // مفيش عربي خالص
});

test("إنذارات المهل بالإنجليزي من نفس أكواد slaCheck", () => {
  assert.equal(slaAlertText("W1", { code: "pickup_breach", minutes: 45, message: "x" }, "en"),
    "Fresh Cuts ALERT - order W1: 45 min and the courier has NOT picked it up. Call the courier.");
  assert.match(slaAlertText("W1", { code: "pos_stuck", minutes: 6, message: "x" }, "ar"), /الطلب W1/);
  assert.match(posFailedText(row, "en"), /did NOT reach the POS/);
});

test("الإرسال: كل رقم لوحده، وفشل رقم مايوقفش التاني، ومفيش أرقام = مفيش إرسال", async () => {
  const sent = [];
  const n = makeStaffNotifier({
    getSettingsData: async () => ({ delivery: { alertPhones: ["0506338246", "0544775082"], newOrderPhones: ["0544775082"] } }),
    sendSms: async ({ phoneNorm, body }) => { if (phoneNorm === "506338246") throw new Error("boom"); sent.push([phoneNorm, body]); },
    log: () => {},
  });
  assert.equal(await n.newOrder(row), 1);
  assert.equal(sent[0][0], "544775082");
  assert.equal(await n.critical((lang) => `alert-${lang}`, "t"), 1); // واحد فشل وواحد وصل
  const none = makeStaffNotifier({ getSettingsData: async () => ({}), sendSms: async () => { throw new Error("no"); }, log: () => {} });
  assert.equal(await none.newOrder(row), 0);
  assert.equal(await none.critical(() => "x", "t"), 0);
});

test("رسالة الطلب الجديد تتقفل من اللوحة", async () => {
  let calls = 0;
  const n = makeStaffNotifier({
    getSettingsData: async () => ({ delivery: { newOrderSms: false, newOrderPhones: ["0544775082"] } }),
    sendSms: async () => { calls++; }, log: () => {},
  });
  assert.equal(await n.newOrder(row), 0);
  assert.equal(calls, 0);
});
