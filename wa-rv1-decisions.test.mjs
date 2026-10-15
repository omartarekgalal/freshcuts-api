/* RV1 — قرارات عمر ١٥/١٠/٢٠٢٦ ١٤:١٥ فوق الشريحة:
     ١) «موافق على كل حاجة» — نص قالب النجوم اتوافق عليه (بيتقدّم بعد النشر، مش دلوقتي: لسه HOLD لحد force:true).
     ٢) «ابعت أرقام كيتا عادي، دول عملائي واشتروا مني» — مفتاح التطبيقات مفتوح افتراضياً (ولسه إعداد في اللوحة).
     ٣) «جوجل تقييمات ده قراري اثبت عليه» — جوجل لـ٤–٥ بس (من غير تغيير — wa-rv1.test.mjs).
     ٤) «عملاء المحل صالة وتيك أواي موافقين مسبقاً وقت الدفع عند الكاشير» — مصدر موافقة pos_payment لطلب التقييم بس.
     ٥) «التقييمات لازم تظهر ف البورتال عند المدير عشان يقفلها من عنده» — portalreviews.js (نفس صف الوارد في اللوحة).
   node --test wa-rv1-decisions.test.mjs — قواعد مزيّفة، من غير شبكة ولا رسايل. */
import test from "node:test";
import assert from "node:assert/strict";

process.env.REVIEW_INVITE_MINUTES = "0";
process.env.REVIEWS_GOOGLE_JOB = "0";
const RV = await import("./wareviews.js");
const reviews = await import("./reviews.js");
const PR = await import("./portalreviews.js");
const WC = await import("./waconsent.js");
const AU = await import("./reviewaudience.js");
const W = await import("./whatsapp.js");
const CAT = await import("./watemplates.js");
W.registerCatalog(CAT);

const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN", "WHATSAPP_TEST_PHONE_ID"];
const ALLOW = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1", WHATSAPP_ENABLED: "1" };
function withEnv(vals, fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, vals);
    try { await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
}
const norm = (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
const fakeApp = () => { const routes = {}; const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; };
const CUST = "534781260";      // رقم عميل شكله حقيقي (512345678 رقم حشو — phonecheck.js)

/* ═══ ١) القالب: النص اتوافق عليه، بس التقديم بعد النشر (لسه HOLD ⇒ force:true) ═══ */
test("decision 1: fc_review_stars wording is the approved one and stays held until the post-deploy submit (force:true)", () => {
  const t = CAT.findTemplate("fc_review_stars");
  assert.equal(CAT.previewText(t), "فريش كاتس تشكرك 🌟\nكيف تقيّم طلبك رقم W1790012345678؟ اختر من الأزرار 👇");
  assert.match(CAT.HOLD.fc_review_stars, /اتوافق|موافق/);
  assert.match(CAT.HOLD.fc_review_stars, /بعد النشر/);
});

/* ═══ ٢ + ٤) الإعدادات ═══ */
test("decisions 2 + 4: Keeta switch ON by default, «عملاء الكاشير موافقين وقت الدفع» ON by default, portal cashier view OFF — all three are dashboard settings with Arabic labels", () => {
  const f = RV.reviewFlowConfig({});
  assert.deepEqual([f.apps, f.posConsent, f.portalCashier], [true, true, false]);
  assert.deepEqual([RV.reviewFlowConfig({ apps: false }).apps, RV.reviewFlowConfig({ posConsent: false }).posConsent, RV.reviewFlowConfig({ portalCashier: true }).portalCashier], [false, false, true]);
  for (const k of ["apps", "posConsent", "portalCashier"]) {
    const row = RV.REVIEW_FLOW_SCHEMA[`reviewFlow.${k}`];
    assert.ok(row && row.type === "boolean" && row.group === "reviews" && /[؀-ۿ]/.test(row.ar), k);
  }
  assert.equal(RV.REVIEW_FLOW_SCHEMA["reviewFlow.posConsent"].ar, "عملاء الكاشير موافقين وقت الدفع");
  assert.match(RV.REVIEW_FLOW_SCHEMA["reviewFlow.posConsent"].help, /لطلب التقييم بس/);
  assert.deepEqual(RV.reviewFlowFromBody({ posConsent: false, portalCashier: true }, {}), { ok: true, value: { posConsent: false, portalCashier: true } });
  assert.equal(RV.reviewFlowFromBody({ posConsent: "yes" }).ok, false);
  assert.deepEqual([WC.posReviewConsentOn({}), WC.posReviewConsentOn({ waBot: { reviewFlow: { posConsent: false } } }), WC.posReviewConsentOn({ waBot: { reviewFlow: { enabled: false } } })], [true, false, false]);
});

/* ═══ ٤) مصدر الموافقة: بيتسجّل لفواتير الصالة/السفري بس، ومع الإعداد بس ═══ */
const ORDER_T = Date.parse("2026-10-15T15:00:00Z");      // 18:00 الرياض
const ago = (min) => new Date(ORDER_T - min * 60_000).toISOString();
/* Postgres (node-pg من غير أنواع) بيرفض أي براميتر مش مستخدم (42P18) وأي $n مالوش قيمة — القاعدة المزيّفة بترفض زيه */
function pgParamsCheck(sql, params = []) {
  const used = new Set([...String(sql).matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  for (let i = 1; i <= params.length; i++) if (!used.has(i)) throw Object.assign(new Error("could not determine data type of parameter $" + i), { code: "42P18" });
  for (const i of used) if (i > params.length) throw Object.assign(new Error("bind message supplies " + params.length + " parameters"), { code: "08P01" });
}
function reviewsRig({ ts = [], invites = [], flow = {}, waReply = null, consent = [], bills = {}, billCounts = {}, countFail = false } = {}) {
  const db = { invites: invites.map((x) => ({ ...x })), consent, sms: [], asked: [], sql: [] };
  const inv = (no) => db.invites.find((x) => x.order_no === no);
  const pool = { async query(q, p = []) {
    const s = String(q).replace(/\s+/g, " ").trim(); db.sql.push(s);
    pgParamsCheck(s, p);
    /* عدد فواتير الرقم في آخر ٢٤ ساعة: billCounts[pn] أو العدّ من ts (countFail ⇒ القاعدة وقعت) */
    if (/FROM ts_orders b LEFT JOIN order_sources bs/i.test(s)) {
      if (countFail) throw new Error("db down");
      return { rows: p[1].map((pn) => ({ pn, n: pn in billCounts ? billCounts[pn] : ts.filter((o) => o.pn === pn && Date.parse(o.order_date) > Date.parse(p[0])).length })).filter((r) => r.n > 0) };
    }
    if (/^INSERT INTO review_invites\(order_no, code, phone_norm, option, due_at, kind, order_at, ref, skip_reason\)/i.test(s)) {
      if (inv(p[0])) return { rows: [], rowCount: 0 };
      db.invites.push({ order_no: p[0], code: p[1], phone_norm: p[2], option: p[3], due_at: p[4], kind: p[5], order_at: p[6], ref: p[7], skip_reason: p[8] }); return { rows: [], rowCount: 1 };
    }
    /* الفاتورة وقت السؤال (reviews.js بيقراها تاني قبل أي رسالة): bills[id] = { pn, src, order_type } | "missing" | "error" — من غيره نفس جوال الفاتورة/الدعوة */
    if (/^SELECT o\.order_type, COALESCE\(s\.source, ''\) AS src/i.test(s)) {
      const b = bills[p[0]];
      if (b === "error") throw new Error("db down");
      if (b === "missing") return { rows: [] };
      const t = ts.find((o) => String(o.order_id) === String(p[0])), iv0 = inv(`pos:${p[0]}`);
      return { rows: [{ order_type: (b && b.order_type) ?? null, src: (b && b.src) ?? "", pn: b && "pn" in b ? b.pn : t ? t.pn || null : iv0 ? iv0.phone_norm : null }] };
    }
    if (/FROM ts_orders o LEFT JOIN order_sources s/i.test(s)) {
      return { rows: ts.filter((o) => Date.parse(o.order_date) > Date.parse(p[0]) && !inv(`pos:${o.order_id}`)).map((o) => ({ order_id: o.order_id, receipt: o.receipt || "", order_date: o.order_date, order_option: o.order_option, pn: o.pn || null, is_app: Boolean(o.is_app), web_near: false })) };
    }
    if (/^INSERT INTO review_invites\(order_no, code, phone_norm, option, due_at, kind, order_at, ref\)/i.test(s)) {
      if (inv(p[0])) return { rows: [], rowCount: 0 };
      db.invites.push({ order_no: p[0], code: p[1], phone_norm: p[2], option: p[3], due_at: p[4], kind: p[5], order_at: p[6], ref: p[7] }); return { rows: [{ code: p[1] }], rowCount: 1 };
    }
    if (/^INSERT INTO wa_optin_log\(phone_norm, kind, value, text_version, text, source, order_no, ip, ua, at\) SELECT \$1, 'review', TRUE/i.test(s)) {
      if (db.consent.some((c) => c.order_no === p[3] && c.phone_norm === p[0])) return { rows: [], rowCount: 0 };
      db.consent.push({ phone_norm: p[0], kind: "review", value: true, text_version: p[1], text: p[2], source: "pos_payment", order_no: p[3], ua: p[4], at: p[5] }); return { rows: [], rowCount: 1 };
    }
    if (/FROM review_invites WHERE sent_at IS NULL AND skip_reason IS NULL AND due_at <=/i.test(s)) return { rows: db.invites.filter((iv) => !iv.sent_at && !iv.skip_reason && Date.parse(iv.due_at) <= Date.parse(p[0])) };
    if (/^UPDATE review_invites SET sent_at=NOW\(\), channel=\$2 WHERE order_no=\$1/i.test(s)) { Object.assign(inv(p[0]), { sent_at: new Date(ORDER_T).toISOString(), channel: p[1] }); return { rows: [], rowCount: 1 }; }
    const m = /^UPDATE review_invites SET (\w+)=\$2 WHERE order_no=\$1/i.exec(s); if (m) { inv(p[0])[m[1]] = p[1]; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const settings = { reviews: { threshold: 4, googleUrl: "https://g.page/r/CSG0gPAqlvHMEBM/review", askMaxAgeHours: 20 }, delivery: { alertPhones: [] }, waBot: { testPhones: [], reviewFlow: flow } };
  const api = reviews.register(fakeApp(), { pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb: JSON.stringify, normPhone: norm },
    { notify: () => ({ sendSmsTo: async (phone, body) => { db.sms.push({ phone, body }); return true; } }),
      ...(waReply ? { waReview: () => ({ reviewAsk: async (x) => { db.asked.push(x); return typeof waReply === "function" ? waReply(x) : waReply; } }) } : {}) });
  return { api, db, settings, run: (isoT) => api.runInvites(new Date(isoT)) };
}

test("decision 4: a dine-in / takeaway bill with the customer's phone records ONE pos_payment consent row (phone, bill, time of the bill, the owner's wording); app orders and web orders never; setting off ⇒ nothing recorded", async () => {
  const ts = [
    { order_id: "9001", order_date: ago(100), order_option: "Dine in", pn: "531478260", receipt: "1043" },
    { order_id: "9002", order_date: ago(60), order_option: "Take away", pn: "542689137" },
    { order_id: "9003", order_date: ago(120), order_option: "Take away", pn: "553791024", is_app: true },
  ];
  const r = reviewsRig({ ts, waReply: { ok: false, skipped: "no_visit_template" } });
  await r.run("2026-10-15T15:00:00Z");
  assert.deepEqual(r.db.consent.map((c) => [c.phone_norm, c.order_no, c.source, c.kind, c.text_version, c.at]).sort(), [
    ["531478260", "pos:9001", "pos_payment", "review", WC.POS_REVIEW_CONSENT.version, ago(100)],
    ["542689137", "pos:9002", "pos_payment", "review", WC.POS_REVIEW_CONSENT.version, ago(60)],
  ].sort(), "Keeta (app) order: the consent is the cashier's payment, apps have none");
  assert.match(r.db.consent[0].text, /وقت الدفع عند الكاشير/);
  assert.equal(r.db.consent.find((c) => c.order_no === "pos:9001").ua, "receipt:1043");
  assert.ok(r.db.invites.some((x) => x.order_no === "pos:9003" && x.kind === "app"), "…but the Keeta order does get its invite (decision 2)");
  await r.run("2026-10-15T15:10:00Z");
  assert.equal(r.db.consent.length, 2, "once per bill");
  const off = reviewsRig({ ts, flow: { posConsent: false }, waReply: { ok: false, skipped: "no_visit_template" } });
  await off.run("2026-10-15T15:00:00Z");
  assert.equal(off.db.consent.length, 0);
  // the setting opened AFTER the invite was queued ⇒ the row is written just before the ask
  const late = reviewsRig({ invites: [{ order_no: "pos:7001", code: "ab12cd34", phone_norm: "564802135", option: "dinein", kind: "dinein", due_at: ago(5), order_at: ago(95), ref: "فاتورة 88" }], waReply: { ok: false, skipped: "no_optin" } });
  await late.run("2026-10-15T15:00:00Z");
  assert.deepEqual(late.db.consent.map((c) => [c.order_no, c.at, c.ua]), [["pos:7001", ago(95), "receipt:88"]]);
  assert.equal(await WC.recordPosReviewConsent({ query: async () => ({ rows: [], rowCount: 1 }) }, { phoneNorm: CUST, orderNo: "W1790012345678", kind: "delivery" }).then((x) => x.error), "not_pos_order");
  assert.equal(await WC.recordPosReviewConsent({ query: async () => ({ rows: [], rowCount: 1 }) }, { phoneNorm: CUST, orderNo: "pos:1", kind: "app" }).then((x) => x.error), "kind_not_covered");
});

/* عالم واتساب صغير (الحارس الحقيقي، fetch مزيّف) + نفس سجل الموافقة */
function waWorld({ settings = {}, optins = {}, consent = [], terms = [] } = {}) {
  const db = { settings: { notifications: { whatsappEnabled: true }, waMaster: { enabled: true }, waBot: { testPhones: [] }, ...settings }, optins: { ...optins }, consent, terms, msgs: [] };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: [] };      // النافذة مقفولة
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: db.optins[p[0]] ? [db.optins[p[0]]] : [] };
    if (/^SELECT text_version FROM wa_optin_log WHERE kind='terms'/i.test(s)) return { rows: db.terms.filter((t) => t.order === p[0] && t.phone === p[1]).map((t) => ({ text_version: t.version })) };
    if (/^SELECT 1 FROM wa_optin_log WHERE kind='review' AND source='pos_payment' AND value AND order_no=\$1 AND phone_norm=\$2 AND text_version=\$3/i.test(s)) {
      return { rows: db.consent.filter((c) => c.order_no === p[0] && c.phone_norm === p[1] && c.text_version === p[2] && c.value !== false).map(() => ({})) };
    }
    if (/FROM cms_contacts/i.test(s)) return { rows: [], rowCount: 0 };
    if (/^INSERT INTO wa_messages/i.test(s)) { db.msgs.push({ wamid: p[0], phone_norm: p[1], template: p[2], status: p[6] }); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.R${calls.length}` }] }) }; };
  const wa = W.register(fakeApp(), { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: JSON.stringify, normPhone: norm }, { fetch, sendSms: async () => ({ ok: true }) });
  return { db, wa, calls };
}
const consentRow = (order = "pos:9001", phone = CUST) => ({ phone_norm: phone, order_no: order, kind: "review", source: "pos_payment", value: true, text_version: WC.POS_REVIEW_CONSENT.version });

test("decision 4 (guard): the pos_payment consent opens the review template only — same phone, same bill, setting on; never another template, a web order, another source, a stopped customer or an explicit «لا»; marketing rules untouched", withEnv(ALLOW, async () => {
  const g = (w, extra = {}) => w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_review_stars", source: "review", orderNo: "pos:9001", ...extra });
  const w = waWorld({ consent: [consentRow()] });
  assert.equal((await g(w)).ok, true, "till customer + consent row + setting on ⇒ the stars template may go");
  assert.equal((await g(w, { template: "fc_order_preparing" })).reason, "no_optin", "an order-update template is not covered: review requests only");
  assert.equal((await g(w, { template: "fc_review_request" })).reason, "no_optin", "only the stars template, not the old link template");
  assert.equal((await g(w, { source: "bot" })).reason, "no_optin", "only from the review sweep");
  assert.equal((await g(w, { source: null })).reason, "no_optin");
  assert.equal((await g(w, { orderNo: "pos:9002" })).reason, "no_optin", "another bill has no row");
  assert.equal((await g(w, { orderNo: "W1790012345678" })).reason, "no_optin", "a website order rests on the terms, not on the cashier");
  assert.equal((await w.wa.guardSend({ phoneNorm: "598765432", kind: "template", template: "fc_review_stars", source: "review", orderNo: "pos:9001" })).reason, "no_optin", "the consent belongs to the phone on the bill");
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "session" })).reason, "window_closed", "it never opens free-form messages");
  const off = waWorld({ consent: [consentRow()], settings: { waBot: { testPhones: [], reviewFlow: { posConsent: false } } } });
  assert.equal((await g(off)).reason, "no_optin", "«عملاء الكاشير موافقين وقت الدفع» off ⇒ no send, even with the row");
  const flowOff = waWorld({ consent: [consentRow()], settings: { waBot: { testPhones: [], reviewFlow: { enabled: false } } } });
  assert.equal((await g(flowOff)).reason, "no_optin");
  const stopped = waWorld({ consent: [consentRow()], optins: { [CUST]: { updates: false, stopped_at: "2026-10-14T08:00:00Z" } } });
  assert.equal((await g(stopped)).reason, "opted_out", "«إيقاف» wins");
  const saidNo = waWorld({ consent: [consentRow()], optins: { [CUST]: { updates: false, answered_at: "2026-10-12T20:00:00Z" } } });
  assert.equal((await g(saidNo)).reason, "no_optin", "an explicit «لا» wins");
  const marketingTpl = Object.keys(W.TEMPLATES).find((n) => W.TEMPLATES[n].category === "MARKETING");
  const none = waWorld();
  assert.equal((await none.wa.guardSend({ phoneNorm: CUST, kind: "template", template: marketingTpl })).ok, true, "marketing is still the owner's 13/10 rule — not widened, not narrowed");
  assert.equal((await g(none)).reason, "no_optin", "no row ⇒ no send");
  assert.equal(w.calls.length + off.calls.length + stopped.calls.length + saidNo.calls.length + none.calls.length, 0, "the guard alone sends nothing");
  // end to end through sendTemplate: the template leaves with the bill's subject
  const ok = await w.wa.sendTemplate({ phoneNorm: CUST, template: "fc_review_stars", params: { body: ["زيارتك للمطعم"] }, orderNo: "pos:9001", stage: "review", source: "review" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(w.calls.at(-1).body.template.name, "fc_review_stars");
}));

test("decision 4 (sweep): till invite + setting on ⇒ the stars template goes; setting off ⇒ no send and no SMS; a stopped customer ⇒ nothing at all; the Keeta order (no cashier consent) ⇒ no template", withEnv(ALLOW, async () => {
  const run = async ({ flow = {}, optins = {}, kind = "dinein", orderNo = "pos:9001" } = {}) => {
    const consent = [];
    let w = null;
    const ask = async (x) => {      // نفس ربط wabotrun.reviewAsk لقالب النجوم بره النافذة: opted_out ⇒ final
      const r = await w.wa.sendTemplate({ phoneNorm: norm(x.phone), template: "fc_review_stars", params: { body: [x.kind === "dinein" ? "زيارتك للمطعم" : "طلبك من الفرع"] }, orderNo: x.orderNo, stage: "review", source: "review" });
      if (r.ok) return { ok: true, channel: "wa_stars", wamid: r.wamid };
      return r.skipped === "opted_out" ? { ok: false, skipped: "opted_out", final: true } : { ok: false, skipped: r.skipped };
    };
    const r = reviewsRig({ flow: { starsTemplate: true, ...flow }, consent, waReply: ask,
      invites: [{ order_no: orderNo, code: "ab12cd34", phone_norm: CUST, option: kind, kind, due_at: ago(5), order_at: ago(95), ref: "فاتورة 1043" }] });
    w = waWorld({ consent, optins, settings: { waBot: { testPhones: [], reviewFlow: { starsTemplate: true, ...flow } } } });
    await r.run("2026-10-15T15:00:00Z");
    return { iv: r.db.invites[0], sms: r.db.sms, calls: w.calls, consent };
  };
  const on = await run();
  assert.deepEqual([on.iv.channel, on.iv.wa_msg_id, on.calls.length, on.sms.length], ["wa_stars", "wamid.R1", 1, 0]);
  const off = await run({ flow: { posConsent: false } });
  assert.deepEqual([off.iv.skip_reason, off.calls.length, off.sms.length, off.consent.length], ["no_sms_visit:no_optin", 0, 0, 0], "till phone without the consent setting ⇒ no WhatsApp, no SMS");
  const stopped = await run({ optins: { [CUST]: { updates: false, stopped_at: "2026-10-14T08:00:00Z" } } });
  assert.deepEqual([stopped.iv.skip_reason, stopped.calls.length, stopped.sms.length], ["wa_opted_out", 0, 0], "stopped customer ⇒ nothing");
  const keeta = await run({ kind: "app", orderNo: "pos:9003" });
  assert.deepEqual([keeta.iv.skip_reason, keeta.calls.length, keeta.consent.length], ["no_sms_visit:no_optin", 0, 0], "a Keeta order has no cashier consent: no template outside the window");
}));

/* ═══ مراجعة ١٥/١٠ — الشخص الغلط: الفاتورة بتتقري تاني وقت السؤال ═══
   الكاشير صلّح رقم غلط بعد ما الدعوة اتعملت ⇒ ولا رسالة للرقم القديم (موافقة الدفع عند الكاشير مش بتاعته). قبل قرار ١٥/١٠ الدعوة القديمة
   ماكانتش بتطلع لأن الغريب مالوش نافذة وsmsVisits مقفول — موافقة الكاشير هي اللي كانت هتخلّيها تطلع. */
test("review fix (wrong person): the bill is read again right before the ask — phone corrected after queueing ⇒ nothing to the old number (phone_changed); bill now a website order ⇒ web_order; voided ⇒ voided; bill gone ⇒ bill_missing; bill check fails ⇒ the invite waits", withEnv(ALLOW, async () => {
  const TYPO = "551234567", RIGHT = "551234576";
  // the scenario from the review, end to end: dine-in bill 18:00 with the typo (this rig: ago(100)), the 17:40 sweep queues it (not due yet: +90)
  const ts = [{ order_id: "9101", order_date: ago(100), order_option: "Dine in", pn: TYPO, receipt: "2001" }];
  const consent = [];
  let w = null;
  const ask = async (x) => {
    const r = await w.wa.sendTemplate({ phoneNorm: norm(x.phone), template: "fc_review_stars", params: { body: ["زيارتك للمطعم"] }, orderNo: x.orderNo, stage: "review", source: "review" });
    return r.ok ? { ok: true, channel: "wa_stars", wamid: r.wamid } : { ok: false, skipped: r.skipped };
  };
  const r = reviewsRig({ ts, consent, flow: { starsTemplate: true }, waReply: ask });
  w = waWorld({ consent, settings: { waBot: { testPhones: [], reviewFlow: { starsTemplate: true } } } });
  await r.run(ago(20));
  assert.deepEqual(r.db.invites.map((x) => [x.order_no, x.phone_norm, x.sent_at, x.skip_reason]), [["pos:9101", TYPO, undefined, undefined]], "queued with the typo, not due yet");
  assert.deepEqual(consent.map((c) => c.phone_norm), [TYPO], "the queue-time proof row (written before anyone could know)");
  ts[0].pn = RIGHT;      // 18:45: the cashier corrects the number (order_sources ON CONFLICT … phone_norm=EXCLUDED.phone_norm)
  await r.run("2026-10-15T15:00:00Z");
  assert.deepEqual([r.db.invites[0].skip_reason, r.db.asked.length, w.calls.length, r.db.sms.length], ["phone_changed", 0, 0, 0], "no template, no SMS — to anyone");
  assert.equal(consent.length, 1, "no proof row re-written for the old number before an ask");
  // unchanged phone ⇒ goes as before (same rig shape)
  const ok = reviewsRig({ invites: [{ order_no: "pos:9102", code: "ab12cd35", phone_norm: RIGHT, option: "dinein", kind: "dinein", due_at: ago(5), order_at: ago(95), ref: "فاتورة 2002" }], bills: { 9102: { pn: RIGHT } }, waReply: { ok: true, channel: "wa_stars" } });
  await ok.run("2026-10-15T15:00:00Z");
  assert.deepEqual([ok.db.invites[0].channel, ok.db.asked.length], ["wa_stars", 1]);
  // the other re-checks
  const one = async (bill, kind = "dinein") => {
    const x = reviewsRig({ invites: [{ order_no: "pos:9103", code: "ab12cd36", phone_norm: RIGHT, option: kind, kind, due_at: ago(5), order_at: ago(95), ref: null }], bills: { 9103: bill }, waReply: { ok: true, channel: "wa_stars" } });
    await x.run("2026-10-15T15:00:00Z");
    return [x.db.invites[0].skip_reason, x.db.invites[0].sent_at ? "sent" : null, x.db.asked.length, x.db.consent.length];
  };
  assert.deepEqual(await one({ pn: RIGHT, src: "website" }), ["web_order", null, 0, 0], "linked to a website order since ⇒ its invite is the website one");
  assert.deepEqual(await one({ pn: RIGHT, order_type: "QR-Menu" }), ["web_order", null, 0, 0]);
  assert.deepEqual(await one({ pn: RIGHT, order_type: "Void" }), ["voided", null, 0, 0]);
  assert.deepEqual(await one("missing"), ["bill_missing", null, 0, 0]);
  assert.deepEqual(await one({ pn: null }), ["phone_changed", null, 0, 0], "phone removed from the bill");
  assert.deepEqual(await one("error"), [undefined, null, 0, 0], "database down ⇒ the invite waits for the next sweep (no decision)");
}));

/* ═══ ٥) البورتال: التقييمات الواطية عند المدير — نفس صف الوارد في اللوحة ═══ */
const NOW = Date.now();
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();
function portalRig({ rows = [], settings = {}, handovers = [], chats = {} } = {}) {
  const db = { reviews: rows.map((r) => ({ resolved: false, is_test: false, hidden_at: null, rating_exact: true, categories: [], outcome: null, portal_seen_at: null, ...r })), actions: [], handovers: handovers.map((h) => ({ ...h })), sql: [],
    chats: Object.fromEntries(Object.entries(chats).map(([k, v]) => [k, { ...v }])) };
  const byId = (id) => db.reviews.find((r) => r.id === Number(id));
  const lowReal = (r) => r.rating < 4 && !r.is_test && !r.hidden_at;
  const inPortal = (r) => lowReal(r) && ((!r.resolved && Date.parse(r.created_at) > NOW - 30 * 86400_000) || (r.resolved && r.resolved_at && Date.parse(r.resolved_at) > NOW - 7 * 86400_000));
  const pool = { async query(q, p = []) {
    const s = String(q).replace(/\s+/g, " ").trim(); db.sql.push(s);
    pgParamsCheck(s, p);
    if (/^(CREATE|ALTER)/i.test(s) || /^ALTER TABLE reviews ADD COLUMN IF NOT EXISTS outcome/i.test(s)) return { rows: [], rowCount: 0 };
    /* مراجعة RV1: قفل التقييم ⇒ تحويل «تقييم واطي» المفتوح على محادثة واتساب بيتمسح (البوت يرجع) */
    if (/^UPDATE wa_bot_chats SET handoff_at=NULL, handoff_reason=NULL, unknown_streak=0, released_at=NOW\(\), updated_at=NOW\(\) WHERE phone_norm=\$1 AND handoff_reason = ANY\(\$2::text\[\]\)/i.test(s)) {
      const ch = db.chats[p[0]]; if (!ch || !p[1].includes(ch.handoff_reason)) return { rows: [], rowCount: 0 };
      Object.assign(ch, { handoff_at: null, handoff_reason: null, unknown_streak: 0, released_at: new Date().toISOString() }); return { rows: [], rowCount: 1 };
    }
    if (/count\(\*\) FILTER \(WHERE NOT r\.resolved AND \(r\.outcome IS NULL/i.test(s)) {
      const f = p[0]; const list = db.reviews.filter(inPortal);
      const unread = list.filter((r) => !r.resolved && !r.portal_seen_at && !r.outcome);
      return { rows: [{ new: list.filter((r) => !r.resolved && !f.includes(r.outcome)).length, follow: list.filter((r) => !r.resolved && f.includes(r.outcome)).length, closed: list.filter((r) => r.resolved).length,
        unread: unread.length, newest_unread: unread.length ? Math.max(...unread.map((r) => r.id)) : null }] };
    }
    if (/^SELECT r\.id, r\.rating, r\.rating_exact/i.test(s)) return { rows: db.reviews.filter(inPortal).sort((a, b) => (a.resolved - b.resolved) || Date.parse(b.created_at) - Date.parse(a.created_at)).map((r) => ({ ...r, ref: r.ref || null })) };
    if (/^SELECT review_id, at, by_name/i.test(s)) return { rows: db.actions.filter((a) => p[0].includes(a.review_id)) };
    if (/^SELECT id, rating, phone_norm, resolved, is_test, hidden_at FROM reviews WHERE id=\$1/i.test(s)) { const r = byId(p[0]); return { rows: r ? [r] : [] }; }
    if (/^UPDATE reviews SET resolved=TRUE, resolved_by=\$2, resolved_at=NOW\(\), resolution_note=\$3, outcome=\$4/i.test(s)) {
      const r = byId(p[0]); if (!r) return { rows: [], rowCount: 0 };
      Object.assign(r, { resolved: true, resolved_by: p[1], resolved_at: new Date().toISOString(), resolution_note: p[2], outcome: p[3], outcome_at: new Date().toISOString(), outcome_by: p[1], outcome_via: p[4], portal_seen_at: r.portal_seen_at || new Date().toISOString() });
      return { rows: [{ phone_norm: r.phone_norm }], rowCount: 1 };
    }
    if (/^UPDATE reviews SET resolved=FALSE, resolved_by=NULL, resolved_at=NULL, resolution_note=\$3, outcome=\$4/i.test(s)) {
      const r = byId(p[0]); if (!r) return { rows: [], rowCount: 0 };
      Object.assign(r, { resolved: false, resolved_by: null, resolved_at: null, resolution_note: p[2], outcome: p[3], outcome_at: new Date().toISOString(), outcome_by: p[1], outcome_via: p[4], portal_seen_at: r.portal_seen_at || new Date().toISOString() });
      return { rows: [{ phone_norm: r.phone_norm }], rowCount: 1 };
    }
    if (/^UPDATE reviews SET resolved=FALSE, resolved_by=NULL, resolved_at=NULL, resolution_note=NULL, outcome=NULL/i.test(s)) { const r = byId(p[0]); Object.assign(r, { resolved: false, resolved_by: null, resolved_at: null, resolution_note: null, outcome: null }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE reviews SET portal_seen_at=NOW\(\), portal_seen_by=\$2 WHERE id = ANY/i.test(s)) {
      const hit = db.reviews.filter((r) => p[0].includes(r.id) && !r.portal_seen_at && r.rating < 4); hit.forEach((r) => { r.portal_seen_at = new Date().toISOString(); r.portal_seen_by = p[1]; });
      return { rows: hit.map((r) => ({ id: r.id })), rowCount: hit.length };
    }
    if (/^UPDATE reviews SET portal_seen_at=COALESCE/i.test(s)) { const r = byId(p[0]); if (r && !r.portal_seen_at) { r.portal_seen_at = new Date().toISOString(); r.portal_seen_by = p[1]; } return { rows: [], rowCount: 1 }; }
    if (/^INSERT INTO review_actions/i.test(s)) { db.actions.push({ review_id: p[0], action: p[1], outcome: p[2], note: p[3], by_name: p[4], by_role: p[5], via: p[6], at: new Date().toISOString() }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_handovers SET acked_at=NOW\(\), acked_by=\$2 WHERE phone_norm=\$1 AND reason='review_low'/i.test(s)) {
      const hit = db.handovers.filter((h) => h.phone_norm === p[0] && h.reason === "review_low" && !h.acked_at); hit.forEach((h) => { h.acked_at = "now"; h.acked_by = p[1]; });
      return { rows: hit.map((h) => ({ id: h.id })), rowCount: hit.length };
    }
    /* reviews.js — وارد اللوحة (GET /api/cms/reviews) */
    if (/^SELECT id, rating, comment, categories, code_label, channel, phone_norm, name, went_google, resolved/i.test(s)) {
      let list = db.reviews.filter((r) => !r.is_test && !r.hidden_at);
      if (/resolved=FALSE AND rating < 4/.test(s)) list = list.filter((r) => !r.resolved && r.rating < 4);
      return { rows: list };
    }
    if (/count\(\*\)::int AS n FROM reviews WHERE NOT/i.test(s)) return { rows: [{ n: 0 }] };
    return { rows: [], rowCount: 0 };
  } };
  const events = [], audits = [];
  const app = fakeApp();
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb: JSON.stringify, normPhone: norm };
  const requirePortal = async (c) => {
    const role = c.__role;
    if (!role) return { res: c.json({ ok: false, error: "unauthorized" }, 401) };
    if (role === "kitchen") return { res: c.json({ ok: false, error: "kitchen_only" }, 403) };
    return { user: { id: role === "manager" ? "st_m" : "st_c", name: role === "manager" ? "أبو فهد" : "أحمد", role } };
  };
  PR.register(app, ctx, { requirePortal, broadcast: (e, d, o) => events.push([e, d, o]), audit: (...a) => audits.push(a), ready: async () => true });
  reviews.register(app, ctx, { broadcast: (e, d, o) => events.push([e, d, o]), sessionUser: null });
  const call = async (method, path, { role = "manager", id = null, body = {}, query = {} } = {}) => {
    const c = { __role: role, req: { param: (k) => (k === "id" ? id : undefined), json: async () => body, header: () => undefined, query: (k) => query[k] }, json: (b, status = 200) => ({ body: b, status }) };
    return app.routes[`${method} ${path}`](c);
  };
  return { db, events, audits, call };
}
const LOW = () => [
  { id: 11, rating: 2, phone_norm: "512345678", order_no: "W1790012345678", kind: "delivery", channel: "whatsapp", comment: "الأكل وصل بارد", categories: ["التوصيل"], created_at: minsAgo(30) },
  { id: 12, rating: 3, rating_exact: false, phone_norm: "523456789", order_no: "pos:9001", ref: "فاتورة 1043", kind: "dinein", channel: "whatsapp", created_at: minsAgo(90) },
  { id: 13, rating: 1, phone_norm: "534567890", channel: "qr", code_label: "طاولة ٤", created_at: minsAgo(60 * 30), outcome: "follow_up", portal_seen_at: minsAgo(60 * 20) },
  { id: 14, rating: 5, phone_norm: "545678901", created_at: minsAgo(20) },                                   // عالي ⇒ مش في البورتال
  { id: 15, rating: 2, phone_norm: "556789012", created_at: minsAgo(10), is_test: true },                     // تجربة ⇒ لأ
  { id: 16, rating: 2, phone_norm: "567890123", created_at: minsAgo(60 * 24 * 40) },                          // أقدم من ٣٠ يوم ⇒ لأ
  { id: 17, rating: 3, phone_norm: "578901234", created_at: minsAgo(60 * 24 * 3), resolved: true, resolved_at: minsAgo(60 * 24 * 2), resolved_by: "المالك", outcome: "resolved", resolution_note: "اتحلت" },
];

test("decision 5: the manager's portal lists the low ratings (open 30 days + closed 7 days), with the unread badge counts; a cashier is refused unless the setting allows it; the kitchen never", async () => {
  const r = portalRig({ rows: LOW() });
  const res = await r.call("GET", "/api/portal/reviews");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.reviews.map((x) => [x.id, x.status, x.unread]), [[11, "new", true], [12, "new", true], [13, "follow", false], [17, "closed", false]]);
  assert.deepEqual(res.body.counts, { new: 2, follow: 1, closed: 1, open: 3, unread: 2, newestUnread: 12 });
  const a = res.body.reviews[0];
  assert.deepEqual([a.phone, a.waPhone, a.ref, a.orderNo, a.kindAr, a.stars, a.channelAr], ["0512345678", "512345678", "W1790012345678", "W1790012345678", "توصيل", "⭐⭐", "واتساب"]);
  const b = res.body.reviews[1];
  assert.deepEqual([b.ratingAr, b.stars, b.ref, b.orderNo, b.kindAr], ["يحتاج تحسين", null, "فاتورة 1043", null, "أكل في الصالة"], "a till bill shows its receipt, never «pos:…»");
  assert.ok(res.body.outcomes.some((o) => o.id === "follow_up" && o.closes === false));
  const cashier = await r.call("GET", "/api/portal/reviews", { role: "cashier" });
  assert.deepEqual([cashier.status, cashier.body.error], [403, "forbidden"]);
  assert.equal((await r.call("GET", "/api/portal/reviews/counts", { role: "cashier" })).status, 403, "no badge for the cashier either");
  assert.equal((await r.call("POST", "/api/portal/reviews/:id/close", { role: "cashier", id: "11", body: { outcome: "resolved" } })).status, 403);
  assert.equal((await r.call("GET", "/api/portal/reviews", { role: "kitchen" })).status, 403);
  const allowed = portalRig({ rows: LOW(), settings: { waBot: { reviewFlow: { portalCashier: true } } } });
  assert.equal((await allowed.call("GET", "/api/portal/reviews", { role: "cashier" })).status, 200, "setting «الكاشير كمان يشوف التقييمات» on");
  assert.equal((await allowed.call("POST", "/api/portal/reviews/:id/reopen", { role: "cashier", id: "17" })).status, 403, "reopening stays with the manager");
});

test("decision 5: badge — opening the screen marks the new ones seen (unread → 0 for everyone); a new low rating raises it again with a newer id (the portal's gentle ring keys on it)", async () => {
  const r = portalRig({ rows: LOW() });
  const seen = await r.call("POST", "/api/portal/reviews/seen", { body: { ids: [11, 12, 14, "x"] } });
  assert.deepEqual(seen.body, { ok: true, seen: 2 }, "the high rating id is ignored");
  assert.ok(r.events.some(([e, d]) => e === "review_update" && d.seen && d.ids.includes(11)));
  let c = (await r.call("GET", "/api/portal/reviews/counts")).body.counts;
  assert.deepEqual([c.unread, c.newestUnread, c.new], [0, null, 2], "seen ≠ handled: still 2 to call");
  r.db.reviews.push({ id: 18, rating: 1, phone_norm: "589012345", created_at: minsAgo(1), resolved: false, is_test: false, hidden_at: null, rating_exact: true, categories: [], outcome: null, portal_seen_at: null });
  c = (await r.call("GET", "/api/portal/reviews/counts")).body.counts;
  assert.deepEqual([c.unread, c.newestUnread, c.new], [1, 18, 3]);
});

test("decision 5: closing from the portal writes the SAME row the dashboard inbox reads (resolved, by, note with the outcome) + an action log; «محتاج متابعة» keeps it open in both; the open «تقييم واطي» WhatsApp alert of that customer is closed too", async () => {
  const r = portalRig({ rows: LOW(), handovers: [{ id: 501, phone_norm: "512345678", reason: "review_low" }, { id: 502, phone_norm: "512345678", reason: "asked_human" }] });
  const before = (await r.call("GET", "/api/cms/reviews", { query: { filter: "open" } })).body.reviews.map((x) => x.id);
  assert.deepEqual(before.sort(), [11, 12, 13, 16], "the dashboard shows every open low rating (the portal only the last 30 days)");
  // validation
  assert.equal((await r.call("POST", "/api/portal/reviews/:id/close", { id: "11", body: { outcome: "nope" } })).body.error, "bad_outcome");
  assert.equal((await r.call("POST", "/api/portal/reviews/:id/close", { id: "11", body: { outcome: "closed" } })).body.error, "note_required", "«من غير إجراء» needs a reason");
  assert.equal((await r.call("POST", "/api/portal/reviews/:id/close", { id: "14", body: { outcome: "resolved" } })).status, 404, "a 5★ rating is not closed from the portal");
  assert.equal((await r.call("POST", "/api/portal/reviews/:id/close", { id: "15", body: { outcome: "resolved" } })).status, 404, "a test rating neither");
  // call + note, then close
  assert.equal((await r.call("POST", "/api/portal/reviews/:id/contact", { id: "11", body: { via: "call" } })).body.ok, true);
  assert.equal((await r.call("POST", "/api/portal/reviews/:id/contact", { id: "11", body: { via: "sms" } })).status, 400);
  assert.equal((await r.call("POST", "/api/portal/reviews/:id/note", { id: "11", body: { note: "  اعتذرت وهيجرب تاني  " } })).body.ok, true);
  const closed = await r.call("POST", "/api/portal/reviews/:id/close", { id: "11", body: { outcome: "resolved", note: "رجعناله المبلغ من تاب سينس" } });
  assert.deepEqual([closed.status, closed.body.status, closed.body.outcome], [200, "closed", "resolved"]);
  assert.deepEqual(closed.body.counts, { new: 1, follow: 1, closed: 2, open: 2, unread: 1, newestUnread: 12 });
  const row = r.db.reviews.find((x) => x.id === 11);
  assert.deepEqual([row.resolved, row.resolved_by, row.resolution_note, row.outcome, row.outcome_via], [true, "أبو فهد", "اتحلت — رجعناله المبلغ من تاب سينس", "resolved", "portal"]);
  assert.deepEqual(r.db.actions.map((a) => [a.review_id, a.action, a.outcome, a.note, a.by_name, a.via]), [[11, "call", null, null, "أبو فهد", "portal"], [11, "note", null, "اعتذرت وهيجرب تاني", "أبو فهد", "portal"], [11, "outcome", "resolved", "رجعناله المبلغ من تاب سينس", "أبو فهد", "portal"]]);
  assert.deepEqual(r.db.handovers.map((h) => [h.id, Boolean(h.acked_at)]), [[501, true], [502, false]], "only the low-rating alert of that customer");
  assert.ok(r.events.some(([e, d]) => e === "wa_handover_ack" && d.id === 501));
  assert.ok(r.events.some(([e, d]) => e === "review_update" && d.id === 11 && d.status === "closed"));
  assert.ok(r.audits.some((a) => a[1] === "review_close" && a[3] === true));
  // the dashboard inbox (one source)
  const inbox = (await r.call("GET", "/api/cms/reviews", { query: { filter: "open" } })).body;
  assert.deepEqual(inbox.reviews.map((x) => x.id).sort(), [12, 13, 16], "closed in the portal ⇒ gone from «محتاج تصرّف» in the dashboard");
  const all = (await r.call("GET", "/api/cms/reviews", { query: { filter: "all" } })).body.reviews.find((x) => x.id === 11);
  assert.deepEqual([all.resolved, all.resolved_by, all.resolution_note, all.outcomeAr, all.outcome_via], [true, "أبو فهد", "اتحلت — رجعناله المبلغ من تاب سينس", "اتحلت ✅", "portal"]);
  // follow-up keeps it open in both
  const fu = await r.call("POST", "/api/portal/reviews/:id/close", { id: "12", body: { outcome: "no_answer" } });
  assert.equal(fu.body.status, "follow");
  const fuInbox = (await r.call("GET", "/api/cms/reviews", { query: { filter: "open" } })).body.reviews.find((x) => x.id === 12);
  assert.deepEqual([fuInbox.resolved, fuInbox.outcomeAr, fuInbox.resolution_note], [false, "اتصلنا ومحدش رد", "اتصلنا ومحدش رد"]);
  // the dashboard's «تم الحل» uses the same function ⇒ the portal sees it closed
  const dash = await r.call("POST", "/api/cms/reviews/:id/resolve", { id: "12", body: { note: "كلمته أنا" } });
  assert.deepEqual(dash.body, { ok: true, status: "closed", outcome: "resolved" });
  const list = (await r.call("GET", "/api/portal/reviews")).body;
  const twelve = list.reviews.find((x) => x.id === 12);
  assert.deepEqual([twelve.status, twelve.outcomeVia, twelve.resolvedBy, twelve.note], ["closed", "dashboard", "المالك", "اتحلت — كلمته أنا"]);
  assert.deepEqual(twelve.actions.map((a) => [a.action, a.outcome, a.via]), [["outcome", "no_answer", "portal"], ["outcome", "resolved", "dashboard"]]);
  // reopen (manager)
  const ro = await r.call("POST", "/api/portal/reviews/:id/reopen", { id: "11" });
  assert.equal(ro.body.status, "new");
  assert.deepEqual([r.db.reviews.find((x) => x.id === 11).resolved, r.db.reviews.find((x) => x.id === 11).outcome], [false, null]);
});

test("review fix (audience): every live event from the reviews screen and from the dashboard's «تم الحل» is scoped to the reviews audience (portal.js sends it to the manager, and the cashier only with the setting)", async () => {
  const r = portalRig({ rows: LOW(), handovers: [{ id: 501, phone_norm: "512345678", reason: "review_low" }, { id: 601, phone_norm: "523456789", reason: "review_low" }] });
  await r.call("POST", "/api/portal/reviews/seen", { body: { ids: [11] } });
  await r.call("POST", "/api/portal/reviews/:id/note", { id: "11", body: { note: "كلمته" } });
  await r.call("POST", "/api/portal/reviews/:id/close", { id: "11", body: { outcome: "resolved" } });
  await r.call("POST", "/api/portal/reviews/:id/reopen", { id: "11" });
  await r.call("POST", "/api/cms/reviews/:id/resolve", { id: "12", body: { note: "كلمته أنا" } });
  assert.ok(r.events.length >= 6, JSON.stringify(r.events.map((e) => e[0])));
  assert.deepEqual(r.events.filter(([, , o]) => !(o && o.scope === "reviews")).map(([e]) => e).filter((e) => e !== "review_update" && e !== "review_low"), [], "acks carry the scope explicitly");
  assert.deepEqual(r.events.filter(([e]) => e === "wa_handover_ack").map(([, d, o]) => [d.id, o && o.scope]), [[501, "reviews"], [601, "reviews"]]);
  assert.ok(r.events.filter(([e]) => e === "review_update").every(([, , o]) => AU.reviewScoped("review_update", {}, o)));
});

test("decision 5: the rating page's low rating pings the portal live (review_low); a test code does not", async () => {
  const events = [];
  const pool = { async query(q) { const s = String(q); if (/INSERT INTO reviews/.test(s)) return { rows: [{ id: 77 }], rowCount: 1 }; return { rows: [], rowCount: 0 }; } };
  const app = fakeApp();
  reviews.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => ({ reviews: { threshold: 4 } }), jb: JSON.stringify, normPhone: norm }, { broadcast: (e, d) => events.push([e, d]) });
  const rate = (rating, code = null) => app.routes["POST /api/reviews/rate"]({ req: { json: async () => ({ rating, code }), header: () => `10.0.0.${rating}${code ? 9 : 1}` }, json: (b, status = 200) => ({ body: b, status }) });
  await rate(2); await rate(5); await rate(1, "test");
  assert.deepEqual(events.map(([e, d]) => [e, d.id, d.rating]), [["review_low", 77, 2]]);
});

test("decision 5 (pure): every outcome has Arabic copy; only «متابعة» outcomes keep the rating open; the card never shows an internal till id", () => {
  for (const o of PR.OUTCOMES) assert.ok(/[؀-ۿ]/.test(o.ar) && /[؀-ۿ]/.test(o.hint), o.id);
  assert.deepEqual(PR.FOLLOW_OUTCOMES, ["follow_up", "no_answer"]);
  const c = PR.publicReview({ id: 5, rating: 2, order_no: "pos:9001", phone_norm: "512345678", created_at: new Date(NOW).toISOString() });
  assert.equal(c.ref, "طلب من الكاشير"); assert.equal(c.orderNo, null); assert.doesNotMatch(JSON.stringify({ ref: c.ref, orderNo: c.orderNo }), /pos:/);
  assert.deepEqual(PR.countsOf({ new: 2, follow: 1, closed: 3, unread: 1, newest_unread: "9" }), { new: 2, follow: 1, closed: 3, open: 3, unread: 1, newestUnread: 9 });
});

/* ═══ مراجعة RV1 (١٥/١٠ بالليل): أرقام «حشو» على فاتورة الكاشير ═══
   الكاشير ساعات بيكتب 555555555 / 500000000 / نفس الرقم ٨ مرات / 512345678، أو رقم واحد لكل الناس. ده مش عميل وافق وقت الدفع ⇒ ولا صف موافقة ولا رسالة. */
test("review fix (phones): a placeholder number on a till bill, or one number on 4+ bills in 24 h, gets NO consent row and NO message — a closed invite with the reason instead; the real customer next to it is asked; the send-time re-check catches a number that became shared after queueing; a failed count waits", async () => {
  const PC = await import("./phonecheck.js");
  const SHARED = "534000111";
  const ts = [
    { order_id: "7001", order_date: ago(100), order_option: "Dine in", pn: "555555555" },
    { order_id: "7002", order_date: ago(100), order_option: "Take away", pn: "500000000" },
    { order_id: "7003", order_date: ago(100), order_option: "Dine in", pn: "577777777" },
    { order_id: "7004", order_date: ago(100), order_option: "Dine in", pn: "512345678" },
    { order_id: "7010", order_date: ago(115), order_option: "Dine in", pn: SHARED },
    { order_id: "7011", order_date: ago(110), order_option: "Take away", pn: SHARED },
    { order_id: "7012", order_date: ago(105), order_option: "Dine in", pn: SHARED },
    { order_id: "7013", order_date: ago(100), order_option: "Dine in", pn: SHARED },
    { order_id: "7020", order_date: ago(100), order_option: "Dine in", pn: CUST, receipt: "88" },
  ];
  const r = reviewsRig({ ts, waReply: { ok: true, channel: "wa_stars", wamid: "wamid.X1" } });
  await r.run("2026-10-15T15:00:00Z");
  assert.deepEqual(r.db.consent.map((c) => [c.phone_norm, c.order_no]), [[CUST, "pos:7020"]], "a consent row only for the real customer");
  assert.deepEqual(r.db.asked.map((x) => [x.phone, x.orderNo]), [[CUST, "pos:7020"]], "a message only to the real customer");
  assert.deepEqual(Object.fromEntries(r.db.invites.map((x) => [x.order_no, x.skip_reason || null])), {
    "pos:7001": "bad_number", "pos:7002": "bad_number", "pos:7003": "bad_number", "pos:7004": "bad_number",
    "pos:7010": "shared_phone", "pos:7011": "shared_phone", "pos:7012": "shared_phone", "pos:7013": "shared_phone", "pos:7020": null,
  }, "the skipped bills keep a closed row with the reason (visible in the invite log, never scanned again)");
  assert.equal(r.db.sms.length, 0);
  await r.run("2026-10-15T15:05:00Z");
  assert.equal(r.db.invites.length, 9, "no second row per bill"); assert.equal(r.db.asked.length, 1);
  // 3 bills in 24 h is still a customer
  const three = reviewsRig({ ts: ts.filter((o) => o.order_id !== "7013" && o.pn === SHARED), waReply: { ok: true, channel: "wa_stars" } });
  await three.run("2026-10-15T15:00:00Z");
  assert.equal(three.db.invites.filter((x) => !x.skip_reason).length, 3);
  // queued while it looked like one customer, then the till used it on more bills ⇒ skipped at send time: no message, no new consent row
  const later = reviewsRig({ invites: [{ order_no: "pos:7030", code: "ab12cd34", phone_norm: "534000222", option: "dinein", kind: "dinein", due_at: ago(5), order_at: ago(95), ref: null }],
    billCounts: { "534000222": 4 }, waReply: { ok: true, channel: "wa_stars" } });
  await later.run("2026-10-15T15:00:00Z");
  assert.deepEqual([later.db.invites[0].skip_reason, later.db.asked.length, later.db.consent.length, later.db.sms.length], ["shared_phone", 0, 0, 0]);
  // a placeholder invite that already exists (queued before this rule) ⇒ bad_number at send time, before the consent re-record
  const old = reviewsRig({ invites: [{ order_no: "pos:7031", code: "ab12cd35", phone_norm: "566666666", option: "takeaway", kind: "takeaway", due_at: ago(5), order_at: ago(55), ref: null }],
    waReply: { ok: true, channel: "wa_stars" } });
  await old.run("2026-10-15T15:00:00Z");
  assert.deepEqual([old.db.invites[0].skip_reason, old.db.asked.length, old.db.consent.length], ["bad_number", 0, 0]);
  // the count fails ⇒ the invite waits (send time) / no invites this sweep (queue time)
  const down = reviewsRig({ invites: [{ order_no: "pos:7032", code: "ab12cd36", phone_norm: "534000333", option: "dinein", kind: "dinein", due_at: ago(5), order_at: ago(95), ref: null }],
    countFail: true, waReply: { ok: true, channel: "wa_stars" } });
  const o = await down.run("2026-10-15T15:00:00Z");
  assert.deepEqual([o.retry, down.db.invites[0].skip_reason, down.db.invites[0].sent_at, down.db.asked.length, down.db.consent.length], [1, undefined, undefined, 0, 0]);
  const qdown = reviewsRig({ ts: [ts[8]], countFail: true, waReply: { ok: true, channel: "wa_stars" } });
  await qdown.run("2026-10-15T15:00:00Z");
  assert.deepEqual([qdown.db.invites.length, qdown.db.consent.length, qdown.db.asked.length], [0, 0, 0]);
  // the consent record and the guard refuse a placeholder on their own; one rule shared with «طبقك المفضل»
  assert.equal((await WC.recordPosReviewConsent({ query: async () => { throw new Error("must not write"); } }, { phoneNorm: "555555555", orderNo: "pos:1", kind: "dinein" })).error, "placeholder_phone");
  assert.equal(await WC.posReviewConsentCovers({ query: async () => ({ rows: [{}] }) }, "511111111", "pos:1"), false);
  assert.equal(await WC.posReviewConsentCovers({ query: async () => ({ rows: [{}] }) }, CUST, "pos:1"), true);
  for (const pn of ["555555555", "500000000", "511111111", "599999999", "512345678"]) assert.equal(PC.isPlaceholderPhone(pn), true, pn);
  for (const pn of [CUST, SHARED, "551234567", "501234568"]) assert.equal(PC.isPlaceholderPhone(pn), false, pn);
  const fs = await import("node:fs");
  assert.match(fs.readFileSync(new URL("./wafavpick.js", import.meta.url), "utf8"), /const FAKE_RE = FAKE_PHONE_RE;/, "wafavpick uses the same rule");
  assert.equal(WC.POS_REVIEW_CONSENT.sharedBills, 4);
});

/* ═══ مراجعة RV1: قفل التقييم بيرجّع محادثة واتساب للبوت ═══ */
test("review fix (chat back to the bot): closing a low rating from the portal or the dashboard — or recording any outcome — clears the open «تقييم واطي» WhatsApp handover of that customer (like «خلصت»); a staff hold, a later order-change handover and other customers are untouched", async () => {
  const chats = () => ({
    "512345678": { handoff_at: minsAgo(20), handoff_reason: "review_low", muted_until: null },
    "523456789": { handoff_at: minsAgo(15), handoff_reason: "order_change", muted_until: null },
    "534567890": { handoff_at: minsAgo(60), handoff_reason: "review_low", muted_until: minsAgo(-30) },
  });
  const r = portalRig({ rows: LOW(), chats: chats() });
  const res = await r.call("POST", "/api/portal/reviews/:id/close", { id: "11", body: { outcome: "resolved" } });
  assert.equal(res.status, 200);
  assert.deepEqual([r.db.chats["512345678"].handoff_at, r.db.chats["512345678"].handoff_reason, Boolean(r.db.chats["512345678"].released_at)], [null, null, true], "the bot serves this customer again");
  assert.equal(r.db.chats["523456789"].handoff_reason, "order_change", "another customer untouched");
  // follow-up outcome: the manager acted ⇒ also handed back (the rating stays open in «متابعة»)
  const f = portalRig({ rows: LOW(), chats: chats() });
  await f.call("POST", "/api/portal/reviews/:id/close", { id: "13", body: { outcome: "no_answer" } });
  assert.deepEqual([f.db.chats["534567890"].handoff_reason, f.db.chats["534567890"].muted_until], [null, minsAgo(-30)], "a staff hold (muted_until) stays");
  // the rating's customer got an order-change handover since ⇒ that one stays (not a review)
  const oc = portalRig({ rows: LOW(), chats: { "523456789": { handoff_at: minsAgo(5), handoff_reason: "order_change" } } });
  await oc.call("POST", "/api/portal/reviews/:id/close", { id: "12", body: { outcome: "resolved" } });
  assert.equal(oc.db.chats["523456789"].handoff_reason, "order_change");
  // the dashboard's «تم الحل» goes through the same function
  const d = portalRig({ rows: LOW(), chats: chats() });
  const dr = await d.call("POST", "/api/cms/reviews/:id/resolve", { id: "11", body: { note: "كلمناه" } });
  assert.equal(dr.status, 200); assert.equal(d.db.chats["512345678"].handoff_reason, null);
  // the bot table missing / down ⇒ the close itself still works
  const PRm = await import("./portalreviews.js");
  const pool = { async query(q) { if (/wa_bot_chats/.test(q)) throw new Error("relation does not exist"); if (/^UPDATE reviews SET resolved=TRUE/.test(String(q).trim())) return { rows: [{ phone_norm: "512345678" }], rowCount: 1 }; return { rows: [], rowCount: 0 }; } };
  const cr = await PRm.closeReview(pool, { id: 11, outcome: "resolved", by: "المدير" });
  assert.deepEqual([cr.ok, cr.chatReleased], [true, false]);
});
