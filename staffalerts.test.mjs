/* رسايل الإدارة — 16 سبتمبر 2026. كل رسالة لازم تبقى «رسالة واحدة» بس (تكلفة).
     node --test staffalerts.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import {
  smsInfo, fitOneSms, normStaffPhone, staffPhones, staffConfig, newOrderText, slaAlertText,
  posFailedText, tabsenseDownText, testText, makeStaffNotifier,
} from "./staffalerts.js";

test("حساب الرسالة: إنجليزي ١٦٠ (| بحرفين)، وأي عربي/إيموجي ⇒ ٧٠", () => {
  assert.deepEqual(smsInfo("a".repeat(160)), { encoding: "GSM-7", length: 160, limit: 160, segments: 1 });
  assert.equal(smsInfo("a".repeat(161)).segments, 2);
  assert.equal(smsInfo("|".repeat(80)).length, 160);
  assert.equal(smsInfo("a".repeat(100) + "ع").encoding, "UCS-2");
  assert.equal(smsInfo("ع".repeat(70)).segments, 1);
  assert.equal(smsInfo("ع".repeat(71)).segments, 2);
  assert.equal(smsInfo("✅").encoding, "UCS-2");
});

test("الحارس بيقص أي رسالة طويلة لرسالة واحدة", () => {
  assert.equal(smsInfo(fitOneSms("x".repeat(500))).segments, 1);
  assert.equal(smsInfo(fitOneSms("ع".repeat(300))).segments, 1);
  assert.equal(fitOneSms("short"), "short");
});

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

// أسوأ حالة: اسم عربي طويل، مبلغ كبير، بوابة دفع بحروف غريبة، أصناف كتير
const worst = {
  order_no: "W1789555412320", option: "delivery", total: "12345.67", pay_gateway: "Apple Pay – مدى ✓",
  customer: { name: "محمد عبدالله عبدالرحمن السالم", phone: "0551234567" }, phone_norm: "551234567",
  items: Array.from({ length: 12 }, () => ({ quantity: 9 })),
};

test("كل القوالب (EN و AR) رسالة واحدة حتى في أسوأ حالة", () => {
  const all = [
    newOrderText(worst, "en"), newOrderText(worst, "ar"),
    posFailedText(worst, "en"), posFailedText(worst, "ar"),
    tabsenseDownText("token expired and refresh failing and something much longer than expected here", "en"),
    tabsenseDownText("x", "ar"), testText("en"), testText("ar"),
  ];
  for (const code of ["pos_stuck", "never_accepted", "accept_breach", "accept_late", "handoff_breach", "handoff_late",
    "pickup_breach", "pickup_late", "deliver_breach", "deliver_late", "unknown_code"]) {
    all.push(slaAlertText(worst.order_no, { code, minutes: 1440, message: "طويلة جداً ".repeat(20) }, "en"));
    all.push(slaAlertText(worst.order_no, { code, minutes: 1440, message: "x" }, "ar"));
  }
  for (const t of all) {
    const info = smsInfo(t);
    assert.equal(info.segments, 1, `${info.encoding} ${info.length}/${info.limit}: ${t}`);
  }
});

test("الإنجليزي فيه اللي المدير محتاجه ومفيهوش اسم عربي (عشان مايقلبش ٧٠ حرف)", () => {
  const t = newOrderText(worst, "en");
  assert.match(t, /NEW ORDER W1789555412320/);
  assert.match(t, /Delivery 12345\.67 SAR PAID Apple Pay/);
  assert.match(t, /108 items, cust 0551234567/);
  assert.equal(smsInfo(t).encoding, "GSM-7");
  const alert = slaAlertText("W1", { code: "pickup_breach", minutes: 45 }, "en");
  assert.equal(alert, "Fresh Cuts ALERT W1: 45min, courier has NOT picked up. Call courier.");
  assert.equal(smsInfo(posFailedText(worst, "en")).encoding, "GSM-7");
});

test("الإرسال: كل رقم لوحده، وفشل رقم مايوقفش التاني، ومفيش أرقام = مفيش إرسال", async () => {
  const sent = [];
  const n = makeStaffNotifier({
    getSettingsData: async () => ({ delivery: { alertPhones: ["0506338246", "0544775082"], newOrderPhones: ["0506338246"] } }),
    sendSms: async ({ phoneNorm, body }) => { if (phoneNorm === "544775082") throw new Error("boom"); sent.push([phoneNorm, body]); },
    log: () => {},
  });
  assert.equal(await n.newOrder(worst), 1);
  assert.equal(sent[0][0], "506338246");
  assert.equal(smsInfo(sent[0][1]).segments, 1);
  assert.equal(await n.critical((lang) => `alert-${lang}`, "t"), 1);
  const none = makeStaffNotifier({ getSettingsData: async () => ({}), sendSms: async () => { throw new Error("no"); }, log: () => {} });
  assert.equal(await none.newOrder(worst), 0);
  assert.equal(await none.critical(() => "x", "t"), 0);
});

test("رسالة الطلب الجديد تتقفل من اللوحة", async () => {
  let calls = 0;
  const n = makeStaffNotifier({
    getSettingsData: async () => ({ delivery: { newOrderSms: false, newOrderPhones: ["0544775082"] } }),
    sendSms: async () => { calls++; }, log: () => {},
  });
  assert.equal(await n.newOrder(worst), 0);
  assert.equal(calls, 0);
});
