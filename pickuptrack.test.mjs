/* 📍 PK1 — تتبّع طلبات الاستلام: «جاهز» من الكاشير بس (عمر ١٧/١٠) — node --test pickuptrack.test.mjs
   الحساب صافي (pickuptrack.js) + المسار العام ‎GET /api/shop/track/:orderNo‎ بقاعدة وهمية (مفيش شبكة) + صفوف اللوحة (deliverycontrol.js).
   بيانات وهمية بس. */
import test from "node:test";
import assert from "node:assert/strict";
import { pickupTrackState, pickupLateCfg, pickupAnchorAt, PICKUP_LABELS, PICKUP_TRACK_DEFAULTS, PICKUP_TRACK_LIMITS } from "./pickuptrack.js";
import { FIELD_BY_PATH, validatePatch, effectiveOf, sourceOf, describeFields, GROUPS } from "./deliverycontrol.js";
import { register as registerShop } from "./shop.js";

const NOW = Date.parse("2026-10-17T16:07:00Z");      // ٧:٠٧ م الرياض — ساعة لقطة شاشة المالك
const min = (n) => n * 60_000;
const at = (offMin) => new Date(NOW + min(offMin)).toISOString();
const row = (x = {}) => ({ order_no: "W1792251412023", option: "pickup", status: "accepted", table_no: null,
  created_at: at(-12), accepted_at: at(-10), updated_at: at(-1), pos_ready_at: null, history: [{ status: "paid", at: at(-12) }, { status: "accepted", at: at(-10) }], ...x });
const CFG45 = { lateAfterMin: 45, source: "default" };

test("المهلة: الافتراضي ٤٥ ← القديم pickupReadyMinutes (١٨٠ المؤقتة) ← الجديد pickupLateAfterMin؛ رقم بره المدى بيتجاهل", () => {
  assert.deepEqual(pickupLateCfg({}), { lateAfterMin: 45, source: "default" });
  assert.equal(PICKUP_TRACK_DEFAULTS.lateAfterMin, 45);
  assert.deepEqual(pickupLateCfg({ shop: { pickupReadyMinutes: 180 } }), { lateAfterMin: 180, source: "legacy" }, "القيمة المؤقتة في الإنتاج لسه بتشتغل");
  assert.deepEqual(pickupLateCfg({ shop: { pickupReadyMinutes: "20" } }), { lateAfterMin: 20, source: "legacy" });
  assert.deepEqual(pickupLateCfg({ shop: { pickupLateAfterMin: 60, pickupReadyMinutes: 180 } }), { lateAfterMin: 60, source: "setting" }, "الجديد يغلب القديم");
  assert.deepEqual(pickupLateCfg({ shop: { pickupLateAfterMin: 5 } }), { lateAfterMin: 45, source: "default" }, "تحت الحد الأدنى ⇒ الافتراضي، مش رقم مجنون");
  assert.deepEqual(pickupLateCfg({ shop: { pickupLateAfterMin: "" , pickupReadyMinutes: 999 } }), { lateAfterMin: 45, source: "default" });
  assert.deepEqual(PICKUP_TRACK_LIMITS.lateAfterMin, [10, 240]);
});

test("مقبول وقبل الوعد ⇒ «بنجهّز» خطوة ٢، late:false، promiseAt = القبول + المهلة", () => {
  const s = pickupTrackState({ row: row(), now: NOW, cfg: CFG45 });
  assert.equal(s.step, 2); assert.equal(s.late, false);
  assert.equal(s.label, PICKUP_LABELS.preparing);
  assert.equal(s.promiseAt, at(-10 + 45)); assert.equal(s.promiseText, null); assert.equal(s.promiseBasis, "default");
  assert.equal(s.anchorAt, at(-10)); assert.equal(s.readyAt, null);
  // pos_created (لسه ماتقبلش): نفس الخطوة ٢، والعدّ من وقت الطلب
  const p = pickupTrackState({ row: row({ status: "pos_created", accepted_at: null, history: [] }), now: NOW, cfg: CFG45 });
  assert.equal(p.step, 2); assert.equal(p.anchorAt, at(-12)); assert.equal(p.promiseAt, at(-12 + 45));
});

test("الحادثة: مقبول من ٤٧ دقيقة ومفيش pos_ready_at ⇒ late:true والنص «أطول شوية» — الخطوة ٢ وعمرها ما تبقى ٤", () => {
  const s = pickupTrackState({ row: row({ accepted_at: at(-47) }), now: NOW, cfg: CFG45 });
  assert.equal(s.late, true); assert.equal(s.step, 2, "مفيش ترقية بالوقت لـ«جاهز»");
  assert.equal(s.label, PICKUP_LABELS.late); assert.match(s.label, /أطول شوية/); assert.doesNotMatch(s.label, /جاهز للاستلام/);
  assert.equal(s.promiseAt, at(-47 + 45));
  // المؤقّت القديم (٢٠ د) كان هنا بيقول «جاهز للاستلام 📍» بعد ٢٠ د — بالقيمة القديمة نفسها دلوقتي: late بس
  const old = pickupTrackState({ row: row({ accepted_at: at(-25) }), now: NOW, cfg: pickupLateCfg({ shop: { pickupReadyMinutes: 20 } }) });
  assert.equal(old.step, 2); assert.equal(old.late, true); assert.equal(old.promiseBasis, "legacy");
  // بعد ٣ ساعات برضه ٢
  assert.equal(pickupTrackState({ row: row({ accepted_at: at(-180) }), now: NOW, cfg: CFG45 }).step, 2);
  // لحظة الوعد بالظبط = متأخر (>=)
  assert.equal(pickupTrackState({ row: row({ accepted_at: at(-45) }), now: NOW, cfg: CFG45 }).late, true);
  assert.equal(pickupTrackState({ row: row({ accepted_at: at(-44) }), now: NOW, cfg: CFG45 }).late, false);
});

test("pos_ready_at موجود ⇒ «جاهز للاستلام» خطوة ٤ مهما كان الوقت (دقيقة واحدة أو ٣ ساعات) — late:false", () => {
  for (const acc of [-1, -30, -180]) {
    const s = pickupTrackState({ row: row({ accepted_at: at(acc), pos_ready_at: at(-0.5) }), now: NOW, cfg: CFG45 });
    assert.equal(s.step, 4, `accepted ${acc}`); assert.equal(s.label, PICKUP_LABELS.ready); assert.equal(s.late, false); assert.equal(s.readyAt, at(-0.5));
  }
  // «جاهز» بتيجي من الكاشير حتى في pos_created
  assert.equal(pickupTrackState({ row: row({ status: "pos_created", pos_ready_at: at(-2) }), now: NOW, cfg: CFG45 }).step, 4);
});

test("delivered ⇒ «استلمت طلبك» خطوة ٥؛ ومش استلام / طاولة / حالات تانية ⇒ null (المسار يسيبها لـSTAGES أو tableTrackLabel)", () => {
  const d = pickupTrackState({ row: row({ status: "delivered", pos_ready_at: at(-20), collected_at: at(-3) }), now: NOW, cfg: CFG45 });
  assert.equal(d.step, 5); assert.equal(d.label, PICKUP_LABELS.collected); assert.equal(d.late, false);
  assert.equal(pickupTrackState({ row: row({ option: "delivery" }), now: NOW, cfg: CFG45 }), null);
  assert.equal(pickupTrackState({ row: row({ table_no: 4 }), now: NOW, cfg: CFG45 }), null);
  for (const st of ["paid", "pending_payment", "rejected_refunded", "refund_failed", "expired", "paid_pos_failed"]) {
    assert.equal(pickupTrackState({ row: row({ status: st, accepted_at: at(-100) }), now: NOW, cfg: CFG45 }), null, st);
  }
  assert.equal(pickupTrackState({ row: null, now: NOW }), null);
});

test("الإعداد القديم ١٨٠ (المؤقّت اللي اتحطّ في الإنتاج يوم الحادثة) محترم: ١٠٠ د ⇒ بنجهّز، ١٨١ د ⇒ أطول شوية — ومفيش ٤ في الحالتين", () => {
  const cfg = pickupLateCfg({ shop: { pickupReadyMinutes: 180 } });
  const a = pickupTrackState({ row: row({ accepted_at: at(-100) }), now: NOW, cfg });
  assert.equal(a.late, false); assert.equal(a.step, 2); assert.equal(a.promiseBasis, "legacy"); assert.equal(a.promiseAt, at(-100 + 180));
  const b = pickupTrackState({ row: row({ accepted_at: at(-181) }), now: NOW, cfg });
  assert.equal(b.late, true); assert.equal(b.step, 2);
});

test("وعد الوقت المتوقع لو اتبعت (PK2): promiseAt = eta.promise ونصه في اللابل، وبيتقدّم على المهلة؛ فات ⇒ late", () => {
  const eta = { promise: at(25), window: { text: "20~25 دقيقة · قبل 7:32 م" } };
  const s = pickupTrackState({ row: row({ accepted_at: at(-50) }), now: NOW, cfg: CFG45, eta });
  assert.equal(s.late, false, "المهلة (٤٥) فاتت بس الوعد الذكي لسه ⇒ مش متأخر");
  assert.equal(s.promiseAt, at(25)); assert.equal(s.promiseText, "20~25 دقيقة · قبل 7:32 م"); assert.equal(s.promiseBasis, "eta");
  assert.equal(s.label, "جاري تجهيز طلبك — جاهز للاستلام خلال 20~25 دقيقة · قبل 7:32 م");
  const l = pickupTrackState({ row: row(), now: NOW, cfg: CFG45, eta: { promise: at(-1), window: { text: "x" } } });
  assert.equal(l.late, true); assert.equal(l.step, 2); assert.equal(l.label, PICKUP_LABELS.late);
  // وعد من غير نص (شكل قديم) ⇒ اللابل العادي والـpromiseAt من الوعد
  const n = pickupTrackState({ row: row(), now: NOW, cfg: CFG45, eta: { promise: at(10) } });
  assert.equal(n.label, PICKUP_LABELS.preparing); assert.equal(n.promiseText, null); assert.equal(n.promiseAt, at(10));
});

test("بداية العدّ: accepted_at ← سجل الطلب ← created_at؛ مش updated_at؛ الطلب المسبق من موعده", () => {
  assert.equal(pickupAnchorAt(row()), Date.parse(at(-10)));
  assert.equal(pickupAnchorAt(row({ accepted_at: null })), Date.parse(at(-10)), "من السجل");
  assert.equal(pickupAnchorAt(row({ accepted_at: null, history: JSON.stringify([{ status: "accepted", at: at(-9) }]) })), Date.parse(at(-9)), "سجل كنص");
  assert.equal(pickupAnchorAt(row({ accepted_at: null, history: [] })), Date.parse(at(-12)), "من وقت الطلب");
  assert.equal(pickupAnchorAt(row({ accepted_at: null, history: [], created_at: null })), null);
  // updated_at اتحرّك دلوقتي (إنذار اتكتب) — العدّاد مايرجعش: لسه متأخر
  const s = pickupTrackState({ row: row({ accepted_at: at(-60), updated_at: at(0) }), now: NOW, cfg: CFG45 });
  assert.equal(s.late, true);
  // طلب مسبق موعده بعد ساعة: العدّ من الموعد
  const pre = pickupTrackState({ row: row({ accepted_at: at(-60), scheduled_for: at(60) }), now: NOW, cfg: CFG45 });
  assert.equal(pre.late, false); assert.equal(pre.anchorAt, at(60)); assert.equal(pre.promiseAt, at(105));
});

test("cfg ناقص/غلط ⇒ الافتراضي ٤٥ من غير ما الحساب يقع", () => {
  assert.equal(pickupTrackState({ row: row({ accepted_at: at(-46) }), now: NOW, cfg: null }).late, true);
  assert.equal(pickupTrackState({ row: row({ accepted_at: at(-44) }), now: NOW, cfg: { lateAfterMin: 0 } }).late, false);
  assert.equal(pickupTrackState({ row: row({ accepted_at: at(-44) }), now: NOW, cfg: { lateAfterMin: "abc" } }).late, false);
});

/* ═══ اللوحة: الصف في «التوصيل والمندوبين» (deliverycontrol.js) ═══ */
test("اللوحة: shop.pickupLateAfterMin صف في مجموعة zone (جنب «صفحة التتبع — …») بعنوان وشرح عربي وحدود ١٠–٢٤٠؛ الفعّال بيقرا القديم؛ والمصدر بيقول منين", () => {
  const f = FIELD_BY_PATH["shop.pickupLateAfterMin"];
  assert.ok(f, "الصف موجود");
  assert.equal(f.group, "zone"); assert.ok(GROUPS.some((g) => g.id === "zone"), "المجموعة بتتعرض في اللوحة");
  assert.equal(f.type, "int"); assert.equal(f.min, 10); assert.equal(f.max, 240);
  assert.match(f.label, /الاستلام/); assert.match(f.label, /أطول شوية/); assert.match(f.hint, /pos|الكاشير/); assert.match(f.hint, /45/);
  assert.equal(validatePatch({ "shop.pickupLateAfterMin": 5 }).ok, false, "تحت الحد ⇒ مرفوض، مش مقصوص");
  assert.equal(validatePatch({ "shop.pickupLateAfterMin": 300 }).ok, false);
  const ok = validatePatch({ "shop.pickupLateAfterMin": "60" });
  assert.equal(ok.ok, true); assert.equal(ok.values["shop.pickupLateAfterMin"], 60);
  assert.equal(effectiveOf("shop.pickupLateAfterMin", {}), 45);
  assert.equal(effectiveOf("shop.pickupLateAfterMin", { shop: { pickupReadyMinutes: 180 } }), 180, "القيمة المؤقتة ظاهرة كـ«الحالي»");
  assert.equal(effectiveOf("shop.pickupLateAfterMin", { shop: { pickupLateAfterMin: 60, pickupReadyMinutes: 180 } }), 60);
  assert.equal(sourceOf("shop.pickupLateAfterMin", {}).kind, "default");
  assert.deepEqual(sourceOf("shop.pickupLateAfterMin", { shop: { pickupReadyMinutes: 180 } }), { kind: "settings", note: "من المفتاح القديم shop.pickupReadyMinutes" });
  assert.equal(sourceOf("shop.pickupLateAfterMin", { shop: { pickupLateAfterMin: 60 } }).kind, "settings");
  const d = describeFields({ shop: { pickupReadyMinutes: 180 } }, () => "").find((x) => x.path === "shop.pickupLateAfterMin");
  assert.equal(d.stored, null); assert.equal(d.effective, 180); assert.equal(d.source.kind, "settings");
});

/* ═══ المسار العام ═══ */
function build({ order, ship = null, settings = {} } = {}) {
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
  const pool = { query: async (sql) => (/^SELECT \* FROM shop_orders WHERE order_no=\$1/.test(String(sql)) ? { rows: order ? [order] : [] } : { rows: [], rowCount: 0 }) };
  process.env.SHOP_SWEEP_SECONDS = "0";
  registerShop(app, { pool, requireAdmin: async () => null, requireCashierOrAdmin: async () => null, getSettingsData: async () => settings, jb: JSON.stringify, normPhone: (p) => String(p || "").replace(/\D/g, "").slice(-9) }, {
    pay: { configured: () => false }, delivery: { quote: async () => ({}), shipmentOf: async () => ship, cancelShipment: async () => null, dispatchGate: async () => ({ mode: "manual" }), canAutoDispatch: async () => false },
    emitOrder: () => {}, journey: () => ({ emit: () => {} }) });
  const get = (no) => routes["GET /api/shop/track/:orderNo"]({ req: { param: () => no, header: () => undefined, query: () => undefined }, json: (body, status = 200) => ({ body, status }) });
  return { get };
}
const live = (offMin) => new Date(Date.now() + min(offMin)).toISOString();
const liveRow = (x = {}) => ({ order_no: "W1792251412023", option: "pickup", status: "accepted", table_no: null, phone_norm: "512345678", total: "96", subtotal: "96", delivery_fee: "0",
  created_at: live(-50), accepted_at: live(-47), updated_at: live(-1), pos_ready_at: null, history: [{ status: "paid", at: live(-50) }, { status: "accepted", at: live(-47) }], ...x });

const plus = (isoAt, m) => new Date(Date.parse(isoAt) + min(m)).toISOString();   // التوقّع من وقت الصف نفسه (مش Date.now() تاني)

test("المسار: الحادثة بالظبط — استلام مقبول من ٤٧ د بالإعداد القديم ٢٠ ومفيش «جاهز» ⇒ step 2 + late:true + promiseAt ISO؛ وبـ pos_ready_at ⇒ step 4", async () => {
  const order = liveRow();
  const s = build({ order, settings: { shop: { pickupReadyMinutes: 20 } } });
  const r = (await s.get("W1792251412023")).body;
  assert.equal(r.ok, true); assert.equal(r.option, "pickup");
  assert.equal(r.step, 2, "كان ٤ قبل PK1"); assert.equal(r.late, true); assert.equal(r.label, PICKUP_LABELS.late);
  assert.equal(r.promiseAt, plus(order.accepted_at, 20)); assert.equal(r.promiseText, null); assert.equal(r.promiseBasis, "legacy");
  assert.equal(r.eta, null, "مفيش وقت متوقع للاستلام (لسه)"); assert.equal(r.stages, null); assert.equal(r.table, null);
  assert.equal(r.readyAt, null);
  // نفس الطلب بعد ما الكاشير ضغط «جاهز»
  const ready = liveRow({ pos_ready_at: live(-1) });
  const ok = build({ order: ready, settings: { shop: { pickupReadyMinutes: 20 } } });
  const b = (await ok.get("W1792251412023")).body;
  assert.equal(b.step, 4); assert.equal(b.label, PICKUP_LABELS.ready); assert.equal(b.late, false); assert.equal(b.readyAt, ready.pos_ready_at);
  // مقبول من ٥ د ومفيش إعداد ⇒ بنجهّز، promiseAt = +٤٥ من القبول
  const young = liveRow({ accepted_at: live(-5), history: [] });
  const fresh = build({ order: young, settings: {} });
  const f = (await fresh.get("W1792251412023")).body;
  assert.equal(f.step, 2); assert.equal(f.late, false); assert.equal(f.label, PICKUP_LABELS.preparing); assert.equal(f.promiseAt, plus(young.accepted_at, 45)); assert.equal(f.promiseBasis, "default");
  // الإعدادات بترمي ⇒ الافتراضي ٤٥ والتتبع شغّال
  const routes = {}; const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  registerShop({ routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") },
    { pool: { query: async (sql) => (/^SELECT \* FROM shop_orders WHERE order_no=\$1/.test(String(sql)) ? { rows: [liveRow()] } : { rows: [], rowCount: 0 }) }, requireAdmin: async () => null, requireCashierOrAdmin: async () => null,
      getSettingsData: async () => { throw new Error("db down"); }, jb: JSON.stringify, normPhone: (p) => String(p || "") },
    { pay: { configured: () => false }, delivery: { quote: async () => ({}), shipmentOf: async () => null, cancelShipment: async () => null, dispatchGate: async () => ({ mode: "manual" }), canAutoDispatch: async () => false }, emitOrder: () => {}, journey: () => ({ emit: () => {} }) });
  const x = (await routes["GET /api/shop/track/:orderNo"]({ req: { param: () => "W1792251412023", header: () => undefined, query: () => undefined }, json: (body, status = 200) => ({ body, status }) })).body;
  assert.equal(x.ok, true); assert.equal(x.step, 2); assert.equal(x.late, true); assert.equal(x.promiseBasis, "default");
});

test("المسار: الاستلام المتسلّم ⇒ step 5؛ والطاولة لسه بتاعة tableTrackLabel (مش استلام من الفرع) وlate:false", async () => {
  const d = (await build({ order: liveRow({ status: "delivered", pos_ready_at: live(-20), collected_at: live(-3) }) }).get("W1792251412023")).body;
  assert.equal(d.step, 5); assert.equal(d.label, PICKUP_LABELS.collected); assert.equal(d.late, false); assert.equal(d.promiseAt, null);
  const t = (await build({ order: liveRow({ table_no: 4, accepted_at: live(-120) }) }).get("W1792251412023")).body;
  assert.equal(t.table, 4); assert.equal(t.step, 2); assert.match(t.label, /طاولة 4/); assert.equal(t.late, false, "الطاولة مش من PK1");
});

test("المسار (التوصيل — القاعدة القائمة «المطعم أولاً»، من غير تغيير): طلب توصيل accepted / courier_assigned من ٣ ساعات ومفيش pos_ready_at ⇒ لا «جاهز» ولا «في الطريق إليك»، step 2، late:false", async () => {
  const base = liveRow({ option: "delivery", created_at: live(-185), accepted_at: live(-180), address: { latitude: 21.6241, longitude: 39.1521 }, delivery_quote: { routeKm: 5.2 } });
  const a = (await build({ order: base, settings: {} }).get("W1792251412023")).body;
  assert.equal(a.step, 2); assert.equal(a.label, "المطعم بيجهّز طلبك 👨‍🍳");
  assert.doesNotMatch(a.label, /جاهز|في الطريق إليك|تم تسليم/); assert.equal(a.late, false); assert.equal(a.promiseAt, null); assert.equal(a.readyAt, null);
  const ship = { status: "assigned", assigned_at: live(-170), arrived_at: null, driver: { name: "أحمد علي", phone: "0551234567" } };
  const b = (await build({ order: { ...base, status: "courier_assigned" }, ship, settings: {} }).get("W1792251412023")).body;
  assert.equal(b.step, 2); assert.equal(b.label, "المطعم بيجهّز طلبك — والمندوب في الطريق للمطعم 🛵");
  assert.doesNotMatch(b.label, /طلبك جاهز|في الطريق إليك|تم تسليم/); assert.equal(b.late, false);
  assert.ok(b.courier && b.courier.firstName === "أحمد", "كارت المندوب بيظهر — بس من غير «جاهز»");
  // والمندوب وصل المطعم ولسه مفيش «جاهز» ⇒ «طلبك بيتجهّز» برضه (step 2)
  const c = (await build({ order: { ...base, status: "courier_assigned" }, ship: { ...ship, arrived_at: live(-160) }, settings: {} }).get("W1792251412023")).body;
  assert.equal(c.step, 2); assert.equal(c.label, "المندوب وصل المطعم — طلبك بيتجهّز 👨‍🍳");
  // «جاهز» بتيجي من الكاشير بس — وساعتها ٣
  const r = (await build({ order: { ...base, status: "courier_assigned", pos_ready_at: live(-2) }, ship, settings: {} }).get("W1792251412023")).body;
  assert.equal(r.step, 3); assert.match(r.label, /جاهز/);
});
