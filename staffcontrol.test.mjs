// node --test staffcontrol.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERT_TYPES, typeOfRef, controlCfg, allowStaff, aggregate, reportPayload } from "./staffcontrol.js";
import { setStaffGate, sendSms } from "./accounts.js";
import { makeStaffNotifier } from "./staffalerts.js";

const OWNER = "544775082", MANAGER = "506338246";

/* كل شكل ref ظهر فعلاً في sms_log (١٩→٢٥/٩) لازم يتعرف — مفيش «other» */
test("كل مراجع السجل الحقيقي بتتعرف", () => {
  const seen = {
    "new-order W1790157861552": ["new_order", null],
    "courier deliver_late W1790157861552": ["courier", "deliver_late"],
    "courier arrive_slow W1789833251536": ["courier", "arrive_slow"],
    "courier refused_far W1790261648555": ["courier", "refused_far"],
    "sla W1790175116055 delivery_failed": ["sla", "delivery_failed"],
    "sla W1790175116055 handoff_breach": ["sla", "handoff_breach"],
    "pos-failed W1": ["pos_failed", null], "total-mismatch W1": ["total_mismatch", null],
    "tabsense-down": ["tabsense_down", null], "checkout-down": ["checkout", "down"],
    "checkout-stalled": ["checkout", "stalled"], "checkout-up": ["checkout", "up"],
    "adconnect meta": ["adconnect", null], "daily_report": ["daily_report", null],
    "optout_brake": ["optout_brake", null], "content_alert": ["content_alert", null],
    "review:118": ["review", null], "test": ["test", null],
  };
  for (const [ref, [type, code]] of Object.entries(seen)) {
    assert.deepEqual(typeOfRef(ref), { type, code }, ref);
    if (type !== "test") assert.ok(ALERT_TYPES.some((t) => t.id === type), `مش في الكتالوج: ${type}`);
  }
});

test("من غير إعدادات كله بيتبعت (الوضع الحالي مايتغيّرش بالنشر)", () => {
  for (const ref of ["new-order W1", "courier deliver_late W1", "checkout-down"]) assert.equal(allowStaff({}, ref, MANAGER), true);
});

test("التحكم: النوع · الكود · الرقم", () => {
  const s = { staffAlerts: { types: {
    new_order: { enabled: false },
    courier: { enabled: true, codes: { arrive_slow: false }, mute: [`0${OWNER}`] },
  } } };
  assert.equal(allowStaff(s, "new-order W1", MANAGER), false);
  assert.equal(allowStaff(s, "courier arrive_slow W1", MANAGER), false);   // الكود مقفول
  assert.equal(allowStaff(s, "courier deliver_late W1", MANAGER), true);   // كود تاني شغّال
  assert.equal(allowStaff(s, "courier deliver_late W1", OWNER), false);    // المالك مكتوم
  assert.equal(allowStaff(s, "sla W1 pickup_breach", OWNER), true);        // نوع مالوش إعداد
  assert.equal(allowStaff({ staffAlerts: { types: { new_order: { enabled: false } } } }, "test", MANAGER), true);
});

test("الإعدادات: أرقام بأي شكل بتتوحّد", () => {
  const c = controlCfg({ staffAlerts: { types: { courier: { mute: ["+966 54 477 5082", "0506338246"] } }, phoneNames: { "0544775082": "عمر" } } });
  assert.deepEqual(c.types.courier.mute, [OWNER, MANAGER]);
  assert.equal(c.phoneNames[OWNER], "عمر");
});

test("البوابة: المقفول مايخرجش لتقنيات، والخطأ فيها مايقفلش حاجة", async () => {
  process.env.TAQNYAT_API_KEY = ""; process.env.TAQNYAT_SENDER = "";   // لو وصل لتقنيات هيرمي
  setStaffGate(async () => false);
  assert.deepEqual(await sendSms({ phoneNorm: MANAGER, body: "x", kind: "staff", ref: "new-order W1" }), { suppressed: true });
  // البوابة بترمي ⇒ fail-open ⇒ بيحاول يبعت (ويفشل هنا لأن تقنيات مش متظبطة في الاختبار)
  setStaffGate(async () => { throw new Error("boom"); });
  await assert.rejects(sendSms({ phoneNorm: MANAGER, body: "x", kind: "staff", ref: "new-order W1" }), /not configured/);
  // رسايل العملاء مابتعدّيش على البوابة أصلاً
  setStaffGate(async () => false);
  await assert.rejects(sendSms({ phoneNorm: MANAGER, body: "x", kind: "otp", ref: null }), /not configured/);
  setStaffGate(null);
});

test("المُبلِّغ مايعدّش المقفول كـ«اتبعت»", async () => {
  const staff = makeStaffNotifier({
    getSettingsData: async () => ({ delivery: { alertPhones: [OWNER, MANAGER] } }),
    sendSms: async ({ phoneNorm }) => (phoneNorm === OWNER ? { suppressed: true } : { messageId: "1" }),
  });
  assert.equal(await staff.critical(() => "x", "courier deliver_late W1"), 1);
});

test("التقرير: تجميع بالنوع والكود والرقم واليوم + المتوقع شهرياً", () => {
  const rows = [
    { at: "2026-09-24T20:00:00Z", phone_norm: MANAGER, ref: "courier deliver_late W1", parts: 1, cost: 0.0765 },
    { at: "2026-09-24T20:00:01Z", phone_norm: OWNER, ref: "courier deliver_late W1", parts: 1, cost: 0.0765 },
    { at: "2026-09-25T10:00:00Z", phone_norm: MANAGER, ref: "new-order W2", parts: 1, cost: 0.0765 },
  ];
  const a = aggregate(rows, [{ type: "courier", n: 4 }], 7);
  assert.equal(a.totals.n, 3);
  assert.equal(a.types[0].id, "courier");
  assert.deepEqual(a.types[0].byCode, { deliver_late: 2 });
  assert.deepEqual(a.types[0].byPhone, { [MANAGER]: 1, [OWNER]: 1 });
  assert.equal(a.types[0].suppressed, 4);
  assert.equal(a.totals.suppressed, 4);
  assert.equal(a.daily.length, 2);
  assert.equal(a.totals.spanDays, 2);
  assert.equal(a.totals.monthly, Math.round((0.2295 / 2) * 30 * 100) / 100);
});

test("رد التقرير: أسامي الأرقام مابتتمسحش (باج ٢٦/٩)", () => {
  const agg = aggregate([{ at: "2026-09-25T10:00:00Z", phone_norm: MANAGER, ref: "new-order W2", parts: 1, cost: 0.0765 }], [], 7);
  const r = reportPayload({ agg, days: 7, settings: {
    delivery: { alertPhones: [`0${OWNER}`, `0${MANAGER}`], newOrderPhones: [`0${MANAGER}`] },
    staffAlerts: { phoneNames: { [OWNER]: "عمر (المالك)", [MANAGER]: "مدير الفرع" } } } });
  assert.deepEqual(r.phones.find((p) => p.pn === MANAGER), { pn: MANAGER, name: "مدير الفرع", n: 1 });
  assert.deepEqual(r.phones.find((p) => p.pn === OWNER), { pn: OWNER, name: "عمر (المالك)", n: 0 });  // رقم مابيستلمش لسه بيظهر
  assert.equal(r.totals.n, 1);
  assert.ok(Array.isArray(r.catalogue) && r.catalogue.length >= 12);
});
