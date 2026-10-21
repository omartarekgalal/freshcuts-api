/* 🍏 AR1 — دخول مراجع المتجر (Apple/Google) برمز ثابت — node --test app-review-login.test.mjs

   قاعدة بيانات وهمية: جدول acct_otp في الذاكرة (بيقلّد الـINSERT … ON CONFLICT بتاع
   المسار العادي ومسار المراجع). الـSMS = fetch متبدّل بيعدّ النداءات — مفيش شبكة. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.ADMIN_TOKEN = "test-admin-token";
process.env.TAQNYAT_API_KEY = "test-key";
process.env.TAQNYAT_SENDER = "FreshCut";

const { register } = await import("./accounts.js");
const AR = await import("./appreview.js");
const { redactForViewer, mergeForPut, SERVER_OWNED_PATHS } = await import("./settings-guard.js");
const { noMarketingPhones, teamPhones } = await import("./phonelists.js");
const { reviewSkipPhones } = await import("./reviews.js");

const REVIEW_PHONE = "500000123";
const OTHER_PHONE = "512345678";
const hashOtp = (pn, code) => crypto.createHash("sha256").update(`${pn}|${code}|${process.env.ADMIN_TOKEN}`).digest("hex");

/* ── SMS = fetch متبدّل ── */
const sms = [];
globalThis.fetch = async (url, opts) => {
  sms.push({ url: String(url), body: JSON.parse(opts.body) });
  return { ok: true, status: 201, json: async () => ({ statusCode: 201, messageId: sms.length, cost: 0.075, msgLength: 1 }) };
};
const smsCodeOf = (m) => (String(m.body.body).match(/#(\d{4})\s*$/) || [])[1];

function fakePool() {
  const otp = new Map();          // phone ⇒ { code_hash, attempts, expires_at(ms), created_at(ms), day_count, day_start }
  const log = [];
  const ttl = 5 * 60_000;
  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    log.push({ s, params });
    if (/^INSERT INTO acct_otp/.test(s)) {
      const [pn, hash] = params, now = Date.now(), cur = otp.get(pn);
      if (/THEN acct_otp\.attempts ELSE 0/.test(s)) {           // مسار المراجع: المحاولات والصلاحية تفضل لحد ما الرمز يخلص
        const live = cur && cur.expires_at > now;
        otp.set(pn, { code_hash: hash, attempts: live ? cur.attempts : 0, expires_at: live ? cur.expires_at : now + ttl, created_at: now, day_count: cur ? cur.day_count : 0, day_start: cur ? cur.day_start : now });
      } else {
        otp.set(pn, { code_hash: hash, attempts: 0, expires_at: now + ttl, created_at: now, day_count: (cur ? cur.day_count : 0) + 1, day_start: cur ? cur.day_start : now });
      }
      return { rowCount: 1, rows: [] };
    }
    if (/^SELECT created_at, day_count, day_start FROM acct_otp/.test(s)) {
      const r = otp.get(params[0]);
      return r ? { rowCount: 1, rows: [{ created_at: new Date(r.created_at), day_count: r.day_count, day_start: new Date(r.day_start) }] } : { rowCount: 0, rows: [] };
    }
    if (/^SELECT \* FROM acct_otp/.test(s)) {
      const r = otp.get(params[0]);
      return r ? { rowCount: 1, rows: [{ phone_norm: params[0], ...r, expires_at: new Date(r.expires_at) }] } : { rowCount: 0, rows: [] };
    }
    if (/^UPDATE acct_otp SET attempts=attempts\+1/.test(s)) { const r = otp.get(params[0]); if (r) r.attempts++; return { rowCount: r ? 1 : 0, rows: [] }; }
    if (/^DELETE FROM acct_otp/.test(s)) { otp.delete(params[0]); return { rowCount: 1, rows: [] }; }
    return { rowCount: 0, rows: [] };   // schema + acct_customers + acct_sessions + أي حاجة تانية
  };
  return { otp, log, query };
}

let ipSeq = 0;
function setup(settings = {}) {
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
  const pool = fakePool();
  register(app, {
    pool, requireAdmin: async () => null, getSettingsData: async () => settings,
    jb: (v) => JSON.stringify(v), normPhone: (p) => String(p || "").replace(/\D/g, "").slice(-9),
    deliveryAppOf: () => null,
  });
  const ip = `10.0.0.${++ipSeq}`;      // حد الـIP في accounts.js على مستوى الموديول — كل تست بـIP لوحده
  const call = (path, body) => routes[`POST ${path}`]({
    req: { header: (n) => (String(n).toLowerCase() === "cf-connecting-ip" ? ip : undefined), json: async () => body, param: () => undefined, query: () => undefined },
    json: (obj, status = 200) => ({ body: obj, status }),
  });
  return {
    pool,
    request: (phone) => call("/api/account/otp/request", { phone }),
    verify: (phone, code) => call("/api/account/otp/verify", { phone, code }),
  };
}
const ON = (extra = {}) => ({ appReview: { enabled: true, phone: REVIEW_PHONE, code: "4826", ...extra } });

/* ── /otp/request + /otp/verify ── */

test("enabled + reviewer phone: no SMS, same reply shape, fixed code logs in", async () => {
  sms.length = 0;
  const t = setup(ON());
  const r = await t.request(`0${REVIEW_PHONE}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, sent: "sms" });
  assert.equal(sms.length, 0, "no Taqnyat call");
  assert.equal(t.pool.otp.get(REVIEW_PHONE).code_hash, hashOtp(REVIEW_PHONE, "4826"), "stored like a real code");
  const v = await t.verify(`+966${REVIEW_PHONE}`, "4826");
  assert.equal(v.status, 200);
  assert.equal(v.body.ok, true);
  assert.equal(v.body.phone, REVIEW_PHONE);
  assert.match(v.body.token, /^[0-9a-f]{64}$/);
  assert.equal(t.pool.otp.has(REVIEW_PHONE), false, "code consumed");
  // مايدخلش دفتر عملاء نقطة البيع
  assert.equal(t.pool.log.some((x) => /^SELECT \* FROM acct_customers/.test(x.s)), false);
});

test("enabled + reviewer phone: no resend wait, no daily cap, otpDevMode never leaks a devCode", async () => {
  sms.length = 0;
  const t = setup({ ...ON(), shop: { otpDevMode: true } });
  for (let i = 0; i < 10; i++) {
    const r = await t.request(REVIEW_PHONE);
    assert.deepEqual(r.body, { ok: true, sent: "sms" }, `request #${i + 1}`);
  }
  assert.equal(sms.length, 0);
  assert.equal((await t.verify(REVIEW_PHONE, "4826")).body.ok, true);
});

test("enabled + another phone: the normal SMS path is unchanged", async () => {
  sms.length = 0;
  const t = setup(ON());
  const r = await t.request(OTHER_PHONE);
  assert.deepEqual(r.body, { ok: true, sent: "sms" });
  assert.equal(sms.length, 1, "one real SMS");
  assert.deepEqual(sms[0].body.recipients, [`966${OTHER_PHONE}`]);
  const sent = smsCodeOf(sms[0]);
  assert.match(sent, /^\d{4}$/);
  // الرمز الثابت مايفتحش رقم تاني
  if (sent !== "4826") assert.equal((await t.verify(OTHER_PHONE, "4826")).body.error, "wrong_code");
  assert.equal((await t.verify(OTHER_PHONE, sent)).body.ok, true);
  // ومهلة إعادة الإرسال لسه شغّالة للرقم العادي
  await t.request(OTHER_PHONE);
  const again = await t.request(OTHER_PHONE);
  assert.equal(again.status, 429);
  assert.equal(again.body.error, "resend_too_soon");
});

test("disabled (or incomplete) => fixed code rejected, the reviewer phone gets a real SMS like anyone", async () => {
  // «0000» عمره ما يطلع من randomInt(1000, 10000) ⇒ الرفض مؤكد
  for (const settings of [ON({ enabled: false, code: "0000" }), ON({ code: "" , enabled: true }), ON({ phone: "", code: "0000" }), {}]) {
    sms.length = 0;
    const t = setup(settings);
    const r = await t.request(REVIEW_PHONE);
    assert.deepEqual(r.body, { ok: true, sent: "sms" });
    assert.equal(sms.length, 1, `real SMS when off: ${JSON.stringify(settings)}`);
    const v = await t.verify(REVIEW_PHONE, "0000");
    assert.equal(v.status, 401);
    assert.equal(v.body.error, "wrong_code");
  }
});

test("wrong codes count attempts; 5 locks it; a new request does not reset the counter", async () => {
  sms.length = 0;
  const t = setup(ON());
  await t.request(REVIEW_PHONE);
  for (let i = 1; i <= 5; i++) {
    const v = await t.verify(REVIEW_PHONE, "1111");
    assert.equal(v.body.error, "wrong_code");
    assert.equal(t.pool.otp.get(REVIEW_PHONE).attempts, i);
  }
  assert.equal((await t.verify(REVIEW_PHONE, "4826")).body.error, "too_many_attempts", "right code after 5 wrong = locked");
  await t.request(REVIEW_PHONE);                 // طلب جديد والرمز لسه صالح ⇒ القفل يفضل
  assert.equal(t.pool.otp.get(REVIEW_PHONE).attempts, 5);
  assert.equal((await t.verify(REVIEW_PHONE, "4826")).body.error, "too_many_attempts");
  // بعد ما الصلاحية تخلص ⇒ طلب جديد يفتح من الأول
  t.pool.otp.get(REVIEW_PHONE).expires_at = Date.now() - 1000;
  await t.request(REVIEW_PHONE);
  assert.equal(t.pool.otp.get(REVIEW_PHONE).attempts, 0);
  assert.equal((await t.verify(REVIEW_PHONE, "4826")).body.ok, true);
  assert.equal(sms.length, 0);
});

/* ── الإعدادات (appreview.js) ── */

test("applyUpdate: validation", () => {
  const ok = AR.applyUpdate({}, { enabled: true, phone: "0500000123", code: "4826" }, { who: "عمر" });
  assert.equal(ok.ok, true);
  assert.equal(ok.next.phone, REVIEW_PHONE);
  assert.equal(ok.next.code, "4826");
  assert.equal(ok.next.updated_by, "عمر");
  for (const code of ["123", "12345", "12a4", "١٢٣٤"]) assert.equal(AR.applyUpdate({}, { phone: "0500000123", code }).error, "bad_code", code);
  for (const phone of ["0400000123", "12345", "05000001234", "abc"]) assert.equal(AR.applyUpdate({}, { phone, code: "4826" }).error, "bad_phone", phone);
  assert.equal(AR.applyUpdate({}, { enabled: true, phone: "0500000123" }).error, "incomplete");
  assert.equal(AR.applyUpdate({}, { enabled: "yes" }).error, "bad_enabled");
  // القفل بيسيب الرقم والرمز زي ما هم
  const off = AR.applyUpdate(ok.next, { enabled: false });
  assert.deepEqual([off.next.enabled, off.next.phone, off.next.code], [false, REVIEW_PHONE, "4826"]);
  // مسح الرقم وهو مفعّل ⇒ مرفوض
  assert.equal(AR.applyUpdate(ok.next, { phone: "" }).error, "incomplete");
});

test("reviewCodeFor: only exact phone + enabled + both fields", () => {
  assert.equal(AR.reviewCodeFor(ON(), REVIEW_PHONE), "4826");
  assert.equal(AR.reviewCodeFor(ON(), OTHER_PHONE), null);
  assert.equal(AR.reviewCodeFor(ON({ enabled: false }), REVIEW_PHONE), null);
  assert.equal(AR.reviewCodeFor(ON({ code: "12" }), REVIEW_PHONE), null);
  assert.equal(AR.reviewCodeFor({ appReview: { enabled: "true", phone: REVIEW_PHONE, code: "4826" } }, REVIEW_PHONE), null);
  assert.equal(AR.reviewCodeFor({}, REVIEW_PHONE), null);
  assert.equal(AR.auditLine(AR.configOf({}), AR.configOf(ON())).includes("4826"), false, "audit never carries the code");
});

test("settings guard: server-owned, hidden from non-owner GET, full PUT can't touch it", () => {
  assert.ok(SERVER_OWNED_PATHS.includes("appReview"));
  const data = { ...ON(), shop: { x: 1 } };
  assert.equal("appReview" in redactForViewer(data), false);
  const merged = mergeForPut(data, { shop: { x: 2 }, appReview: { enabled: false, phone: "", code: "" } });
  assert.deepEqual(merged.appReview, data.appReview);
  assert.equal("appReview" in mergeForPut({ shop: {} }, { appReview: ON().appReview }), false);
});

test("marketing / review-ask exclusion includes the reviewer phone (even when off) but it's not «team»", () => {
  for (const s of [ON(), ON({ enabled: false })]) {
    assert.ok(noMarketingPhones(s).has(REVIEW_PHONE));
    assert.ok(reviewSkipPhones(s).has(REVIEW_PHONE));
    assert.equal(teamPhones(s).has(REVIEW_PHONE), false, "no staff powers");
  }
  assert.equal(noMarketingPhones({}).has(REVIEW_PHONE), false);
});

/* ── مسارات اللوحة ── */

test("admin GET/PUT /api/cms/app-review: auth, validation, jsonb_set write, audit note without code", async () => {
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { get: add("GET"), post: add("POST"), put: add("PUT") };
  let row = { shop: {} };
  const notes = [];
  const q = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, " ");
    if (/SELECT data FROM settings WHERE id=1 FOR UPDATE/.test(s)) return { rowCount: 1, rows: [{ data: row }] };
    if (/UPDATE settings SET data = jsonb_set/.test(s)) { row = { ...row, appReview: JSON.parse(params[0]) }; return { rowCount: 1, rows: [] }; }
    return { rowCount: 0, rows: [] };
  };
  let authed = false;
  AR.register(app, {
    pool: { query: q, connect: async () => ({ query: q, release: () => {} }) },
    requireAdmin: async (c) => (authed ? null : c.json({ error: "Unauthorized" }, 401)),
    getSettingsData: async () => row,
    auditNote: async (_c, s) => { notes.push(s); },
  }, { whoami: async () => ({ name: "عمر" }) });
  const call = (m, body) => routes[`${m} /api/cms/app-review`]({
    req: { header: () => undefined, json: async () => body, param: () => undefined, query: () => undefined },
    json: (obj, status = 200) => ({ body: obj, status }),
  });
  assert.equal((await call("GET")).status, 401, "no admin ⇒ no code");
  assert.equal((await call("PUT", { enabled: true })).status, 401);
  authed = true;
  assert.equal((await call("PUT", { enabled: true, phone: "0500000123", code: "48" })).body.error, "bad_code");
  assert.equal(row.appReview, undefined, "nothing saved on a bad request");
  const w = await call("PUT", { enabled: true, phone: "0500000123", code: "4826" });
  assert.equal(w.body.ok, true);
  assert.equal(w.body.active, true);
  assert.deepEqual([row.appReview.enabled, row.appReview.phone, row.appReview.code, row.appReview.updated_by], [true, REVIEW_PHONE, "4826", "عمر"]);
  const g = await call("GET");
  assert.deepEqual([g.body.appReview.phone, g.body.appReview.code, g.body.active], ["0500000123", "4826", true]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].includes("4826"), false);
  assert.equal(notes[0].includes("اتفعّل"), true);
});
