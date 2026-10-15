/* SB2 — reviews.js: طلب التقييم بعد التوصيل بيروح واتساب أولاً، والـSMS احتياطي بس، ومفيش ولا رسالة للي وقّف. قاعدة مزيّفة، من غير شبكة.      node --test wa-sb2.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";

process.env.REVIEW_INVITE_MINUTES = "0";      // مفيش مؤقّت: بنشغّل المسح بإيدنا من مسار اللوحة
process.env.REVIEWS_GOOGLE_JOB = "0";
const reviews = await import("./reviews.js");

function rig({ invites, waReply = null, optedOut = [] }) {
  const sql = [], sms = [], asked = [];
  const pool = { async query(q, p = []) {
    const s = String(q).replace(/\s+/g, " ").trim(); sql.push([s, p]);
    if (/FROM review_invites WHERE sent_at IS NULL AND skip_reason IS NULL AND due_at <=/i.test(s)) return { rows: invites.filter((iv) => !iv.sent_at && !iv.skip_reason) };
    if (/^SELECT opted_out_at FROM cms_contacts/i.test(s)) return { rows: optedOut.includes(p[0]) ? [{ opted_out_at: "2026-10-01" }] : [] };
    if (/^UPDATE review_invites SET sent_at=NOW\(\), channel=\$2 WHERE order_no=\$1/i.test(s)) { const iv = invites.find((x) => x.order_no === p[0]); iv.sent_at = "now"; iv.channel = p[1]; return { rows: [], rowCount: 1 }; }
    if (/^UPDATE review_invites SET sent_at=NOW\(\), channel='sms' WHERE order_no=\$1/i.test(s)) { const iv = invites.find((x) => x.order_no === p[0]); iv.sent_at = "now"; iv.channel = "sms"; return { rows: [], rowCount: 1 }; }
    const m = /^UPDATE review_invites SET (\w+)=\$2 WHERE order_no=\$1/i.exec(s); if (m) { const iv = invites.find((x) => x.order_no === p[0]); iv[m[1]] = p[1]; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const routes = {}; const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
  /* مفيش ساعات هدوء في الاختبار (القديمة ٠→٠، وبتاعة RV1 من = لحد) — النتيجة ماتعتمدش على ساعة التشغيل */
  const settings = { reviews: { askQuietStart: 0, askQuietEnd: 0 }, delivery: { alertPhones: [] }, waBot: { reviewFlow: { quietFromHour: 0, quietFromMinute: 0, quietToHour: 0, quietToMinute: 0 } } };
  reviews.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb: (x) => JSON.stringify(x), normPhone: (x) => x },
    { notify: () => ({ sendSmsTo: async (phone, body, meta) => { sms.push({ phone, body, meta }); return true; } }),
      ...(waReply ? { waReview: () => ({ reviewAsk: async (x) => { asked.push(x); return typeof waReply === "function" ? waReply(x) : waReply; } }) } : {}) });
  const run = async () => (await routes["POST /api/cms/reviews/invites/run"]({ req: {}, json: (b) => b })).result;
  return { run, sql, sms, asked, invites };
}
const IV = () => [{ order_no: "W1790012345678", code: "ab12cd34", phone_norm: "512345678" }];

test("WhatsApp first: delivered ⇒ reviewAsk (order + code), the invite is marked sent on «wa» / «wa_template», no SMS", async () => {
  const a = rig({ invites: IV(), waReply: { ok: true, channel: "wa" } });
  const r = await a.run();
  assert.deepEqual([r.sent, r.wa, a.sms.length], [1, 1, 0]);
  assert.deepEqual(a.asked, [{ phone: "512345678", orderNo: "W1790012345678", code: "ab12cd34" }]);
  assert.equal(a.invites[0].channel, "wa");
  const b = rig({ invites: IV(), waReply: { ok: true, channel: "wa_template" } });
  await b.run(); assert.equal(b.invites[0].channel, "wa_template");
  assert.deepEqual((await b.run()).sent, 0, "one per order: the row is sent, a second sweep sends nothing");
});

test("SMS only as the fallback, with the reason kept; a customer who stopped gets nothing at all", async () => {
  const a = rig({ invites: IV(), waReply: { ok: false, skipped: "no_optin" } });
  const r = await a.run();
  assert.deepEqual([r.sent, a.sms.length, a.invites[0].channel, a.invites[0].wa_skip], [1, 1, "sms", "no_optin"]);
  assert.match(a.sms[0].body, /freshcuts\.sa\/r\?c=ab12cd34|\/r\?c=ab12cd34/);
  const s = rig({ invites: IV(), waReply: { ok: false, skipped: "stopped", final: true } });
  const rs = await s.run();
  assert.deepEqual([rs.sent, s.sms.length, s.invites[0].skip_reason], [0, 0, "wa_stopped"]);
  const o = rig({ invites: IV(), waReply: { ok: true, channel: "wa" }, optedOut: ["512345678"] });
  await o.run(); assert.deepEqual([o.asked.length, o.sms.length, o.invites[0].skip_reason], [0, 0, "opted_out"], "the existing SMS opt-out still wins before anything is sent");
  const none = rig({ invites: IV() });
  await none.run(); assert.equal(none.sms.length, 1, "no WhatsApp module wired ⇒ exactly the old SMS path");
});

/* ١٤/١٠ (wapolicy): قالب بفلوس لنفس الطلب لسه طالع ⇒ reviewAsk بيرجّع defer ⇒ الدعوة تتأجل (due_at) — مش SMS ومش إلغاء؛ والمسح اللي بعده بيبعتها */
test("defer: a paid template for the same order minutes ago ⇒ the invite moves to «until» — no SMS, no skip; the next sweep sends it", async () => {
  const until = "2026-10-14T18:30:00.000Z";
  let n = 0;
  const a = rig({ invites: IV(), waReply: () => (++n === 1 ? { ok: false, skipped: "paid_gap", defer: true, until } : { ok: true, channel: "wa_template" }) });
  const r = await a.run();
  assert.deepEqual([r.sent, r.deferred, a.sms.length, a.invites[0].due_at, a.invites[0].skip_reason, a.invites[0].sent_at], [0, 1, 0, until, undefined, undefined]);
  const r2 = await a.run();
  assert.deepEqual([r2.sent, a.invites[0].channel, a.sms.length], [1, "wa_template", 0]);
  const m = rig({ invites: IV(), waReply: { ok: true, channel: "wa_merged" } });
  await m.run(); assert.deepEqual([m.invites[0].channel, m.sms.length], ["wa_merged", 0], "merged into the delivered message: marked sent, nothing else");
});
