import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStoreAdset, STORE_RULES } from "./autopilot.js";

/* ملاحظة: `STORE_RULES.scaleFreeze` فيه تجميد ثابت ٢٢–٢٤ سبتمبر ٢٠٢٦ —
   يعني أي توسيع في الأيام دي متوقف. بقى قابل للتعديل من الإعدادات بالدمج
   تحت، لكن مامعنديش صف اختبار بيستوفي شروط التوسيع كلها عشان أثبت المسار
   ده، فمابدّعيش إني غطّيته. */

/* ٢٤/٩ — قواعد المتجر كانت ثابتة في الكود وبتتجاهل الإعدادات. تكلفة الشرا
   الحقيقية ٧٣–٩٥ ر.س و`killCpa` الثابتة ٨٠ — يعني أول ما الطيار يشتغل auto
   كان هيقتل محرّك الطلبات الأساسي. الاختبارات دي بتثبت إن الإعدادات بتغلب. */

/* صف واقعي: حملة شغّالة من زمن، صرف كويس، وتكلفة شرا ٨٥ */
const row = (over = {}) => ({
  key: "M2", platform: "meta", adsetId: "123", campaignId: "c1", name: "FC96-SALES",
  spend: 900, orders: 10, cpa: 85, roas: 2.6, atc: 40, days: 3,
  ageHours: 240, budget: 200, ...over,
});

test("من غير إعدادات: CPA ٨٥ بيتقتل — ده السلوك القديم", () => {
  const d = decideStoreAdset(row(), {});
  assert.equal(d.action, "kill", `المفروض kill، طلع ${d.action}: ${d.reason}`);
});

test("بإعدادات storeRules: نفس الصف مابيتقتلش", () => {
  const d = decideStoreAdset(row(), { storeRules: { killCpa: 160, cutCpaMin: 120 } });
  assert.notEqual(d.action, "kill", `اترفع الخط فالمفروض مايتقتلش — ${d.reason}`);
});

test("رفع خط القص بيطلّع الصف من مسار القص", () => {
  const mid = row({ spend: 660, orders: 12, cpa: 55, roas: 4 });
  const off = decideStoreAdset(mid, {});
  assert.match(off.reason, /بين 45 و80/, "الافتراضي: ٥٥ جوه نطاق القص ٤٥–٨٠");
  const on = decideStoreAdset(mid, { storeRules: { cutCpaMin: 120, killCpa: 200 } });
  assert.doesNotMatch(on.reason, /بين 45 و80/, "بعد رفع الخطوط مايبقاش في نطاق القص");
  assert.doesNotMatch(on.reason, /بين 120 و200/, "و٥٥ تحت ١٢٠ فمش في النطاق الجديد كمان");
});

test("إعدادات فاضية/بايظة = الافتراضي، من غير ما تقع", () => {
  for (const bad of [undefined, null, {}, { storeRules: null }, { storeRules: "x" }, { storeRules: 5 }]) {
    const d = decideStoreAdset(row(), bad === undefined ? undefined : bad);
    assert.equal(d.action, "kill", `${JSON.stringify(bad)} المفروض ترجع للافتراضي`);
  }
});

test("الافتراضيات نفسها ما اتغيّرتش", () => {
  assert.equal(STORE_RULES.killCpa, 80);
  assert.equal(STORE_RULES.scaleCpaMax, 30);
});

test("تجاوز جزئي: المفتاح اللي مابعتوش يفضل على الافتراضي", () => {
  const d = decideStoreAdset(row({ cpa: 200 }), { storeRules: { scaleCpaMax: 90 } });
  assert.equal(d.action, "kill", "killCpa لسه ٨٠ فـ٢٠٠ بتتقتل");
});
