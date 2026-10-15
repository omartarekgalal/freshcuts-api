/* RV1 — مراجعة ١٥/١٠: التقييم الواطي «عند المدير» في كل طريق بيوصل بيه للبورتال (reviewaudience.js).
   النجوم جوّه واتساب (٣ أو أقل) بتفتح تحويل review_low — كان بيظهر لكل كاشير ويرنّ كل ٦ ث على كل الأدوار ويروح Push لكل الأجهزة
   ومعاه رنّات RG1، وأحداث review_low / review_update كانت بتتبث لكل البوابات. دلوقتي: جمهور التقييمات بس (المدير، والكاشير لو
   «الكاشير كمان يشوف التقييمات الواطية في البورتال» مفتوح)، ومفيش رنّة متكررة (الرنّة الهادية بتاعة شاشة التقييمات هي بس).
   node --test wa-rv1-audience.test.mjs — قواعد مزيّفة، من غير شبكة ولا Push حقيقي ولا رسايل. */
import test from "node:test";
import assert from "node:assert/strict";
import { register as registerPortal } from "./portal.js";
import { register as registerHandover, pushPayloadFor, ringPlan } from "./wahandover.js";
import * as AU from "./reviewaudience.js";
import { reviewFlowConfig } from "./wareviews.js";

const tick = () => new Promise((r) => setTimeout(r, 15));
const CASHIER_ON = { waBot: { reviewFlow: { portalCashier: true } } };

/* ═══ القاعدة نفسها ═══ */
test("audience rule: manager (and the owner, who is a manager in the portal) always; cashier only with «الكاشير كمان يشوف التقييمات الواطية في البورتال»; kitchen never — same default as reviewFlowConfig", () => {
  for (const s of [{}, null, { waBot: {} }, { waBot: { reviewFlow: {} } }, { waBot: { reviewFlow: { portalCashier: false } } }, CASHIER_ON, { waBot: { reviewFlow: { portalCashier: "yes" } } }]) {
    assert.equal(AU.portalCashierOn(s), reviewFlowConfig(s && s.waBot ? s.waBot.reviewFlow : undefined).portalCashier === true, JSON.stringify(s));
  }
  assert.deepEqual(["manager", "cashier", "kitchen", "dashboard", ""].map((r) => AU.reviewPortalRole(r, {})), [true, false, false, false, false]);
  assert.deepEqual(["manager", "cashier", "kitchen"].map((r) => AU.reviewPortalRole(r, CASHIER_ON)), [true, true, false]);
  assert.deepEqual([AU.reviewPushRoles({}), AU.reviewPushRoles(CASHIER_ON)], [["manager"], ["manager", "cashier"]]);
  assert.equal(AU.reviewScoped("review_low", {}), true);
  assert.equal(AU.reviewScoped("review_update", { id: 1 }), true);
  assert.equal(AU.reviewScoped("wa_handover", { reason: "review_low" }), true);
  assert.equal(AU.reviewScoped("wa_handover_escalated", { reason: "review_low" }), true);
  assert.equal(AU.reviewScoped("wa_handover", { reason: "complaint" }), false);
  assert.equal(AU.reviewScoped("wa_handover_ack", { id: 5 }), false);
  assert.equal(AU.reviewScoped("wa_handover_ack", { id: 5 }, { scope: "reviews" }), true);
  assert.equal(AU.reviewScoped("order", { reason: "review_low" }), false);
});

/* ═══ البث الحي (portal.js) ═══ */
function portalHub(settings = {}, { failSettings = false } = {}) {
  const pool = { async query() { return { rows: [], rowCount: 0 }; } };
  const app = { get() {}, post() {}, put() {}, delete() {}, use() {} };
  const api = registerPortal(app, { pool, getSettingsData: async () => { if (failSettings) throw new Error("db down"); return settings; }, requireAdmin: async () => null, log: { error() {} } },
    { timers: false, eventStore: false, subscribe: () => () => {}, emitOrder: () => {}, env: {} });
  const got = {};
  for (const [id, role] of [["m", "manager"], ["owner", "manager"], ["c", "cashier"], ["k", "kitchen"]]) {
    got[id] = [];
    api.hub.clients.add({ user: { id, role }, send: (f) => got[id].push(String(f).split("\n").find((l) => l.startsWith("event:")) || f), close() {} });
  }
  return { api, got };
}
const evs = (frames) => frames.map((f) => String(f).replace(/^event:\s*/, ""));

test("live events: low-rating events reach the manager and the owner only — never the cashier (setting off) or the kitchen; everything else still reaches every screen", async () => {
  const { api, got } = portalHub();
  api.broadcast("review_low", { id: 7, rating: 2, channel: "delivery" });
  api.broadcast("review_update", { id: 7, status: "closed", by: "أبو فهد" });
  api.broadcast("wa_handover", { id: 3, phone: "0512345678", reason: "review_low", reasonAr: "تقييم واطي", urgent: true, note: "تقييم 2★ · طلب W1" });
  api.broadcast("wa_handover_escalated", { id: 3, reason: "review_low", step: "manager" });
  api.broadcast("wa_handover_ack", { id: 3, by: "تقييم: أبو فهد" }, { scope: "reviews" });
  api.broadcast("wa_handover", { id: 4, phone: "0598765432", reason: "complaint", urgent: true });
  api.broadcast("wa_handover_ack", { id: 4, by: "منى" });
  await tick();
  const ALL = ["review_low", "review_update", "wa_handover", "wa_handover_escalated", "wa_handover_ack", "wa_handover", "wa_handover_ack"].sort();
  assert.deepEqual(evs(got.m).sort(), ALL, "manager: the 5 low-rating events + the complaint pair");
  assert.deepEqual(evs(got.owner).sort(), ALL, "the owner (a manager in the portal) too");
  assert.deepEqual(evs(got.c), ["wa_handover", "wa_handover_ack"], "cashier: only the complaint and its ack — no rating, no phone, no closer's name");
  assert.deepEqual(evs(got.k), ["wa_handover", "wa_handover_ack"]);
});
test("live events: the frames the cashier gets carry nothing from the rating", async () => {
  const { api, got } = portalHub();
  const raw = [];
  for (const cl of api.hub.clients) if (cl.user.role === "cashier") cl.send = (f) => raw.push(String(f));
  api.broadcast("wa_handover", { id: 3, phone: "0512345678", reason: "review_low", note: "تقييم 2★" });
  api.broadcast("review_low", { id: 7, rating: 2 });
  await tick();
  assert.deepEqual(raw, []);
  assert.equal(got.m.length, 2);
});

test("live events: «الكاشير كمان يشوف التقييمات الواطية في البورتال» on ⇒ the cashier gets them too (never the kitchen); settings unreadable ⇒ manager only", async () => {
  const on = portalHub(CASHIER_ON);
  on.api.broadcast("review_low", { id: 8, rating: 1 });
  on.api.broadcast("wa_handover", { id: 9, reason: "review_low" });
  await tick();
  assert.deepEqual([evs(on.got.m), evs(on.got.c), evs(on.got.k)], [["review_low", "wa_handover"], ["review_low", "wa_handover"], []]);
  const down = portalHub(CASHIER_ON, { failSettings: true });
  down.api.broadcast("review_low", { id: 8, rating: 1 });
  await tick();
  assert.deepEqual([evs(down.got.m), evs(down.got.c)], [["review_low"], []]);
});

/* ═══ wahandover.js: الإشعار والقايمة والرنّة ═══ */
const NOW = "2026-10-15T16:30:00Z";
function hoWorld({ role = "cashier", settings = {} } = {}) {
  const db = { rows: [], seq: 0 };
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE IF NOT EXISTS wa_handovers/i.test(s) || /^UPDATE portal_presence/i.test(s)) return { rows: [] };
    if (/^SELECT body FROM wa_messages/i.test(s)) return { rows: [{ body: "الأكل وصل بارد" }] };
    if (/^INSERT INTO wa_handovers/i.test(s)) {
      const row = { id: ++db.seq, phone_norm: p[0], reason: p[1], reason_ar: p[2], urgent: p[3], order_no: p[4], test: p[5], last_text: p[6], at: p[7], acked_at: null };
      db.rows.push(row); return { rows: [{ ...row }], rowCount: 1 };
    }
    if (/FROM wa_handovers WHERE acked_at IS NULL AND at >= \$1/i.test(s)) return { rows: db.rows.filter((r) => !r.acked_at).map((r) => ({ ...r })) };
    if (/FROM wa_handovers WHERE phone_norm=\$1 AND acked_at IS NULL ORDER BY at DESC LIMIT 1/i.test(s)) return { rows: db.rows.filter((r) => r.phone_norm === p[0] && !r.acked_at).slice(-1).map((r) => ({ ...r })) };
    if (/^UPDATE wa_handovers SET rung_at=\$2 WHERE id=\$1/i.test(s)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const events = [], pushes = [];
  let user = { id: "s1", name: "منى", role };
  const api = registerHandover({ get: add("GET"), post: add("POST") }, { pool, getSettingsData: async () => settings }, {
    requirePortal: async () => ({ user, seen: true }), broadcast: (ev, d, o) => events.push([ev, d, o]), now: () => new Date(NOW), log: { error() {} }, noTimer: true,
    push: () => ({ PORTAL_URL: "https://x/portal/", sendToSubs: async (payload, opts) => { pushes.push([payload, opts || null]); return { sent: 1, of: 1 }; } }) });
  const list = async (r = role) => { user = { id: "s1", name: "x", role: r }; return (await routes["GET /api/portal/wa-handovers"]({ req: { param: () => undefined, header: () => "UA" }, json: (b) => b })).handovers; };
  return { db, api, events, pushes, list };
}
const LOW_EV = { phone: "0512345678", phoneMasked: "…5678", reason: "review_low", reasonAr: "تقييم واطي", urgent: true, orderNo: "W1790012345678", at: "2026-10-15T16:29:00Z", test: false, note: "تقييم 2★ · طلب W1790012345678" };
const COMPLAINT = { ...LOW_EV, phone: "0598765432", reason: "complaint", reasonAr: "شكوى", note: undefined };

test("a WhatsApp low rating (review_low handover): one calm push to the managers' devices only (cashiers too only with the setting); a complaint still goes to every device", async () => {
  const w = hoWorld();
  await w.api.emit(LOW_EV);
  await tick();
  assert.equal(w.pushes.length, 1);
  assert.deepEqual(w.pushes[0][1], { role: "manager" });
  assert.equal(w.pushes[0][0].requireInteraction, false, "gentle: not a sticky urgent push");
  assert.equal(w.pushes[0][0].urgency, "normal");
  await w.api.emit(COMPLAINT);
  await tick();
  assert.deepEqual(w.pushes[1][1], null, "complaint: every device, as before");
  assert.equal(w.pushes[1][0].requireInteraction, true);
  // the bot's reminder for the same open rating card ⇒ again managers only
  await w.api.emit({ phone: "0512345678", reminder: true, waitedMin: 10 });
  await tick();
  assert.deepEqual(w.pushes[2][1], { role: "manager" });
  const on = hoWorld({ settings: CASHIER_ON });
  await on.api.emit(LOW_EV);
  await tick();
  assert.deepEqual(on.pushes.map((x) => x[1]), [{ role: "manager" }, { role: "cashier" }]);
  assert.equal(pushPayloadFor({ id: 1, phone_norm: "512345678", reason: "complaint", urgent: true }, "u").requireInteraction, true);
  assert.equal(pushPayloadFor({ id: 1, phone_norm: "512345678", reason: "review_low", urgent: true }, "u").requireInteraction, false);
});

test("the portal's WhatsApp-handover list: the low-rating card is hidden from the cashier (setting off) and shown to the manager; with the setting the cashier sees it", async () => {
  const w = hoWorld();
  await w.api.emit(LOW_EV); await w.api.emit(COMPLAINT);
  assert.deepEqual((await w.list("cashier")).map((h) => h.reason), ["complaint"]);
  assert.deepEqual((await w.list("manager")).map((h) => h.reason).sort(), ["complaint", "review_low"]);
  assert.deepEqual((await w.api.openList()).map((h) => h.reason).sort(), ["complaint", "review_low"], "internal callers (no role) see all");
  const on = hoWorld({ settings: CASHIER_ON });
  await on.api.emit(LOW_EV);
  assert.deepEqual((await on.list("cashier")).map((h) => h.reason), ["review_low"]);
});

test("RG1 repeat ring: never for a low rating (the reviews screen's single gentle ring is the only one); taken/answered still settles it; a complaint keeps ringing", () => {
  const at = "2026-10-15T16:00:00Z", now = "2026-10-15T16:20:00Z";
  const rows = [{ id: 1, reason: "review_low", urgent: true, at }, { id: 2, reason: "complaint", urgent: true, at }, { id: 3, reason: "review_low", at, taken: true }];
  const plan = ringPlan(rows, { now, everyMin: 3, capMin: 45 });
  assert.deepEqual(plan.ring.map((r) => r.id), [2]);
  assert.deepEqual(plan.settle.map((s) => s.id), [3]);
});
