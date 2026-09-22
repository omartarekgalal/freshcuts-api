/* بوابة المطعم — المنطق الصافي + الإشعارات (node --test portal-core.test.mjs)
   مفيش قاعدة بيانات ولا شبكة: web-push وهمي، والـpool وهمي. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  hashPin, verifyPin, validPin, signToken, verifyToken, tokenSecret, identitiesFrom, matchLogin,
  currentFingerprint, makeLoginLimiter, toPortalOrder, orderSignature, sseFrame, buildTimeline,
  pushKindForEvent, pushPayload, driverLatLng, localPhone, stageLabel, normStaffList, clientIp,
  itemsOf, courierDurations, lineName, UNKNOWN_ITEM,
} from "./portal-core.js";
import { makePortalPush, validSubscription } from "./portal-push.js";

const SECRET = "test-secret-0123456789";

/* ═══ PIN + التوكن ═══════════════════════════════════════════════════════ */

test("hashPin/verifyPin: الصح بيعدّي، الغلط والتالف لأ، والـPIN مش متخزّن", () => {
  const h = hashPin("4821");
  assert.match(h, /^s1\$[\w-]+\$[\w-]+$/);
  assert.ok(!h.includes("4821"));
  assert.equal(verifyPin("4821", h), true);
  assert.equal(verifyPin("4822", h), false);
  assert.equal(verifyPin("4821", "plain4821"), false);
  assert.equal(verifyPin("4821", null), false);
  assert.notEqual(hashPin("4821"), h, "ملح مختلف كل مرة");
  assert.equal(validPin("123"), false);
  assert.equal(validPin("12345678"), true);
  assert.equal(validPin("12a4"), false);
});

test("التوكن: موقّع، بينتهي بعد ١٢ ساعة، والتلاعب بيترفض", () => {
  const user = { id: "st_1", name: "أحمد", role: "cashier", pv: "abc" };
  const t0 = 1_700_000_000_000;
  const tok = signToken(user, SECRET, t0);
  const p = verifyToken(tok, SECRET, t0 + 1000);
  assert.equal(p.sid, "st_1");
  assert.equal(p.r, "cashier");
  assert.equal(verifyToken(`portal:${tok}`, SECRET, t0 + 1000).sid, "st_1", "البادئة portal: مقبولة");
  assert.equal(verifyToken(tok, SECRET, t0 + 12 * 3600_000 + 1), null, "منتهي");
  assert.equal(verifyToken(tok, "other-secret-xxxxxxxx", t0), null, "سر تاني");
  const [body, sig] = tok.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), r: "manager" })).toString("base64url");
  assert.equal(verifyToken(`${forged}.${sig}`, SECRET, t0), null, "تغيير الدور بيكسر التوقيع");
  assert.equal(verifyToken("garbage", SECRET, t0), null);
  assert.equal(verifyToken(tok, null, t0), null);
});

test("tokenSecret: PORTAL_TOKEN_SECRET أولاً، وإلا مشتق من ADMIN_TOKEN (مش هو نفسه)", () => {
  assert.equal(tokenSecret({ PORTAL_TOKEN_SECRET: "x".repeat(20), ADMIN_TOKEN: "adm" }), "x".repeat(20));
  const d = tokenSecret({ ADMIN_TOKEN: "admin-token-123" });
  assert.ok(d && d !== "admin-token-123");
  assert.equal(tokenSecret({}), null);
});

test("الهويات: موظفين بالاسم والدور، الرقم المشترك بس لو القائمة فاضية، ومفتاح الأدمن = مدير", () => {
  const staff = [
    { id: "st_a", name: "سارة", role: "manager", pinHash: hashPin("7777") },
    { id: "st_b", name: "علي", role: "cashier", pinHash: hashPin("2468") },
    { id: "st_c", name: "معطّل", role: "cashier", pinHash: hashPin("1357"), active: false },
    { id: "bad", name: "مالوش هاش", role: "cashier", pin: "9999" },
  ];
  const env = { ADMIN_PASSWORD: "owner-pass-1" };
  const ids = identitiesFrom({ portal: { staff }, shop: { cashierPin: "5555" } }, env);
  assert.equal(ids.staff.length, 2);
  assert.equal(ids.sharedPin, null, "الرقم المشترك مقفول لما فيه موظفين");
  assert.deepEqual(pick(matchLogin(ids, "7777")), { id: "st_a", role: "manager", name: "سارة" });
  assert.deepEqual(pick(matchLogin(ids, "2468")), { id: "st_b", role: "cashier", name: "علي" });
  assert.equal(matchLogin(ids, "1357"), null, "المعطّل مايدخلش");
  assert.equal(matchLogin(ids, "9999"), null);
  assert.equal(matchLogin(ids, "5555"), null);
  assert.equal(matchLogin(ids, "2468", "st_a"), null, "staffId بيحدد الموظف");
  assert.deepEqual(pick(matchLogin(ids, "owner-pass-1")), { id: "admin", role: "manager", name: "المالك" });

  const seed = identitiesFrom({ shop: { cashierPin: "5555" } }, {});
  assert.deepEqual(pick(matchLogin(seed, "5555")), { id: "cashier", role: "cashier", name: "الكاشير" });
  assert.equal(matchLogin(seed, "1111"), null);
  const legacy = identitiesFrom({ cashierPin: "4040" }, {});
  assert.equal(matchLogin(legacy, "4040").role, "cashier", "settings.cashierPin القديم مقبول");
  assert.equal(identitiesFrom({}, {}).sharedPin, "1111", "نفس افتراضي #delivery");
  assert.equal(identitiesFrom({}, { PORTAL_REQUIRE_PIN: "1" }).sharedPin, null, "PORTAL_REQUIRE_PIN يقفل الافتراضي");
});

function pick(u) { return u ? { id: u.id, role: u.role, name: u.name } : u; }

test("بصمة التوكن: تغيير الـPIN أو الدور أو الحذف بيلغي الجلسة", () => {
  const h1 = hashPin("2468");
  const ids1 = identitiesFrom({ portal: { staff: [{ id: "st_b", name: "علي", role: "cashier", pinHash: h1 }] } }, {});
  const u = matchLogin(ids1, "2468");
  assert.ok(currentFingerprint(ids1, "st_b", "cashier").includes(u.pv));
  const ids2 = identitiesFrom({ portal: { staff: [{ id: "st_b", name: "علي", role: "cashier", pinHash: hashPin("1122") }] } }, {});
  assert.ok(!currentFingerprint(ids2, "st_b", "cashier").includes(u.pv), "PIN جديد");
  const ids3 = identitiesFrom({ portal: { staff: [{ id: "st_b", name: "علي", role: "manager", pinHash: h1 }] } }, {});
  assert.deepEqual(currentFingerprint(ids3, "st_b", "cashier"), [], "الدور اتغيّر");
  assert.deepEqual(currentFingerprint(identitiesFrom({ portal: { staff: [] } }, { PORTAL_REQUIRE_PIN: "1" }), "st_b", "cashier"), []);
  const seed = identitiesFrom({ shop: { cashierPin: "5555" } }, {});
  const s = matchLogin(seed, "5555");
  assert.ok(!currentFingerprint(identitiesFrom({ shop: { cashierPin: "6666" } }, {}), "cashier", "cashier").includes(s.pv));
});

test("قفل المحاولات: ٥ غلطات ← قفل ١٠ دقايق، والنجاح بيصفّر", () => {
  const lim = makeLoginLimiter();
  const t = 1_000_000;
  for (let i = 0; i < 4; i++) assert.equal(lim.fail("ip:1", t + i).locked, false);
  assert.equal(lim.check("ip:1", t).locked, false);
  assert.equal(lim.fail("ip:1", t + 5).locked, true);
  const c = lim.check("ip:1", t + 60_000);
  assert.equal(c.locked, true);
  assert.ok(c.retryAfterSec > 500 && c.retryAfterSec <= 600);
  assert.equal(lim.check("ip:2", t).locked, false, "IP تاني مش مقفول");
  assert.equal(lim.check("ip:1", t + 10 * 60_000 + 10).locked, false, "القفل بينتهي");
  lim.fail("ip:3", t); lim.fail("ip:3", t); lim.success("ip:3");
  for (let i = 0; i < 4; i++) lim.fail("ip:3", t);
  assert.equal(lim.check("ip:3", t).locked, false, "النجاح صفّر العدّاد");
});

test("clientIp: cf-connecting-ip ثم أول x-forwarded-for", () => {
  assert.equal(clientIp((n) => ({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" })[n]), "1.2.3.4");
  assert.equal(clientIp((n) => ({ "x-forwarded-for": "5.6.7.8, 10.0.0.1" })[n]), "5.6.7.8");
  assert.equal(clientIp(() => undefined), "unknown");
});

test("normStaffList: بيشيل المكرر والناقص والدور الغلط", () => {
  const h = hashPin("1234");
  const l = normStaffList([{ id: "a", name: "x", role: "cashier", pinHash: h }, { id: "a", name: "y", role: "cashier", pinHash: h },
    { id: "b", name: "z", role: "boss", pinHash: h }, null, { id: "c", name: "", role: "manager", pinHash: h }]);
  assert.deepEqual(l.map((x) => x.id), ["a"]);
});

/* ═══ الطلب → شكل العقد ══════════════════════════════════════════════════ */

const NOW = Date.parse("2026-09-17T12:00:00Z");
const baseRow = () => ({
  order_no: "W1758100000000", status: "accepted", option: "delivery",
  customer: { name: "محمد", phone: "+966512345678", deviceId: "d1" }, phone_norm: "512345678",
  address: { area: "السلامة", street: "شارع ١", building: "12", floor: "2", landmark: "جنب البنك", latitude: 21.58, longitude: 39.15, extra: "x" },
  items: [{ name: "برجر", quantity: 2, variant_name: "دبل", notes: "بدون بصل" }, { product_id: 55, qty: 1, bundle_name: "باقة العيلة" }],
  subtotal: "80", delivery_fee: "15", tip: "0", total: "95.5", notes: "اتصل قبل",
  pos_order_id: "9001", created_at: new Date(NOW - 20 * 60_000), updated_at: new Date(NOW - 5 * 60_000),
  history: [{ at: new Date(NOW - 20 * 60_000).toISOString(), status: "pending_payment" },
    { at: new Date(NOW - 19 * 60_000).toISOString(), status: "paid" },
    { at: new Date(NOW - 12 * 60_000).toISOString(), status: "accepted" }],
  alerts: {}, pos_ready_at: null, accepted_at: null, portal_ack_at: null, portal_ack_by: null,
  pay_gateway: "Apple Pay (Mada)", is_test: false,
  ship_status: "assigned", ship_driver: { name: "كابتن سعيد", phone: "966555000111", location: { lat: "21.6", lng: "39.2" } },
  ship_provider: "leajlak", ship_ref: "W1758100000000", ship_updated_at: new Date(NOW - 60_000), ship_dispatch: { assigned: true },
});

test("toPortalOrder: نفس شكل العقد بالظبط", () => {
  const o = toPortalOrder(baseRow(), {}, NOW);
  assert.deepEqual(Object.keys(o).sort(), [
    "acceptedAt", "ackAt", "ackBy", "address", "courier", "courierOps", "createdAt", "customer", "deliveryFee", "farZone", "isTest", "items",
    "itemsCount", "notes", "option", "orderNo", "paidAt", "paidWith", "posOrderId", "readyAt",
    "scheduledFor", "scheduledLabel", "scheduledSlot", "sla", "stageLabel",
    "status", "subtotal", "total", "updatedAt"].sort());
  assert.equal(o.total, 95.5);
  assert.equal(o.itemsCount, 3, "عنوان الباقة مش صنف");
  assert.deepEqual(o.items[0], { name: "برجر — دبل", qty: 2, note: "بدون بصل", kind: "item", level: 0 });
  assert.deepEqual(o.items[1], { name: "باقة العيلة", qty: 1, note: null, kind: "bundle", level: 0 });
  assert.deepEqual(o.items[2], { name: "صنف #55", qty: 1, note: null, kind: "component", level: 1 });
  assert.deepEqual(o.customer, { name: "محمد", phone: "0512345678" });
  assert.deepEqual(o.address, { area: "السلامة", street: "شارع ١", building: "12", floor: "2", apartment: null, landmark: "جنب البنك", leaveAtDoor: false, deliveryNotes: null, lat: 21.58, lng: 39.15 });
  assert.equal(o.paidWith, "Apple Pay (Mada)");
  assert.equal(o.acceptedAt, new Date(NOW - 12 * 60_000).toISOString(), "من history لو العمود فاضي");
  assert.equal(o.paidAt, new Date(NOW - 19 * 60_000).toISOString());
  assert.equal(o.readyAt, null);
  assert.deepEqual({ ...o.courier, updatedAt: undefined }, { status: "assigned", name: "كابتن سعيد", phone: "0555000111", lat: 21.6, lng: 39.2,
    updatedAt: undefined, provider: "leajlak", ref: "W1758100000000", assigned: true,
    arrivedAt: null, pickedAt: null, readyToArrivedMin: null, arrivedToPickedMin: null,
    pickedToDeliveredMin: null, arrivedBeforeReady: null });
  assert.deepEqual(Object.keys(o.sla).sort(), ["code", "level", "message"]);
  assert.equal(o.stageLabel, "بيتجهّز");
  assert.equal(o.posOrderId, "9001");
  assert.equal(o.isTest, false);
});

test("toPortalOrder: استلام بدون عنوان، ومفيش شحنة = courier null، وSLA من slaCheck", () => {
  const r = { ...baseRow(), option: "pickup", status: "pos_created", ship_status: null, ship_driver: null, is_test: true,
    created_at: new Date(NOW - 16 * 60_000) };
  const o = toPortalOrder(r, {}, NOW);
  assert.equal(o.address, null);
  assert.equal(o.courier, null);
  assert.equal(o.isTest, true);
  assert.equal(o.sla.level, 2);
  assert.equal(o.sla.code, "accept_breach");
  assert.equal(o.stageLabel, "طلب جديد — اقبله من نقطة البيع");
  assert.equal(stageLabel({ status: "accepted", option: "pickup", pos_ready_at: new Date() }), "جاهز — مستني العميل يستلم");
});

test("driverLatLng: أشكال موقع الكابتن المختلفة", () => {
  assert.deepEqual(driverLatLng({ location: { latitude: 21.5, longitude: 39.1 } }), { lat: 21.5, lng: 39.1 });
  assert.deepEqual(driverLatLng({ location: [21.5, 39.1] }), { lat: 21.5, lng: 39.1 });
  assert.deepEqual(driverLatLng({ location: "21.5,39.1" }), { lat: 21.5, lng: 39.1 });
  assert.deepEqual(driverLatLng({ lat: 21.5, lon: 39.1 }), { lat: 21.5, lng: 39.1 });
  assert.deepEqual(driverLatLng({ location: { lat: 999, lng: 1 } }), { lat: null, lng: null });
  assert.deepEqual(driverLatLng(null), { lat: null, lng: null });
  assert.equal(localPhone("+966 55 500 0111"), "0555000111");
});

test("orderSignature: دقايق رسالة الـSLA مابتعتبرش تغيير، لكن المستوى بيعتبر", () => {
  const a = toPortalOrder(baseRow(), {}, NOW);
  const b = { ...a, sla: { ...a.sla, message: "رسالة تانية 12 دقيقة" } };
  assert.equal(orderSignature(a), orderSignature(b));
  assert.notEqual(orderSignature(a), orderSignature({ ...a, sla: { ...a.sla, level: 2 } }));
  assert.notEqual(orderSignature(a), orderSignature({ ...a, courier: { ...a.courier, lat: 21.7 } }));
});

test("sseFrame: event/id/data متعدد السطور", () => {
  assert.equal(sseFrame("order", { a: 1 }, 7), 'id: 7\nevent: order\ndata: {"a":1}\n\n');
  assert.equal(sseFrame("ping", "x\ny"), "event: ping\ndata: x\ndata: y\n\n");
});

/* ═══ الخط الزمني ════════════════════════════════════════════════════════ */

test("buildTimeline: دمج كل المصادر بترتيب زمني وعربي ومن غير تكرار ولا بيانات خام", () => {
  const T = (m) => new Date(NOW + m * 60_000).toISOString();
  const tl = buildTimeline({
    order: {
      created_at: T(0), option: "delivery",
      history: [{ at: T(0), status: "pending_payment" }, { at: T(1), status: "paid" }, { at: T(2), status: "pos_created" },
        { at: T(4), status: "accepted" }],
      alerts: { "staff:new_order": T(1.1), "accept_late:1": T(3) },
    },
    events: [
      { at: T(1), name: "order_status", source: "shop", ok: null, data: { from: null, to: "paid" } },
      { at: T(1.05), name: "order_paid", source: "shop", ok: true, summary: "تم الدفع", data: { total: 95 } },
      { at: T(2), name: "pos_push", source: "shop", ok: true, data: { attempt: 1 } },
      { at: T(9), name: "staff_action", source: "portal", ok: true, actor_name: "سارة", data: { action: "courier_request", via: "portal" } },
    ],
    shipments: [{ provider: "leajlak", status: "assigned", events: [
      { at: T(9), event: "created", provider: "leajlak", resp: { phone: "966500000000", secret: "s" } },
      { at: T(12), event: "poll", provider: "leajlak", status: "assigned" },
    ] }],
    webhooks: [
      { received_at: T(3.9), event: "order-updated", approval: "accepted" },
      { received_at: T(3.95), event: "order-paid", approval: "accepted" },
      { received_at: T(8), event: "order-updated", approval: "pickup_ready" },
    ],
    pushLog: [{ kind: "new", at: T(1.2), sent: 2, of: 2 }],
    audit: [{ at: T(9), staff_id: "st_a", staff_name: "سارة", role: "manager", action: "courier_request", ok: true, detail: { provider: "leajlak" } }],
  });
  const ats = tl.map((x) => x.at);
  assert.deepEqual(ats, [...ats].sort(), "ترتيب زمني");
  assert.equal(tl.filter((x) => x.type === "status" || x.type === "order_status").filter((x) => (x.data.to || "") === "paid").length, 1, "مفيش تكرار للحالة");
  assert.ok(tl.some((x) => x.type === "status" && x.data.to === "accepted"), "من history لما مفيش حدث");
  assert.equal(tl.filter((x) => x.type === "pos_webhook").length, 2, "نفس approval المتكرر بيتجمّع");
  assert.ok(tl.some((x) => x.label_ar === "الكاشير سجّل «جاهز»"));
  assert.ok(tl.some((x) => x.label_ar === "رسالة للإدارة: طلب جديد"));
  assert.ok(tl.some((x) => x.type === "staff_alert" && x.label_ar.includes("القبول متأخر")));
  assert.ok(tl.some((x) => x.type === "portal_push" && x.data.sent === 2));
  assert.equal(tl.filter((x) => x.type === "staff_action").length, 0, "سجل البوابة بدل الحدث المكرر");
  assert.ok(tl.some((x) => x.type === "portal_courier_request" && x.label_ar.includes("سارة")));
  assert.ok(tl.some((x) => x.label_ar === "المندوب: اتعيّن كابتن"));
  const json = JSON.stringify(tl);
  assert.ok(!json.includes("966500000000") && !json.includes('"secret"'), "مفيش رد خام من شركة التوصيل");
  for (const e of tl) assert.deepEqual(Object.keys(e).sort(), ["at", "data", "label_ar", "source", "type"]);
});

/* ═══ الإشعارات ═══════════════════════════════════════════════════════════ */

test("pushKindForEvent: الأحداث اللي بترن بس", () => {
  assert.deepEqual(pushKindForEvent({ orderNo: "W1", name: "order_paid" }), { kind: "new", key: "new" });
  assert.equal(pushKindForEvent({ orderNo: "W1", name: "order_status", data: { to: "paid_pos_failed" } }).kind, "pos_failed");
  assert.equal(pushKindForEvent({ orderNo: "W1", name: "order_status", data: { to: "courier_assigned" } }).kind, "courier_assigned");
  assert.equal(pushKindForEvent({ orderNo: "W1", name: "order_status", data: { to: "on_the_way" } }).kind, "courier_picked");
  assert.equal(pushKindForEvent({ orderNo: "W1", name: "order_status", data: { to: "delivered" } }).kind, "delivered");
  assert.equal(pushKindForEvent({ orderNo: "W1", name: "order_status", data: { to: "accepted" } }), null);
  assert.equal(pushKindForEvent({ orderNo: "W1", name: "sla_alert", data: { level: 1, code: "accept_late" } }), null);
  assert.deepEqual(pushKindForEvent({ orderNo: "W1", name: "sla_alert", data: { level: 2, code: "accept_breach" } }), { kind: "sla", key: "sla:accept_breach:2" });
  assert.equal(pushKindForEvent({ name: "order_paid" }), null);
});

test("pushPayload: طلب جديد عاجل وعنوانه «طلب جديد W…» وفيه الإجمالي والنوع", () => {
  const p = pushPayload("new", { orderNo: "W123", total: 95.5, option: "delivery", itemsCount: 3 }, "https://x/portal/");
  assert.equal(p.title, "طلب جديد W123");
  assert.match(p.body, /95\.5 ر\.س/);
  assert.match(p.body, /توصيل/);
  assert.equal(p.urgency, "high");
  assert.equal(p.requireInteraction, true);
  assert.equal(p.url, "https://x/portal/#order=W123");
  assert.ok(p.ttl > 0);
});

function fakePushPool({ subs = [] } = {}) {
  const log = new Set();
  const calls = [];
  const state = { subs: subs.map((s, i) => ({ id: i + 1, staff_id: "st_a", ...s })) };
  return {
    calls, state,
    query: async (sql, vals = []) => {
      calls.push({ sql: String(sql), vals });
      if (/CREATE (TABLE|INDEX)/.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO portal_push_log/.test(sql)) {
        const k = `${vals[0]}|${vals[1]}`;
        if (log.has(k)) return { rows: [], rowCount: 0 };
        log.add(k); return { rows: [{ order_no: vals[0] }], rowCount: 1 };
      }
      if (/SELECT id, sub(, staff_id)? FROM portal_push_subs/.test(sql)) {
        let rows = state.subs;
        if (/staff_id=\$1/.test(sql)) rows = rows.filter((r) => r.staff_id === vals[0]);
        return { rows, rowCount: rows.length };
      }
      if (/DELETE FROM portal_push_subs WHERE id=/.test(sql)) {
        state.subs = state.subs.filter((r) => r.id !== vals[0]); return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const KEYS = { webPushKeys: { publicKey: "PUB", privateKey: "PRIV" } };

test("push: مرة واحدة لكل (طلب، نوع)، بـVAPID وurgency وTTL، و410 بيمسح الاشتراك", async () => {
  const pool = fakePushPool({ subs: [{ sub: { endpoint: "https://a" } }, { sub: { endpoint: "https://dead" } }, { sub: { endpoint: "https://err" } }] });
  const sent = [];
  const webpush = {
    sendNotification: async (sub, body, opts) => {
      sent.push({ sub, body: JSON.parse(body), opts });
      if (sub.endpoint === "https://dead") throw Object.assign(new Error("gone"), { statusCode: 410 });
      if (sub.endpoint === "https://err") throw Object.assign(new Error("boom"), { statusCode: 500 });
      return {};
    },
  };
  const push = makePortalPush({ pool, getSettingsData: async () => KEYS, webpush, log: { error() {} }, baseUrl: "https://p/" });
  const r1 = await push.notifyOrder("new", "new", "W9", { total: 50, option: "pickup" });
  assert.deepEqual(r1, { sent: 1, of: 3 });
  assert.equal(sent.length, 3);
  assert.equal(sent[0].opts.urgency, "high");
  assert.ok(sent[0].opts.TTL > 0);
  assert.deepEqual(sent[0].opts.vapidDetails, { subject: "https://freshcuts.sa", publicKey: "PUB", privateKey: "PRIV" });
  assert.equal(sent[0].body.title, "طلب جديد W9");
  assert.equal(sent[0].body.orderNo, "W9");
  await tick();
  assert.equal(pool.state.subs.length, 2, "410 اتمسح");
  assert.ok(pool.calls.some((c) => /fail_count=fail_count\+1/.test(c.sql)), "500 بيتعدّ");
  const r2 = await push.notifyOrder("new", "new", "W9", {});
  assert.deepEqual(r2, { skipped: "already_sent" });
  assert.equal(sent.length, 3, "مفيش إرسال تاني");
});

test("push: مفيش VAPID أو مقفول من الإعدادات = مفيش إرسال ومفيش رمي", async () => {
  const pool = fakePushPool({ subs: [{ sub: { endpoint: "https://a" } }] });
  let n = 0;
  const webpush = { sendNotification: async () => { n++; } };
  const p1 = makePortalPush({ pool, getSettingsData: async () => ({}), webpush, log: { error() {} } });
  assert.equal((await p1.sendToSubs(pushPayload("new", { orderNo: "W1" }))).reason, "no_vapid");
  const p2 = makePortalPush({ pool, getSettingsData: async () => ({ ...KEYS, portal: { pushEnabled: false } }), webpush, log: { error() {} } });
  assert.equal((await p2.sendToSubs(pushPayload("new", { orderNo: "W1" }))).reason, "disabled");
  assert.equal(n, 0);
  const p3 = makePortalPush({ pool: { query: async () => { throw new Error("db down"); } }, getSettingsData: async () => KEYS, webpush, log: { error() {} } });
  assert.deepEqual(await p3.notifyOrder("new", "new", "W1", {}), { sent: 0, of: 0, error: true });
});

test("push.onOrderEvent: طلب اختبار مابيرنّش، وSLA ≥٢ بيبعت مرة", async () => {
  const pool = fakePushPool({ subs: [{ sub: { endpoint: "https://a" } }] });
  const sent = [];
  const push = makePortalPush({ pool, getSettingsData: async () => KEYS, webpush: { sendNotification: async (s, b) => { sent.push(JSON.parse(b)); } }, log: { error() {} } });
  assert.deepEqual(await push.onOrderEvent({ orderNo: "WT", name: "order_paid", data: {} }, async () => ({ isTest: true })), { skipped: "test_order" });
  assert.equal(await push.onOrderEvent({ orderNo: "W2", name: "notify_sent", data: {} }, async () => ({})), null);
  await push.onOrderEvent({ orderNo: "W2", name: "sla_alert", data: { level: 2, code: "pickup_breach" } }, async () => ({}));
  await push.onOrderEvent({ orderNo: "W2", name: "sla_alert", data: { level: 2, code: "pickup_breach" } }, async () => ({}));
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /تأخير W2/);
  assert.equal(push.onOrderEvent(null), null, "مابيرميش");
});

test("push.test: لجهاز المستخدم بس (staff_id/endpoint)", async () => {
  const pool = fakePushPool({ subs: [{ sub: { endpoint: "https://mine" }, staff_id: "st_a" }, { sub: { endpoint: "https://other" }, staff_id: "st_b" }] });
  const sent = [];
  const push = makePortalPush({ pool, getSettingsData: async () => ({ ...KEYS, portal: { pushEnabled: false } }), webpush: { sendNotification: async (s) => { sent.push(s.endpoint); } }, log: { error() {} } });
  const r = await push.test({ id: "st_a", name: "سارة" });
  assert.deepEqual(r, { sent: 1, of: 1 });
  assert.deepEqual(sent, ["https://mine"]);
});

test("validSubscription", () => {
  assert.equal(validSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } }), true);
  assert.equal(validSubscription({ endpoint: "http://insecure/x", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } }), false);
  assert.equal(validSubscription({ endpoint: "https://x.y/z" }), false);
  assert.equal(validSubscription(null), false);
});

/* ═══ أسماء الأصناف + محطّات المندوب (١٧ سبتمبر) ═════════════════════════ */

test("itemsOf: الاسم + الوزن، والفولباك «صنف #رقم» مش «منتج رقم»", () => {
  const items = itemsOf([
    { product_id: 105, name: "سجق مشوي بالوزن", variant_name: "ثلث كيلو", quantity: 1 },
    { product_id: 79, quantity: 2 },                       // اسم ناقص خالص
    { product_id: 3, product_name: "كبدة", qty: 1, note: "حار" },
    { quantity: 1 },                                        // لا اسم ولا رقم
  ]);
  assert.equal(items[0].name, "سجق مشوي بالوزن — ثلث كيلو");
  assert.equal(items[1].name, "صنف #79");
  assert.equal(items[2].name, "كبدة");
  assert.equal(items[2].note, "حار");
  assert.equal(items[3].name, "صنف غير معروف");
  assert.ok(items.every((x) => x.kind === "item" && x.level === 0));
});

test("itemsOf: الباقة عنوان واحد ومكوّناتها متزاحة تحته بكميتها لكل باقة", () => {
  const b = (slot, name, qty) => ({ product_id: 1, name, quantity: qty, bundle: "nd96",
    bundle_name: "بوكس اليوم الوطني ٩٦", bundle_line: "nd96-abc", bundle_slot: slot, bundle_qty: 2 });
  const items = itemsOf([
    { product_id: 9, name: "بيبسي", quantity: 1 },
    b("grill", "كفتة مشوية بالوزن", 2), b("rice", "رز", 4),
  ]);
  assert.deepEqual(items.map((x) => [x.kind, x.level, x.name, x.qty]), [
    ["item", 0, "بيبسي", 1],
    ["bundle", 0, "بوكس اليوم الوطني ٩٦", 2],
    ["component", 1, "كفتة مشوية بالوزن", 1],
    ["component", 1, "رز", 2],
  ]);
  // سطر الباقة بيتكتب مرة واحدة مهما كان عدد مكوّناتها
  assert.equal(items.filter((x) => x.kind === "bundle").length, 1);
});

test("courierDurations: «جاهز→وصل» سالبة لما المندوب يسبق الأكل", () => {
  const t = (m) => new Date(NOW + m * 60_000).toISOString();
  const d = courierDurations({ pos_ready_at: t(10), ship_arrived_at: t(4), ship_picked_at: t(12),
    ship_status: "delivered", ship_updated_at: t(30) });
  assert.equal(d.readyToArrivedMin, -6, "وصل قبل ما الأكل يجهز بـ٦ دقايق");
  assert.equal(d.arrivedToPickedMin, 8);
  assert.equal(d.pickedToDeliveredMin, 18);
  assert.equal(d.arrivedBeforeReady, true);
  // مفيش إشارة وصول = مفيش رقم مخترع
  const none = courierDurations({ pos_ready_at: t(10), ship_arrived_at: null, ship_picked_at: t(12) });
  assert.equal(none.readyToArrivedMin, null);
  assert.equal(none.arrivedBeforeReady, null);
  assert.equal(courierDurations({}).pickedToDeliveredMin, null);
});

test("toPortalOrder + الخط الزمني: المحطتين بيوصلوا الشاشة بالعربي", () => {
  const t = (m) => new Date(NOW + m * 60_000);
  const o = toPortalOrder({ ...baseRow(), pos_ready_at: t(-8), ship_arrived_at: t(-10), ship_picked_at: t(-3) }, {}, NOW);
  assert.equal(o.courier.arrivedAt, t(-10).toISOString());
  assert.equal(o.courier.pickedAt, t(-3).toISOString());
  assert.equal(o.courier.readyToArrivedMin, -2);
  assert.equal(o.courier.arrivedToPickedMin, 7);
  const tl = buildTimeline({ order: { created_at: new Date(NOW - 60_000) }, events: [
    { at: t(-10).toISOString(), name: "courier_arrived", source: "courier_poll", data: { provider: "leajlak", raw_status: "Reached Shop" } },
    { at: t(-3).toISOString(), name: "courier_picked", source: "courier_poll", data: { provider: "leajlak", raw_status: "Order Picked" } },
  ] });
  assert.ok(tl.some((x) => x.label_ar.includes("المندوب وصل المطعم")));
  assert.ok(tl.some((x) => x.label_ar.includes("المندوب استلم الطلب")));
});

test("pushKindForEvent/pushPayload: «المندوب وصل المطعم» إشعار مستقل للكاشير", () => {
  const m = pushKindForEvent({ orderNo: "W1", name: "courier_arrived", data: { provider: "leajlak" } });
  assert.deepEqual(m, { kind: "courier_arrived", key: "courier_arrived" });
  const p = pushPayload("courier_arrived", { orderNo: "W1" }, "https://x/portal/");
  assert.match(p.title, /المندوب وصل المطعم/);
  assert.equal(p.urgency, "high");
});

/* ٢٢ سبتمبر: شحنة اتسترجعت من لوحة لاجلك (أو اتصحّحت يدوي) بيتغيّر فيها
   updated_at بعد التوصيل، فالمدة كانت بتطلع ساعات وهمية. المصدر بقى
   delivered_at، وupdated_at احتياطي للصفوف القديمة اللي مالهاش العمود. */
test("مدة الطريق بتتقاس من delivered_at مش من آخر لمسة للصف", () => {
  const r = {
    ship_status: "delivered",
    ship_arrived_at: "2026-09-21T17:56:00.000Z",
    ship_picked_at: "2026-09-21T17:57:00.000Z",
    ship_delivered_at: "2026-09-21T18:29:00.000Z",
    ship_updated_at: "2026-09-21T23:41:05.000Z",   // اتصحّح بعد التوصيل بساعات
  };
  assert.equal(courierDurations(r).pickedToDeliveredMin, 32);
  // صف قديم من غير العمود: بيرجع لـupdated_at زي الأول
  const old = { ...r, ship_delivered_at: null, ship_updated_at: "2026-09-21T18:29:00.000Z" };
  assert.equal(courierDurations(old).pickedToDeliveredMin, 32);
});
