/* C360a — واتساب في ملف العميل + «ملف العميل» من أي مكان + «افتح الطلب» (node --test c360wa.test.mjs)
   القواعد الصافية + المسارات على Hono حقيقي وقاعدة وهمية (بتطابق نص الاستعلام). أرقام وهمية بس — مفيش بيانات عملاء. */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  canSeeWaFile, parseOrderRef, campaignState, messageItem, campaignItem, mergePage, summaryOf, cardOf, webOrderOut, posOrderOut,
  handoverItem, ownerItem, ratingItem, consentItem, register, currentOrderOut, etaOut, profileBrief, FINAL_ORDER_STATUSES,
} from "./c360wa.js";
import { profileView, profileCfg } from "./custprofile.js";

const PN = "500000001";          // رقم وهمي
const T = (min) => new Date(Date.UTC(2026, 9, 16, 12, 0) + min * 60_000).toISOString();

test("canSeeWaFile: owner always, operations only while in the inbox roles, nobody else", () => {
  assert.equal(canSeeWaFile("owner", {}), true);
  assert.equal(canSeeWaFile("owner", { waHub: { inboxRoles: [] } }), true);
  assert.equal(canSeeWaFile("operations", {}), true);                                      // الافتراضي: العمليات في الصندوق
  assert.equal(canSeeWaFile("operations", { waHub: { inboxRoles: ["kitchen"] } }), false);  // المالك شالها من «مين يشوف المحادثات»
  assert.equal(canSeeWaFile("kitchen", {}), false);                                         // الكاشير/المطبخ مايشوفش التاريخ الكامل
  assert.equal(canSeeWaFile("marketing", { waHub: { inboxRoles: ["marketing"] } }), false);
  assert.equal(canSeeWaFile(undefined, {}), false);
});

test("parseOrderRef: W… web, pos:<id>, bare digits", () => {
  assert.deepEqual(parseOrderRef("w10234"), { kind: "web", no: "W10234" });
  assert.deepEqual(parseOrderRef(" pos:98765 "), { kind: "pos", id: "98765" });
  assert.deepEqual(parseOrderRef("4471"), { kind: "pos", id: "4471" });
  assert.equal(parseOrderRef("pos:abc"), null);
  assert.equal(parseOrderRef("DROP TABLE"), null);
  assert.equal(parseOrderRef(""), null);
});

test("campaignState: strongest state wins, steps carry their times", () => {
  const base = { status: "sent", sent_at: T(0) };
  assert.equal(campaignState(base).id, "sent");
  assert.equal(campaignState({ ...base, cloud_status: "delivered" }).id, "delivered");
  assert.equal(campaignState({ ...base, cloud_status: "read", read_at: T(5) }).id, "read");
  assert.equal(campaignState({ ...base, read_at: T(5), clicks: 2 }).id, "clicked");
  assert.equal(campaignState({ ...base, read_at: T(5), clicks: 1, replied_at: T(9) }).id, "replied");
  assert.equal(campaignState({ ...base, replied_at: T(9), optout_at: T(10) }).id, "optout");
  assert.equal(campaignState({ status: "failed", reason: "undeliverable" }).id, "failed");
  assert.equal(campaignState({ status: "holdout" }).id, "holdout");
  const st = campaignState({ ...base, delivered_at: T(1), read_at: T(5), clicked_at: T(6), replied_at: T(9) });
  assert.deepEqual(st.steps.map((s) => s.k), ["sent", "delivered", "read", "clicked", "replied"]);
});

test("campaignItem: Arabic reason only for failed/skipped; channel label", () => {
  const f = campaignItem({ id: 7, job_id: 3, job_name: "عرض الجمعة", status: "failed", reason: "undeliverable", channel: "wa_cloud", claimed_at: T(0), error_code: 131026 });
  assert.equal(f.state, "failed");
  assert.equal(f.reasonAr, "الرقم مش على واتساب");
  assert.equal(f.channelLabel, "واتساب الرسمي");
  assert.equal(f.at, T(0));
  const ok = campaignItem({ id: 8, job_id: 3, status: "sent", reason: "whatever", sent_at: T(2), clicks: 1 });
  assert.equal(ok.reasonAr, null);
  assert.equal(ok.state, "clicked");
});

test("messageItem: same shape as the inbox thread (staff / echo / bot / media)", () => {
  const staff = messageItem({ id: 1, direction: "out", body: "أهلاً", source: "echo", created_at: T(1), by_name: "سارة", staff_via: "portal", staff_role: "manager" });
  assert.equal(staff.source, "staff");
  assert.deepEqual(staff.staff, { by: "سارة", role: "manager", via: "portal" });
  assert.equal(staff.echoKind, undefined);
  const auto = messageItem({ id: 2, direction: "out", body: "رد آلي", source: "echo", echo_kind: "auto", created_at: T(2) });
  assert.equal(auto.echoKind, "auto");
  const bot = messageItem({ id: 3, direction: "out", body: "مرحبا", source: "bot", created_at: T(3) });
  assert.equal(bot.source, "bot");
  const img = messageItem({ id: 4, direction: "in", body: null, source: "api", created_at: T(4), media: { id: "MID", kind: "image", mime: "image/jpeg" } });
  assert.equal(img.dir, "in");
  assert.deepEqual(img.media, { ref: "4", kind: "image", mime: "image/jpeg", voice: false, filename: null, caption: null });
  const tpl = messageItem({ id: 5, direction: "out", template: "fc_order_on_the_way", created_at: T(5) });
  assert.equal(tpl.text, "[قالب: fc_order_on_the_way]");
});

test("mergePage: newest first across sources, cursor = oldest shown, nothing skipped across pages", () => {
  const a = [{ id: "m1", at: T(10) }, { id: "m2", at: T(4) }, { id: "m3", at: T(1) }];
  const b = [{ id: "q1", at: T(8) }, { id: "q2", at: T(3) }];
  const c = [{ id: "h1", at: T(6) }];
  const p1 = mergePage([a, b, c], 3);
  assert.deepEqual(p1.items.map((x) => x.id), ["m1", "q1", "h1"]);
  assert.equal(p1.nextBefore, T(6));
  /* الصفحة التانية = كل حاجة أقدم من المؤشر */
  const older = (l) => l.filter((x) => Date.parse(x.at) < Date.parse(p1.nextBefore));
  const p2 = mergePage([older(a), older(b), older(c)], 3);
  assert.deepEqual(p2.items.map((x) => x.id), ["m2", "q2", "m3"]);
  assert.equal(p2.nextBefore, null);
  assert.deepEqual(mergePage([[], []], 10), { items: [], nextBefore: null });
});

test("summaryOf: window from the last real inbound, opt-in and not-on-WhatsApp flags", () => {
  const now = Date.parse(T(60));
  const s = summaryOf({ counts: { n_in: 3, n_out: 5, last_in: T(30), first_at: T(0), last_at: T(40) }, camp: { total: 2, delivered: 1, replied: 1 },
    optin: { updates: true, marketing: false, stopped_at: null }, invalid: null, key: "k".repeat(32), now });
  assert.equal(s.messages.in, 3);
  assert.equal(s.window.open, true);
  assert.equal(s.optIn.updates, true);
  assert.equal(s.campaigns.replied, 1);
  assert.equal(s.notOnWhatsapp, null);
  const s2 = summaryOf({ invalid: { at: T(1), hits: 2 }, now });
  assert.equal(s2.window.open, false);
  assert.equal(s2.hasThread, false);
  assert.deepEqual(s2.notOnWhatsapp, { at: T(1), hits: 2 });
});

test("cardOf: small, ref only for the owner, phone per role", () => {
  const profile = { ref: "c0123456789abcde", identity: { name: "عميل تجربة" }, tags: ["VIP"],
    summary: { orders: 4, spend: 520.5, aov: 130.13, status: "repeat", daysSinceLast: 3, channels: [{ label: "متجرنا (الموقع)", orders: 3 }] },
    orders: [{ source: "web", orderNo: "W1", at: T(0), channel: "website", total: 120, items: [{ name: "كفتة", qty: 2 }] },
      { source: "pos", id: "55", receipt: "R55", at: T(-100), channel: "keeta", total: 90, items: [1, 2, 3, 4, 5].map((i) => ({ name: `صنف ${i}`, qty: 1 })) }],
    reviews: [{ rating: 5 }, { rating: 2 }, { rating: 4, hidden: true }] };
  const mgr = cardOf(profile, PN, { owner: false, full: true });
  assert.equal(mgr.ref, undefined);
  assert.equal(mgr.phone, `0${PN}`);
  assert.equal(mgr.lastOrders[1].no, "pos:55");
  assert.equal(mgr.lastOrders[1].channelLabel, "كيتا");
  assert.equal(mgr.lastOrders[1].items.length, 4);
  assert.equal(mgr.lastOrders[1].more, 1);
  assert.deepEqual(mgr.reviews, { count: 2, avg: 3.5, low: 1 });
  const own = cardOf(profile, PN, { owner: true, full: true });
  assert.equal(own.ref, "c0123456789abcde");
  const masked = cardOf(profile, PN, { owner: false, full: false });
  assert.equal(masked.phone, null);
  assert.equal(masked.phoneMasked, "…0001");
});

test("order out: web + POS (Keeta via payments) shapes", () => {
  const w = webOrderOut({ order_no: "W9", status: "delivered", option: "delivery", total: "95.5", delivery_fee: 15, items: [{ name: "برجر", quantity: 2, note: "بدون بصل" }],
    address: { area: "السلامة" }, created_at: T(0), customer: { name: "س" } });
  assert.equal(w.channelLabel, "متجرنا (الموقع)");
  assert.equal(w.items[0].qty, 2);
  assert.equal(w.area, "السلامة");
  const p = posOrderOut({ order_id: "77", receipt: "1203", order_date: T(0), order_type: "External", payments: { Keeta: 80 }, total: 80, items: [{ name: "شيش", qty: 1, amount: 80 }] });
  assert.equal(p.no, "pos:77");
  assert.equal(p.channel, "keeta");
  assert.equal(p.channelLabel, "كيتا");
});

test("event items: handover / owner / rating / consent carry Arabic labels", () => {
  assert.equal(handoverItem({ id: 1, at: T(0), reason: "review_low", reason_ar: "تقييم واطي", urgent: true }).reasonAr, "تقييم واطي");
  const o = ownerItem({ id: 2, at: T(1), action: "take", by_name: "سارة", via: "portal" });
  assert.equal(o.actionAr, "استلم المحادثة");
  assert.equal(o.viaAr, "البورتال");
  const r = ratingItem({ id: 3, at: T(2), rating: 2, rating_exact: false, kind: "app", order_no: "pos:5" });
  assert.equal(r.kindAr, "تطبيق توصيل");
  assert.equal(r.exact, false);
  assert.equal(consentItem({ id: 4, at: T(3), kind: "marketing", value: false }).kindAr, "العروض على واتساب");
});

/* ── المسارات ── */
const ADMIN = "admin-token-c360-test";
function makeApp({ role = "owner", settings = {}, portalUser = { role: "manager", admin: false }, current = null, profileRow = null, optout = null, waOptin = null } = {}) {
  const calls = [];
  const rows = (sql) => {
    if (/FROM wa_threads WHERE md5/.test(sql)) return [{ phone_norm: PN }];
    if (/FROM shop_orders o\s+LEFT JOIN LATERAL/.test(sql)) return current ? [current] : [];      // IBX1a: الطلب الحالي
    if (/SELECT opted_out_at, optout_source FROM cms_contacts/.test(sql)) return optout ? [optout] : [];
    if (/FROM wa_optins o WHERE phone_norm/.test(sql)) return waOptin ? [waOptin] : [];
    if (/FROM wa_invalid_numbers/.test(sql)) return [];
    if (/FROM wa_send_queue WHERE id=/.test(sql)) return [{ phone_norm: PN }];
    if (/FROM reviews r/.test(sql)) return [{ pn: PN }];
    if (/FROM shop_orders WHERE order_no/.test(sql)) return [{ order_no: "W1077", status: "delivered", total: 100, items: [], created_at: T(0), phone_norm: PN }];
    if (/FROM ts_orders o/.test(sql)) return [{ order_id: "88", order_date: T(0), order_type: "External", payments: { Keeta: 50 }, total: 50, items: [], pn: PN }];
    if (/FROM wa_messages m LEFT JOIN wa_staff_replies/.test(sql)) return [{ id: 1, direction: "in", body: "السلام", created_at: T(5), source: "api" }, { id: 2, direction: "out", body: "هلا", created_at: T(6), source: "bot" }];
    if (/FROM wa_send_queue q JOIN wa_send_jobs/.test(sql)) return [{ id: 9, job_id: 2, job_name: "حملة", status: "sent", sent_at: T(3), read_at: T(4) }];
    if (/FROM wa_handovers/.test(sql)) return [{ id: 3, at: T(7), reason: "human", reason_ar: "طلب موظف" }];
    if (/FROM wa_chat_owner_log/.test(sql)) return [];
    if (/FROM reviews\s+WHERE phone_norm/.test(sql)) return [{ id: 11, at: T(8), rating: 5 }];
    if (/FROM wa_optin_log/.test(sql)) return [];
    if (/count\(\*\) FILTER \(WHERE direction='in'\)/.test(sql)) return [{ n_in: 1, n_out: 1, last_in: T(5) }];
    if (/FROM wa_threads WHERE phone_norm/.test(sql)) return [{ x: 1 }];
    return [];
  };
  const pool = { query: async (sql, p) => { calls.push({ sql, p }); return { rows: rows(sql) }; } };
  const app = new Hono();
  const requireAdmin = async (c) => (c.req.header("Authorization") === `Bearer ${ADMIN}` ? null : c.json({ error: "Unauthorized" }, 401));
  const requirePortal = async (c, need) => {
    if (c.req.header("Authorization") !== "Bearer portal:ok") return { res: c.json({ ok: false, error: "unauthorized" }, 401) };
    if (need === "manager" && portalUser.role !== "manager") return { res: c.json({ ok: false, error: "forbidden" }, 403) };
    return { user: portalUser };
  };
  const c360 = {
    remember: async () => {}, refOf: (pn) => `c${String(pn).padStart(15, "0")}`, pnOfRef: async (ref) => (ref === "c000000500000001" ? PN : null),
    buildProfile: async () => ({ ref: "c000000500000001", identity: { name: "عميل" }, summary: { orders: 2, spend: 150 }, orders: [], reviews: [] }),
  };
  const profiles = { forPhone: async () => profileRow, cfg: async () => profileCfg(settings) };
  register(app, { pool, requireAdmin, getSettingsData: async () => settings, canSeePhones: async () => true }, {
    whoami: async () => ({ role }), c360, requirePortal, keySalt: "salt", log: { error() {} }, profiles: () => profiles,
  });
  const get = async (path, token = `Bearer ${ADMIN}`) => { const r = await app.request(path, { headers: { Authorization: token } }); return { status: r.status, body: await r.json() }; };
  return { get, calls };
}

test("resolve: wa key / campaign row / review / order / phone ⇒ ref; junk ⇒ 404/400; needs login", async () => {
  const { get } = makeApp();
  for (const q of ["wa=" + "a".repeat(32), "queue=9", "review=11", "order=W1077", "order=pos:88", "phone=0500000001"]) {
    const r = await get(`/api/cms/customers/resolve?${q}`);
    assert.equal(r.status, 200, q);
    assert.equal(r.body.ref, "c000000500000001", q);
  }
  assert.equal((await get("/api/cms/customers/resolve?wa=nothex")).status, 404);
  assert.equal((await get("/api/cms/customers/resolve")).status, 400);
  assert.equal((await get("/api/cms/customers/resolve?queue=9", "Bearer wrong")).status, 401);
});

test("order peek: web + pos", async () => {
  const { get } = makeApp();
  const w = await get("/api/cms/customers/order/W1077");
  assert.equal(w.body.order.source, "web");
  assert.equal(w.body.ref, "c000000500000001");
  const p = await get("/api/cms/customers/order/pos:88");
  assert.equal(p.body.order.channel, "keeta");
  assert.equal((await get("/api/cms/customers/order/abc")).status, 404);
});

test("whatsapp timeline: merged page + summary for the owner; 403 for roles outside owner/operations", async () => {
  const { get, calls } = makeApp();
  const r = await get("/api/cms/customers/360/c000000500000001/whatsapp?limit=5");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((x) => x.type), ["rating", "handover", "msg", "msg", "campaign"]);
  assert.equal(r.body.items[4].state, "read");
  assert.equal(r.body.summary.messages.in, 1);
  assert.equal(r.body.summary.hasThread, true);
  assert.match(r.body.threadKey, /^[0-9a-f]{32}$/);
  assert.deepEqual(r.body.partial, []);
  /* كل الاستعلامات بالرقم كمعامل — مفيش رقم جوّه نص SQL */
  assert.ok(calls.every((x) => !String(x.sql).includes(PN)));
  /* صفحة تانية: من غير ملخص */
  const p2 = await get(`/api/cms/customers/360/c000000500000001/whatsapp?before=${encodeURIComponent(T(5))}`);
  assert.equal(p2.body.summary, null);
  assert.equal((await makeApp({ role: "kitchen" }).get("/api/cms/customers/360/c000000500000001/whatsapp")).status, 403);
  assert.equal((await makeApp({ role: "operations", settings: { waHub: { inboxRoles: ["kitchen"] } } }).get("/api/cms/customers/360/c000000500000001/whatsapp")).status, 403);
  assert.equal((await makeApp({ role: "operations" }).get("/api/cms/customers/360/c000000500000001/whatsapp")).status, 200);
  assert.equal((await get("/api/cms/customers/360/cdeadbeefdeadbee/whatsapp")).status, 404);
});

test("portal card: manager gets the card without ref; owner (admin) gets ref; cashier 403", async () => {
  const mgr = await makeApp().get("/api/portal/customer-card?key=" + "b".repeat(32), "Bearer portal:ok");
  assert.equal(mgr.status, 200);
  assert.equal(mgr.body.card.orders, 2);
  assert.equal(mgr.body.card.ref, undefined);
  assert.equal(mgr.body.owner, false);
  const own = await makeApp({ portalUser: { role: "manager", admin: true } }).get("/api/portal/customer-card?review=11", "Bearer portal:ok");
  assert.equal(own.body.card.ref, "c000000500000001");
  const cashier = await makeApp({ portalUser: { role: "cashier" } }).get("/api/portal/customer-card?review=11", "Bearer portal:ok");
  assert.equal(cashier.status, 403);
  const peek = await makeApp().get("/api/portal/order-peek/pos:88", "Bearer portal:ok");
  assert.equal(peek.body.order.channelLabel, "كيتا");
});


/* ═══ IBX1a (عمر ١٧/١٠): كارت العميل جنب المحادثة — الطلب الحالي، آخر الطلبات، القيمة، التصنيف، التقييمات، الإيقاف ═══ */
const KEY = "c".repeat(32);
const ACTIVE = { order_no: "W1790077", status: "courier_assigned", option: "delivery", total: "187.50", delivery_fee: "17", discount_amount: "0", coupon: null, is_test: false, pay_gateway: "myfatoorah",
  created_at: T(-20), accepted_at: T(-18), pos_ready_at: null, scheduled_for: null, address: { area: "الروضة" }, table_no_i: null,
  items: [{ name: "كيلو مشاوي", quantity: 1 }, { name: "رز بخاري", qty: 2 }],
  ship_status: "assigned", ship_provider: "leajlak", ship_driver: { name: "محمد", phone: "0555555555" }, ship_assigned_at: T(-10), ship_arrived_at: null, ship_picked_at: null, ship_delivered_at: null, ship_updated_at: T(-9), ship_tracking_url: null };

test("IBX1a currentOrderOut: Arabic status + courier + pay + items; a finished order older than 3 h is not «current»; eta is a labelled estimate", () => {
  const now = Date.parse(T(0));
  const o = currentOrderOut(ACTIVE, { now, eta: { at: T(25), minutes: 25, soon: false } });
  assert.equal(o.no, "W1790077"); assert.equal(o.statusLabel, "المندوب رايح للمحل"); assert.equal(o.done, false); assert.equal(o.ageMin, 20);
  assert.deepEqual([o.option, o.optionLabel, o.area, o.total, o.paid, o.payGateway], ["delivery", "توصيل", "الروضة", 187.5, true, "myfatoorah"]);
  assert.deepEqual(o.items, [{ name: "كيلو مشاوي", qty: 1 }, { name: "رز بخاري", qty: 2 }]);
  assert.equal(o.courier.providerLabel, "لاجلك"); assert.equal(o.courier.statusLabel, "اتعيّن مندوب"); assert.equal(o.courier.driverName, "محمد"); assert.equal(o.courier.assignedAt, T(-10));
  assert.deepEqual(o.eta, { text: "خلال 25 دقيقة تقريباً", soon: false, at: T(25), minutes: 25 });
  assert.equal(currentOrderOut({ ...ACTIVE, status: "delivered", created_at: T(-100), ship_status: "delivered" }, { now }).done, true, "finished < 3 h ⇒ shown as done");
  assert.equal(currentOrderOut({ ...ACTIVE, status: "delivered", created_at: T(-100), ship_status: "delivered" }, { now, eta: { at: T(1), minutes: 1 } }).eta, null, "no eta on a finished order");
  assert.equal(currentOrderOut({ ...ACTIVE, status: "delivered", created_at: T(-200) }, { now }), null, "finished > 3 h ⇒ not current");
  assert.equal(currentOrderOut({ ...ACTIVE, option: "pickup", table_no_i: 4 }, { now }).optionLabel, "طاولة");
  assert.equal(currentOrderOut({ ...ACTIVE, ship_status: null, ship_provider: null }, { now }).courier, null);
  assert.deepEqual(etaOut({ soon: true }), { text: "قرّب يوصل", soon: true, at: null });
  assert.equal(etaOut({ range: { from: T(10), to: T(20), fromMin: 10, toMin: 20 } }).text, "خلال 10~20 دقيقة تقريباً");
  assert.equal(etaOut(null), null);
  assert.ok(FINAL_ORDER_STATUSES.includes("delivered") && FINAL_ORDER_STATUSES.includes("rejected_refunded"));
});

test("IBX1a profileBrief: segments + short Arabic lines from the classification row, empty values dropped", () => {
  const row = { phone_norm: PN, main_channel: "web", daypart: "late", value_tier: "A", spend_pct: 95, recency_band: "active", days_since: 3, freq_band: "regular", fav_dish: "مشكل مشاوي",
    service_pref: "delivery", district: "الروضة", lang: "ar", wa_reach: "reachable", price_sensitivity: "unknown", loyalty_left: 2, reward_code: null, segments: ["late_night"], computed_at: T(0), is_staff: false };
  const b = profileBrief(profileView(row, profileCfg({})), row);
  const by = Object.fromEntries(b.lines.map((l) => [l.key, l.value]));
  assert.equal(by.main_channel, "الموقع"); assert.equal(by.daypart, "آخر الليل"); assert.equal(by.value_tier, "A · أعلى 5٪"); assert.equal(by.recency_band, "نشط · من 3 يوم");
  assert.equal(by.fav_dish, "مشكل مشاوي"); assert.equal(by.loyalty, "فاضل 2 طلب للمكافأة"); assert.equal(by.price_sensitivity, undefined, "unknown is dropped");
  assert.equal(b.computedAt, T(0)); assert.equal(b.isStaff, false);
  assert.ok(Array.isArray(b.segments));
  assert.equal(profileBrief(null, row), null);
});

test("IBX1a customer route: inbox roles only, phone per phoneRoles, card + current + optouts + reviews + ref; unknown key 404", async () => {
  const profileRow = { phone_norm: PN, main_channel: "pos", daypart: "dinner", value_tier: "B", spend_pct: 70, recency_band: "active", days_since: 1, segments: [], computed_at: T(0) };
  const own = makeApp({ current: ACTIVE, profileRow, optout: { opted_out_at: T(-500), optout_source: "sms_reply" }, waOptin: { updates: true, marketing: false, stopped_at: null, marketing_off_at: T(-400) } });
  let r = await own.get(`/api/cms/wa/threads/${KEY}/customer`);
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  assert.equal(r.body.card.orders, 2); assert.equal(r.body.card.phone, "0" + PN); assert.equal(r.body.full, true);
  assert.equal(r.body.current.no, "W1790077"); assert.equal(r.body.current.courier.providerLabel, "لاجلك");
  assert.equal(r.body.profile.lines.find((l) => l.key === "daypart").value, "عشا");
  assert.deepEqual(r.body.optouts.sms, { at: T(-500), source: "sms_reply" });
  assert.deepEqual(r.body.optouts.wa, { updates: true, marketing: false, stopped: false, stoppedAt: null, marketingOff: true });
  assert.equal(r.body.optouts.notOnWhatsapp, false);
  assert.deepEqual(r.body.reviews, []); assert.equal(r.body.ref, "c000000500000001"); assert.deepEqual(r.body.partial, []);
  assert.ok(!own.calls.some((x) => /^\s*(INSERT|UPDATE|DELETE)/i.test(x.sql)), "read-only");
  /* مفيش طلب حالي ولا تصنيف ⇒ null من غير خطأ */
  r = await makeApp().get(`/api/cms/wa/threads/${KEY}/customer`);
  assert.equal(r.status, 200); assert.equal(r.body.current, null); assert.equal(r.body.profile, null); assert.equal(r.body.optouts.sms, null);
  /* الكاشير بيشوف المحادثات والرقم مخفي عنده ⇒ الكارت من غير رقم */
  r = await makeApp({ role: "kitchen", settings: { waHub: { inboxRoles: ["operations", "kitchen"], phoneRoles: ["operations"] } }, current: ACTIVE }).get(`/api/cms/wa/threads/${KEY}/customer`);
  assert.equal(r.status, 200); assert.equal(r.body.full, false); assert.equal(r.body.card.phone, null); assert.equal(r.body.card.phoneMasked, "…0001");
  assert.ok(!JSON.stringify({ ...r.body.card, ref: undefined }).includes(PN), "the number is nowhere in the card (the fake ref of this harness is built from it)");
  /* التسويق 403، مفتاح غلط 404، من غير دخول 401 */
  assert.equal((await makeApp({ role: "marketing" }).get(`/api/cms/wa/threads/${KEY}/customer`)).status, 403);
  assert.equal((await makeApp().get("/api/cms/wa/threads/nothex/customer")).status, 404);
  assert.equal((await makeApp().get(`/api/cms/wa/threads/${KEY}/customer`, "Bearer wrong")).status, 401);
});

test("IBX1a messageItem carries mid + wamid for «open this message in the chat»", () => {
  const m = messageItem({ id: 41, wamid: "wamid.z", direction: "in", body: "هلا", created_at: T(1), source: "api" });
  assert.equal(m.id, "m41"); assert.equal(m.mid, 41); assert.equal(m.wamid, "wamid.z");
});
