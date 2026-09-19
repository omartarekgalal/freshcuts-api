/* عمر ١٩/٩: (١) لاجلك العنوان = النقطة بس، (٢) الاسم الثنائي إجباري،
   (٣) «ملاحظات التوصيل» بتاعة العنوان ≠ «ملاحظات الأكل» بتاعة الطلب.
   node --test notes-split.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { leajlakPayload, leajlakNotes, courierNotes, mapPoint, notesSplit, PROVIDERS } from "./couriers.js";
import { posNotesOf, orderAddress } from "./shop.js";
import { toPortalOrder } from "./portal-core.js";
import { cleanAddress, addAddress, recordUsedAddress } from "./accounts.js";
import { checkPersonName } from "./person-name.js";

const JED = { latitude: 21.58814, longitude: 39.15212 };
const ADDR = { ...JED, area: "السلامة", street: "صاري", building: "12", floor: "3", apartment: "7",
  landmark: "جنب النهدي", leave_at_door: true, city: "جدة", delivery_notes: "اتصل قبل ما توصل، البوابة الشرقية" };
const ROW = {
  order_no: "W9", option: "delivery", created_at: "2026-09-19T17:00:00Z", delivery_fee: 9, total: 120,
  notes: "بدون بصل، الصوص على جنب", address: ADDR, customer: { name: "محمد الغامدي", phone: "0551234567" },
};

test("النقطة: lat,lng بـ٦ خانات، أو رابط جوجل لو اتطلب، وفاضي من غير إحداثيات", () => {
  assert.equal(mapPoint(JED), "21.588140,39.152120");
  assert.equal(mapPoint(JED, "link"), "https://maps.google.com/?q=21.588140,39.152120");
  assert.equal(mapPoint({}), "");
  assert.equal(mapPoint({ latitude: 0, longitude: 0 }), "");
});

test("لاجلك: address = النقطة بس، notes = العنوان كامل + ملاحظات التوصيل ومفيش أكل", () => {
  const p = leajlakPayload(ROW, "15882");
  assert.equal(p.delivery_details.address, "21.588140,39.152120");
  assert.deepEqual(p.delivery_details.coordinate, { latitude: 21.58814, longitude: 39.15212 });
  assert.equal(p.order.notes,
    "اترك الطلب عند الباب — العنوان: حي السلامة، صاري، مبنى 12، الدور 3، شقة 7، جنب النهدي — ملاحظات التوصيل: اتصل قبل ما توصل، البوابة الشرقية");
  assert.ok(!p.order.notes.includes("بصل"), "ملاحظات الأكل مابتوصلش المندوب");
  assert.equal(leajlakPayload(ROW, "1", { addressFormat: "link" }).delivery_details.address,
    "https://maps.google.com/?q=21.588140,39.152120");
  // ملاحظات توصيل فاضية بعد الفصل ⇒ مفيش «ملاحظة العميل» حتى لو فيه ملاحظة أكل
  const noDn = leajlakNotes({ ...ROW, address: { ...ADDR, delivery_notes: "", leave_at_door: false } });
  assert.equal(noDn, "العنوان: حي السلامة، صاري، مبنى 12، الدور 3، شقة 7، جنب النهدي");
});

test("dispatch لاجلك بيقرا ljAddressFormat من الإعدادات", async () => {
  const lj = PROVIDERS.leajlak;
  const orig = lj.call;
  let body = null;
  lj.call = async (path, opts) => { body = opts.body; return { data: {} }; };
  try { await lj.dispatch(ROW, { ljShopId: "1", ljAddressFormat: "link" }); } catch { /* الشكل بس */ } finally { lj.call = orig; }
  assert.equal(body.delivery_details.address, "https://maps.google.com/?q=21.588140,39.152120");
});

test("Flying Arrow: ملاحظات التوصيل بس — الأكل لأ", () => {
  assert.equal(courierNotes(ROW), "اترك الطلب عند الباب — اتصل قبل ما توصل، البوابة الشرقية");
  // طلب قديم (العنوان مافيهوش delivery_notes خالص) = زي الأول
  const { delivery_notes, ...old } = ADDR;
  assert.equal(notesSplit({ address: old }), false);
  assert.equal(courierNotes({ ...ROW, address: old }), "اترك الطلب عند الباب — بدون بصل، الصوص على جنب");
});

test("نقطة البيع: ملاحظات الأكل بس (📝) — ملاحظات التوصيل مش فيها", () => {
  const n = posNotesOf(ROW, { withFee: true });
  assert.equal(n, "توصيل - اتركه عند الباب🚪 - طُلب 20:00 - توصيل 9ر - مدفوع أونلاين✅ - 📝 بدون بصل، الصوص على جنب");
  assert.ok(!n.includes("البوابة الشرقية"));
});

test("orderAddress: بينضّف ملاحظات التوصيل، وبيشيلها من الاستلام، والقديم زي ما هو", () => {
  assert.equal(orderAddress({ ...JED, delivery_notes: "  <b>اتصل</b>   قبل  " }).delivery_notes, "bاتصل/b قبل");
  assert.equal(orderAddress({ ...JED, delivery_notes: "x".repeat(400) }).delivery_notes.length, 150);
  assert.equal("delivery_notes" in orderAddress({ ...JED, delivery_notes: "x" }, "pickup"), false);
  assert.equal("delivery_notes" in orderAddress({ ...JED }), false, "متجر قديم ⇒ طلب قديم");
  assert.equal(orderAddress({ ...JED, delivery_notes: null }).delivery_notes, "");
  assert.equal(orderAddress(null), null);
});

test("البوابة: deliveryNotes في قسم التوصيل، وnotes = الأكل", () => {
  const o = toPortalOrder({ ...ROW, status: "pos_created", items: [], history: [] });
  assert.equal(o.address.deliveryNotes, "اتصل قبل ما توصل، البوابة الشرقية");
  assert.equal(o.notes, "بدون بصل، الصوص على جنب");
  const { delivery_notes, ...old } = ADDR;
  assert.equal(toPortalOrder({ ...ROW, address: old, status: "pos_created", items: [], history: [] }).address.deliveryNotes, null);
});

test("دفتر العناوين: delivery_notes بتتحفظ وتتعدّل، والقديم (notes) مابيضيعش", () => {
  const a = cleanAddress({ ...ADDR });
  assert.equal(a.delivery_notes, "اتصل قبل ما توصل، البوابة الشرقية");
  const legacy = cleanAddress({ ...JED, notes: "عمارة ٢١١ الدور التالت شقه ١٨" });
  assert.equal(legacy.notes, "عمارة ٢١١ الدور التالت شقه ١٨");
  assert.equal(legacy.delivery_notes, "");
  // تعديل من غير المفتاح مابيمسحهاش
  assert.equal(cleanAddress({ label: "البيت" }, a).delivery_notes, a.delivery_notes);
  // طلب اتدفع على نفس المكان بملاحظة جديدة ⇒ تتحدّث على العنوان المحفوظ
  const list = addAddress([], { ...ADDR }).list;
  const next = recordUsedAddress(list, { ...JED, delivery_notes: "البوابة الغربية" });
  assert.equal(next[0].delivery_notes, "البوابة الغربية");
  const same = recordUsedAddress(addAddress([], { ...ADDR }).list, { ...JED });
  assert.equal(same[0].delivery_notes, ADDR.delivery_notes, "طلب من غير المفتاح مايمسحش");
});

test("الاسم الثنائي: كلمتين حروف عربي/إنجليزي، طول معقول", () => {
  for (const ok of ["محمد الغامدي", "Mohammed Alghamdi", "عبدالرحمن بن سعيد", "Sara Al-Qahtani", "  نورة   العتيبي  ", "Ali Hassan"]) {
    assert.equal(checkPersonName(ok).ok, true, ok);
  }
  assert.equal(checkPersonName("  نورة   العتيبي ").name, "نورة العتيبي");
  const bad = {
    "": "name_required", "محمد": "name_two_words", "عميل": "name_two_words", "Omar": "name_two_words",
    "م ع": "name_two_words", "محمد 123": "name_letters", "محمد ٥٥": "name_letters", "a@b c": "name_letters",
    "محمد 🙂": "name_letters",
  };
  bad["ا".repeat(25) + " " + "ب".repeat(20)] = "name_too_long";
  for (const [v, err] of Object.entries(bad)) assert.equal(checkPersonName(v).error, err, v);
  assert.equal(checkPersonName(null).ok, false);
});
