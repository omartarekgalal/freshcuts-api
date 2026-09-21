/* اختبارات طبقة المزوّدين — بتشتغل من غير شبكة ولا قاعدة بيانات.
   الهدف: نتأكد إن نفس الطلب بيتحول لشكلين صحيحين حسب الشركة، وإن حالات
   الشركتين بتترجم لنفس المصطلحات الموحّدة. */
import assert from "node:assert";
import { PROVIDERS, activeProvider, e164, msisdn, readableAddress, courierMilestone, PROVIDER_REPORTS_ARRIVAL, isDuplicateMsg, pickLjOrder } from "./couriers.js";

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n     ", e.message); }
};

const ORDER = {
  order_no: "W1756000000",
  total: 128.5,
  notes: "استلام 8:30",
  customer: { name: "محمد", phone: "0546715683" },
  address: { latitude: 21.633056, longitude: 39.1521236, street: "شارع صاري", building: "12", area: "السلامة" },
};
const CFG = {
  storeLat: 21.5881404, storeLng: 39.1521236,
  webhookUrl: "https://freshcuts-api.o2m8.me/api/delivery/courier-webhook",
  pickupContactPhone: "0546715683", faCityId: 20, faVehicleId: 3, faPaymentMethod: "wallet",
  ljShopId: "821015895",
};

/* بنستبدل call بمجسّ عشان نشوف الجسم من غير ما نبعت حاجة لحد */
function capture(provider, reply) {
  const seen = {};
  const orig = provider.call;
  provider.call = async (path, opts = {}) => { seen.path = path; seen.opts = opts; return reply; };
  return { seen, restore: () => { provider.call = orig; } };
}

console.log("\nأرقام الهاتف:");
t("e164 للسعودي", () => assert.equal(e164("0546715683"), "+966546715683"));
t("msisdn من غير +", () => assert.equal(msisdn("0546715683"), "966546715683"));
t("e164 بيقبل صيغة 966 مسبقاً", () => assert.equal(e164("966546715683"), "+966546715683"));

console.log("\nالعنوان المقروء:");
t("بيرتب الشارع والمبنى والحي", () => {
  const a = readableAddress(ORDER.address);
  assert.ok(a.includes("شارع صاري") && a.includes("مبنى 12") && a.includes("حي السلامة"), a);
});
t("عنوان فاضي بيوجّه السائق للإحداثيات", () =>
  assert.ok(readableAddress({}).includes("الإحداثيات")));
t("نصوص الـplaceholder ما توصلش السائق", () => {
  const a = readableAddress({ area: "الزهراء", street: "شارع حلمى كتبى",
    building: "المبتى والدور", floor: "🏠 بيت", landmark: "علامة مميزة" });
  assert.ok(!a.includes("المبتى"), a);
  assert.ok(!a.includes("علامة مميزة"), a);
  assert.ok(!/\p{Extended_Pictographic}/u.test(a), "فيه إيموجي: " + a);
  assert.ok(a.includes("حي الزهراء") && a.includes("شارع حلمى كتبى"), a);
});

console.log("\nFlying Arrow — شكل الطلب:");
{
  const fa = PROVIDERS.flyingarrow;
  const { seen, restore } = capture(fa, {
    data: { order: { id: 8, order_number: "ORD-1", status: { value: "confirmed" }, pricing: { total: 25.51 } } },
    dispatch_result: { status: "dispatched", driver_id: 15 },
  });
  const res = await fa.dispatch(ORDER, CFG);
  restore();
  const b = seen.opts.body;
  t("بيروح على /orders", () => assert.equal(seen.path, "/orders"));
  t("الإحداثيات بـ lat/lng مش latitude/longitude", () => {
    const drop = b.locations.find((l) => l.type === "dropoff");
    assert.ok("lat" in drop && "lng" in drop, "المفاتيح: " + Object.keys(drop).join(","));
    assert.ok(!("latitude" in drop));
  });
  t("مفيش حقول مش في مواصفتهم", () => {
    for (const l of b.locations) {
      assert.ok(!("sequence" in l), "sequence اتبعتت");
    }
    assert.ok(!("quantity" in b), "quantity اتبعتت");
  });
  t("جدة ٢٠ والدباب ٣", () => {
    assert.equal(b.city_id, 20); assert.equal(b.service_vehicle_id, 3);
  });
  t("الدفع محفظة (العميل دفع مسبقاً)", () => assert.equal(b.payment_method, "wallet"));
  t("الأرقام E.164", () => assert.equal(b.locations[1].contact_phone, "+966546715683"));
  t("بيقرا الرقم من data.order.id", () => assert.equal(res.ref, "8"));
  t("بيقرا التكلفة من pricing.total", () => assert.equal(res.cost, 25.51));
}

console.log("\nLeajlak — شكل الطلب:");
{
  const lj = PROVIDERS.leajlak;
  const { seen, restore } = capture(lj, { dsp_order_id: 400069217, status: "New Order" });
  const res = await lj.dispatch(ORDER, CFG);
  restore();
  const b = seen.opts.body;
  t("بيروح على /orders", () => assert.equal(seen.path, "/orders"));
  t("رقم طلبنا في id", () => assert.equal(b.id, "W1756000000"));
  t("المحل بـ shop_id مش إحداثيات استلام", () => {
    assert.equal(b.shop_id, "821015895");
    assert.ok(!("locations" in b), "بعت locations وهي مش في مواصفتهم");
  });
  t("الإحداثيات جوّه coordinate", () => {
    assert.equal(b.delivery_details.coordinate.latitude, 21.633056);
    assert.equal(b.delivery_details.coordinate.longitude, 39.1521236);
  });
  t("payment_type = 0 (مدفوع مسبقاً)", () => assert.equal(b.order.payment_type, 0));
  t("الإجمالي بيتبعت", () => assert.equal(b.order.total, 128.5));
  t("الرقم من غير +", () => assert.equal(b.delivery_details.phone, "966546715683"));
  t("المرجع = رقمهم (dsp_order_id) مش رقمنا", () => assert.equal(res.ref, "400069217"));
  t("بيمسك رقمهم كمان", () => assert.equal(res.orderNumber, "400069217"));
  t("«New Order» → pending", () => assert.equal(res.status, "pending"));
}

console.log("\nتوحيد الحالات — الشركتان بتتكلما نفس اللغة:");
t("FA: order.driver_assigned → assigned", () => {
  const e = PROVIDERS.flyingarrow.parseWebhook({ external_order_id: "W1", event: "order.driver_assigned" });
  assert.equal(e.status, "assigned"); assert.equal(e.orderNo, "W1");
});
t("LJ: «Order Accept» → assigned", () => {
  const e = PROVIDERS.leajlak.parseWebhook({ id: "W1", status: "Order Accept" });
  assert.equal(e.status, "assigned"); assert.equal(e.orderNo, "W1");
});
t("FA: pickup_completed و LJ: Order Picked → picked", () => {
  assert.equal(PROVIDERS.flyingarrow.parseWebhook({ external_order_id: "W1", event: "order.pickup_completed" }).status, "picked");
  assert.equal(PROVIDERS.leajlak.parseWebhook({ id: "W1", status: "Order Picked" }).status, "picked");
});
t("الاتنين: delivered → delivered", () => {
  assert.equal(PROVIDERS.flyingarrow.parseWebhook({ external_order_id: "W1", event: "order.delivered" }).status, "delivered");
  assert.equal(PROVIDERS.leajlak.parseWebhook({ id: "W1", status: "Delivered" }).status, "delivered");
});
t("FA بيقرا الكابتن من data.order.driver", () => {
  const e = PROVIDERS.flyingarrow.parseWebhook({
    external_order_id: "W1", event: "order.delivered",
    data: { order: { driver: { name: "أحمد" }, total_amount: 25.51 } },
  });
  assert.equal(e.driver.name, "أحمد"); assert.equal(e.cost, 25.51);
});
t("رسالة مش مفهومة بترجع null (ما تلوّثش شحنة)", () => {
  assert.equal(PROVIDERS.flyingarrow.parseWebhook({ hello: "world" }), null);
  assert.equal(PROVIDERS.leajlak.parseWebhook({ hello: "world" }), null);
});

console.log("\nاختيار المزوّد:");
t("الافتراضي Flying Arrow", () => assert.equal(activeProvider({}).id, "flyingarrow"));
t("الإعدادات بتبدّل", () => assert.equal(activeProvider({ delivery: { provider: "leajlak" } }).id, "leajlak"));
t("اسم غلط ما يكسرش الدنيا", () => assert.equal(activeProvider({ delivery: { provider: "nope" } }).id, "flyingarrow"));

console.log("\nمحطّات المندوب:");
/* ═══ محطّات المندوب (١٧ سبتمبر — أداء شركة التوصيل) ══════════════════════ */

t("courierMilestone: لاجلك بتقول «وصل المطعم» و«استلم» بكل الصيغ", () => {
  const lj = (x) => courierMilestone("leajlak", x);
  assert.equal(lj("Reached Shop"), "arrived");
  assert.equal(lj("reached_shop"), "arrived");
  assert.equal(lj("ARRIVED AT SHOP"), "arrived");
  assert.equal(lj("Order Picked"), "picked");
  assert.equal(lj("Shipped"), "picked");
  assert.equal(lj("Reached Customer"), "picked");
  assert.equal(lj("Order Accept"), null);
  assert.equal(lj("Start Ride"), null, "اتحرّك ≠ وصل");
  assert.equal(lj("New Order"), null);
  assert.equal(lj("Delivered"), null, "التوصيل محطة تانية، مش وصول للمطعم");
  assert.equal(lj(""), null);
  assert.equal(courierMilestone("unknown_provider", "Reached Shop"), null);
});

t("Flying Arrow: مافيش إشارة «وصل المطعم» موثّقة، والاستلام موجود", () => {
  assert.equal(PROVIDER_REPORTS_ARRIVAL.leajlak, true);
  assert.equal(PROVIDER_REPORTS_ARRIVAL.flyingarrow, false);
  assert.equal(PROVIDER_REPORTS_ARRIVAL.manual, false);
  assert.equal(courierMilestone("flyingarrow", "pickup_completed"), "picked");
  assert.equal(courierMilestone("flyingarrow", "driver_assigned"), null);
});

/* ═══ «الطلب موجود عندهم بالفعل» (٢١ سبتمبر) ════════════════════════════
   طلب حقيقي (W1790011118692) خلّى المدير يعيد ٣ مرات على نفس الرد، والسبب
   إن محاولة سابقة وصلتهم وإحنا ضيّعنا المرجع. فالرد ده لازم يتفرز كنوع
   لوحده عشان الطبقة اللي فوق تسترجع بدل ما تعيد. */
console.log("\nالتكرار عند لاجلك:");
t("رسالتهم الحرفية بتتعرف كتكرار", () => {
  assert.equal(isDuplicateMsg("With this W1790011118692 client order id an order is already exist in our system"), true);
  assert.equal(isDuplicateMsg("Order created"), false);
  assert.equal(isDuplicateMsg(""), false);
});

t("pickLjOrder بيلاقي الصف اللي id بتاعه = رقم طلبنا", () => {
  const listed = { data: [{ id: "W1", dsp_order_id: "uuid-1", status: "Order Accept" },
                          { id: "W2", dsp_order_id: "uuid-2" }] };
  assert.equal(pickLjOrder(listed, "W2").dsp_order_id, "uuid-2");
  assert.equal(pickLjOrder(listed, "W9"), null);
  assert.equal(pickLjOrder({ id: "W3", dsp_order_id: "u3" }, "W3").dsp_order_id, "u3");
  assert.equal(pickLjOrder({ id: "W3" }, "W3"), null, "من غير مرجعهم مفيش استرجاع");
});

{
  const lj = PROVIDERS.leajlak;
  const orig = lj.call;

  lj.call = async () => {
    throw Object.assign(new Error("Leajlak /orders: With this W1 client order id an order is already exist in our system"),
      { code: "COURIER_ERROR", status: 400, resp: { message: "With this W1 client order id an order is already exist in our system" } });
  };
  let code = null, msg = null;
  try { await lj.dispatch({ ...ORDER, order_no: "W1" }, CFG); } catch (e) { code = e.code; msg = e.providerMessage; }
  t("رد التكرار بيرمي COURIER_DUPLICATE مش COURIER_ERROR", () => {
    assert.equal(code, "COURIER_DUPLICATE");
    assert.ok(/already exist/.test(msg || ""));
  });

  lj.call = async () => { throw Object.assign(new Error("Leajlak /orders: boom"), { code: "COURIER_ERROR", status: 500, resp: { message: "boom" } }); };
  let code2 = null;
  try { await lj.dispatch({ ...ORDER, order_no: "W2" }, CFG); } catch (e) { code2 = e.code; }
  t("خطأ عادي مايتحوّلش لتكرار", () => assert.equal(code2, "COURIER_ERROR"));

  lj.call = async () => { throw Object.assign(new Error("no"), { status: 404, resp: { message: "There is no order with this order id" } }); };
  const miss = await lj.lookup("W1790011118692", CFG);
  t("الاسترجاع بيرجّع كل اللي اتجرّب لما مفيش طريق", () => {
    assert.equal(miss.found, false);
    assert.ok(miss.tried.length >= 6, `جرّب ${miss.tried.length} مسار بس`);
    assert.ok(miss.tried.every((x) => x.status === 404));
  });

  lj.call = async (path) => {
    if (path === "/orders") return { data: [{ id: "W1790011118692", dsp_order_id: "abc-uuid", status: "Order Accept" }] };
    throw Object.assign(new Error("no"), { status: 404, resp: { message: "nope" } });
  };
  const hit = await lj.lookup("W1790011118692", CFG);
  t("الاسترجاع بيتبنّى الـuuid بتاعهم", () => {
    assert.equal(hit.found, true);
    assert.equal(hit.ref, "abc-uuid");
    assert.equal(hit.status, "assigned");
  });

  const fa = await PROVIDERS.flyingarrow.lookup("W1", {});
  t("Flying Arrow بتقول صراحة إن مفيش بحث برقمنا", () => assert.equal(fa.unsupported, true));
  lj.call = orig;
}

console.log(`\n${pass} نجحت، ${fail} فشلت\n`);
process.exit(fail ? 1 : 0);
