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

function harness({ rows, settings = {}, pushOk = false, smsOk = true, smsThrows = false, paying = [], paid = {} }) {
  const log = { sms: [], push: [], updates: [] };
  const pool = { async query(sql, p = []) {
    const q = String(sql).replace(/\s+/g, " ");
    if (q.includes("CREATE TABLE")) return { rows: [] };
    if (q.includes("SET skip_reason='expired'")) return { rows: [], rowCount: 0 };
    if (q.includes("UPDATE open_waitlist w SET order_no")) return { rows: [], rowCount: 0 };
    if (q.startsWith("SELECT id, phone_norm, code, device_id FROM open_waitlist")) return { rows };
    if (q.includes("status='pending_payment'")) return { rows: [], rowCount: paying.includes(p[0]) ? 1 : 0 };
    if (q.startsWith("SELECT order_no FROM shop_orders")) return { rows: paid[p[0]] ? [{ order_no: paid[p[0]] }] : [] };
    if (q.includes("FROM cms_contacts")) return { rows: [] };
    if (q.startsWith("SELECT 1 FROM open_waitlist WHERE phone_norm=$1 AND id<>$2")) return { rows: [], rowCount: 0 };
    if (q.startsWith("UPDATE open_waitlist SET")) { log.updates.push({ q, p }); return { rowCount: 1 }; }
    throw new Error("unexpected sql: " + q.slice(0, 90));
  } };
  const notify = {
    async sendSmsTo(phone, body, meta) { if (smsThrows) throw new Error("taqnyat down"); if (!smsOk) return false; log.sms.push({ phone, body, meta }); return true; },
    async sendToAudience(a) { log.push.push(a); return pushOk; },
  };
  const app = { post() {}, get() {}, put() {} };
  const api = register(app, {
    pool, requireAdmin: async () => null, jb: JSON.stringify, normPhone: (x) => String(x || "").replace(/^(\+?966|0)/, ""),
    getSettingsData: async () => ({ hours: HOURS, delivery: { alertPhones: ["0544775082"] }, ...settings }),
  }, { notify, carts: {} });
  return { api, log };
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
