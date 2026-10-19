/* 💸 UT2 (عمر ١٩/١٠: «كل الى نقدر نحوله خدمي خلينا نحاول ناخد عليه موافقة انه خدمي» · «متوقفش اي حاجة دلوقتي … ادخل قدم صيغة خدمية وناخد موافقة ع القالب
   ونتابع ميتا ونغيره») — node --test ut2-utility-rewrites.test.mjs
   whatsapp.js + wabotrun.js الحقيقيين فوق قاعدة وهمية وfetch بيسجّل كل نداء (مفيش شبكة ولا رسالة حقيقية). بيثبت:
     ١) القرار الصافي (pickRewrite): الجديد بس لما APPROVED + UTILITY + المفتاح مفتوح + المُرسل واتساب — كل حالة تانية القديم.
     ٢) البدايل في الكتالوج: صالحة لميتا، UTILITY، لغة الخريطة بس، أسماء جديدة، مرجع ثابت في أول الجملة، نفس مسارات بيانات القديم، في دفعة تقديم.
     ٣) قالب الفريق: fc_staff_inbox_summary:ar بيفضل لحد ما fc_staff_inbox_alert يتعتمد خدمي، وبعدها الجديد بنفس البيانات؛ اتصنّف تسويق ⇒ القديم + صف في السجل.
     ٤) طلب التقييم: fc_review_stars لحد الاعتماد، وبعدها fc_review_order_v3 برقم الطلب (W… / فاتورة الكاشير / فاتورة كيتا من ts_orders) وتاريخه؛ ناقص ⇒ القديم.
     ٥) مفاتيح اللوحة لكل خريطة + تقرير القراية (GET /api/cms/wa-cloud/utility-rewrites). */
import test from "node:test";
import assert from "node:assert/strict";

const W = await import("./whatsapp.js");
const C = await import("./watemplates.js");
const R = await import("./wabotrun.js");
const WC = await import("./wacloud.js");
const RW = await import("./warewrite.js");
const U = await import("./wautility-cfg.js");
const CONSENT = await import("./waconsent.js");
W.registerCatalog(C);

const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN"];
function withEnv(vals, fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, vals);
    try { await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
}
const OPEN = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1", WHATSAPP_WABA_ID: "WABA1", WHATSAPP_ENABLED: "1" };
const CASH = "561000001", CUST = "512345678";
const NEW = RW.UTILITY_REWRITES.map((m) => m.new);

/* عالم صغير: whatsapp.js الحقيقي + fetch مسجّل + قاعدة وهمية + حالة/فئة ميتا بنحقنها (زي wacloud) */
function world({ meta = {}, settings = {}, ts = [], shop = [] } = {}) {
  const db = { settings: { waMaster: { enabled: true }, notifications: { whatsappEnabled: true }, waBot: { testPhones: [`0${CUST}`], ...(settings.waBot || {}) },
    waTeam: { members: [{ phone: `0${CASH}`, name: "منى", role: "cashier" }] }, ...settings, ...(settings.waBot ? { waBot: { testPhones: [`0${CUST}`], ...settings.waBot } } : {}) },
  rwlog: [], out: [], marks: [] };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^INSERT INTO wa_rewrite_log/i.test(s)) { const last = db.rwlog.filter((r) => r.key === p[0]).at(-1); if (!last || last.state !== p[4]) db.rwlog.push({ key: p[0], old_name: p[1], new_name: p[2], lang: p[3], state: p[4], status: p[5], category: p[6], at: new Date().toISOString() }); return { rows: [], rowCount: 1 }; }
    if (/^SELECT state, status, category, at FROM wa_rewrite_log/i.test(s)) return { rows: db.rwlog.filter((r) => r.key === p[0]).reverse() };
    if (/^SELECT receipt, order_date FROM ts_orders WHERE order_id=\$1/i.test(s)) return { rows: ts.filter((o) => o.order_id === p[0]) };
    if (/^SELECT created_at FROM shop_orders WHERE order_no=\$1/i.test(s)) return { rows: shop.filter((o) => o.order_no === p[0]) };
    if (/^INSERT INTO wa_messages/i.test(s)) { db.out.push({ template: p[2] }); return { rows: [], rowCount: 1 }; }
    if (/^INSERT INTO wa_bot_chats\(phone_norm, review_code/i.test(s)) { db.marks.push(p); return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  } };
  const calls = [];
  const fetch = async (url, init) => { const body = init && init.body ? JSON.parse(init.body) : null; calls.push({ url, body }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.T${calls.length}` }] }) }; };
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE"), request: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, bundles: [] }) }) };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, ""), isOwner: () => true };
  const wa = W.register(app, ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const row = (name, lang) => (meta[`${name}:${lang}`] || null);
  wa.setTemplateStatus(async (name, lang) => (row(name, lang) ? row(name, lang).status : null));
  wa.setTemplateCategory(async (name, lang) => (row(name, lang) ? row(name, lang).category : null));
  const inject = () => { wa.setTemplateStatus(async (name, lang) => (row(name, lang) ? row(name, lang).status : null)); wa.setTemplateCategory(async (name, lang) => (row(name, lang) ? row(name, lang).category : null)); };
  const templates = () => calls.map((c) => c.body).filter((b) => b && b.type === "template").map((b) => b.template);
  return { db, pool, wa, app, ctx, calls, templates, routes, fetch, inject };
}
const A = (category = "UTILITY") => ({ status: "APPROVED", category });

test("pickRewrite: the new template only when Meta says APPROVED + UTILITY, the owner switch is on and the sender is WhatsApp — every other state keeps the old one", () => {
  const map = RW.rewriteByKey("reviewStars");
  const P = (x) => RW.pickRewrite({ map, ...x });
  assert.deepEqual(P({ status: "APPROVED", category: "UTILITY" }), { use: "new", name: "fc_review_order_v3", state: "in_use", record: true });
  assert.equal(P({ status: null }).state, "unknown");
  assert.equal(P({ status: "NOT_SUBMITTED" }).state, "not_submitted");
  assert.equal(P({ status: "PENDING", category: "UTILITY" }).state, "pending");
  assert.deepEqual(P({ status: "REJECTED", category: "UTILITY" }), { use: "old", name: "fc_review_stars", state: "rejected", record: true });
  assert.deepEqual(P({ status: "APPROVED", category: "MARKETING" }), { use: "old", name: "fc_review_stars", state: "reclassified", record: true });
  assert.equal(P({ status: "APPROVED", category: null }).state, "unknown", "approved but the category for THIS language is unknown ⇒ old");
  assert.equal(P({ status: "PAUSED", category: "UTILITY" }).state, "paused");
  assert.equal(P({ status: "APPROVED", category: "UTILITY", switchOn: false }).state, "switch_off");
  for (const x of [{}, { status: "PENDING" }, { status: "REJECTED" }, { status: "APPROVED", category: "MARKETING" }, { status: "APPROVED", category: "UTILITY", switchOn: false }]) assert.equal(P(x).use, "old", JSON.stringify(x));
  const notWired = RW.rewriteByKey("waitlistOpen");
  assert.deepEqual(RW.pickRewrite({ map: notWired, status: "APPROVED", category: "UTILITY" }), { use: "old", name: "fc_waitlist_open", state: "ready_not_wired", record: true });
  assert.ok(Object.keys(RW.REWRITE_STATE_AR).every((k) => /[؀-ۿ]/.test(RW.REWRITE_STATE_AR[k])));
});

test("catalog: the five replacements are valid, UTILITY, ONE language each (the mapping's), new names, a fixed reference before the first variable, same data paths as the old template, queued in a batch", () => {
  assert.deepEqual(RW.UTILITY_REWRITES.map((m) => `${m.old}:${m.lang}→${m.new}`), ["fc_review_stars:ar→fc_review_order_v3", "fc_staff_inbox_summary:ar→fc_staff_inbox_alert",
    "fc_staff_task_notice:en→fc_staff_task_alert", "fc_staff_checkout_watchdog:ar→fc_staff_payment_notice", "fc_waitlist_open:ar→fc_open_request_update"]);
  for (const m of RW.UTILITY_REWRITES) {
    const rows = C.TEMPLATES.filter((t) => t.name === m.new);
    assert.deepEqual(rows.map((t) => t.language), [m.lang], `${m.new}: only the language Meta re-classed`);
    const t = rows[0], old = C.findTemplate(m.old, m.lang);
    assert.ok(old, `${m.old}:${m.lang} exists`);
    assert.deepEqual(C.validateTemplate(t), [], m.new);
    assert.equal(t.category, "UTILITY"); assert.equal(t.meta.replaces, m.old);
    assert.ok(!Object.keys(C.META_CATEGORY).some((k) => k.startsWith(`${m.new}:`)), `${m.new} never re-classed`);
    const body = C.bodyOf(t);
    assert.ok(/^[^{]{8,}\{\{1\}\}/.test(body), `${m.new}: fixed text before {{1}}`);
    assert.ok(!/^(فريش كاتس|شكر|أهلاً|مرحب)/.test(body), `${m.new}: opens with the transaction, not the brand or thanks`);
    assert.ok(!/جرّب|تفضّل|اطلب|اشترك|جدّد|try |order now/i.test(body), `${m.new}: no call to try/visit/order/renew`);
    for (const b of C.buttonsOf(t)) assert.equal(C.buttonTextProblem(b.text), null);
    if (m.audience === "staff") { assert.equal(t.meta.group, "staff"); assert.ok(C.buttonsOf(t).every((b) => b.type === "URL"), `${m.new}: link button only`); }
    if (m.wired && m.audience === "staff") assert.deepEqual(t.meta.vars.map((v) => v.path), old.meta.vars.map((v) => v.path), `${m.new}: binds from the same data the sender already passes`);
    assert.ok(C.SUBMIT_BATCHES.some((b) => b.includes(m.new)), `${m.new} in a batch`);
    assert.ok(!(m.new in C.HOLD));
  }
  const v3 = C.findTemplate("fc_review_order_v3");
  assert.deepEqual(C.buttonsOf(v3).map((b) => [b.type, b.text]), C.STAR_BUTTONS.map((b) => ["QUICK_REPLY", b.text]), "the very same star buttons (wareviews.starOfQr reads the text)");
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿👇🌟]/u.test(C.bodyOf(v3)), "no emoji in the review question");
  assert.deepEqual(C.buttonsOf(C.findTemplate("fc_open_request_update")), [], "the opening notice has no button");
  assert.deepEqual(C.SUBMIT_BATCHES.at(-1), ["fc_review_order_v3", "fc_staff_inbox_alert", "fc_staff_task_alert", "fc_staff_payment_notice", "fc_open_request_update"]);
  // the fallback table knows the two UT1 names Meta approved as MARKETING on 19/10
  assert.equal(C.META_CATEGORY["fc_staff_inbox_summary:ar"], "MARKETING"); assert.equal(C.META_CATEGORY["fc_staff_task_notice:en"], "MARKETING");
  // the review consent (till payment / Keeta) covers the replacement of the same review message, nothing else
  assert.deepEqual(CONSENT.POS_REVIEW_CONSENT.templates, ["fc_review_stars", "fc_review_order_v3"]);
  assert.deepEqual(CONSENT.KA2_REVIEW_CONSENT.templates, ["fc_review_stars", "fc_review_order_v3"]);
});

test("resolveRewrite: old until Meta approves the new one as UTILITY; re-classed / rejected ⇒ old + ONE log row per change; owner switch off ⇒ old; unknown map ⇒ same name", withEnv(OPEN, async () => {
  const meta = {};
  const w = world({ meta });
  assert.deepEqual(await w.wa.resolveRewrite("fc_order_received", "ar"), { name: "fc_order_received", rewrite: null });
  assert.deepEqual(await w.wa.resolveRewrite("fc_review_stars", "ar"), { name: "fc_review_stars", rewrite: { key: "reviewStars", state: "unknown" } });
  meta["fc_review_order_v3:ar"] = { status: "PENDING", category: "UTILITY" };
  assert.equal((await w.wa.resolveRewrite("fc_review_stars", "ar")).name, "fc_review_stars");
  meta["fc_review_order_v3:ar"] = A("UTILITY");
  assert.deepEqual(await w.wa.resolveRewrite("fc_review_stars", "ar"), { name: "fc_review_order_v3", rewrite: { key: "reviewStars", state: "in_use" } });
  await w.wa.resolveRewrite("fc_review_stars", "ar");
  meta["fc_review_order_v3:ar"] = A("MARKETING");
  assert.equal((await w.wa.resolveRewrite("fc_review_stars", "ar")).name, "fc_review_stars", "Meta re-classed the new one ⇒ back to the old");
  await w.wa.resolveRewrite("fc_review_stars", "ar");
  assert.deepEqual(w.db.rwlog.map((r) => [r.key, r.state, r.status, r.category]), [["reviewStars", "in_use", "APPROVED", "UTILITY"], ["reviewStars", "reclassified", "APPROVED", "MARKETING"]], "one row per change, not per message");
  assert.equal((await w.wa.resolveRewrite("fc_review_stars", "en")).rewrite, null, "the mapping is per language");
  const off = world({ meta: { "fc_review_order_v3:ar": A() }, settings: { waBot: { utilityFirst: { rewriteReviewStars: false } } } });
  assert.deepEqual(await off.wa.resolveRewrite("fc_review_stars", "ar"), { name: "fc_review_stars", rewrite: { key: "reviewStars", state: "switch_off" } });
  const rej = world({ meta: { "fc_staff_inbox_alert:ar": { status: "REJECTED", category: "UTILITY" } } });
  assert.equal((await rej.wa.resolveRewrite("fc_staff_inbox_summary", "ar")).name, "fc_staff_inbox_summary");
  assert.deepEqual(rej.db.rwlog.map((r) => r.state), ["rejected"]);
  // wrong language row only ⇒ category unknown for ar ⇒ old (never the new one on a guess)
  const en = world({ meta: { "fc_staff_inbox_alert:en": A() } });
  assert.equal((await en.wa.resolveRewrite("fc_staff_inbox_summary", "ar")).name, "fc_staff_inbox_summary");
}));

test("staff sender: fc_staff_inbox_summary:ar (MARKETING at Meta) is refused today; once fc_staff_inbox_alert is APPROVED + UTILITY the same call sends the new one with the same data", withEnv(OPEN, async () => {
  const data = { inbox: { at: "23:40", handovers: "4", alerts: "2" } };
  const before = world({ meta: { "fc_staff_inbox_summary:ar": A("MARKETING"), "fc_staff_inbox_alert:ar": { status: "PENDING", category: "UTILITY" } } });
  const r0 = await before.wa.sendStaffTemplate({ phoneNorm: CASH, template: "fc_staff_inbox_summary", data, lang: "ar" });
  assert.equal(r0.skipped, "meta_marketing", "unchanged until Meta approves the replacement");
  assert.deepEqual(before.templates(), []);
  const after = world({ meta: { "fc_staff_inbox_summary:ar": A("MARKETING"), "fc_staff_inbox_alert:ar": A("UTILITY") } });
  const r1 = await after.wa.sendStaffTemplate({ phoneNorm: CASH, template: "fc_staff_inbox_summary", data, lang: "ar" });
  assert.equal(r1.ok, true, JSON.stringify(r1)); assert.equal(r1.template, "fc_staff_inbox_alert"); assert.equal(r1.rewriteOf, "fc_staff_inbox_summary");
  const t = after.templates()[0];
  assert.equal(t.name, "fc_staff_inbox_alert"); assert.equal(t.language.code, "ar");
  assert.deepEqual(t.components[0].parameters.map((x) => x.text), ["23:40", "4", "2"]);
  // the English inbox summary is UTILITY at Meta and has no mapping ⇒ untouched
  const enw = world({ meta: { "fc_staff_inbox_summary:en": A("UTILITY"), "fc_staff_inbox_alert:ar": A("UTILITY") } });
  const r2 = await enw.wa.sendStaffTemplate({ phoneNorm: CASH, template: "fc_staff_inbox_summary", data, lang: "en" });
  assert.equal(r2.ok, true); assert.equal(enw.templates()[0].name, "fc_staff_inbox_summary"); assert.equal(enw.templates()[0].language.code, "en");
  // re-classed replacement ⇒ the old one (refused as today) and a log row
  const bad = world({ meta: { "fc_staff_inbox_summary:ar": A("MARKETING"), "fc_staff_inbox_alert:ar": A("MARKETING") } });
  assert.equal((await bad.wa.sendStaffTemplate({ phoneNorm: CASH, template: "fc_staff_inbox_summary", data, lang: "ar" })).skipped, "meta_marketing");
  assert.deepEqual(bad.db.rwlog.map((r) => [r.key, r.state]), [["inboxSummary", "reclassified"]]);
}));

/* reviewAsk الحقيقي (wabotrun) بره النافذة في وضع التجربة — قالب النجوم مفتوح */
function bot(w) {
  return R.register(w.app, w.ctx, { app: w.app, wa: w.wa, now: () => new Date("2026-10-19T12:00:00Z"), noTimer: true, sendSms: async () => ({ ok: true }) });
}
const FLOW = { waBot: { mode: "test", reviewWhatsApp: true, reviewFlow: { enabled: true, starsTemplate: true } } };
test("review ask: fc_review_stars until the replacement is APPROVED + UTILITY; then fc_review_order_v3 with the order number + its Riyadh date — web W…, till receipt, Keeta receipt from ts_orders; no number or no date ⇒ the old one", withEnv(OPEN, async () => {
  const pend = world({ meta: { "fc_review_order_v3:ar": { status: "PENDING", category: "UTILITY" } }, settings: FLOW });
  const b0 = bot(pend);
  const r0 = await b0.reviewAsk({ phone: `0${CUST}`, orderNo: "W1790012345678", code: "ab12cd34", kind: "delivery", orderAt: "2026-10-18T19:30:00Z" });
  assert.equal(r0.ok, true, JSON.stringify(r0));
  assert.equal(pend.templates()[0].name, "fc_review_stars");

  const ok = world({ meta: { "fc_review_order_v3:ar": A() }, settings: FLOW, ts: [{ order_id: "9201", receipt: "3307", order_date: "2026-10-18T22:10:00Z" }] });
  const b1 = bot(ok);
  assert.equal((await b1.reviewAsk({ phone: `0${CUST}`, orderNo: "W1790012345678", code: "ab12cd34", kind: "delivery", orderAt: "2026-10-18T19:30:00Z" })).channel, "wa_stars");
  let t = ok.templates().at(-1);
  assert.equal(t.name, "fc_review_order_v3");
  assert.deepEqual(t.components.find((c) => c.type === "body").parameters.map((x) => x.text), ["W1790012345678", "18/10/2026"]);
  // till receipt from the invite ref, date = order time in Riyadh (22:10 UTC on 18/10 = 01:10 on 19/10 Riyadh)
  await b1.reviewAsk({ phone: `0${CUST}`, orderNo: "pos:9201", code: "ab12cd35", kind: "dinein", ref: "فاتورة 3307", orderAt: "2026-10-18T22:10:00Z" });
  t = ok.templates().at(-1);
  assert.deepEqual([t.name, ...t.components.find((c) => c.type === "body").parameters.map((x) => x.text)], ["fc_review_order_v3", "3307", "19/10/2026"]);
  // Keeta (KA2): no ref on the invite ⇒ the receipt + date come from ts_orders
  await b1.reviewAsk({ phone: `0${CUST}`, orderNo: "pos:9201", code: "ab12cd36", kind: "app", ka2: true });
  t = ok.templates().at(-1);
  assert.deepEqual([t.name, ...t.components.find((c) => c.type === "body").parameters.map((x) => x.text)], ["fc_review_order_v3", "3307", "19/10/2026"]);
  // nothing the customer would recognise ⇒ the old template, not an invented number
  await b1.reviewAsk({ phone: `0${CUST}`, orderNo: "pos:9999", code: "ab12cd37", kind: "takeaway" });
  assert.equal(ok.templates().at(-1).name, "fc_review_stars");
  // web order without orderAt ⇒ the date from shop_orders; still missing ⇒ old
  const web = world({ meta: { "fc_review_order_v3:ar": A() }, settings: FLOW, shop: [{ order_no: "W1790000000001", created_at: "2026-10-17T15:00:00Z" }] });
  const b2 = bot(web);
  await b2.reviewAsk({ phone: `0${CUST}`, orderNo: "W1790000000001", code: "ab12cd38", kind: "delivery" });
  t = web.templates().at(-1);
  assert.deepEqual([t.name, ...t.components.find((c) => c.type === "body").parameters.map((x) => x.text)], ["fc_review_order_v3", "W1790000000001", "17/10/2026"]);
  await b2.reviewAsk({ phone: `0${CUST}`, orderNo: "W1790000000002", code: "ab12cd39", kind: "delivery" });
  assert.equal(web.templates().at(-1).name, "fc_review_stars");
  // the star buttons work the same for both templates (same texts)
  assert.deepEqual(C.buttonsOf(C.findTemplate("fc_review_order_v3")).map((b) => b.text), C.buttonsOf(C.findTemplate("fc_review_stars")).map((b) => b.text));
}));

test("dashboard switches: one per mapping in «الخدمي أولاً» (default on, Arabic label + help), saved through the same validator; report route is GET only and lists every mapping with its live state", withEnv(OPEN, async () => {
  const def = R.botConfig({}).utilityFirst;
  for (const sw of RW.REWRITE_SWITCHES) assert.equal(def[sw], true, sw);
  const rows = R.schemaFor(R.botConfig({})).filter((x) => x.group === "utilityFirst" && /\.rewrite/.test(x.key));
  assert.deepEqual(rows.map((x) => x.key), RW.REWRITE_SWITCHES.map((s) => `utilityFirst.${s}`));
  assert.ok(rows.every((x) => x.type === "boolean" && x.default === true && /[؀-ۿ]/.test(x.ar) && /[؀-ۿ]/.test(x.help)));
  assert.deepEqual(U.utilityFirstFromBody({ rewriteReviewStars: false }, {}), { ok: true, value: { rewriteReviewStars: false } });
  assert.equal(U.utilityFirstFromBody({ rewriteReviewStars: "x" }).ok, false);
  assert.equal(R.botConfig({ waBot: { utilityFirst: { rewriteInboxSummary: false } } }).utilityFirst.rewriteInboxSummary, false);

  const w = world({ meta: { "fc_review_order_v3:ar": A(), "fc_staff_inbox_alert:ar": { status: "PENDING", category: "UTILITY" }, "fc_staff_task_alert:en": A("MARKETING"),
    "fc_staff_payment_notice:ar": A(), "fc_review_stars:ar": A("MARKETING") } });
  WC.register(w.app, w.ctx, { wa: w.wa, fetch: w.fetch });
  w.inject();      // wacloud بيحقن قراية ميتا بتاعته (fetch الوهمي) — نرجّع حالة ميتا بتاعة الاختبار
  const h = w.routes["GET /api/cms/wa-cloud/utility-rewrites"];
  assert.ok(h, "route registered");
  assert.ok(!Object.keys(w.routes).some((k) => /utility-rewrites/.test(k) && !k.startsWith("GET ")), "no write route");
  let out = null;
  await h({ req: { query: () => null, header: () => null }, json: (x) => { out = x; return x; } });
  assert.equal(out.ok, true, JSON.stringify(out));
  const by = Object.fromEntries(out.rows.map((r) => [r.key, r]));
  assert.deepEqual(Object.keys(by), RW.REWRITE_KEYS);
  assert.deepEqual([by.reviewStars.state, by.reviewStars.using, by.reviewStars.oldCategory], ["in_use", "fc_review_order_v3", "MARKETING"]);
  assert.deepEqual([by.inboxSummary.state, by.inboxSummary.using], ["pending", "fc_staff_inbox_summary"]);
  assert.deepEqual([by.taskNotice.state, by.taskNotice.using], ["reclassified", "fc_staff_task_notice"]);
  assert.deepEqual([by.checkoutWatchdog.state, by.checkoutWatchdog.using], ["ready_not_wired", "fc_staff_checkout_watchdog"]);
  assert.equal(by.waitlistOpen.state, "unknown");
  assert.deepEqual(out.inUse, ["reviewStars"]);
  assert.ok(out.rows.every((r) => /[؀-ۿ]/.test(r.stateAr) && r.switch.startsWith("waBot.utilityFirst.rewrite") && r.inCatalog));
  assert.ok(by.reviewStars.log.length >= 1 && by.reviewStars.log[0].state === "in_use");
}));
