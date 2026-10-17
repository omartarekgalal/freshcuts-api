/* SW1 (١٣/١٠) — مفاتيح واتساب المستقلة (M6 من مراجعة الخبير):
   الرد الحر (بوت + موظف) مش محتاج مفتاح تحديثات الطلب · تحديثات الطلب لكل مرحلة (الافتراضي: ولا مرحلة) · «يغني عن الـSMS» لكل مرحلة ·
   شاشة «قبل ما تشغّل» · قالبين جداد موقوفين.
   node --test wa-switches.test.mjs — قاعدة وهمية وfetch وهمي؛ مفيش شبكة حقيقية ولا أي إرسال. */
import test from "node:test";
import assert from "node:assert/strict";

const W = await import("./whatsapp.js");
const C = await import("./wacloud.js");
const CAT = await import("./watemplates.js");
const SW = await import("./waswitches.js");
const ST = await import("./wastaff.js");
const { register: registerNotify, MANDATORY_SMS_STAGES } = await import("./notify.js");
const { SERVER_OWNED_PATHS } = await import("./settings-guard.js");
W.registerCatalog(CAT);

const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN", "WHATSAPP_TEMPLATES_WRITE"];
function withEnv(vals, fn) {
  return async () => { const saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } Object.assign(process.env, vals);
    try { await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
}
const CONFIGURED = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1", WHATSAPP_WABA_ID: "WABA1" };
const ALLOW = { ...CONFIGURED, WHATSAPP_ENABLED: "1" };
const CUST = "512345678";
const STAGES = Object.keys(W.STAGE_TEMPLATES);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
function fakeApp() { const routes = {}; const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; }
const call = (app, route, { json = {}, query = {}, param = {}, auth = "Bearer cms:own" } = {}) => app.routes[route]({
  req: { json: async () => json, header: (n) => (String(n).toLowerCase() === "authorization" ? auth : undefined), query: (n) => query[n], param: (n) => param[n] }, json: (body, status = 200) => ({ body, status }) });

// ═════════ دوال صافية ═════════
test("المراحل: الافتراضي ولا مرحلة؛ القايمة بتتنضّف؛ و«يغني عن الـSMS» لكل مرحلة (والمفتاح القديم بيفضل شغّال لو مفيش قايمة)", () => {
  assert.deepEqual(SW.waStagesOf(undefined), []); assert.deepEqual(SW.waStagesOf({}), []); assert.deepEqual(SW.waStagesOf({ whatsappStages: "accepted" }), []);
  assert.deepEqual(SW.waStagesOf({ whatsappStages: ["accepted", "accepted", " delivered ", "DROP TABLE", null, 7] }), ["accepted", "delivered"]);
  assert.equal(SW.waStageOn({ whatsappStages: ["accepted"] }, "accepted"), true); assert.equal(SW.waStageOn({ whatsappStages: ["accepted"] }, "delivered"), false);
  assert.equal(SW.waStageOn({ whatsappEnabled: true }, "accepted"), false, "المفتاح العام لوحده مابيشغّلش ولا مرحلة");
  // لكل مرحلة
  const n = { whatsappStages: ["accepted", "delivered"], whatsappReplacesSmsStages: ["delivered"], whatsappReplacesSms: true };
  assert.equal(SW.waReplacesSms(n, "delivered"), true); assert.equal(SW.waReplacesSms(n, "accepted"), false, "القايمة بتغلب المفتاح القديم");
  assert.equal(SW.waReplacesSms({ whatsappReplacesSmsStages: [] , whatsappReplacesSms: true }, "accepted"), false);
  // قديم: من غير قايمة ⇒ المفتاح العام على كل المراحل زي الأول
  assert.equal(SW.waReplacesSms({ whatsappReplacesSms: true }, "accepted"), true); assert.equal(SW.waReplacesSms({}, "accepted"), false); assert.equal(SW.waReplacesSms(undefined, "accepted"), false);
  assert.deepEqual([...SW.MANDATORY_SMS_STAGES], [...MANDATORY_SMS_STAGES], "نفس قايمة notify.js");
  for (const s of STAGES) assert.ok(SW.STAGE_LABELS[s], `label for ${s}`);
  assert.ok(SERVER_OWNED_PATHS.includes("notifications.whatsappStages") && SERVER_OWNED_PATHS.includes("notifications.whatsappReplacesSmsStages"), "الحفظ العام للإعدادات مايقدرش يشغّل مرحلة");
});

const META = (over = {}) => STAGES.map((st) => ({ name: W.STAGE_TEMPLATES[st], language: "ar", category: "UTILITY", status: "APPROVED", ...(over[st] || {}) }));

test("صفوف المراحل: حالة قالب كل مرحلة عند ميتا، والمرفوض/غير المقدَّم/المصنَّف تسويق مايتشغّلش وبنقول ليه", () => {
  const rows = SW.stageRows({ stageTemplates: W.STAGE_TEMPLATES, notifications: { whatsappStages: ["accepted", "delivered"], whatsappReplacesSmsStages: ["delivered"] },
    metaList: META({ pickup_ready: { status: "REJECTED" }, on_the_way: { category: "MARKETING" } }).filter((t) => t.name !== "fc_refund_in_progress"), metaOk: true, mandatorySms: SW.MANDATORY_SMS_STAGES });
  const by = Object.fromEntries(rows.map((r) => [r.stage, r]));
  assert.deepEqual(rows.map((r) => r.stage), [...STAGES, "collected"]);      // RT2: + صف المرحلة الحرة «اتسلّم من الفرع»
  assert.deepEqual([by.collected.free, by.collected.template, by.collected.canEnable, by.collected.enabled, by.collected.smsOnly], [true, null, true, false, false]);
  assert.deepEqual([by.accepted.enabled, by.accepted.replacesSms, by.accepted.smsOnly, by.accepted.canEnable, by.accepted.metaStatus, by.accepted.template], [true, false, false, true, "APPROVED", "fc_order_preparing"]);
  assert.deepEqual([by.delivered.enabled, by.delivered.replacesSms], [true, true]);
  assert.deepEqual([by.pickup_ready.canEnable, by.pickup_ready.blockedBy, by.pickup_ready.metaStatus, by.pickup_ready.smsOnly], [false, "template_not_approved", "REJECTED", true]);
  assert.match(by.pickup_ready.note, /SMS بس/);
  assert.deepEqual([by.on_the_way.canEnable, by.on_the_way.blockedBy], [false, "template_not_utility"]);
  assert.deepEqual([by.refund_failed.metaStatus, by.refund_failed.blockedBy, by.refund_failed.mandatorySms], ["NOT_SUBMITTED", "template_not_approved", true]);
  // ماقدرناش نقرا ميتا ⇒ مانعرفش، ومايتشغّلش جديد
  const blind = SW.stageRows({ stageTemplates: W.STAGE_TEMPLATES, notifications: {}, metaOk: false });
  assert.ok(blind.filter((r) => !r.free).every((r) => r.metaStatus === null && r.canEnable === false && r.blockedBy === "meta_unreadable" && r.enabled === false));
  assert.ok(blind.filter((r) => r.free).every((r) => r.canEnable === true && r.blockedBy === null && r.template === null), "RT2: المرحلة الحرة من غير قالب مابتقفش على ميتا");
});

test("حفظ المراحل: إضافة مرحلة محتاجة قالب معتمد وخدمي؛ الشيل مسموح دايماً؛ و«يغني عن الـSMS» لازم لمرحلة مشغّلة", () => {
  const P = (x) => { const r = SW.stagesProblem({ stageTemplates: W.STAGE_TEMPLATES, metaList: META({ pickup_ready: { status: "REJECTED" } }), metaOk: true, current: [], ...x }); return r ? r.error : null; };
  assert.equal(P({ want: ["accepted", "delivered"] }), null);
  assert.equal(P({ want: [] }), null);
  assert.equal(P({ want: "accepted" }), "bad_stages"); assert.equal(P({ want: ["accepted", "accepted"] }), "bad_stages"); assert.equal(P({ want: ["x y"] }), "bad_stages");
  assert.equal(P({ want: ["loyalty_status"] }), "unknown_stage");
  assert.equal(P({ want: ["pickup_ready"] }), "template_not_approved");
  assert.equal(P({ want: ["pickup_ready"], current: ["pickup_ready"] }), null, "مرحلة كانت مشغّلة بتفضل (مش إضافة)");
  assert.equal(P({ want: ["accepted"], metaOk: false }), "meta_unreadable");
  assert.equal(P({ want: [], metaOk: false, current: ["accepted"] }), null, "القفل مايستناش ميتا");
  assert.equal(P({ want: ["accepted"], metaOk: false, current: ["accepted", "delivered"] }), null);
  assert.equal(P({ want: ["accepted"], replaces: ["delivered"] }), "replaces_needs_stage");
  assert.equal(P({ want: ["accepted"], replaces: "accepted" }), "bad_replaces");
  assert.equal(P({ want: ["accepted"], replaces: ["accepted"] }), null);
  const msg = SW.stagesProblem({ want: ["pickup_ready"], stageTemplates: W.STAGE_TEMPLATES, metaList: META({ pickup_ready: { status: "REJECTED" } }), metaOk: true });
  assert.deepEqual([msg.stage, msg.template], ["pickup_ready", "fc_order_ready_pickup"]); assert.match(msg.message, /جاهز للاستلام \(استلام من الفرع\): القالب لسه مش معتمد عند ميتا/);      // RT2: التسمية الجديدة
});

test("القالبين الجداد: في الكتالوج، موقوفين (HOLD)، مش في أي دفعة تقديم، ومش مربوطين بمرحلة", withEnv({ ...ALLOW, WHATSAPP_TEMPLATES_WRITE: "1" }, async () => {
  for (const name of ["fc_order_pickup_ready", "fc_staff_checkout_notice"]) {
    assert.ok(CAT.HOLD[name], `${name} held`);
    assert.ok(!CAT.SUBMIT_BATCHES.flat().includes(name), `${name} not in a submit batch`);
    for (const lang of ["ar", "en"]) { const t = CAT.findTemplate(name, lang); assert.ok(t, `${name} ${lang}`); assert.equal(t.category, "UTILITY"); assert.deepEqual(CAT.validateTemplate(t), []); }
    assert.ok(W.TEMPLATES[name] && !W.TEMPLATES[name].stage && !W.TEMPLATES[name].campaign, `${name} is not wired to a sender`);
    assert.equal(C.campaignSpec(name), null);
  }
  assert.equal(W.STAGE_TEMPLATES.pickup_ready, "fc_order_ready_pickup", "المرحلة لسه على القالب القديم — الجديد مايتبعتش");
  // RT2 (١٧/١٠): صياغة المالك — نفس النص بيطلع رسالة حرة جوّه النافذة لحد ما ميتا تعتمده
  assert.equal(CAT.bodyOf(CAT.findTemplate("fc_order_pickup_ready", "ar")), "طلبك رقم {{1}} جاهز للاستلام من فريش كاتس 📍 تفضّل إلى الفرع واذكر رقم طلبك.");
  assert.equal(CAT.bodyOf(CAT.findTemplate("fc_order_pickup_ready", "en")), "Your order {{1}} is ready for pickup from Fresh Cuts 📍 Please come to the branch and mention your order number.");
  // مسار التقديم بيرفضهم
  const app = fakeApp(); const calls = [];
  W.register(app, { pool: { query: async () => ({ rows: [], rowCount: 0 }) }, requireAdmin: async () => null, getSettingsData: async () => ({}), jb: JSON.stringify, normPhone: String },
    { fetch: async (u) => { calls.push(String(u)); return { ok: true, status: 200, json: async () => ({ id: "1" }) }; } });
  for (const name of ["fc_order_pickup_ready", "fc_staff_checkout_notice"]) {
    const r = await call(app, "POST /api/wa/templates/submit", { json: { names: [name] } });
    assert.deepEqual([r.body.results[0].ok, r.body.results[0].error], [false, "held"], name);
  }
  assert.equal(calls.length, 0, "nothing reached Meta");
}));

// ═════════ الحارس والإرسال ═════════
function world({ settings = {}, optins = {}, inbound = [CUST], orders = {}, terms = [], metaList = META(), metaOk = true, queued = { rm: 0, rj: 0, pm: 0, pj: 0 }, stopped = null } = {}) {
  const db = { settings: { waMaster: { enabled: true }, waBot: { testPhones: [] }, ...settings }, msgs: [], staff: [], sql: [], sms: [], saved: [] };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim(); db.sql.push(s);
    if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: inbound.includes(p[0]) ? [{}] : [] };
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: optins[p[0]] ? [optins[p[0]]] : [] };
    if (/FROM wa_optin_log/i.test(s)) return { rows: terms.filter((t) => t.phone === p[0] && t.order === p[1]).map(() => ({ ok: 1, version: "terms-2026-10-13" })) };
    if (/FROM shop_orders/i.test(s)) return { rows: orders[p[0]] ? [{ order_no: p[0], phone_norm: CUST, ...orders[p[0]] }] : [] };
    if (/^INSERT INTO wa_messages/i.test(s)) { db.msgs.push({ wamid: p[0], phone_norm: p[1], template: p[2], status: p[6], body: p[8], source: p[10] }); return { rows: [], rowCount: 1 }; }
    if (/^INSERT INTO wa_staff_replies/i.test(s)) { db.staff.push({ phone_norm: p[0], by: p[2] }); return { rows: [], rowCount: 1 }; }
    if (/FROM wa_send_queue q JOIN wa_send_jobs j/i.test(s)) return { rows: [queued] };
    if (/^SELECT stopped_reason FROM wa_sender_state WHERE id=2/i.test(s)) return { rows: [{ stopped_reason: stopped }] };
    if (/^UPDATE settings SET data = jsonb_set\(jsonb_set\(jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{notifications\}'/i.test(s)) {
      db.saved.push([JSON.parse(p[0]), JSON.parse(p[1])]);
      db.settings.notifications = { ...(db.settings.notifications || {}), whatsappStages: JSON.parse(p[0]), whatsappReplacesSmsStages: JSON.parse(p[1]) };
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  } };
  const calls = [], graphReads = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (/message_templates/.test(u)) { graphReads.push(u); return metaOk ? { ok: true, status: 200, json: async () => ({ data: metaList }) } : { ok: false, status: 500, json: async () => ({ error: { message: "meta down", code: 2 } }) }; }
    if ((init.method || "GET") === "GET") { graphReads.push(u); return { ok: true, status: 200, json: async () => ({}) }; }
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.S${calls.length}` }] }) };
  };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(fakeApp(), ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const app = fakeApp();
  const cloud = C.register(app, ctx, { wa, fetch, sessionUser: async (t) => (t === "cms:mk" ? { name: "تسويق", role: "marketing" } : { name: "عمر", role: "owner" }) });
  const staff = ST.register(fakeApp(), ctx, { wa, hub: () => null, keySalt: "s", log: { error() {} } });
  const notify = registerNotify(fakeApp(), { ...ctx, sendSms: async (m) => { db.sms.push(m); return { ok: true }; } }, { wa, sendSms: async (m) => { db.sms.push(m); return { ok: true }; } });
  return { db, app, wa, cloud, staff, notify, calls, graphReads };
}
const text = () => ({ type: "text", text: { body: "حيّاك" } });
const ORDER = { name: "أحمد", option: "delivery", total: 80, refund_id: null, table_no: null };

test("القبول (M6): المفتاح الرئيسي مفتوح + ولا مرحلة + قناة الحملات مقفولة ⇒ رد الموظف يوصل، رد البوت يوصل، وطلب مدفوع مايبعتش ولا قالب", withEnv(ALLOW, async () => {
  // من غير notifications.whatsappEnabled خالص (زي السيرفر الحي لو المفتاح ده مقفول) — ومعاه كمان
  for (const notifications of [undefined, { whatsappEnabled: false }, { whatsappEnabled: true }, { whatsappEnabled: true, whatsappStages: [] }]) {
    const w = world({ settings: { ...(notifications ? { notifications: { smsEnabled: false, pushEnabled: false, ...notifications } } : {}), waCloud: { enabled: false } },
      optins: { [CUST]: { updates: true, marketing: true } }, orders: { W1: ORDER }, terms: [{ phone: CUST, order: "W1" }] });
    const tag = JSON.stringify(notifications || null);
    // ١) رد الموظف من البورتال
    const r = await w.staff.reply({ phoneNorm: "0" + CUST, text: "حيّاك، نجهّزها لك", by: "سلمى", role: "cashier", via: "portal" });
    assert.deepEqual([r.ok, r.wamid], [true, "wamid.S1"], tag);
    assert.deepEqual(await w.staff.sendStateFor(CUST), { ok: true, gate: null, test: false }, `${tag}: reply box open`);
    // ٢) رد البوت (sendFreeform بمصدر bot — نفس اللي wabotrun بينادي عليه في وضع live)
    const b = await w.wa.sendFreeform({ phoneNorm: CUST, payload: text(), source: "bot" });
    assert.deepEqual([b.ok, b.wamid], [true, "wamid.S2"], tag);
    assert.equal(await w.wa.gate("session"), null, tag);
    // ٣) طلب مدفوع بيعدّي على كل مراحله: ولا قالب
    for (const st of ["pos_created", "accepted", "on_the_way", "delivered", "rejected_refunded", "refund_failed"]) await w.notify.orderStatusChanged("W1", st);
    await w.notify.orderReady("W1");
    await flush();
    assert.equal(w.calls.length, 2, `${tag}: only the two session replies reached Meta`);
    assert.equal(w.db.msgs.filter((m) => m.template).length, 0, `${tag}: zero templates`);
    for (const st of STAGES) assert.deepEqual(await w.wa.sendOrderUpdate({ order_no: "W1", phone_norm: CUST, ...ORDER }, st), { ok: false, skipped: "stage_off" }, `${tag} ${st}`);
    assert.equal(w.calls.length, 2);
  }
}));

test("الرد الحر لسه محكوم بالأقفال التلاتة والنافذة؛ والقوالب لسه على الأربعة", async () => {
  const optins = { [CUST]: { updates: true, marketing: true } };
  const tryAll = async (w) => [
    (await w.wa.sendFreeform({ phoneNorm: CUST, payload: text(), source: "bot" })).skipped || "sent",
    (await w.wa.sendText({ phoneNorm: CUST, text: "أهلاً" })).skipped || "sent",
    (await w.staff.reply({ phoneNorm: CUST, text: "أهلاً", by: "x", role: "cashier", via: "portal" })).gate || "sent",
    (await w.wa.sendTemplate({ phoneNorm: CUST, template: "fc_order_preparing", params: { body: ["W1"], button: ["W1"] }, orderNo: "W1" })).skipped || "sent",
    (await w.wa.sendTemplate({ phoneNorm: CUST, template: "fc_offer_img", params: { header: { image: "https://freshcuts.sa/x.jpg" }, body: ["أحمد", "عرض"], button: ["w1-abc"] }, source: "campaign" })).skipped || "sent",
  ];
  const N = { notifications: { whatsappEnabled: false } };
  for (const [env, settings, want] of [
    [CONFIGURED, N, ["disabled", "disabled", "disabled", "disabled", "disabled"]],                                   // مفتاح الخادم مش مكتوب
    [{ ...CONFIGURED, WHATSAPP_ENABLED: "0" }, N, ["disabled", "disabled", "disabled", "disabled", "disabled"]],      // قفل صلب
    [{ WHATSAPP_ENABLED: "1" }, N, ["unconfigured", "unconfigured", "unconfigured", "unconfigured", "unconfigured"]],
    [ALLOW, { ...N, waMaster: { enabled: false } }, ["master_off", "master_off", "master_off", "master_off", "master_off"]],
    [ALLOW, { ...N, waMaster: undefined }, ["master_off", "master_off", "master_off", "master_off", "master_off"]],
    [ALLOW, N, ["sent", "sent", "sent", "settings_off", "settings_off"]],                                             // SW1: هنا الفرق
    [ALLOW, { notifications: { whatsappEnabled: true } }, ["sent", "sent", "sent", "sent", "sent"]],
  ]) {
    await withEnv(env, async () => { assert.deepEqual(await tryAll(world({ settings, optins })), want, JSON.stringify([env.WHATSAPP_ENABLED, settings])); })();
  }
  // النافذة مقفولة ⇒ الرد الحر مرفوض حتى والأقفال مفتوحة
  await withEnv(ALLOW, async () => {
    const w = world({ settings: N, optins, inbound: [] });
    assert.deepEqual((await tryAll(w)).slice(0, 3), ["window_closed", "window_closed", "window_closed"]); assert.equal(w.calls.length, 0);
  })();
  // الإعدادات مش مقروءة ⇒ مقفول للمسارين
  await withEnv(ALLOW, async () => {
    const w = world({ settings: N, optins });
    const ctx2 = { pool: w.db && { query: async () => ({ rows: [{}], rowCount: 1 }) }, requireAdmin: async () => null, getSettingsData: async () => { throw new Error("db"); }, jb: JSON.stringify, normPhone: String };
    const wa2 = W.register(fakeApp(), ctx2, { fetch: async () => { throw new Error("no network expected"); } });
    assert.equal(await wa2.gate("session"), "settings_unreadable"); assert.equal(await wa2.gate(), "settings_unreadable");
    assert.equal((await wa2.sendFreeform({ phoneNorm: CUST, payload: text(), source: "bot" })).skipped, "settings_unreadable");
  })();
});

test("تحديثات الطلب لكل مرحلة: المرحلة المتعلّم عليها بس هي اللي بتتبعت، بنصها ورقم الطلب", withEnv(ALLOW, async () => {
  const w = world({ settings: { notifications: { whatsappEnabled: true, whatsappStages: ["accepted"], smsEnabled: false, pushEnabled: false }, waBot: { windowFreeUpdates: false } },
    optins: { [CUST]: { updates: true } }, orders: { W1: ORDER } });
  for (const st of ["pos_created", "accepted", "on_the_way", "delivered"]) await w.notify.orderStatusChanged("W1", st);
  await flush();
  assert.equal(w.calls.length, 1);
  assert.deepEqual([w.calls[0].body.template.name, w.db.msgs[0].template, w.db.msgs[0].status], ["fc_order_preparing", "fc_order_preparing", "accepted"]);
  assert.match(w.db.msgs[0].body, /طلبك رقم W1 صار في المطبخ/);
  // المفتاح العام مقفول ⇒ ولا المرحلة المتعلّم عليها
  const off = world({ settings: { notifications: { whatsappEnabled: false, whatsappStages: ["accepted"], pushEnabled: false } }, optins: { [CUST]: { updates: true } }, orders: { W1: ORDER } });
  await off.notify.orderStatusChanged("W1", "accepted"); await flush();
  assert.equal(off.calls.length, 0);
  assert.equal((await off.wa.sendOrderUpdate({ order_no: "W1", phone_norm: CUST, ...ORDER }, "accepted")).skipped, "settings_off");
  // مرحلة مالهاش قالب: نفس الرد القديم
  assert.equal((await w.wa.sendOrderUpdate({ order_no: "W1", phone_norm: CUST, ...ORDER }, "courier_assigned")).skipped, "no_template_for_stage");
}));

test("«يغني عن الـSMS» لكل مرحلة: المرحلة اللي عليها العلامة مابيطلعش لها SMS، والباقي واتساب + SMS زي الأول", withEnv(ALLOW, async () => {
  const mk = (notifications) => world({ settings: { waBot: { windowFreeUpdates: false }, notifications: { whatsappEnabled: true, smsEnabled: true, smsStages: ["accepted", "delivered", "pos_created"], pushEnabled: false, ...notifications } },
    optins: { [CUST]: { updates: true } }, orders: { W1: ORDER } });
  const run = async (w, stages) => { for (const st of stages) await w.notify.orderStatusChanged("W1", st); await flush(); return { wa: w.calls.map((c) => c.body.template.name), sms: w.db.sms.map((m) => String(m.ref).split(":")[1]) }; };
  // لكل مرحلة
  assert.deepEqual(await run(mk({ whatsappStages: ["accepted", "delivered"], whatsappReplacesSmsStages: ["delivered"] }), ["accepted", "delivered"]),
    { wa: ["fc_order_preparing", "fc_order_delivered"], sms: ["accepted"] });
  // مرحلة مش مشغّلة على واتساب: SMS بس، حتى لو اسمها في قايمة «يغني»
  assert.deepEqual(await run(mk({ whatsappStages: ["accepted"], whatsappReplacesSmsStages: ["accepted", "delivered"] }), ["accepted", "delivered"]), { wa: ["fc_order_preparing"], sms: ["delivered"] });
  // المفتاح القديم العام من غير قايمة: زي الأول
  assert.deepEqual(await run(mk({ whatsappStages: ["accepted", "delivered"], whatsappReplacesSms: true }), ["accepted", "delivered"]), { wa: ["fc_order_preparing", "fc_order_delivered"], sms: [] });
  // واتساب اترفض للعميل (مش موافق) ⇒ الـSMS يطلع حتى لو المرحلة «يغني»
  const noOpt = world({ settings: { notifications: { whatsappEnabled: true, smsEnabled: true, smsStages: ["accepted"], pushEnabled: false, whatsappStages: ["accepted"], whatsappReplacesSmsStages: ["accepted"] } }, orders: { W1: ORDER } });
  assert.deepEqual(await run(noOpt, ["accepted"]), { wa: [], sms: ["accepted"] });
}));

// ═════════ المسارات ═════════
test("شاشة «قبل ما تشغّل»: الأقفال الأربعة وحالة مفتاح الخادم، قفل كل مسار، المراحل بحالة ميتا، وإيه اللي هيبدأ", withEnv(CONFIGURED, async () => {
  const w = world({ settings: { waMaster: { enabled: false }, notifications: { whatsappEnabled: true, whatsappStages: ["accepted"], whatsappLoyaltyStatus: true, whatsappAutoReply: false },
    waBot: { mode: "live", testPhones: ["0544775082"], assist: { mode: "test" }, alertPhones: ["0500000001"] }, waCloud: { enabled: true } },
    metaList: META({ pickup_ready: { status: "REJECTED" } }), queued: { rm: 40, rj: 1, pm: 12, pj: 2 } });
  const r = await call(w.app, "GET /api/cms/wa-cloud/checklist", { auth: "Bearer cms:mk" });
  assert.equal(r.status, 200); const b = r.body;
  assert.deepEqual(b.locks.map((l) => [l.id, l.ok]), [["env", false], ["configured", true], ["master", false], ["orderUpdates", true]]);
  assert.deepEqual([b.envState, b.locks[0].state, b.locks[3].appliesTo], ["unset", "unset", "templates"]);
  assert.deepEqual([b.paths.session.blockedBy, b.paths.template.blockedBy, b.paths.session.needs, b.paths.template.needs], ["disabled", "disabled", ["env", "configured", "master"], ["env", "configured", "master", "orderUpdates"]]);
  assert.deepEqual(b.stages.map((s) => s.stage), [...STAGES, "collected"]);      // RT2
  const pick = b.stages.find((s) => s.stage === "pickup_ready");
  assert.deepEqual([pick.enabled, pick.smsOnly, pick.canEnable, pick.metaStatus], [false, true, false, "REJECTED"]);
  const m = b.masterOnWouldStart;
  assert.deepEqual([m.needsServerSwitch, m.session.staffReplies, m.session.bot, m.session.botRepliesToCustomers, m.session.autoReply],
    [true, true, { mode: "live", liveScope: null, assistMode: "test" }, true, false]);
  assert.deepEqual([m.orderUpdates.switchOn, m.orderUpdates.sends, m.orderUpdates.loyaltyStatus, m.orderUpdates.stages], [true, true, true, [{ stage: "accepted", label: "الطلب دخل المطبخ", template: "fc_order_preparing", replacesSms: false }]]);
  assert.deepEqual(m.campaigns, { channelEnabled: true, needsOrderUpdatesSwitch: false, stoppedReason: null, queued: { runningJobs: 1, runningMessages: 40, pausedJobs: 2, pausedMessages: 12 }, sends: true });
  assert.equal(m.testPhones, 1);
  assert.ok(!/05\d{8}|5\d{8}/.test(JSON.stringify(b)), "no phone number in the answer");
  assert.equal(w.calls.length, 0, "reading the checklist sends nothing");
}));

test("شاشة «قبل ما تشغّل»: المفاتيح كلها مفتوحة بس مفتاح تحديثات الطلب مقفول ⇒ الرد الحر مفتوح والقوالب مقفولة", withEnv(ALLOW, async () => {
  const w = world({ settings: { notifications: { whatsappEnabled: false, whatsappStages: ["accepted"] }, waCloud: { enabled: true } }, stopped: "quality_YELLOW" });
  const b = (await call(w.app, "GET /api/cms/wa-cloud/checklist")).body;
  assert.deepEqual([b.paths.session.open, b.paths.session.blockedBy, b.paths.template.open, b.paths.template.blockedBy], [true, null, false, "settings_off"]);
  assert.deepEqual([b.masterOnWouldStart.orderUpdates.sends, b.masterOnWouldStart.orderUpdates.stages, b.masterOnWouldStart.campaigns.sends, b.masterOnWouldStart.campaigns.stoppedReason, b.masterOnWouldStart.campaigns.needsOrderUpdatesSwitch],
    [false, [], false, "quality_YELLOW", true]);
  assert.equal(b.masterOnWouldStart.session.bot.mode, "off");
}));

test("حفظ المراحل: للمالك بس، بقراءة جديدة من ميتا، والمرفوض مايتشغّلش — والشيل شغّال حتى وميتا واقعة", withEnv(ALLOW, async () => {
  const w = world({ settings: { notifications: { whatsappEnabled: true, whatsappReplacesSms: true } }, metaList: META({ pickup_ready: { status: "REJECTED" } }) });
  assert.equal((await call(w.app, "POST /api/cms/wa-cloud/stages", { json: { stages: ["accepted"] }, auth: "Bearer cms:mk" })).status, 403);
  assert.equal(w.db.saved.length, 0);
  const bad = await call(w.app, "POST /api/cms/wa-cloud/stages", { json: { stages: ["accepted", "pickup_ready"] } });
  assert.deepEqual([bad.status, bad.body.error, bad.body.stage, bad.body.template], [409, "template_not_approved", "pickup_ready", "fc_order_ready_pickup"]);
  assert.equal((await call(w.app, "POST /api/cms/wa-cloud/stages", { json: { stages: ["nope"] } })).status, 400);
  assert.equal((await call(w.app, "POST /api/cms/wa-cloud/stages", { json: {} })).body.error, "bad_stages");
  assert.equal(w.db.saved.length, 0);
  const ok = await call(w.app, "POST /api/cms/wa-cloud/stages", { json: { stages: ["accepted", "delivered"], replacesSms: ["delivered"] } });
  assert.deepEqual([ok.status, ok.body.enabled, ok.body.replacesSms, ok.body.by, ok.body.orderUpdatesSwitch], [200, ["accepted", "delivered"], ["delivered"], "عمر", true]);
  assert.deepEqual(w.db.saved, [[["accepted", "delivered"], ["delivered"]]]);
  assert.deepEqual(ok.body.stages.filter((s) => s.enabled).map((s) => [s.stage, s.replacesSms]), [["accepted", false], ["delivered", true]]);
  assert.ok(w.graphReads.length >= 4, "every save reads the template states from Meta again");
  // replacesSms مااتبعتش ⇒ اللي كان متعلّم يفضل للمراحل اللي لسه مشغّلة
  const keep = await call(w.app, "POST /api/cms/wa-cloud/stages", { json: { stages: ["delivered", "on_the_way"] } });
  assert.deepEqual([keep.body.enabled, keep.body.replacesSms], [["delivered", "on_the_way"], ["delivered"]]);
  assert.equal(w.calls.length, 0, "saving stages sends nothing");
  // المفتاح القديم العام بيتحوّل لقايمة بنفس المعنى أول مرة
  const legacy = world({ settings: { notifications: { whatsappEnabled: true, whatsappReplacesSms: true } } });
  assert.deepEqual((await call(legacy.app, "POST /api/cms/wa-cloud/stages", { json: { stages: ["accepted"] } })).body.replacesSms, ["accepted"]);
  // ميتا واقعة: مفيش إضافة، بس القفل والشيل شغّالين
  const down = world({ settings: { notifications: { whatsappEnabled: true, whatsappStages: ["accepted", "delivered"] } }, metaOk: false });
  const add = await call(down.app, "POST /api/cms/wa-cloud/stages", { json: { stages: ["accepted", "delivered", "on_the_way"] } });
  assert.deepEqual([add.status, add.body.error, add.body.stage], [409, "meta_unreadable", "on_the_way"]);
  const rm = await call(down.app, "POST /api/cms/wa-cloud/stages", { json: { stages: [] } });
  assert.deepEqual([rm.status, rm.body.enabled], [200, []]);
}));

/* ١٤/١٠ — سياسة النافذة المقفولة (wapolicy.js): «بنجهّز» مابتطلعش قالب، ومفيش SMS بدلها لو المرحلة «تغني عن الـSMS»؛ الاستلام والتوصيل قالب زي ما هم.
   النافذة مفتوحة ⇒ المسار الحر زي النهارده (ولا شطب). المفتاح مقفول ⇒ كل مرحلة قالب زي الأول. */
test("closed window policy: «preparing» is left out (no template, no SMS in its place), received + delivered still go; open window or switch off ⇒ unchanged", withEnv(ALLOW, async () => {
  const mk = (waBot = {}, inbound = []) => world({ inbound, settings: { waBot: { windowFreeUpdates: false, ...waBot }, notifications: { whatsappEnabled: true, smsEnabled: true, smsStages: ["pos_created", "accepted", "delivered"], pushEnabled: false,
    whatsappStages: ["pos_created", "accepted", "delivered"], whatsappReplacesSmsStages: ["pos_created", "accepted", "delivered"] } }, optins: { [CUST]: { updates: true } }, orders: { W1: ORDER } });
  const run = async (w) => { for (const st of ["pos_created", "accepted", "delivered"]) await w.notify.orderStatusChanged("W1", st); await flush(); return { wa: w.calls.map((c) => c.body.template.name), sms: w.db.sms.map((m) => String(m.ref).split(":")[1]) }; };
  const closed = mk();
  assert.deepEqual(await run(closed), { wa: ["fc_order_received", "fc_order_delivered"], sms: [] }, "preparing skipped on WhatsApp AND no SMS instead");
  assert.ok(closed.db.sql.some((s) => /^INSERT INTO wa_policy_skips/.test(s)), "the skip is recorded for the daily report");
  assert.deepEqual((await closed.wa.sendOrderUpdate({ order_no: "W1", phone_norm: CUST, ...ORDER }, "accepted")), { ok: false, skipped: "policy_skip_preparing", policy: true });
  assert.deepEqual(await run(mk({}, [CUST])), { wa: ["fc_order_received", "fc_order_preparing", "fc_order_delivered"], sms: [] }, "window open ⇒ nothing is left out (free path off here ⇒ templates as before)");
  assert.deepEqual(await run(mk({ closedPolicy: false })), { wa: ["fc_order_received", "fc_order_preparing", "fc_order_delivered"], sms: [] }, "policy switched off ⇒ every stage as before");
  assert.deepEqual(await run(mk({ closedSkipPreparing: false })), { wa: ["fc_order_received", "fc_order_preparing", "fc_order_delivered"], sms: [] }, "only that rule switched off ⇒ preparing goes");
}));
