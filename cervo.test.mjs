/* اختبارات Cervo — كلها من غير شبكة. الهدف إن كل قاعدة اتفقنا عليها مع
   عمر والمورّد تبقى مكتوبة هنا، مخصوص القاعدة اللي لو اتكسرت المندوب
   هيطلب فلوس من عميل دفع خلاص. */
import { test as t } from "node:test";
import assert from "node:assert/strict";
import {
  cervoStage, CERVO_STATUS, CERVO_STATUS_AR, isCervoStatus, cervoStatusAr,
  cervoNumericId, cervoNotes, cervoAsciiLine, cervoAddress, cervoPayload,
  assertPrepaid, assertCervoPayload, parseCervoWebhook, pickCervoUid,
  normalizeCervoOrder, riyadhToIso, isoToRiyadh, cervoTimeToIso, isoToCervoTime,
  CERVO_TZ_OFFSET_DEFAULT, cervoContract, cervoCostFor,
  maskedPayload, CERVO_PAYMENT, CERVO_LIMITS,
} from "./cervo.js";
import { PROVIDERS, API_PROVIDER_IDS, courierMilestone, PROVIDER_REPORTS_ARRIVAL,
         routeCourier, courierRoutingCfg } from "./couriers.js";

const ORDER = {
  order_no: "W1789825687099",
  total: 87.5,
  customer: { name: "أحمد", phone: "0544775082" },
  address: {
    latitude: 21.59208, longitude: 39.143515,
    area: "السلامة", street: "شارع الأمير سلطان", building: "12", floor: "3", apartment: "7",
    landmark: "جنب النهدي", delivery_notes: "الجرس مش شغال",
  },
  notes: "من غير بصل",
};
const CFG = { storeLat: 21.5, storeLng: 39.15, cervoWebhookUrl: "https://x.test/api/delivery/cervo-webhook" };

/* ═══ خريطة الحالات ═══ */
t("خريطة الحالات كاملة — كل كود عندهم ليه حالة موحّدة", () => {
  assert.equal(cervoStage(0), "cancelled");
  assert.equal(cervoStage(1), "pending");
  assert.equal(cervoStage(2), "assigned");
  assert.equal(cervoStage(3), "picked");
  assert.equal(cervoStage(4), "delivered");
  assert.equal(cervoStage(5), "cancelled");
  assert.equal(cervoStage(6), "cancelled");
  assert.equal(cervoStage(7), "cancelled");
  assert.equal(cervoStage(20), "assigned");
});
t("الكود بيتقبل نصاً كمان (الويبهوك ممكن يبعته string)", () => {
  assert.equal(cervoStage("3"), "picked");
  assert.equal(cervoStage("20"), "assigned");
});
t("كود مش معروف = null مش تخمين", () => {
  assert.equal(cervoStage(99), null);
  assert.equal(cervoStage(null), null);
  assert.equal(cervoStage(""), null);
  assert.equal(cervoStage("abc"), null);
});
t("٢٠ = وصل المطعم — أول إشارة وصول حقيقية عندنا", () => {
  assert.equal(courierMilestone("cervo", 20), "arrived");
  assert.equal(courierMilestone("cervo", "20"), "arrived");
  assert.equal(courierMilestone("cervo", 3), "picked");
  assert.equal(courierMilestone("cervo", 2), null);   // قبول مش وصول
  assert.equal(PROVIDER_REPORTS_ARRIVAL.cervo, true);
});
t("تغيير normStatus ما كسرش لاجلك", () => {
  assert.equal(courierMilestone("leajlak", "Reached Shop"), "arrived");
  assert.equal(courierMilestone("leajlak", "Order Picked"), "picked");
  assert.equal(courierMilestone("flyingarrow", "pickup_completed"), "picked");
});
t("الأسماء العربية موجودة لكل كود", () => {
  for (const k of Object.keys(CERVO_STATUS)) assert.ok(CERVO_STATUS_AR[k], `ناقص ${k}`);
  assert.equal(cervoStatusAr(20), "الكابتن وصل المطعم");
  assert.equal(isCervoStatus(4), true);
  assert.equal(isCervoStatus(99), false);
});

/* ═══ الـid الرقمي ═══ */
t("رقم الطلب بيتحوّل لـid رقمي ثابت", () => {
  assert.equal(cervoNumericId("W1789825687099"), 1789825687099);
  assert.equal(cervoNumericId("W1789825687099"), cervoNumericId("W1789825687099"));
  assert.ok(Number.isSafeInteger(cervoNumericId("W1789825687099")));
});
t("id من غير أرقام بيرمي بدل ما يبعت صفر", () => {
  assert.throws(() => cervoNumericId("ABC"), /مافيهوش أرقام/);
  assert.throws(() => cervoNumericId(""), /مافيهوش أرقام/);
});
t("رقم طويل جداً بياخد آخر ١٥ خانة ويفضل آمن", () => {
  const n = cervoNumericId("W" + "9".repeat(20));
  assert.ok(Number.isSafeInteger(n) && n > 0);
});

/* ═══ القاعدة اللي مايصحش تتكسر: المندوب مايحصّلش ═══ */
t("الجسم دايماً ONLINE + ispaid + price 0", () => {
  const p = cervoPayload(ORDER, CFG);
  assert.equal(p.payment, "ONLINE");
  assert.equal(p.payment, CERVO_PAYMENT);
  assert.equal(p.ispaid, true);
  assert.equal(p.price, 0);
});
t("إجمالي الطلب عمره ما يتسرّب لخانة السعر", () => {
  const p = cervoPayload({ ...ORDER, total: 999 }, CFG);
  assert.equal(p.price, 0);
  assert.equal(JSON.stringify(p).includes("999"), false);
});
t("الإعدادات مش بتقدر تكسر قاعدة الدفع", () => {
  const p = cervoPayload(ORDER, { ...CFG, price: 50, payment: "CASH", ispaid: false });
  assert.equal(p.price, 0);
  assert.equal(p.payment, "ONLINE");
  assert.equal(p.ispaid, true);
});
t("assertPrepaid بترمي على أي انحراف", () => {
  assert.throws(() => assertPrepaid({ payment: "CASH", ispaid: true, price: 0 }), /CASH|ONLINE/);
  assert.throws(() => assertPrepaid({ payment: "ONLINE", ispaid: false, price: 0 }), /ispaid/);
  assert.throws(() => assertPrepaid({ payment: "ONLINE", ispaid: true, price: 12 }), /price/);
  const e = (() => { try { assertPrepaid({ payment: "CASH", ispaid: true, price: 0 }); } catch (x) { return x; } })();
  assert.equal(e.code, "CERVO_UNSAFE_PAYMENT");
});

/* ═══ التحقق قبل الشبكة ═══ */
t("جوال غلط بيوقف الإرسال قبل ما يروح لهم", () => {
  assert.throws(() => cervoPayload({ ...ORDER, customer: { name: "س", phone: "123" } }, CFG), /mobile/);
});
t("من غير إحداثيات عميل بيرمي", () => {
  assert.throws(() => cervoPayload({ ...ORDER, address: { ...ORDER.address, latitude: 0 } }, CFG), /customerlat/);
});
t("من غير إحداثيات محل بيرمي", () => {
  assert.throws(() => cervoPayload(ORDER, { storeLat: 0, storeLng: 0 }), /storelat/);
});
t("الجوال بصيغة +9665", () => {
  assert.equal(cervoPayload(ORDER, CFG).mobile, "+966544775082");
  assert.equal(cervoPayload({ ...ORDER, customer: { phone: "966544775082" } }, CFG).mobile, "+966544775082");
  assert.equal(cervoPayload({ ...ORDER, customer: { phone: "+966544775082" } }, CFG).mobile, "+966544775082");
});

/* ═══ العنوان والملاحظات ═══ */
t("العنوان = نص مقروء + النقطة", () => {
  const a = cervoAddress(ORDER.address);
  assert.match(a, /حي السلامة/);
  assert.match(a, /21\.592080,39\.143515/);
});
t("صيغة «النقطة بس» متاحة لو تطبيقهم بيبحث بالنص", () => {
  assert.equal(cervoAddress(ORDER.address, "coords"), "21.592080,39.143515");
  assert.equal(cervoPayload(ORDER, { ...CFG, cervoAddressFormat: "coords" }).address, "21.592080,39.143515");
});
t("الإحداثيات في حقولهم المنفصلة برضه", () => {
  const p = cervoPayload(ORDER, CFG);
  assert.equal(p.customerlat, 21.59208);
  assert.equal(p.customerlng, 39.143515);
  assert.equal(p.storelat, 21.5);
  assert.equal(p.storelng, 39.15);
});
t("العربي بيتبعت زي ما هو — من غير ترميز ولا هروب", () => {
  const p = cervoPayload(ORDER, CFG);
  assert.ok(p.notes.includes("العنوان: حي السلامة"));
  assert.ok(p.notes.includes("ملاحظات التوصيل: الجرس مش شغال"));
  assert.equal(p.customer, "أحمد");
  /* الرحلة اللي الشبكة هتعملها: JSON → UTF-8 → رجوع. لازم نفس النص. */
  const round = JSON.parse(Buffer.from(JSON.stringify(p), "utf8").toString("utf8"));
  assert.equal(round.notes, p.notes);
  assert.equal(round.customer, "أحمد");
  assert.ok(Buffer.byteLength(p.notes, "utf8") > p.notes.length);   // فعلاً عربي مش ASCII
});
t("ملاحظات الأكل عمرها ما توصل المندوب", () => {
  const withSplit = cervoNotes(ORDER);
  assert.equal(withSplit.includes("من غير بصل"), false);
});
t("طلب قديم (قبل فصل الملاحظات) ملاحظته بتفضل توصل المندوب", () => {
  const legacy = { ...ORDER, address: { ...ORDER.address } };
  delete legacy.address.delivery_notes;
  assert.ok(cervoNotes(legacy).includes("من غير بصل"));
});
t("سطر إنجليزي بالأرقام في الأول — تأمين لو رمّزوا العربي غلط", () => {
  const l = cervoAsciiLine(ORDER);
  assert.match(l, /PREPAID - collect nothing/);
  assert.match(l, /Bldg 12/);
  assert.match(l, /Floor 3/);
  assert.match(l, /Apt 7/);
  assert.equal(/[؀-ۿ]/.test(l), false);
});
t("السطر الإنجليزي يتقفل من الإعدادات", () => {
  const p = cervoPayload(ORDER, { ...CFG, cervoAsciiLine: false });
  assert.equal(p.notes.includes("PREPAID - collect nothing"), false);
  assert.ok(p.notes.includes("العنوان:"));
});
t("«اترك عند الباب» بتوصل بالعربي والإنجليزي", () => {
  const o = { ...ORDER, address: { ...ORDER.address, leave_at_door: true } };
  assert.ok(cervoNotes(o).includes("اترك الطلب عند الباب"));
  assert.ok(cervoNotes(o).includes("LEAVE AT DOOR"));
});
t("الملاحظات ما تعدّيش ٣٠٠ حرف", () => {
  const o = { ...ORDER, address: { ...ORDER.address, delivery_notes: "ط".repeat(900) } };
  assert.ok(cervoNotes(o).length <= 300);
});
t("رقمنا في order_id ومرجع الطلب في id", () => {
  const p = cervoPayload(ORDER, CFG);
  assert.equal(p.order_id, "W1789825687099");
  assert.equal(p.id, 1789825687099);
});
t("رابط الويبهوك بيتبعت في callback", () => {
  assert.equal(cervoPayload(ORDER, CFG).callback, CFG.cervoWebhookUrl);
});
t("المسافة بالمتر عندهم", () => {
  assert.equal(cervoPayload(ORDER, { ...CFG, routeKm: 11.2 }).distance, 11200);
  assert.equal(cervoPayload(ORDER, CFG).distance, undefined);
});
t("الجوال بيتقنّع في اللوج", () => {
  const m = maskedPayload(cervoPayload(ORDER, CFG));
  assert.equal(m.mobile.includes("4775082"), false);
  assert.match(m.mobile, /\*\*\*/);
});

/* ═══ الويبهوك ═══ */
t("قراءة كل حالات الويبهوك", () => {
  for (const [code, want] of Object.entries(CERVO_STATUS)) {
    const e = parseCervoWebhook({ order_id: "uid-1", partner_ref: "W1789825687099", order_status: Number(code) });
    assert.equal(e.status, want, `كود ${code}`);
    assert.equal(e.statusCode, Number(code));
  }
});
t("الويبهوك بيطلّع مرجعهم ورقمنا", () => {
  const e = parseCervoWebhook({ order_id: "uid-9", partner_ref: "W1789825687099", order_status: 2,
    driver_name: "خالد", driver_mobile: "0555555555", tracking: "https://track.test/x" });
  assert.equal(e.ref, "uid-9");
  assert.equal(e.orderNo, "W1789825687099");
  assert.equal(e.driver.name, "خالد");
  assert.equal(e.tracking, "https://track.test/x");
  assert.equal(e.provider, "cervo");
});
t("partner_ref رقمي (الـid) بيتفرز لوحده", () => {
  const e = parseCervoWebhook({ order_id: "uid-9", partner_ref: "1789825687099", order_status: 1 });
  assert.equal(e.numericRef, "1789825687099");
  assert.equal(e.orderNo, null);
});
t("سبب الإلغاء والمسافات بيتقروا", () => {
  const e = parseCervoWebhook({ order_id: "u", order_status: 5, cancel: "العميل مش راد", store_distance: 500, customer_distance: 1200 });
  assert.equal(e.cancelReason, "العميل مش راد");
  assert.equal(e.storeDistance, 500);
  assert.equal(e.customerDistance, 1200);
  assert.equal(e.status, "cancelled");
});
t("رسالة مش بتاعتنا = null", () => {
  assert.equal(parseCervoWebhook({ hello: "world" }), null);
  assert.equal(parseCervoWebhook(null), null);
  assert.equal(parseCervoWebhook("x"), null);
});
t("رسالة Cervo مابتتخطفش من مزوّد تاني", () => {
  const b = { order_id: "uid-1", partner_ref: "W1", order_status: 2 };
  assert.equal(PROVIDERS.leajlak.parseWebhook(b), null);
  const fa = PROVIDERS.flyingarrow.parseWebhook(b);
  assert.ok(!fa || !fa.status, "Flying Arrow مالهاش حق تفسّر رسالة Cervo كحالة");
  assert.ok(PROVIDERS.cervo.parseWebhook(b).status);
});
t("ورسالة لاجلك مابتتخطفش من Cervo", () => {
  assert.equal(parseCervoWebhook({ id: "W1", status: "Order Accept" }), null);
});
t("مفيش تكلفة في أي رسالة منهم", () => {
  assert.equal(parseCervoWebhook({ order_id: "u", order_status: 4 }).cost, null);
});

/* ═══ الردود ═══ */
t("رد الإنشاء نص GUID", () => {
  assert.equal(pickCervoUid("a1b2c3d4-e5f6-7890-abcd-ef1234567890"), "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  assert.equal(pickCervoUid('"a1b2c3d4-e5f6-7890-abcd-ef1234567890"'), "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  assert.equal(pickCervoUid({ id: "uid-7" }), "uid-7");
  assert.equal(pickCervoUid("No available drivers found within the specified range."), null);
  assert.equal(pickCervoUid(null), null);
});
t("GET /order بيتقرا صح", () => {
  const o = normalizeCervoOrder({
    id: "uid-1", db_id: 12345, DriverName: "سعد", DriverMobile: "+966500000000", Status: 3,
    OrderStatus: [{ Status: 1, Date: "2026-01-21 10:00" }, { Status: 20, Date: "2026-01-21 10:15" }],
    tracking: "https://track.cervodelivery.com/uid-1",
  });
  assert.equal(o.status, "picked");
  assert.equal(o.statusCode, 3);
  assert.equal(o.driver.name, "سعد");
  assert.equal(o.tracking, "https://track.cervodelivery.com/uid-1");
  assert.equal(o.history.length, 2);
  assert.equal(o.history[1].status, "assigned");
  assert.equal(o.history[1].at, "2026-01-21T10:15:00.000Z");   // UTC (مقاس)
});
t("من غير كابتن بيرجّع null مش كائن فاضي", () => {
  assert.equal(normalizeCervoOrder({ id: "u", Status: 1 }).driver, null);
});

/* ═══ الوقت ═══ */
t("تواريخهم UTC — مقاسة، مش اللي اتقال", () => {
  /* ٢٢/٩ على الساندبوكس: أنشأنا الطلب 10:18:34 UTC (13:18 رياض)، وهم
     سجّلوا "2026-09-22 10:18". يعني UTC حرفياً. */
  assert.equal(CERVO_TZ_OFFSET_DEFAULT, 0);
  assert.equal(cervoTimeToIso("2026-09-22 10:18"), "2026-09-22T10:18:00.000Z");
  assert.equal(riyadhToIso("2026-01-21 10:00"), "2026-01-21T10:00:00.000Z");
  assert.equal(cervoTimeToIso("خربان"), null);
  assert.equal(cervoTimeToIso(null), null);
});
t("الإزاحة قابلة للتغيير لو رجعوا لرياض من غير نشر", () => {
  assert.equal(cervoTimeToIso("2026-09-22 13:18", 3), "2026-09-22T10:18:00.000Z");
  assert.equal(isoToCervoTime("2026-09-22T10:18:00.000Z", 3), "2026-09-22 13:18:00");
});
t("والعكس للطلبات المجدولة بنفس الإزاحة", () => {
  assert.equal(isoToRiyadh("2026-01-21T07:00:00.000Z"), "2026-01-21 07:00:00");
  assert.equal(isoToCervoTime("لأ"), null);
});
t("محطات الـhistory بتتقرا UTC", () => {
  const o = normalizeCervoOrder({ id: "u", status: 2, orderStatus: [{ status: 2, date: "2026-09-22 10:18" }] });
  assert.equal(o.history[0].at, "2026-09-22T10:18:00.000Z");
});

/* ═══ التكلفة ═══ */
t("الافتراضي تقدير معلّم — رقم في الحسابات، بس مش مؤكد", () => {
  /* عمر (٢٢/٩): المالية ماتبقاش فاضية طول التجربة، فالافتراضي = نفس
     تسعيرة لاجلك. بس `assumed` بيفضل مرفوع لحد ما Cervo تبعت تسعيرتها. */
  const r = cervoCostFor(9, {});
  assert.equal(r.cost, 19.55);
  assert.equal(r.known, false);
  assert.equal(r.assumed, true);
  /* فوق ١٠ كم: ٢٫٣٠/كم زي لاجلك */
  assert.equal(cervoCostFor(12, {}).cost, 24.15);
});
t("مفيش سعر أساسي خالص ⇒ null — صفر كان هيوري ربح مش موجود", () => {
  const r = cervoCostFor(11, { cervoContract: { baseFee: null } });
  assert.equal(r.cost, null);
  assert.equal(r.known, false);
  assert.equal(r.assumed, false);
});
t("تسعيرة مؤكدة ⇒ assumed=false والشحنة بتخرج من «من غير تكلفة مؤكدة»", () => {
  const r = cervoCostFor(9, { cervoContract: { known: true, baseFee: 18, includedKm: 10 } });
  assert.equal(r.known, true);
  assert.equal(r.assumed, false);
});
t("لما عمر يكتب الأسعار بتتحسب", () => {
  const cfg = { cervoContract: { known: true, baseFee: 25, includedKm: 10, perKm: 3, vatIncluded: true } };
  assert.equal(cervoCostFor(10, cfg).cost, 25);
  assert.equal(cervoCostFor(12, cfg).cost, 31);
  assert.equal(cervoCostFor(12, cfg).known, true);
});
t("أسعار من غير ضريبة بتتضاف عليها", () => {
  const cfg = { cervoContract: { known: true, baseFee: 20, includedKm: 10, perKm: 0, vatIncluded: false, vatPct: 15 } };
  assert.equal(cervoCostFor(9, cfg).cost, 23);
});
t("known:true من غير سعر أساسي = لسه مش معروف", () => {
  assert.equal(cervoContract({ cervoContract: { known: true, baseFee: null } }).known, false);
  assert.equal(cervoCostFor(5, { cervoContract: { known: true, baseFee: null } }).cost, null);
});
t("حد أدنى للأجرة بيتحسب", () => {
  const cfg = { cervoContract: { known: true, baseFee: 10, includedKm: 10, perKm: 1, minFare: 22 } };
  assert.equal(cervoCostFor(5, cfg).cost, 22);
});

/* ═══ التوجيه بالمسافة ═══ */
t("الافتراضي مقفول — توكن التجارب ما يوصلش لطلب حقيقي لوحده", () => {
  assert.equal(routeCourier(11, {}).enabled, false);
  assert.equal(routeCourier(11, {}).provider, null);
  assert.equal(courierRoutingCfg({}).enabled, false);
});
const ON = { delivery: { courierRouting: { enabled: true } } };
t("شرايح عمر: ≤١٠ لاجلك، ١٠-١٢ Cervo، فوق كده طلباتك", () => {
  assert.equal(routeCourier(3, ON).provider, "leajlak");
  assert.equal(routeCourier(10, ON).provider, "leajlak");
  assert.equal(routeCourier(10.1, ON).provider, "cervo");
  assert.equal(routeCourier(12, ON).provider, "cervo");
  assert.equal(routeCourier(12.1, ON).provider, "district");
  assert.equal(routeCourier(40, ON).provider, "district");
});
t("مسافة مش معروفة = مفيش توجيه (المزوّد الفعّال)", () => {
  assert.equal(routeCourier(null, ON).provider, null);
  assert.equal(routeCourier(0, ON).provider, null);
  assert.equal(routeCourier("خربان", ON).provider, null);
});
t("شرايح من اللوحة بترتيب مقلوب بتتظبّط", () => {
  const cfg = { delivery: { courierRouting: { enabled: true, rules: [
    { upToKm: null, provider: "district" }, { upToKm: 15, provider: "cervo" }, { upToKm: 5, provider: "leajlak" },
  ] } } };
  assert.equal(routeCourier(4, cfg).provider, "leajlak");
  assert.equal(routeCourier(9, cfg).provider, "cervo");
  assert.equal(routeCourier(20, cfg).provider, "district");
});
t("اسم مزوّد مخترع بيتشال مش بيتحوّل لحاجة", () => {
  const cfg = { delivery: { courierRouting: { enabled: true, rules: [
    { upToKm: 10, provider: "uber" }, { upToKm: null, provider: "leajlak" },
  ] } } };
  assert.equal(routeCourier(5, cfg).provider, "leajlak");
});
t("قواعد فاضية بترجع للافتراضي بدل ما الطلب يقع", () => {
  const cfg = { delivery: { courierRouting: { enabled: true, rules: [] } } };
  assert.equal(routeCourier(5, cfg).provider, "leajlak");
});

/* ═══ المزوّد في السجل ═══ */
t("Cervo مسجّلة كمزوّد بـAPI", () => {
  assert.ok(PROVIDERS.cervo);
  assert.equal(PROVIDERS.cervo.id, "cervo");
  assert.ok(API_PROVIDER_IDS.includes("cervo"));
  assert.equal(PROVIDERS.cervo.idempotentCreate, true);
});
t("من غير توكن بتقول ناقص إيه بالظبط", () => {
  const saved = process.env.CERVO_TOKEN;
  delete process.env.CERVO_TOKEN;
  assert.equal(PROVIDERS.cervo.configured(), false);
  assert.deepEqual(PROVIDERS.cervo.missing(), ["CERVO_TOKEN"]);
  if (saved) process.env.CERVO_TOKEN = saved;
});
t("لاجلك و Flying Arrow ما اتغيّروش", () => {
  assert.ok(API_PROVIDER_IDS.includes("leajlak"));
  assert.ok(API_PROVIDER_IDS.includes("flyingarrow"));
  assert.equal(PROVIDERS.leajlak.idempotentCreate, undefined);
});
t("الاسترجاع من غير صفّ الطلب بيقول unsupported مش بيخمّن", async () => {
  const r = await PROVIDERS.cervo.lookup("W1789825687099", {});
  assert.equal(r.found, false);
  assert.equal(r.unsupported, true);
});

/* ═══ حدود حقولهم — من ٤٠٠ حقيقي (٢٢/٩) ═══ */
t("اسم العميل بيتقصّ على ٥٠ حرف (٤٠٠ منهم: maximum length of 50)", () => {
  const p = cervoPayload({ ...ORDER, customer: { name: "أ".repeat(120), phone: "0544775082" } }, CFG);
  assert.equal(p.customer.length, 50);
  assert.ok(CERVO_LIMITS.customer === 50);
});
t("اسم فاضي بياخد «العميل» مش نص فاضي", () => {
  assert.equal(cervoPayload({ ...ORDER, customer: { name: "   ", phone: "0544775082" } }, CFG).customer, "العميل");
});
t("العنوان الطويل بيتقصّ من غير ما يرمي", () => {
  const o = { ...ORDER, address: { ...ORDER.address, street: "ش".repeat(400) } };
  assert.ok(cervoPayload(o, CFG).address.length <= CERVO_LIMITS.address);
});
t("اسم المحل وعنوانه بيتقصّوا كمان", () => {
  const p = cervoPayload(ORDER, { ...CFG, cervoStoreName: "م".repeat(200), cervoStoreAddress: "ع".repeat(400) });
  assert.ok(p.storeName.length <= CERVO_LIMITS.storeName);
  assert.ok(p.storeAddress.length <= CERVO_LIMITS.storeAddress);
});
t("رد GET بـcamelCase (الشكل الحقيقي) بيتقرا زي PascalCase", () => {
  const a = normalizeCervoOrder({ id: "u", db_id: 1, driverName: "سعد", driverMobile: "05", status: 3,
    orderStatus: [{ Status: 20, Date: "2026-09-22 10:00" }], tracking: "https://t/x" });
  assert.equal(a.status, "picked");
  assert.equal(a.driver.name, "سعد");
  assert.equal(a.history[0].status, "assigned");
  const b = normalizeCervoOrder({ id: "u", DriverName: "سعد", Status: 3, OrderStatus: [] });
  assert.equal(b.status, "picked");
  assert.equal(b.driver.name, "سعد");
});

/* ═══ السرّ: «ناقص» ≠ «غلط» — من ويبهوك حقيقي اترفض ٤٠١ (٢٢/٩) ═══ */
t("من غير سرّ متسجّل عندنا: absent", () => {
  const sv = process.env.CERVO_WEBHOOK_SECRET; delete process.env.CERVO_WEBHOOK_SECRET;
  assert.equal(PROVIDERS.cervo.verifyWebhook({}, {}), "absent");
  if (sv) process.env.CERVO_WEBHOOK_SECRET = sv;
});
t("سرّ متسجّل + رسالة زيهم (مفيش أي سرّ في الهيدرز) ← absent مش fail", () => {
  const sv = process.env.CERVO_WEBHOOK_SECRET; process.env.CERVO_WEBHOOK_SECRET = "abc";
  /* دي الهيدرز الحقيقية اللي بعتوها — مفيش فيها سرّ، وفيها delivery-company */
  const real = { accept: "*/*", "content-type": "application/json", "delivery-company": "cervo" };
  assert.equal(PROVIDERS.cervo.verifyWebhook(real, { order_id: "u", order_status: 2 }), "absent");
  if (sv === undefined) delete process.env.CERVO_WEBHOOK_SECRET; else process.env.CERVO_WEBHOOK_SECRET = sv;
});
t("سرّ اتبعت وغلط ← fail", () => {
  const sv = process.env.CERVO_WEBHOOK_SECRET; process.env.CERVO_WEBHOOK_SECRET = "abc";
  assert.equal(PROVIDERS.cervo.verifyWebhook({ "x-cervo-signature": "nope" }, {}), "fail");
  assert.equal(PROVIDERS.cervo.verifyWebhook({ "x-cervo-signature": "abc" }, {}), "pass");
  assert.equal(PROVIDERS.cervo.verifyWebhook({}, { secret: "abc" }), "pass");
  assert.equal(PROVIDERS.cervo.verifyWebhook({ authorization: "Bearer abc" }, {}), "pass");
  if (sv === undefined) delete process.env.CERVO_WEBHOOK_SECRET; else process.env.CERVO_WEBHOOK_SECRET = sv;
});

/* ═══ الجسم الحقيقي اللي بعتوه (٢٢/٩) ═══ */
const REAL_BODY = {
  cancel: null, member: null, order_id: "ec186b35-62be-41bf-9540-b14185611130",
  store_id: 3017, tracking: "https://dashboard.cervodelivery.com/tracking/ec186b35-62be-41bf-9540-b14185611130",
  driver_name: "Fot testing", partner_ref: "1790072314698", order_status: 2,
  driver_mobile: "0599000111", isRiderChange: false,
};
t("جسمهم الحقيقي بيتقرا كامل", () => {
  const e = parseCervoWebhook(REAL_BODY);
  assert.equal(e.ref, "ec186b35-62be-41bf-9540-b14185611130");
  assert.equal(e.status, "assigned");
  assert.equal(e.statusCode, 2);
  assert.equal(e.driver.name, "Fot testing");
  assert.equal(e.storeId, "3017");
  assert.equal(e.riderChanged, false);
  /* partner_ref رقمي — مش رقم طلبنا النصّي */
  assert.equal(e.orderNo, null);
  assert.equal(e.numericRef, "1790072314698");
});
t("الرقم المجرّد بيطابق رقم طلبنا لما نشيل الحروف", () => {
  const e = parseCervoWebhook(REAL_BODY);
  assert.equal("W1790072314698".replace(/\D/g, ""), e.numericRef);
});
t("isRiderChange بيتقرا لما يبقى true", () => {
  assert.equal(parseCervoWebhook({ ...REAL_BODY, isRiderChange: true }).riderChanged, true);
});
