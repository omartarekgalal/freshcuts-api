/* الدور والشقة كخانتين + «اترك الطلب عند الباب» — عمر 18 سبتمبر 2026.
   بنتأكد إن الاختيار بيوصل المندوب (العنوان + الملاحظات) والكاشير/المطبخ
   (ملاحظات نقطة البيع + سطر العنوان) والبوابة، وإن العناوين/الطلبات القديمة
   بتفضل شغالة.  node --test address-door.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, readableAddress, courierNotes, floorAptText, leaveAtDoor } from "./couriers.js";
import { posNotesOf, posAddressLine } from "./shop.js";
import { toPortalOrder } from "./portal-core.js";
import { cleanAddress, addAddress, updateAddress } from "./accounts.js";

const JED = { latitude: 21.5881, longitude: 39.1521 };
const NEW_ADDR = { ...JED, area: "السلامة", street: "صاري", building: "12", floor: "3", apartment: "7",
  landmark: "جنب النهدي", leave_at_door: true, city: "جدة" };
const ROW = {
  order_no: "W1", option: "delivery", created_at: "2026-09-18T10:00:00Z", delivery_fee: 9,
  notes: "بدون بصل", address: NEW_ADDR, customer: { name: "محمد", phone: "0512345678" }, total: 99,
};

test("عنوان المندوب: الدور والشقة منفصلين + اترك الطلب عند الباب قبل الإحداثيات", () => {
  const a = readableAddress(NEW_ADDR, { withPin: true });
  assert.equal(a, "حي السلامة، صاري، مبنى 12، الدور 3، شقة 7، جنب النهدي، اترك الطلب عند الباب — 21.588100,39.152100");
});

test("الدور/الشقة: القديم في خانة واحدة يتكتب زي ما هو، ونوع المكان مايوصلش", () => {
  assert.equal(floorAptText({ floor: "الدور ٣ شقة ٧" }), "الدور ٣ شقة ٧");
  assert.equal(floorAptText({ floor: "3" }), "الدور/الشقة 3", "قديم من غير خانة شقة");
  assert.equal(floorAptText({ floor: "3", apartment: "" }), "الدور 3");
  assert.equal(floorAptText({ floor: "أرضي", apartment: "شقة ٢" }), "أرضي، شقة ٢");
  assert.equal(floorAptText({ floor: "🏠 بيت" }), "");
  assert.equal(floorAptText({ floor: "🏢 مكتب" }), "");
  assert.equal(floorAptText({}), "");
});

test("leave_at_door: true/1/\"true\" بس — أي حاجة تانية لا", () => {
  for (const v of [true, 1, "1", "true"]) assert.equal(leaveAtDoor({ leave_at_door: v }), true);
  for (const v of [false, 0, "0", "", undefined, null, "yes"]) assert.equal(leaveAtDoor({ leave_at_door: v }), false);
  assert.equal(leaveAtDoor(null), false);
});

test("ملاحظات المندوب: الباب أولاً، وطلب قديم زي ما هو", () => {
  assert.equal(courierNotes(ROW), "اترك الطلب عند الباب — بدون بصل");
  assert.equal(courierNotes({ ...ROW, notes: "" }), "اترك الطلب عند الباب");
  assert.equal(courierNotes({ notes: "بدون بصل", address: { ...JED } }), "بدون بصل");
  assert.match(courierNotes({ address: {} }), /مدفوع مسبقاً/);
  assert.ok(courierNotes({ ...ROW, notes: "x".repeat(400) }).length <= 200);
});

test("لاجلك: الباب في العنوان والملاحظات", async () => {
  const lj = PROVIDERS.leajlak;
  const orig = lj.call;
  let body = null;
  lj.call = async (path, opts) => { body = opts.body; return { data: { dsp_order_id: "u1" } }; };
  try { await lj.dispatch(ROW, { ljShopId: "1" }); } catch { /* الشكل هو اللي يهمنا */ } finally { lj.call = orig; }
  assert.ok(body, "مااتبعتش حاجة");
  assert.match(body.delivery_details.address, /الدور 3، شقة 7/);
  assert.match(body.delivery_details.address, /اترك الطلب عند الباب/);
  assert.equal(body.order.notes, "اترك الطلب عند الباب — بدون بصل");
});

test("ملاحظات نقطة البيع: «اتركه عند الباب🚪» جنب «توصيل» ومفيش خصم", () => {
  const n = posNotesOf({ ...ROW, discount_percent: 50 }, { withFee: true });
  assert.equal(n, "توصيل - اتركه عند الباب🚪 - طُلب 13:00 - توصيل 9ر - مدفوع أونلاين✅ - بدون بصل");
  assert.ok(!n.includes("خصم"));
  // من غير الاختيار: نفس شكل النهارده بالظبط
  assert.equal(posNotesOf({ ...ROW, address: { ...JED } }, { withFee: true }),
    "توصيل - طُلب 13:00 - توصيل 9ر - مدفوع أونلاين✅ - بدون بصل");
  // استلام مابيكتبش الباب حتى لو جه في الجسم
  const now = Date.parse("2026-09-18T10:05:00Z");
  assert.equal(posNotesOf({ ...ROW, option: "pickup", delivery_fee: 0, notes: "" }, { now }),
    "استلام - طُلب 13:00 - استلام 13:45 - مدفوع أونلاين✅");
});

test("سطر عنوان نقطة البيع: العنوان كامل من غير إحداثيات", () => {
  assert.equal(posAddressLine(ROW), "حي السلامة، صاري، مبنى 12، الدور 3، شقة 7، جنب النهدي، اترك الطلب عند الباب");
  assert.equal(posAddressLine({ option: "delivery", address: { ...JED } }), "توصيل");
  assert.equal(posAddressLine({ option: "pickup", address: null }), "استلام");
  // طلب من نسخة قديمة (شارع بس)
  assert.equal(posAddressLine({ option: "delivery", address: { ...JED, street: "صاري" } }), "صاري");
});

test("البوابة: الشقة + علامة الباب", () => {
  const o = toPortalOrder({ ...ROW, status: "pos_created", items: [], history: [] });
  assert.equal(o.address.apartment, "7");
  assert.equal(o.address.leaveAtDoor, true);
  const old = toPortalOrder({ ...ROW, address: { ...JED, floor: "2" }, status: "pos_created", items: [], history: [] });
  assert.equal(old.address.apartment, null);
  assert.equal(old.address.leaveAtDoor, false);
});

test("دفتر العناوين: الشقة والباب بيتحفظوا، وتعديل قديم مابيمسحهمش", () => {
  const a = cleanAddress({ ...NEW_ADDR, leave_at_door: "true", apartment: "<7>" });
  assert.equal(a.apartment, "7");
  assert.equal(a.leave_at_door, true);
  const legacy = cleanAddress({ ...JED, floor: "الدور 2 شقة 5" });
  assert.equal(legacy.apartment, "");
  assert.equal(legacy.leave_at_door, false);
  // واجهة قديمة بتبعت label بس → الشقة والباب يفضلوا
  const kept = cleanAddress({ label: "البيت" }, a);
  assert.equal(kept.apartment, "7");
  assert.equal(kept.leave_at_door, true);
  const off = cleanAddress({ leave_at_door: false }, a);
  assert.equal(off.leave_at_door, false);
});

test("دفتر العناوين: نفس المبنى والدور بشقة تانية = عنوان منفصل", () => {
  let r = addAddress([], { label: "المنزل", building: "5", floor: "1", apartment: "2", ...JED });
  r = addAddress(r.list, { label: "بيت الأهل", building: "5", floor: "1", apartment: "4", ...JED });
  assert.equal(r.list.length, 2);
  r = addAddress(r.list, { label: "المنزل", building: "5", floor: "1", apartment: "2", leave_at_door: true, ...JED });
  assert.equal(r.list.length, 2);
  const u = updateAddress(r.list, r.address.id, { leave_at_door: false });
  assert.equal(u.address.leave_at_door, false);
  assert.equal(u.address.apartment, "2");
});
