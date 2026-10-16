/* RV5 (١٦/١٠) — قالب النجوم fc_review_stars اتفتح لعملاء الكاشير (صالة / سفري) وميتا صنّفته تسويقي:
     ١) رقم «الحشو» اللي الكاشير بيكتبه عشان يعدّي خانة الجوال عمره ما ياخد رسالة ولا صف موافقة — القاعدة اتوسّعت (phonecheck.js).
     ٢) أرقام الفريق والتنبيهات وموظفين البورتال والمناديب عمرها ما تاخد طلب تقييم — لا واتساب ولا SMS (reviews.js).
   node --test rv5-review-dummy-phones.test.mjs — أرقام مزيّفة، قاعدة مزيّفة، من غير شبكة ولا رسايل. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.REVIEW_INVITE_MINUTES = "0";
process.env.REVIEWS_GOOGLE_JOB = "0";
const PC = await import("./phonecheck.js");
const reviews = await import("./reviews.js");
const WC = await import("./waconsent.js");

/* ═══ ١) القاعدة ═══ */
const PLACEHOLDERS = {
  classic: ["555555555", "500000000", "511111111", "599999999", "512345678"],
  eight_same: ["555555551", "555555515", "555515555", "515555555", "555555550"],
  seven_run: ["550000000", "560000000", "590000000", "571111111", "551111111", "500000001", "533333339"],
  zeros_tail: ["555000000", "512000000", "566000000"],
  straight: ["501234567", "551234567", "591234567", "561234567", "597654321", "587654321", "523456789", "567890123", "543210987", "598765432", "501234568", "556789012"],
  pattern: ["512121212", "505050505", "534343434", "512312312", "512341234", "543214321", "590129012"],
};
test("RV5 rule: every filler shape the cashier types is a placeholder, with its rule name (classic / 8 same / 7 in a row / 000000 tail / 7-digit straight run / repeated block)", () => {
  for (const [why, list] of Object.entries(PLACEHOLDERS)) {
    for (const pn of list) {
      assert.equal(PC.placeholderWhy(pn), why, pn);
      assert.equal(PC.isPlaceholderPhone(pn), true, pn);
    }
  }
  // the old RV1 regex is still part of the rule (also exported for anything that reads it)
  for (const pn of PLACEHOLDERS.classic) assert.equal(PC.FAKE_PHONE_RE.test(pn), true, pn);
});

/* أرقام شكلها حقيقي — «قريبة» من القواعد عن قصد (٦ ورا بعض بس، تسلسل ٥–٦، نمط مش متكرر) ⇒ مايتقفلش ولا واحد */
const REAL_LOOKING = [
  "534781260", "534000111", "566712398", "542689137", "531478260", "553791024", "564802135",
  "501234968", "551234876", "555123456", "505551234", "530000111", "541122334", "555500055", "512340000",
  "567812345", "598712345", "555666777", "543212345", "550550551", "500000910", "512345098", "598760432", "512123123",
  "555550000", "512300000", "566666601", "509876123", "534343430",
];
test("RV5 rule: real-looking numbers — near misses on purpose (6 in a row, 5–6 straight digits, broken patterns) — are NOT placeholders", () => {
  for (const pn of REAL_LOOKING) assert.equal(PC.placeholderWhy(pn), null, pn);
  for (const pn of ["", null, undefined, "0534781260", "966534781260", "53478126", "5347812601"]) assert.equal(PC.isPlaceholderPhone(pn), false, String(pn));
});

test("RV5 rule: false-positive rate on random mobile numbers ≈ 1 in 100,000 (seeded sample of 400k numbers 5XXXXXXXX)", () => {
  let a = 0x2f6b1d3; const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (t ^ (t >>> 14)) >>> 0; };
  const N = 400_000; let hits = 0;
  for (let i = 0; i < N; i++) if (PC.isPlaceholderPhone(`5${String(rnd() % 100_000_000).padStart(8, "0")}`)) hits++;
  // expected ≈ 4 (rate ≈ 1e-5); the bound leaves room for sampling noise but fails if a rule turns broad
  assert.ok(hits <= 20, `hits ${hits} / ${N}`);
});

test("RV5 rule is the ONE rule: the cashier consent record, the consent guard and «طبقك المفضل» all use isPlaceholderPhone", async () => {
  for (const pn of ["501234567", "551234567", "555555551", "550000000"]) {
    assert.equal((await WC.recordPosReviewConsent({ query: async () => { throw new Error("must not write"); } }, { phoneNorm: pn, orderNo: "pos:1", kind: "dinein" })).error, "placeholder_phone", pn);
    assert.equal(await WC.posReviewConsentCovers({ query: async () => ({ rows: [{}] }) }, pn, "pos:1"), false, pn);
  }
  assert.equal(await WC.posReviewConsentCovers({ query: async () => ({ rows: [{}] }) }, "534781260", "pos:1"), true);
  const fav = fs.readFileSync(new URL("./wafavpick.js", import.meta.url), "utf8");
  assert.match(fav, /import \{ isPlaceholderPhone \} from "\.\/phonecheck\.js";/);
  assert.match(fav, /if \(isPlaceholderPhone\(pn\)\) \{ ex\("bad_number"\); continue; \}/);
  assert.doesNotMatch(fav, /FAKE_RE/);
  assert.equal(WC.POS_REVIEW_CONSENT.sharedBills, 4, "the many-bills rule stays (4+ bills in 24 h)");
});

/* ═══ ٢) مين مايتسألش: القايمة الواحدة ═══ */
const P = {      // أرقام مزيّفة
  deliveryAlert: "531110001", newOrder: "531110002", team: "531110003", staffList: "531110004", legacy: "531110005",
  botAlert: "531110006", llmAlert: "531110007", health: "531110008", adsReport: "531110009", portalStaff: "531110010", portalMobile: "531110011",
  tester: "531110012", never: "531110013", publicPhone: "531110014", noAds: "531110015", awaiting: "531110016", courier: "531110017",
  customer: "534781260", customer2: "542689137", customer3: "553791024",
};
const fullSettings = (extra = {}) => ({
  reviews: { threshold: 4, googleUrl: "https://g.page/r/fake/review", askMaxAgeHours: 20 },
  delivery: { alertPhones: [`0${P.deliveryAlert}`], newOrderPhones: [`+966${P.newOrder}`] },
  waTeam: { members: [{ phone: `0${P.team}`, name: "كاشير", role: "cashier" }] },
  cms: { phoneLists: { migratedAt: "2026-10-15T00:00:00Z", staffPhones: [{ phone: P.staffList, reason: "employee" }], noAdsPhones: [{ phone: P.noAds, reason: "family" }], reviewPhones: [{ phone: P.awaiting }] } },
  waBot: { testPhones: [P.tester], neverReplyPhones: [P.never], alertPhones: [`0${P.botAlert}`], llm: { alertPhones: [P.llmAlert] }, publicPhone: `0${P.publicPhone}`, reviewFlow: {} },
  waHealth: { phones: [`0${P.health}`] },
  adsReport: { phones: `0${P.adsReport}, 0500` },
  portal: { staff: [{ id: "s1", name: "مدير", role: "manager", phone: `0${P.portalStaff}` }, { id: "s2", name: "كاشير", role: "cashier", mobile: P.portalMobile }, null] },
  ...extra,
});

test("RV5 reviewSkipPhones: every non-customer number in the settings — order alerts, team directory, staff list, bot handover/AI alerts, WhatsApp-health and ads-report alerts, portal staff, bot testers / never-reply, our own number — and NOT the «ads only» / «awaiting the owner» lists (those are customers)", () => {
  const set = reviews.reviewSkipPhones(fullSettings());
  for (const k of ["deliveryAlert", "newOrder", "team", "staffList", "botAlert", "llmAlert", "health", "adsReport", "portalStaff", "portalMobile", "tester", "never", "publicPhone"]) assert.ok(set.has(P[k]), k);
  for (const k of ["noAds", "awaiting", "customer", "courier"]) assert.ok(!set.has(P[k]), k);
  assert.ok([...set].every((p) => /^5\d{8}$/.test(p)), "only normalised mobiles («0500» is dropped)");
  // the legacy list counts until the SX1 migration (same as teamPhoneSet)
  const pre = reviews.reviewSkipPhones({ cms: { campaigns: { excludePhones: [P.legacy] } } });
  assert.ok(pre.has(P.legacy));
  assert.equal(reviews.reviewSkipPhones(null).size >= 0, true);
  assert.equal(reviews.reviewSkipPhones({}).has(P.customer), false);
});

/* ═══ ٣) المسح كله (reviews.runInvites) بقاعدة مزيّفة ═══ */
const NOW = "2026-10-16T15:00:00Z";      // 18:00 الرياض — بره ساعات الهدوء
const T0 = Date.parse(NOW);
const ago = (min) => new Date(T0 - min * 60_000).toISOString();
const norm = (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
const fakeApp = () => { const add = () => () => {}; return { get: add(), post: add(), put: add(), delete: add() }; };
function rig({ ts = [], invites = [], settings = fullSettings(), waReply = { ok: true, channel: "wa_stars", wamid: "wamid.T" }, never = {}, neverThrows = false, smsOk = true } = {}) {
  const db = { invites: invites.map((x) => ({ ...x })), consent: [], sms: [], asked: [], neverAsked: [] };
  const inv = (no) => db.invites.find((x) => x.order_no === no);
  const pool = { async query(q, p = []) {
    const s = String(q).replace(/\s+/g, " ").trim();
    if (/FROM ts_orders b LEFT JOIN order_sources bs/i.test(s)) return { rows: p[1].map((pn) => ({ pn, n: ts.filter((o) => o.pn === pn).length })).filter((r) => r.n > 0) };
    if (/^INSERT INTO review_invites\(order_no, code, phone_norm, option, due_at, kind, order_at, ref, skip_reason\)/i.test(s)) {
      if (inv(p[0])) return { rows: [], rowCount: 0 };
      db.invites.push({ order_no: p[0], code: p[1], phone_norm: p[2], option: p[3], due_at: p[4], kind: p[5], order_at: p[6], ref: p[7], skip_reason: p[8] }); return { rows: [], rowCount: 1 };
    }
    if (/^SELECT o\.order_type, COALESCE\(s\.source, ''\) AS src/i.test(s)) {
      const t = ts.find((o) => String(o.order_id) === String(p[0])), iv0 = inv(`pos:${p[0]}`);
      return { rows: [{ order_type: null, src: "", pn: t ? t.pn : iv0 ? iv0.phone_norm : null }] };
    }
    if (/FROM ts_orders o LEFT JOIN order_sources s/i.test(s)) {
      return { rows: ts.filter((o) => !inv(`pos:${o.order_id}`)).map((o) => ({ order_id: o.order_id, receipt: "", order_date: o.order_date, order_option: o.order_option, pn: o.pn, is_app: false, web_near: false })) };
    }
    if (/^INSERT INTO review_invites\(order_no, code, phone_norm, option, due_at, kind, order_at, ref\)/i.test(s)) {
      if (inv(p[0])) return { rows: [], rowCount: 0 };
      db.invites.push({ order_no: p[0], code: p[1], phone_norm: p[2], option: p[3], due_at: p[4], kind: p[5], order_at: p[6], ref: p[7] }); return { rows: [{ code: p[1] }], rowCount: 1 };
    }
    if (/^INSERT INTO wa_optin_log\(phone_norm, kind, value, text_version, text, source, order_no, ip, ua, at\) SELECT \$1, 'review', TRUE/i.test(s)) {
      if (db.consent.some((c) => c.order_no === p[3] && c.phone_norm === p[0])) return { rows: [], rowCount: 0 };
      db.consent.push({ phone_norm: p[0], order_no: p[3] }); return { rows: [], rowCount: 1 };
    }
    if (/FROM review_invites WHERE sent_at IS NULL AND skip_reason IS NULL AND due_at <=/i.test(s)) return { rows: db.invites.filter((iv) => !iv.sent_at && !iv.skip_reason && Date.parse(iv.due_at) <= Date.parse(p[0])) };
    if (/^UPDATE review_invites SET sent_at=NOW\(\), channel=\$2 WHERE order_no=\$1/i.test(s)) { Object.assign(inv(p[0]), { sent_at: NOW, channel: p[1] }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE review_invites SET sent_at=NOW\(\), channel='sms' WHERE order_no=\$1/i.test(s)) { Object.assign(inv(p[0]), { sent_at: NOW, channel: "sms" }); return { rows: [], rowCount: 1 }; }
    const m = /^UPDATE review_invites SET (\w+)=\$2 WHERE order_no=\$1/i.exec(s); if (m) { inv(p[0])[m[1]] = p[1]; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const bot = {
    reviewAsk: async (x) => { db.asked.push(x); return typeof waReply === "function" ? waReply(x) : waReply; },
    neverReplyOf: async (ph) => { db.neverAsked.push(ph); if (neverThrows) throw new Error("db down"); return never[ph] || null; },
  };
  const api = reviews.register(fakeApp(), { pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb: JSON.stringify, normPhone: norm },
    { notify: () => ({ sendSmsTo: async (phone, body, meta) => { db.sms.push({ phone, body, meta }); return smsOk; } }), waReview: () => bot });
  return { api, db, run: (iso = NOW) => api.runInvites(new Date(iso)) };
}
const webInvite = (no, phone, extra = {}) => ({ order_no: no, code: `c${no.slice(-6)}`.toLowerCase(), phone_norm: phone, option: "delivery", kind: "delivery", due_at: ago(5), order_at: ago(90), ref: no, ...extra });
const posInvite = (id, phone, kind = "dinein") => ({ order_no: `pos:${id}`, code: `p${id}abcd`, phone_norm: phone, option: kind, kind, due_at: ago(5), order_at: ago(95), ref: null });
const reasons = (db) => Object.fromEntries(db.invites.map((x) => [x.order_no, x.skip_reason || (x.sent_at ? `sent:${x.channel}` : null)]));

test("RV5 send time: team / alert / portal-staff numbers on a web order get NO WhatsApp and NO SMS fallback (before RV5 the bot refused with never_reply and the SMS went out); the real customer next to them is still asked", async () => {
  const r = rig({
    invites: [
      webInvite("W1790000000001", P.botAlert), webInvite("W1790000000002", P.health), webInvite("W1790000000003", P.portalStaff),
      webInvite("W1790000000004", P.llmAlert), webInvite("W1790000000005", P.adsReport), webInvite("W1790000000006", P.deliveryAlert),
      webInvite("W1790000000009", P.customer),
    ],
    waReply: (x) => (x.phone === P.customer ? { ok: true, channel: "wa_template" } : { ok: false, skipped: "never_reply" }),
  });
  await r.run();
  assert.deepEqual(reasons(r.db), {
    W1790000000001: "staff", W1790000000002: "staff", W1790000000003: "staff", W1790000000004: "staff", W1790000000005: "staff", W1790000000006: "staff",
    W1790000000009: "sent:wa_template",
  });
  assert.deepEqual(r.db.asked.map((x) => x.phone), [P.customer], "WhatsApp asked only for the customer");
  assert.equal(r.db.sms.length, 0, "no SMS to any staff / alert number");
});

test("RV5 send time: a number the bot itself treats as «not a customer» (a courier on a recent shipment, …) is skipped on BOTH channels as staff:<why>; a never_reply refusal from reviewAsk never falls back to SMS; a failed bot read leaves the customer path as it was", async () => {
  const r = rig({
    invites: [webInvite("W1790000000011", P.courier), webInvite("W1790000000012", P.customer2), webInvite("W1790000000013", P.customer3), posInvite("8101", P.courier)],
    settings: fullSettings({ waBot: { ...fullSettings().waBot, reviewFlow: { smsVisits: true } } }),
    never: { [P.courier]: "courier" },
    waReply: (x) => (x.phone === P.customer2 ? { ok: false, skipped: "never_reply" } : { ok: false, skipped: "window_closed" }),
  });
  await r.run();
  assert.deepEqual(reasons(r.db), {
    W1790000000011: "staff:courier", "pos:8101": "staff:courier",
    W1790000000012: "staff:never_reply",
    W1790000000013: "sent:sms",
  });
  assert.deepEqual(r.db.sms.map((x) => x.phone), [P.customer3], "the SMS fallback still works for a real customer (WhatsApp window closed)");
  assert.ok(!r.db.asked.some((x) => x.phone === P.courier), "the courier never reaches reviewAsk");
  assert.equal(r.db.consent.length, 0, "no cashier-consent row for the courier's till bill");
  // the bot's read fails ⇒ null (like the bot itself); the settings list still holds and the customer is still asked
  const down = rig({ invites: [webInvite("W1790000000021", P.customer), webInvite("W1790000000022", P.team)], neverThrows: true, waReply: { ok: true, channel: "wa_list" } });
  await down.run();
  assert.deepEqual(reasons(down.db), { W1790000000021: "sent:wa_list", W1790000000022: "staff" });
});

test("RV5 till bills: new filler shapes and staff numbers get a closed invite (bad_number / staff) with NO consent row and NO message — even with smsVisits on; already-queued filler invites are caught at send time; the real customer is asked", async () => {
  const ts = [
    { order_id: "9101", order_date: ago(100), order_option: "Dine in", pn: "501234567" },
    { order_id: "9102", order_date: ago(100), order_option: "Take away", pn: "555555551" },
    { order_id: "9103", order_date: ago(100), order_option: "Dine in", pn: "550000000" },
    { order_id: "9104", order_date: ago(100), order_option: "Take away", pn: "561234567" },
    { order_id: "9105", order_date: ago(100), order_option: "Dine in", pn: "512121212" },
    { order_id: "9106", order_date: ago(100), order_option: "Dine in", pn: P.deliveryAlert },
    { order_id: "9107", order_date: ago(100), order_option: "Take away", pn: P.portalStaff },
    { order_id: "9110", order_date: ago(100), order_option: "Dine in", pn: P.customer },
  ];
  const settings = fullSettings({ waBot: { ...fullSettings().waBot, reviewFlow: { smsVisits: true } } });
  const r = rig({ ts, settings, invites: [posInvite("9001", "597654321", "takeaway"), posInvite("9002", "555000000")], waReply: { ok: false, skipped: "no_visit_template" } });
  await r.run();
  assert.deepEqual(reasons(r.db), {
    "pos:9001": "bad_number", "pos:9002": "bad_number",
    "pos:9101": "bad_number", "pos:9102": "bad_number", "pos:9103": "bad_number", "pos:9104": "bad_number", "pos:9105": "bad_number",
    "pos:9106": "staff", "pos:9107": "staff",
    "pos:9110": "sent:sms",
  });
  assert.deepEqual(r.db.consent.map((c) => c.phone_norm), [P.customer], "a consent row only for the real customer");
  assert.deepEqual(r.db.asked.map((x) => x.phone), [P.customer]);
  assert.deepEqual(r.db.sms.map((x) => x.phone), [P.customer], "smsVisits on: the SMS goes to the customer only");
  await r.run(ago(-5));
  assert.equal(r.db.invites.length, 10, "closed rows are never re-queued");
  assert.equal(r.db.sms.length, 1);
});

/* ═══ ٤) قراية للمالك: GET /api/cms/reviews/dummy-phones ═══ */
test("RV5 GET /api/cms/reviews/dummy-phones: till numbers of the last N days that the rule blocks (RV1 rule vs new in RV5, by shape, bills, masked), invite skip reasons, and ?phone= for one number — read-only, admin only", async () => {
  const routes = {}; const app = { get: (p, h) => { routes[`GET ${p}`] = h; }, post: () => {}, put: () => {}, delete: () => {} };
  const sql = [];
  const pool = { async query(q, p = []) {
    const s = String(q).replace(/\s+/g, " ").trim(); sql.push(s);
    if (/^SELECT x\.pn, count\(DISTINCT x\.oid\)::int AS bills/i.test(s)) {
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(p[0]));
      return { rows: [
        { pn: "555555555", bills: 40, last_at: NOW }, { pn: "551234567", bills: 9, last_at: NOW }, { pn: "500000001", bills: 1, last_at: NOW },
        { pn: P.customer, bills: 3, last_at: NOW }, { pn: P.deliveryAlert, bills: 2, last_at: NOW }, { pn: P.customer2, bills: 1, last_at: NOW },
      ] };
    }
    if (/^SELECT split_part\(skip_reason, ':', 1\) AS reason/i.test(s)) return { rows: [{ reason: "staff", n: 3 }, { reason: "bad_number", n: 2 }] };
    if (/^(INSERT|UPDATE|DELETE)/i.test(s) && /review_invites|wa_optin_log/i.test(s)) throw new Error("the stats route must not write");
    return { rows: [], rowCount: 0 };
  } };
  let denied = false;
  reviews.register(app, { pool, requireAdmin: async () => (denied ? { status: 401 } : null), getSettingsData: async () => fullSettings(), jb: JSON.stringify, normPhone: norm }, {});
  const h = routes["GET /api/cms/reviews/dummy-phones"]; assert.ok(h);
  const call = (q = {}) => h({ req: { query: (k) => q[k] }, json: (body, status = 200) => ({ body, status }) });
  await new Promise((res) => setTimeout(res, 20));      // boot (schema) settles first — only the route's own SQL is checked below
  const boot = sql.length;
  const r = await call({ days: "30" });
  assert.equal(r.status, 200);
  const b = r.body;
  assert.deepEqual([b.ok, b.days, b.tillPhones, b.placeholder, b.byRv1Rule, b.newByRv5, b.oneBill, b.onSkipList, b.sharedBills], [true, 30, 6, 3, 1, 2, 1, 1, 4]);
  assert.deepEqual(b.byWhy, { classic: 1, straight: 1, seven_run: 1 });
  assert.deepEqual(b.newOnes.map((x) => [x.phone, x.why, x.bills]), [["55•••••67", "straight", 9], ["50•••••01", "seven_run", 1]]);
  assert.deepEqual(b.inviteSkips, { staff: 3, bad_number: 2 });
  assert.doesNotMatch(JSON.stringify(b), /551234567|500000001|534781260|531110001/, "no full phone in the answer");
  const one = await call({ phone: "0551234567" });
  assert.deepEqual(one.body.check, { phone: "55•••••67", placeholder: true, why: "straight", rv1Rule: false, skipList: false });
  assert.deepEqual((await call({ phone: `+966${P.deliveryAlert}` })).body.check, { phone: "53•••••01", placeholder: false, why: null, rv1Rule: false, skipList: true });
  assert.equal((await call({ days: "500" })).body.days, 90);
  denied = true; assert.deepEqual(await call(), { status: 401 });
  assert.ok(!sql.slice(boot).some((s) => /^(INSERT|UPDATE|DELETE|CREATE|ALTER)/i.test(s)), "read-only");
});
