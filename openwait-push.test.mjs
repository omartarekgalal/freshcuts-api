/* «نبّهني لما تفتحوا» — دورة الحارس بقاعدة وهمية (١٠/١٠):
   Push + SMS مع بعض، رقم الفريق مابيتستبعدش، واللي بيدفع دلوقتي بيستنى. */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENWAIT_MINUTES = "0";          // من غير setInterval في الاختبار
const { register } = await import("./openwait.js");

const HOURS = { enabled: true, days: Object.fromEntries(
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, { open: "12:00", close: "02:00" }])) };
const NOON = new Date("2026-10-10T09:01:00Z");   // ١٢:٠١ الرياض
const MORNING = new Date("2026-10-10T08:45:00Z"); // ١١:٤٥ الرياض — مقفول

function harness({ rows, settings = {}, pushOk = false, smsOk = true, smsThrows = false, paying = [], paid = {}, adBlocked = [] }) {
  const log = { sms: [], ad: [], push: [], updates: [] };
  rows = rows.map((r) => ({ verified: true, ...r }));
  const pool = { async query(sql, p = []) {
    const q = String(sql).replace(/\s+/g, " ");
    if (q.includes("CREATE TABLE")) return { rows: [] };
    if (q.includes("SET skip_reason='expired'")) return { rows: [], rowCount: 0 };
    if (q.includes("UPDATE open_waitlist w SET order_no")) return { rows: [], rowCount: 0 };
    if (q.startsWith("SELECT id, phone_norm, code, device_id, verified FROM open_waitlist")) return { rows };
    if (q.includes("status='pending_payment'")) return { rows: [], rowCount: paying.includes(p[0]) ? 1 : 0 };
    if (q.startsWith("SELECT order_no FROM shop_orders")) return { rows: paid[p[0]] ? [{ order_no: paid[p[0]] }] : [] };
    if (q.includes("FROM cms_contacts")) return { rows: [] };
    if (q.includes("FROM sms_ad_blocked")) return { rows: [], rowCount: adBlocked.includes(p[0]) ? 1 : 0 };
    if (q.startsWith("SELECT 1 FROM open_waitlist WHERE phone_norm=$1 AND id<>$2")) return { rows: [], rowCount: 0 };
    if (q.includes("FROM acct_sessions")) return { rows: p[0] === "a".repeat(48) ? [{ phone_norm: "544775082" }] : [] };
    if (q.startsWith("INSERT INTO open_waitlist")) { log.updates.push({ q, p }); return { rowCount: 1 }; }
    if (q.startsWith("UPDATE open_waitlist SET")) { log.updates.push({ q, p }); return { rowCount: 1 }; }
    throw new Error("unexpected sql: " + q.slice(0, 90));
  } };
  const notify = {
    async sendSmsTo(phone, body, meta) { if (smsThrows) throw new Error("taqnyat down"); if (!smsOk) return false; log.sms.push({ phone, body, meta }); return true; },
    async sendToAudience(a) { log.push.push(a); return pushOk; },
  };
  const routes = {};
  const app = { post(path, fn) { routes[path] = fn; }, get() {}, put() {} };
  const api = register(app, {
    pool, requireAdmin: async () => null, jb: JSON.stringify, normPhone: (x) => String(x || "").replace(/^(\+?966|0)/, ""),
    sendAdSms: async (pn, body, meta) => { log.ad.push({ pn, body, meta }); return { parts: 2 }; },
    getSettingsData: async () => ({ hours: HOURS, notifications: { smsEnabled: true }, delivery: { alertPhones: ["0544775082"] }, ...settings }),
  }, { notify, carts: {} });
  return { api, log, routes };
}

test("مقفول ⇒ ولا رسالة ولا إشعار", async () => {
  const { api, log } = harness({ rows: [{ id: 1, phone_norm: "511111111", code: "abcd1234", device_id: "dev-aaaaaaaa" }] });
  assert.deepEqual(await api.runOpenWait(MORNING), { skipped: "closed" });
  assert.equal(log.sms.length + log.push.length, 0);
});

test("وقت الفتح: SMS للكل، والإشعار كمان للي مفعّله — والقناة بتتسجّل", async () => {
  const { api, log } = harness({ pushOk: true,
    rows: [{ id: 7, phone_norm: "511111111", code: "abcd1234", device_id: "dev-aaaaaaaa" }] });
  const out = await api.runOpenWait(NOON);
  assert.equal(out.sent, 1); assert.equal(out.pushed, 1);
  assert.equal(log.sms[0].body, "فريش كاتس فتح! كمّل طلبك: freshcuts.sa/c/abcd1234");
  assert.deepEqual(log.sms[0].meta, { kind: "waitlist", ref: "wait:7" });
  assert.equal(log.push[0].url, "https://freshcuts.sa/c/abcd1234");
  assert.equal(log.push[0].deviceId, "dev-aaaaaaaa");
  assert.equal(log.push[0].stage, "waitlist");
  assert.deepEqual(log.updates.at(-1).p, [7, "push+sms"]);
});

test("مفيش اشتراك إشعارات ⇒ SMS بس (السلوك القديم)", async () => {
  const { api, log } = harness({ pushOk: false, rows: [{ id: 8, phone_norm: "522222222", code: null, device_id: null }] });
  const out = await api.runOpenWait(NOON);
  assert.equal(out.sent, 1); assert.equal(out.pushed, undefined);
  assert.ok(log.sms[0].body.includes("utm_campaign=open_now"));
  assert.deepEqual(log.updates.at(-1).p, [8, "sms"]);
});

test("رقم المالك/الفريق بياخد التنبيه (كان بيتقفل staff في صمت)", async () => {
  const { api, log } = harness({ rows: [{ id: 9, phone_norm: "544775082", code: "zzzz9999", device_id: null }] });
  const out = await api.runOpenWait(NOON);
  assert.equal(out.sent, 1);
  assert.equal(log.sms[0].phone, "544775082");
  assert.ok(!log.updates.some((u) => u.p.includes("staff")));
});

test("الـSMS وقع بس الإشعار وصل ⇒ الصف يتقفل كـpush مش كفشل", async () => {
  const { api, log } = harness({ pushOk: true, smsThrows: true,
    rows: [{ id: 10, phone_norm: "533333333", code: "cccc3333", device_id: "dev-cccccccc" }] });
  const out = await api.runOpenWait(NOON);
  assert.equal(out.sent, 1);
  assert.deepEqual(log.updates.at(-1).p, [10, "push"]);
});

test("الاتنين وقعوا ⇒ skip_reason واضح", async () => {
  const { api, log } = harness({ pushOk: false, smsThrows: true,
    rows: [{ id: 11, phone_norm: "533333333", code: "cccc3333", device_id: null }] });
  const out = await api.runOpenWait(NOON);
  assert.equal(out.sent, 0); assert.equal(out.skipped, 1);
  assert.ok(String(log.updates.at(-1).p[1]).startsWith("sms_failed: taqnyat down"));
});

test("بيدفع دلوقتي ⇒ يستنى الدورة الجاية؛ دفع خلاص ⇒ يتشال ordered", async () => {
  const { api, log } = harness({ paying: ["544444444"], paid: { "555555555": "W1" },
    rows: [{ id: 12, phone_norm: "544444444", code: "dddd4444", device_id: null },
           { id: 13, phone_norm: "555555555", code: "eeee5555", device_id: null }] });
  const out = await api.runOpenWait(NOON);
  assert.equal(out.sent, 0); assert.equal(out.held, 1); assert.equal(out.skipped, 1);
  assert.equal(log.sms.length + log.push.length, 0);
  assert.ok(log.updates.some((u) => u.q.includes("skip_reason='ordered'") && u.p[0] === 13));
  assert.ok(!log.updates.some((u) => u.p[0] === 12));   // الصف فضل مفتوح
});

test("pushEnabled=false من الإعدادات ⇒ مفيش إشعار", async () => {
  const { api, log } = harness({ pushOk: true, settings: { openWait: { pushEnabled: false } },
    rows: [{ id: 14, phone_norm: "566666666", code: "ffff6666", device_id: "dev-ffffffff" }] });
  await api.runOpenWait(NOON);
  assert.equal(log.push.length, 0); assert.equal(log.sms.length, 1);
});

/* -- sender by verification (owner rule 10/10) -- */
test("unverified number: marketing sender + opt-out line, never the transactional sender", async () => {
  const { api, log } = harness({ rows: [{ id: 20, phone_norm: "577777777", code: "gggg7777", device_id: null, verified: false }] });
  const out = await api.runOpenWait(NOON);
  assert.equal(out.sent, 1);
  assert.equal(log.sms.length, 0);
  assert.equal(log.ad.length, 1);
  assert.ok(log.ad[0].body.startsWith("فريش كاتس فتح! كمّل طلبك: freshcuts.sa/c/gggg7777"));
  assert.ok(log.ad[0].body.includes("801001"));
  assert.deepEqual(log.updates.at(-1).p, [20, "sms-ad"]);
});

test("unverified + ad-blocked at the carrier: no SMS at all (no fallback to the transactional sender)", async () => {
  const { api, log } = harness({ adBlocked: ["588888888"],
    rows: [{ id: 21, phone_norm: "588888888", code: "hhhh8888", device_id: null, verified: false }] });
  const out = await api.runOpenWait(NOON);
  assert.equal(out.sent, 0); assert.equal(out.skipped, 1);
  assert.equal(log.sms.length + log.ad.length, 0);
  assert.equal(log.updates.at(-1).p[1], "unverified_ad_blocked");
});

test("unverified + ad-blocked but push delivered: closed as push", async () => {
  const { api, log } = harness({ adBlocked: ["588888888"], pushOk: true,
    rows: [{ id: 22, phone_norm: "588888888", code: "hhhh8888", device_id: "dev-hhhhhhhh", verified: false }] });
  const out = await api.runOpenWait(NOON);
  assert.equal(out.sent, 1);
  assert.deepEqual(log.updates.at(-1).p, [22, "push"]);
});

test("unverified inside marketing quiet hours (service resume at 22:10): held, verified still goes", async () => {
  const NIGHT = new Date("2026-10-10T19:10:00Z");   // 22:10 Riyadh, store open
  const { api, log } = harness({ settings: { service: { resumedAt: "2026-10-10T19:07:00Z" } },
    rows: [{ id: 23, phone_norm: "599999999", code: "iiii9999", device_id: null, verified: false },
           { id: 24, phone_norm: "500000001", code: "jjjj0000", device_id: null, verified: true }] });
  const out = await api.runOpenWait(NIGHT);
  assert.equal(out.held, 1); assert.equal(out.sent, 1);
  assert.equal(log.ad.length, 0); assert.equal(log.sms[0].phone, "500000001");
});

/* -- join: verified only with a live account session for the SAME phone -- */
const CLOSED = { enabled: true, days: Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, { closed: true }])) };
const call = async (routes, body, auth) => {
  let out = null;
  await routes["/api/openwait/join"]({
    req: { header: (h) => (h === "Authorization" ? auth : h === "cf-connecting-ip" ? "ip" + Math.random() : undefined), json: async () => body },
    json: (o, st) => { out = { ...o, status: st || 200 }; return out; },
  });
  return out;
};
test("join: no session = stored unverified; session of the same phone = verified; session of another phone = unverified", async () => {
  const { routes, log } = harness({ rows: [], settings: { hours: CLOSED } });
  const tok = "Bearer cust:" + "a".repeat(48);
  let r = await call(routes, { phone: "0544775082", items: [{ id: 1, qty: 2 }], source: "cart" });
  assert.equal(r.joined, true); assert.equal(r.verified, false);
  assert.equal(log.updates.at(-1).p[7], false); assert.equal(log.updates.at(-1).p[6], "cart");
  r = await call(routes, { phone: "0544775082" }, tok);
  assert.equal(r.verified, true); assert.equal(log.updates.at(-1).p[7], true);
  r = await call(routes, { phone: "0511111111" }, tok);
  assert.equal(r.verified, false);
  r = await call(routes, { phone: "0544775082" }, "Bearer cust:" + "b".repeat(48));
  assert.equal(r.verified, false);
  assert.ok(log.updates.at(-1).q.includes("verified = open_waitlist.verified OR EXCLUDED.verified"));
});
