import test from "node:test";
import assert from "node:assert/strict";
import {
  haversineKm, shouldRecordPing, etaMinutes, maskPhone, localPhone, handoffText, waUrl,
  PING_MIN_M,
} from "./courierlive.js";

/* نقطة المطعم ونقطة قريبة منها (من طلبات حقيقية في جدة) */
const STORE = { lat: 21.5881404, lng: 39.1521236 };
const CUST = { lat: 21.6147007, lng: 39.1450365 };

test("haversineKm: نفس النقطة = صفر، والمسافة معقولة", () => {
  assert.equal(haversineKm(STORE, STORE), 0);
  const km = haversineKm(STORE, CUST);
  assert.ok(km > 2.5 && km < 3.5, `توقعنا ~٣ كم، طلعت ${km}`);
  assert.equal(haversineKm(null, CUST), null);
  assert.equal(haversineKm({ lat: 1, lng: null }, CUST), null);
});

test("shouldRecordPing: أول نقطة دايماً، والوقوف مابيتسجّلش كل ثانية", () => {
  assert.equal(shouldRecordPing(null, { lat: 21.5, lng: 39.1 }), true);
  const last = { at: "2026-09-21T10:00:00.000Z", lat: 21.5, lng: 39.1 };
  // نفس المكان بعد ١٠ ثواني = مش نقطة جديدة
  assert.equal(shouldRecordPing(last, { ...last, at: "2026-09-21T10:00:10.000Z" }), false);
  // نفس المكان بعد ٣ دقايق = نسجّل («لسه حي»)
  assert.equal(shouldRecordPing(last, { ...last, at: "2026-09-21T10:03:00.000Z" }), true);
  // اتحرّك ٥٠ متر = نسجّل فوراً
  assert.equal(shouldRecordPing(last, { at: "2026-09-21T10:00:05.000Z", lat: 21.50045, lng: 39.1 }), true);
});

test("shouldRecordPing: بيرفض الإحداثيات المستحيلة والنصوص", () => {
  const last = { at: "2026-09-21T10:00:00.000Z", lat: 21.5, lng: 39.1 };
  assert.equal(shouldRecordPing(last, { lat: 999, lng: 39 }), false);
  assert.equal(shouldRecordPing(last, { lat: 21.5, lng: 200 }), false);
  assert.equal(shouldRecordPing(last, { lat: 0, lng: 0 }), false);   // نقطة «صفر صفر» = GPS فاضي
  assert.equal(shouldRecordPing(last, { lat: NaN, lng: 39 }), false);
  assert.equal(shouldRecordPing(last, null), false);
});

test("PING_MIN_M ثابت صغير معقول (متر مش كيلومتر)", () => {
  assert.ok(PING_MIN_M > 0 && PING_MIN_M < 100);
});

test("etaMinutes: أبعد = أطول، وفيه حد أدنى", () => {
  const near = etaMinutes({ from: STORE, to: { lat: 21.5891, lng: 39.1531 } });
  const far = etaMinutes({ from: STORE, to: CUST });
  assert.ok(near <= far);
  assert.ok(near >= 2, "الحد الأدنى دقيقتين");
  assert.equal(etaMinutes({ from: null, to: CUST }), null);
  // ~٣ كم × ١٫٣ ÷ ٢٤ كم/س ≈ ١٠ د
  assert.ok(far >= 7 && far <= 14, `ETA غير منطقي: ${far}`);
});

test("maskPhone: بيبان أول ٣ وآخر ٤ بس", () => {
  assert.equal(maskPhone("0551234567"), "055•••4567");
  assert.equal(maskPhone("966551234567"), "966•••••4567");
  assert.ok(!maskPhone("0551234567").includes("123"));
  assert.equal(maskPhone(""), "");
  assert.equal(maskPhone(null), "");
});

test("localPhone: أي صيغة → ٠٥XXXXXXXX", () => {
  assert.equal(localPhone("966551234567"), "0551234567");
  assert.equal(localPhone("+966 55 123 4567"), "0551234567");
  assert.equal(localPhone("0551234567"), "0551234567");
  assert.equal(localPhone("551234567"), "0551234567");
});

/* ── رسالة الواتساب ───────────────────────────────────────────────────── */
const ORDER = {
  order_no: "W1789940276452",
  total: 152.5,
  customer: { name: "أحمد", phone: "0551234567" },
  address: {
    area: "السلامة", street: "شارع الأمير سلطان", building: "12", floor: "3", apartment: "7",
    landmark: "النهدي", latitude: 21.6147007, longitude: 39.1450365,
    delivery_notes: "البوابة الخلفية", leave_at_door: true,
  },
};

test("handoffText: فيه كل اللي المندوب محتاجه", () => {
  const t = handoffText(ORDER, { link: "https://freshcuts.sa/d/abc123" });
  assert.ok(t.includes("W1789940276452"), "رقم الطلب");
  assert.ok(t.includes("أحمد"), "اسم العميل");
  assert.ok(t.includes("0551234567"), "جوال العميل كامل — المندوب لازم يكلّمه");
  assert.ok(t.includes("21.614701,39.145037"), "الدبوس بست خانات عشرية");
  assert.ok(t.includes("maps.google.com"), "رابط خريطة يفتح عنده");
  assert.ok(t.includes("حي السلامة"), "نص العنوان");
  assert.ok(t.includes("مبنى 12"), "المبنى");
  assert.ok(t.includes("البوابة الخلفية"), "ملاحظات التوصيل");
  assert.ok(t.includes("اترك الطلب عند الباب"), "اختيار العميل");
  assert.ok(t.includes("152.50"), "المبلغ");
  assert.ok(t.includes("مدفوع مسبقاً"), "تحذير عدم التحصيل");
  assert.ok(t.includes("https://freshcuts.sa/d/abc123"), "رابط التتبع");
});

test("handoffText: نفس صيغة العنوان اللي بتتبعت للاجلك", async () => {
  const { readableAddress } = await import("./couriers.js");
  const t = handoffText(ORDER, { link: "https://x/d/y" });
  const ljAddress = readableAddress({ ...ORDER.address, leave_at_door: false }, { withPin: false });
  assert.ok(t.includes(ljAddress), "لو صيغة العنوان اتغيّرت للاجلك لازم تتغيّر هنا لوحدها");
});

test("handoffText: مفيش دبوس = مفيش سطر خريطة، والرسالة بتفضل صالحة", () => {
  const t = handoffText({ ...ORDER, address: { ...ORDER.address, latitude: null, longitude: null } }, { link: "L" });
  assert.ok(!t.includes("maps.google.com"));
  assert.ok(t.includes("حي السلامة"));
  assert.ok(t.includes("مدفوع مسبقاً"));
});

test("handoffText: «اترك عند الباب» مابيتكررش في نص العنوان", () => {
  const t = handoffText(ORDER, { link: "L" });
  assert.equal(t.split("اترك الطلب عند الباب").length - 1, 1);
});

test("handoffText: من غير رابط (معاينة) مابيكدبش على المندوب", () => {
  const t = handoffText(ORDER, {});
  assert.ok(!t.includes("ابدأ التوصيل وسجّل التسليم"));
  assert.ok(t.includes("W1789940276452"));
});

test("waUrl: برقم = محادثة جاهزة، من غير رقم = اختيار جهة اتصال", () => {
  const t = "مرحبا";
  assert.ok(waUrl("0551234567", t).startsWith("https://wa.me/966551234567?text="));
  assert.ok(waUrl("", t).startsWith("https://wa.me/?text="));
  assert.ok(waUrl("مش رقم", t).startsWith("https://wa.me/?text="));
  assert.ok(waUrl("0551234567", t).includes(encodeURIComponent(t)));
});

test("waUrl: النص بيتشفّر (السطور الجديدة مابتكسرش الرابط)", () => {
  const u = waUrl("0551234567", handoffText(ORDER, { link: "https://freshcuts.sa/d/abc" }));
  assert.ok(!u.includes("\n"));
  assert.ok(!/\s/.test(u.split("?text=")[1]));
});
