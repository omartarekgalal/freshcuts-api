/* PH1 (١٦/١٠) — إيقاف الإرسال المدفوع وقت مشكلة دفع/قفل/توكن عند ميتا + التنبيه للمالك على واتساب كقناة تانية.
   الحادثة: فاتورة واتساب Cloud ماكانتش مدفوعة ⇒ 131042 على ٨٣ رسالة (٠٠:١٥–١٣:٤١)، المراقب بعت SMS ١٢:١٢ بس حملات ١٣:٠٠ بدأت وفشلت،
   و١١ قالب فريق مدفوع اتبعتوا وفشلوا. الحملات/البدء المجدول في wa-sx2-robust.test.mjs (آخر اختبارين «PH1»).
   node --test wa-payhold.test.mjs   (قاعدة وهمية، مفيش شبكة، أرقام وهمية بس) */
import test from "node:test";
import assert from "node:assert/strict";
const H = await import("./wahealth.js");
const W = await import("./whatsapp.js");
const CAT = await import("./watemplates.js");
W.registerCatalog(CAT);

const NOW = Date.parse("2026-10-16T10:00:00Z");      // ١٣:٠٠ الرياض
const MIN = 60_000;
const iso = (t) => new Date(t).toISOString();
const P1 = "500000901", P2 = "500000902";

/* ── دوال صافية ── */
test("holdVerdict: مشكلة دفع قايمة لحد ما قالب ينجح بعد آخر غلطة — رسالة خدمة ببلاش مش دليل؛ القفل/التوكن أي رسالة", () => {
  const last = { checkedAt: iso(NOW), issues: [{ key: "pay_error", level: "crit", last: iso(NOW - 20 * MIN) }, { key: "health_limited", level: "warn" }] };
  const v = H.holdVerdict(last, { any: null, tpl: null });
  assert.equal(v.held, true); assert.equal(v.key, "pay_error"); assert.deepEqual(v.keys, ["pay_error"]);
  assert.equal(v.reasonAr, "موقوفة لحد ما مشكلة الدفع عند ميتا تتحل"); assert.equal(v.lastErr, iso(NOW - 20 * MIN)); assert.equal(v.lastErrRiyadh, "16/10 12:40");
  assert.equal(H.holdVerdict(last, { any: iso(NOW - 5 * MIN), tpl: iso(NOW - 30 * MIN) }).held, true, "رسالة حرة نجحت + آخر قالب قبل الغلطة ⇒ لسه");
  assert.equal(H.holdVerdict(last, { any: iso(NOW - 5 * MIN), tpl: iso(NOW - 5 * MIN) }).held, false, "قالب نجح بعد الغلطة ⇒ اتشال");
  assert.equal(H.holdVerdict(last, { any: iso(NOW), tpl: iso(NOW - 20 * MIN) }).held, true, "نفس اللحظة مش «بعد»");
  assert.equal(H.holdVerdict(last, null).held, true, "ماقدرناش نقرا ⇒ الإيقاف بيفضل");
  const lock = { checkedAt: iso(NOW), issues: [{ key: "account_locked", level: "crit", last: iso(NOW - 20 * MIN) }] };
  assert.equal(H.holdVerdict(lock, { any: iso(NOW - MIN), tpl: null }).held, false, "القفل: أي رسالة نجحت بعده = اتفك");
  assert.equal(H.holdVerdict(lock, { any: null, tpl: null }).reasonAr, "موقوفة لحد ما ميتا تفك قفل حساب واتساب");
  /* محمولة (carried) — last بيفضل من الأول؛ من غير last ⇒ freshAt ⇒ وقت الفحص */
  assert.equal(H.holdVerdict({ checkedAt: iso(NOW), issues: [{ key: "pay_error", level: "crit", carried: true, freshAt: iso(NOW - 60 * MIN) }] }, { tpl: iso(NOW - 30 * MIN) }).held, false);
  assert.equal(H.holdVerdict({ checkedAt: iso(NOW), issues: [{ key: "token", level: "crit" }] }, { any: iso(NOW - MIN) }).held, true, "من غير last ⇒ وقت الفحص");
  /* مش من مشاكل الإيقاف / مش خطيرة ⇒ مفيش إيقاف */
  for (const i of [{ key: "spam_limit", level: "crit" }, { key: "quality_red", level: "crit" }, { key: "pay_error", level: "warn" }]) assert.equal(H.holdVerdict({ issues: [i] }, null).held, false, i.key);
  assert.equal(H.holdVerdict(null, null).held, false);
  assert.deepEqual(H.HOLD_KEYS, ["pay_error", "account_locked", "token", "permission"]);
});

test("probeAllowed: قالب خدمي بس، مرة كل probeMin دقيقة؛ التسويق والحملات وكود التحقق عمرهم ما بيبقوا تجربة", () => {
  assert.equal(H.probeAllowed({ category: "UTILITY" }, 0, 10, NOW), true);
  assert.equal(H.probeAllowed({ category: "UTILITY" }, NOW - 9 * MIN, 10, NOW), false);
  assert.equal(H.probeAllowed({ category: "UTILITY" }, NOW - 10 * MIN, 10, NOW), true);
  assert.equal(H.probeAllowed({ category: "UTILITY", marketing: true }, 0, 10, NOW), false);
  assert.equal(H.probeAllowed({ category: "MARKETING" }, 0, 10, NOW), false);
  assert.equal(H.probeAllowed({ category: "AUTHENTICATION" }, 0, 10, NOW), false);
});

test("waUsable + healthCfg: الدفع مابيمنعش الرسالة الحرة للمالك، القفل/التوكن بيمنعوا؛ الإعدادات الجديدة بافتراضياتها وحدودها", () => {
  assert.equal(H.waUsable([{ key: "pay_error", level: "crit" }, { key: "health_limited", level: "warn" }]), true);
  for (const k of ["account_locked", "token", "permission", "not_registered", "health_blocked"]) assert.equal(H.waUsable([{ key: k, level: "crit" }]), false, k);
  const d = H.healthCfg({});
  assert.deepEqual([d.payHold, d.probeMin, d.holdMaxHours, d.ownerWa], [true, 10, 6, true]);
  const c = H.healthCfg({ waHealth: { payHold: false, probeMin: 1, holdMaxHours: 99, ownerWa: false } });
  assert.deepEqual([c.payHold, c.probeMin, c.holdMaxHours, c.ownerWa], [false, 2, 48, false]);
  for (const k of ["payHold", "probeMin", "holdMaxHours", "ownerWa"]) assert.ok(H.HEALTH_KEYS.includes(k), `${k} بيتحفظ من مسار الإعدادات`);
});

/* ── المراقب على قاعدة وهمية ── */
function fakeDb() {
  const st = { data: {}, ver: 0 };
  const db = { st, errorsRows: [], okRow: {}, skips: [], settings: null };
  db.pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE|^INSERT INTO wa_health_state/.test(s)) return { rows: [], rowCount: 0 };
    if (/^SELECT data, ver::text AS ver/.test(s)) return { rows: [{ data: JSON.parse(JSON.stringify(st.data)), ver: String(st.ver), updated_at: null }] };
    if (/^UPDATE wa_health_state SET data=\$1::jsonb, ver=ver\+1/.test(s)) { if (String(st.ver) !== String(p[1])) return { rows: [], rowCount: 0 }; st.data = JSON.parse(p[0]); st.ver++; return { rows: [{ id: 1 }], rowCount: 1 }; }
    if (/^UPDATE wa_health_state SET data = jsonb_set\(data, '\{log\}'/.test(s)) { st.data.log = JSON.parse(p[0]); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_health_state SET data = jsonb_set\(jsonb_set\(data, '\{alerts\}', \$2::jsonb, true\), '\{log\}'/.test(s)) { st.data.log = JSON.parse(p[0]); st.data.alerts = JSON.parse(p[1]); return { rows: [], rowCount: 1 }; }
    if (/AS any_at/.test(s)) { db.okReads = (db.okReads || 0) + 1; return { rows: [db.okRow] }; }
    if (/^INSERT INTO wa_hold_skips/.test(s)) { db.skips.push({ key: p[0], template: p[1], source: p[2], order_no: p[3], phone_norm: p[4] }); return { rows: [], rowCount: 1 }; }
    if (/FROM wa_hold_skips/.test(s)) { const m = new Map(); for (const x of db.skips) m.set(x.template || "", (m.get(x.template || "") || 0) + 1);
      return { rows: [...m.entries()].map(([template, n]) => ({ template, n, last: iso(NOW) })) }; }
    if (/FROM wa_messages/.test(s)) return { rows: db.errorsRows };
    if (/FROM wa_send_queue WHERE error_code IS NOT NULL/.test(s)) return { rows: [] };
    if (/FROM wa_send_queue/.test(s)) return { rows: [{ marketing: 0, capped: 0 }] };
    if (/FROM wa_quality_events/.test(s)) return { rows: [] };
    throw new Error(`unexpected sql: ${s.slice(0, 80)}`);
  } };
  return db;
}
const LIVE = { ok: true, health: "AVAILABLE", quality: "GREEN", status: "CONNECTED", tier: "TIER_250", nameStatus: "APPROVED", portfolio: { ok: true, limit: "TIER_2K" }, healthErrors: [] };
function harness({ settings = null, wa = undefined } = {}) {
  const db = fakeDb();
  db.settings = settings || { waTeam: { members: [{ phone: P1, role: "owner" }] }, delivery: { alertPhones: [P1] }, waHealth: { monthBudgetSar: 10000 } };
  const sms = [], waSent = [];
  const fakeWa = wa === undefined ? { async sendFreeform(a) { waSent.push(a); return db.waReply || { ok: true, wamid: `wamid.H${waSent.length}` }; } } : wa;
  const cloud = { phoneInfo: async () => LIVE, wabaId: () => "WABA1", graphGet: async (path, q) => (q && q.fields === "currency" ? { currency: "SAR" } : { pricing_analytics: { data: [] } }) };
  let clock = NOW;
  const routes = {};
  const app = { get: (p, h) => { routes[`GET ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } };
  const api = H.register(app, { pool: db.pool, requireAdmin: async () => null, getSettingsData: async () => db.settings, isOwner: async () => true },
    { cloud: () => cloud, wa: fakeWa, sendSms: async (m) => { if (db.smsDown) throw new Error("taqnyat down"); sms.push(m); return { ok: true }; }, now: () => clock, schedule: false, log: () => {} });
  const call = async (key) => routes[key]({ req: { json: async () => ({}) }, json: (body, status = 200) => ({ body, status }) });
  return { db, sms, waSent, api, call, tick: (ms) => { clock += ms; } };
}
const PAY_STATE = (lastErr) => ({ last: { checkedAt: iso(NOW), level: "crit", issues: [{ key: "pay_error", level: "crit", last: iso(lastErr), title: "x" }] } });

test("templateHold: وقت مشكلة الدفع — أول قالب خدمي يعدّي تجربة، اللي بعده بيتخطّى ويتسجّل، الحملة دايماً بتتخطّى؛ قالب نجح بعد الغلطة ⇒ كله يرجع", async () => {
  const h = harness();
  h.db.st.data = PAY_STATE(NOW - 20 * MIN);
  const U = { template: "fc_order_on_the_way", category: "UTILITY", marketing: false, source: null, orderNo: "1001", phoneNorm: P2 };
  assert.equal(await h.api.templateHold(U), null, "أول قالب خدمي = تجربة (يعدّي)");
  const v = await h.api.templateHold(U);
  assert.equal(v.held, true); assert.equal(v.key, "pay_error");
  assert.ok((await h.api.templateHold({ ...U, template: "fc_offer_img", category: "MARKETING", marketing: true, source: "campaign" })).held, "الحملة عمرها ما بتبقى تجربة");
  assert.ok((await h.api.templateHold({ ...U, template: "fc_staff_team_notice" })).held, "قالب الفريق بيتخطّى برضه (المحاولة الوحيدة كل ١٠ دقايق اتاخدت)");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.db.skips.map((x) => [x.key, x.template, x.source, x.order_no]), [["pay_error", "fc_order_on_the_way", null, "1001"], ["pay_error", "fc_offer_img", "campaign", "1001"], ["pay_error", "fc_staff_team_notice", null, "1001"]]);
  /* بعد ١٠ دقايق: تجربة تانية */
  h.tick(10 * MIN);
  assert.equal(await h.api.templateHold(U), null, "تجربة كل probeMin دقيقة");
  assert.ok((await h.api.templateHold(U)).held);
  /* التجربة نجحت (ميتا قالت sent) ⇒ الإيقاف بيتشال لوحده — من غير ما المالك يعمل حاجة */
  h.db.okRow = { any_at: iso(NOW + 10 * MIN), tpl_at: iso(NOW + 10 * MIN) };
  h.tick(21_000);
  assert.equal(await h.api.templateHold(U), null);
  assert.equal(await h.api.templateHold({ ...U, marketing: true, category: "MARKETING" }), null, "الحملات رجعت");
  assert.equal((await h.api.holdState()).held, false);
  /* المفتاح مقفول من اللوحة ⇒ ولا إيقاف */
  const off = harness({ settings: { waHealth: { payHold: false } } });
  off.db.st.data = PAY_STATE(NOW - 20 * MIN);
  assert.equal(await off.api.templateHold({ ...U, marketing: true, category: "MARKETING" }), null);
  assert.equal((await off.api.holdState()).on, false);
  /* الداتابيز وقعت ⇒ مايوقّفش الإرسال (الإيقاف تحسين مش قفل) */
  const broken = harness();
  broken.db.pool.query = async () => { throw new Error("db down"); };
  assert.equal(await broken.api.templateHold({ ...U, marketing: true, category: "MARKETING" }), null);
});

test("GET /api/cms/wa-health: حالة الإيقاف + عدد القوالب اللي اتخطّت في ٢٤ ساعة (للكارت)", async () => {
  const h = harness();
  h.db.st.data = PAY_STATE(NOW - 20 * MIN);
  await h.api.templateHold({ template: "fc_order_on_the_way", category: "UTILITY" });      // تجربة
  await h.api.templateHold({ template: "fc_order_on_the_way", category: "UTILITY" });
  await h.api.templateHold({ template: "fc_review_request_v2", category: "UTILITY" });
  await new Promise((r) => setImmediate(r));
  const r = await h.call("GET /api/cms/wa-health");
  assert.equal(r.body.ok, true);
  const hd = r.body.hold;
  assert.equal(hd.held, true); assert.equal(hd.on, true); assert.equal(hd.reasonAr, "موقوفة لحد ما مشكلة الدفع عند ميتا تتحل"); assert.equal(hd.probeMin, 10); assert.ok(hd.lastProbeAt);
  assert.equal(hd.skipped24h.n, 2); assert.deepEqual(hd.skipped24h.byTemplate.map((x) => x.template).sort(), ["fc_order_on_the_way", "fc_review_request_v2"]);
  assert.deepEqual([r.body.defaults.payHold, r.body.defaults.ownerWa, r.body.limits.probeMin, r.body.limits.holdMaxHours], [true, true, [2, 120], [1, 48]]);
});

test("التنبيه للمالك على واتساب (قناة تانية): نفس نص الـSMS رسالة حرة؛ الـSMS بيفضل الأساسي؛ مقفول/النافذة مقفولة/واتساب نفسه واقع ⇒ SMS بس", async () => {
  const h = harness();
  h.db.errorsRows = [{ code: 131042, n: 3, last: iso(NOW) }];
  const r = await h.api.check({ reason: "test" });
  assert.deepEqual(r.alerted, ["pay_error"]); assert.equal(h.sms.length, 1); assert.equal(r.waSent, 1);
  assert.equal(h.waSent.length, 1); assert.equal(h.waSent[0].phoneNorm, P1); assert.equal(h.waSent[0].source, "health");
  assert.equal(h.waSent[0].payload.type, "text"); assert.equal(h.waSent[0].payload.text.body, h.sms[0].body, "نفس النص بالعلامة");
  assert.deepEqual(h.db.st.data.log[0].wa, { sent: 1, skipped: [] });
  /* النافذة مقفولة ⇒ الحارس بيرفض — الـSMS اتبعت عادي */
  const c = harness();
  c.db.errorsRows = [{ code: 131042, n: 1, last: iso(NOW) }];
  c.db.waReply = { ok: false, skipped: "window_closed" };
  await c.api.check({});
  assert.equal(c.sms.length, 1); assert.deepEqual(c.db.st.data.log[0].wa, { sent: 0, skipped: ["window_closed"] });
  /* التوكن بايظ ⇒ واتساب نفسه واقع: مابنحاولش */
  const t = harness();
  t.db.errorsRows = [{ code: 190, n: 2, last: iso(NOW) }];
  await t.api.check({});
  assert.equal(t.sms.length, 1); assert.equal(t.waSent.length, 0); assert.deepEqual(t.db.st.data.log[0].wa, { sent: 0, skipped: ["wa_down"] });
  /* مقفول من اللوحة */
  const o = harness({ settings: { waTeam: { members: [{ phone: P1, role: "owner" }] }, waHealth: { ownerWa: false } } });
  o.db.errorsRows = [{ code: 131042, n: 1, last: iso(NOW) }];
  await o.api.check({});
  assert.equal(o.waSent.length, 0); assert.deepEqual(o.db.st.data.log[0].wa, { sent: 0, skipped: ["off"] });
  /* الـSMS وقع لكل الأرقام بس الواتساب وصل ⇒ التنبيه مايتعادش (المالك عرف) */
  const s = harness();
  s.db.errorsRows = [{ code: 131042, n: 1, last: iso(NOW) }];
  s.db.smsDown = true;
  await s.api.check({});
  assert.equal(s.waSent.length, 1); assert.ok(s.db.st.data.alerts.pay_error, "مارجّعناش «اتبعت عن إيه»");
  /* الاتنين وقعوا ⇒ يرجّع زي SX/WH1 فالدورة الجاية تحاول تاني */
  const b = harness();
  b.db.errorsRows = [{ code: 131042, n: 1, last: iso(NOW) }];
  b.db.smsDown = true; b.db.waReply = { ok: false, skipped: "window_closed" };
  await b.api.check({});
  assert.deepEqual(b.db.st.data.alerts, {});
  /* من غير واتساب مركّب (سيرفر قديم) ⇒ زي الأول */
  const n = harness({ wa: null });
  n.db.errorsRows = [{ code: 131042, n: 1, last: iso(NOW) }];
  await n.api.check({});
  assert.equal(n.sms.length, 1); assert.deepEqual(n.db.st.data.log[0].wa, { sent: 0, skipped: ["no_sender"] });
});

test("«ابعت تجربة»: SMS + واتساب (لو مفتوح) والرد بيقول وصل فين", async () => {
  const h = harness();
  const r = await h.call("POST /api/cms/wa-health/test");
  assert.equal(r.body.ok, true); assert.equal(r.body.sent, 1); assert.deepEqual(r.body.wa, { sent: 1, skipped: [] });
  assert.equal(h.waSent[0].payload.text.body, r.body.text);
  const c = harness();
  c.db.waReply = { ok: false, skipped: "window_closed" };
  assert.deepEqual((await c.call("POST /api/cms/wa-health/test")).body.wa, { sent: 0, skipped: ["window_closed"] });
});

/* ── الحارس المركزي (whatsapp.js guardSend) ── */
function waWorld() {
  const db = { settings: { notifications: { whatsappEnabled: true, whatsappStages: Object.keys(W.STAGE_TEMPLATES) }, waMaster: { enabled: true }, waBot: { testPhones: [`0${P1}`] },
    waTeam: { members: [{ phone: P1, role: "owner" }] } }, optins: { [P2]: { updates: true, marketing: true } }, inbound: [P2] };
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: db.inbound.includes(p[0]) ? [{}] : [] };
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: db.optins[p[0]] ? [db.optins[p[0]]] : [] };
    if (/FROM cms_contacts/i.test(s)) return { rows: [], rowCount: 0 };
    if (/count\(\*\) FILTER \(WHERE created_at > NOW\(\) - INTERVAL '7 days'\)::int AS d7/i.test(s)) return { rows: [{ d7: 0, d30: 0 }] };
    return { rows: [], rowCount: 0 };
  } };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const app = { get() {}, post() {}, put() {}, delete() {} };
  const wa = W.register(app, ctx, { fetch: async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.X" }] }) }), sendSms: async () => ({ ok: true }) });
  return { db, wa };
}
const ENV = { WHATSAPP_ENABLED: "1", WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1" };
async function withEnv(fn) {
  const saved = {}; for (const k of Object.keys(ENV)) { saved[k] = process.env[k]; process.env[k] = ENV[k]; }
  try { await fn(); } finally { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("الحارس: إيقاف الدفع ⇒ كل قالب (خدمي/حملة/فريق) «pay_hold» من غير طلب لميتا؛ الرسالة الحرة جوّه النافذة والتجربة بيعدّوا؛ الرفض بسبب الموافقة بيسبق (التجربة ماتتحرقش)", () => withEnv(async () => {
  const { wa, db } = waWorld();
  const U = Object.values(W.STAGE_TEMPLATES)[0];
  const calls = [];
  let answer = { held: true, key: "pay_error" };
  wa.setPayHold(async (ctx) => { calls.push(ctx); if (answer instanceof Error) throw answer; return answer; });
  assert.equal((await wa.guardSend({ phoneNorm: P2, kind: "template", template: U, orderNo: "1001" })).reason, "pay_hold");
  assert.deepEqual([calls[0].template, calls[0].category, calls[0].marketing, calls[0].orderNo, calls[0].phoneNorm], [U, "UTILITY", false, "1001", P2]);
  assert.equal((await wa.guardSend({ phoneNorm: P2, kind: "template", template: U, source: "campaign", purpose: "marketing" })).reason, "pay_hold");
  assert.equal(calls[1].marketing, true, "الحملة بتتعلّم تسويق (عمرها ما بتبقى تجربة)");
  const staffTpl = Object.keys(W.TEMPLATES).find((n) => W.TEMPLATES[n].group === "staff" && W.TEMPLATES[n].category === "UTILITY");
  if (staffTpl) assert.equal((await wa.guardSend({ phoneNorm: P1, kind: "template", template: staffTpl, staff: true })).reason, "pay_hold", "قوالب الفريق كمان (١١ فشلوا ١٦/١٠)");
  const n = calls.length;
  assert.equal((await wa.guardSend({ phoneNorm: P2, kind: "session" })).ok, true, "رسالة حرة جوّه النافذة بتكمّل");
  assert.equal((await wa.guardSend({ phoneNorm: P1, kind: "template", template: U, test: true })).ok, true, "رسالة تجربة لرقم تجربة بتعدّي (هي اللي بتثبت إن الدفع رجع)");
  assert.equal(calls.length, n, "الحر والتجربة مابيسألوش");
  db.optins[P2] = { updates: false };
  assert.equal((await wa.guardSend({ phoneNorm: P2, kind: "template", template: U })).reason, "no_optin", "الموافقة الأول");
  assert.equal(calls.length, n);
  db.optins[P2] = { updates: true, marketing: true };
  answer = null;
  assert.equal((await wa.guardSend({ phoneNorm: P2, kind: "template", template: U, orderNo: "1001" })).ok, true, "مفيش إيقاف ⇒ زي الأول");
  answer = new Error("boom");
  assert.equal((await wa.guardSend({ phoneNorm: P2, kind: "template", template: U, orderNo: "1001" })).ok, true, "المراقب رمى ⇒ مانوقّفش");
  wa.setPayHold(null);
  assert.equal((await wa.guardSend({ phoneNorm: P2, kind: "template", template: U, orderNo: "1001" })).ok, true);
}));

test("sendTemplate وقت الإيقاف: skipped «pay_hold» (المنادي بيكمّل بالـSMS البديل زي أي تخطّي) ومفيش طلب لميتا", () => withEnv(async () => {
  const { wa } = waWorld();
  wa.setPayHold(async () => ({ held: true, key: "pay_error" }));
  const U = Object.values(W.STAGE_TEMPLATES)[0];
  const r = await wa.sendTemplate({ phoneNorm: P2, template: U, params: {}, orderNo: "1001" });
  assert.deepEqual(r, { ok: false, skipped: "pay_hold" });
}));
