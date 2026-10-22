/* ═══════════════════════════════════════════════════════════════════════════
   📍 RT2 (١٧/١٠) — واتساب «جاهز للاستلام» لطلبات الاستلام (عمر: «موصلتش رسايل واتس اب ان الطلب جاهز»)
     ١) الترحيل: pickup_ready تتضاف للقوايم الحيّة (whatsappStages / whatsappReplacesSmsStages / waBot.windowV2Stages) مرة واحدة — idempotent، وصف cms_audit واحد
     ٢) notify.orderReady لطلب استلام: النافذة مفتوحة ⇒ رسالة حرة بصياغة المالك + حدث؛ مقفولة والقالب مرفوض ⇒ template_not_approved + SMS البديل (لو المرحلة في smsStages) + حدث؛
        no_template_for_stage بيتسجّل مش بيتبلع؛ التوصيل والطاولة زي ما هم
     ٣) لحظة «اتسلّم» (collected): دعوة التقييم جاية قريب ⇒ covered_by_review؛ غير كده والمرحلة مفتوحة ⇒ رسالة حرة جوّه النافذة بس
     ٤) الكتالوج: fc_order_pickup_ready بصياغة المالك (ar + en) ولسه HOLD؛ المخطط والافتراضيات
     ٥) RT2 مراجعة (١٧/١٠): shop.js — «جاهز» من غير محطات ويبهوك (الكنس الاحتياطي) بيبلّغ العميل برضه؛ PENDING/PAUSED عند ميتا بيكمّلوا للقالب (الأكيد بس بيتقفل)؛
        نص «اتسلّم» من اللوحة + اختبار انجراف السجل الواحد؛ مفتاح collectedSkipIfReviewWithinMin في المخطط؛ الـPush مابيستناش واتساب؛ pickup_ready مش في افتراضي SMS
   node --test rt2-pickup-ready-wa.test.mjs — قاعدة وهمية وfetch وهمي؛ مفيش شبكة حقيقية ولا أي إرسال. أرقام وهمية بس (9665xxxxxxx).
═══════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";

const W = await import("./whatsapp.js");
const C = await import("./wacloud.js");
const CAT = await import("./watemplates.js");
const SW = await import("./waswitches.js");
const BOT = await import("./wabotrun.js");
const SMS = await import("./smstemplates.js");
const { register: registerNotify, smsStagesOf, statusSmsText } = await import("./notify.js");
const { bus, CHANNEL } = await import("./order-events.js");
W.registerCatalog(CAT);

const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN", "WHATSAPP_TEMPLATES_WRITE"];
function withEnv(vals, fn) {
  return async () => { const saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } Object.assign(process.env, vals);
    try { await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
}
const ALLOW = { WHATSAPP_ENABLED: "1", WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1", WHATSAPP_WABA_ID: "WABA1" };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const fakeApp = () => ({ get() {}, post() {}, put() {}, delete() {} });
const fakePush = () => ({ generateVAPIDKeys: () => ({ publicKey: "p", privateKey: "q" }), setVapidDetails() {}, async sendNotification() {} });
function capture() {
  const events = [];
  const fn = (e) => { if (e.name === "notify_sent") events.push(e); };
  bus.on(CHANNEL, fn);
  return { events, stop: () => bus.off(CHANNEL, fn), of: (stage, channel) => events.filter((e) => e.data.stage === stage && (!channel || e.channel === channel)) };
}

/* الإعدادات الحيّة زي ما ev4.json رصدها ١٧/١٠ (قبل الترحيل): pickup_ready مش في ولا قايمة */
const LIVE_N = Object.freeze({
  smsStages: ["on_the_way", "rejected_refunded", "refund_failed"], smsEnabled: true, whatsappEnabled: true,
  whatsappStages: ["pos_created", "accepted", "on_the_way", "delivered", "rejected_refunded", "refund_failed"],
  whatsappReplacesSmsStages: ["pos_created", "accepted", "on_the_way", "delivered", "rejected_refunded", "refund_failed"],
});
const LIVE_V2 = Object.freeze(["pos_created", "accepted", "on_the_way", "delivered", "rejected_refunded", "refund_failed", "review"]);
/* بعد الترحيل */
const N_ON = Object.freeze({ ...LIVE_N, pushEnabled: false, whatsappStages: [...LIVE_N.whatsappStages, "pickup_ready"], whatsappReplacesSmsStages: [...LIVE_N.whatsappReplacesSmsStages, "pickup_ready"] });
const V2_ON = Object.freeze([...LIVE_V2, "pickup_ready"]);

const CUST = "512345678";      // رقم وهمي
const NO = "W1790012345678";
const AGO = (min) => new Date(Date.now() - min * 60_000).toISOString();
const PICKUP = Object.freeze({ order_no: NO, phone_norm: CUST, option: "pickup", total: 96, table_no: null, created_at: AGO(45), is_test: false });
const DELIVERY = Object.freeze({ ...PICKUP, order_no: "W1790022222222", option: "delivery" });
const TABLE = Object.freeze({ ...PICKUP, order_no: "W1790033333333", table_no: 4 });

// ═════════ ١) الترحيل ═════════
test("الترحيل (دالة صافية): pickup_ready تتضاف للتلات قوايم الحيّة، waStageOn بتشوفها، smsStages مابتتلمسش، وidempotent", () => {
  const m = SW.pickupReadyMigration({ notifications: LIVE_N, waBot: { windowV2Stages: [...LIVE_V2] } });
  assert.deepEqual(m.changed, ["notifications.whatsappStages", "notifications.whatsappReplacesSmsStages", "waBot.windowV2Stages"]);
  assert.deepEqual(m.notifications.whatsappStages, [...LIVE_N.whatsappStages, "pickup_ready"]);
  assert.deepEqual(m.notifications.whatsappReplacesSmsStages, [...LIVE_N.whatsappReplacesSmsStages, "pickup_ready"]);
  assert.ok(!("smsStages" in m.notifications), "SMS بفلوس — قرار المالك من شاشة SMS");
  assert.deepEqual(m.waBot.windowV2Stages, [...LIVE_V2, "pickup_ready"]);
  const next = { notifications: { ...LIVE_N, ...m.notifications }, waBot: { windowV2Stages: m.waBot.windowV2Stages } };
  assert.equal(SW.waStageOn(LIVE_N, "pickup_ready"), false, "قبل الترحيل: المرحلة مقفولة (سبب سكوت ٧ أيام)");
  assert.equal(SW.waStageOn(next.notifications, "pickup_ready"), true);
  assert.equal(SW.waReplacesSms(next.notifications, "pickup_ready"), true);
  assert.deepEqual(SW.pickupReadyMigration(next), { changed: [], notifications: {}, waBot: {} }, "تاني مرة: ولا حاجة");
  // المفتاح القديم العام (مفيش قايمة «يغني عن الـSMS») بيفضل زي ما هو؛ إعدادات فاضية بتتبني من الصفر
  assert.deepEqual(SW.pickupReadyMigration({ notifications: { whatsappReplacesSms: true } }).changed, ["notifications.whatsappStages", "waBot.windowV2Stages"]);
  assert.deepEqual(SW.pickupReadyMigration({}).notifications.whatsappStages, ["pickup_ready"]);
  assert.deepEqual(SW.pickupReadyMigration({}).waBot.windowV2Stages, ["pickup_ready"]);
  assert.equal(SW.PICKUP_READY_MIGRATION_ID, "rt2_pickup_ready_stage_v1");
});

test("الترحيل عند الإقلاع: cms_migrations بتقفله — كتابة واحدة للإعدادات وصف cms_audit واحد، والإقلاع التاني مابيكتبش؛ ولو القوايم فيها المرحلة أصلاً مفيش كتابة", async () => {
  const mkDb = (settings) => ({ migrations: new Set(), writes: [], audits: [], settings: { webPushKeys: { publicKey: "p", privateKey: "q" }, ...settings } });
  const poolOf = (db) => ({ async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ");
    if (/INSERT INTO cms_migrations/.test(s)) { if (db.migrations.has(p[0])) return { rows: [], rowCount: 0 }; db.migrations.add(p[0]); return { rows: [{ id: p[0] }], rowCount: 1 }; }
    if (/^UPDATE settings SET data = jsonb_set\(jsonb_set/.test(s)) {
      const [n, b] = p.map((x) => JSON.parse(x)); db.writes.push({ n, b });
      db.settings.notifications = { ...(db.settings.notifications || {}), ...n }; db.settings.waBot = { ...(db.settings.waBot || {}), ...b };
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO cms_audit/.test(s)) { db.audits.push(p); return { rows: [], rowCount: 1 }; }
    if (/FROM shop_orders|FROM push_subs/.test(s)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  } });
  const boot = (db) => registerNotify(fakeApp(), { pool: poolOf(db), requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)),
    jb: JSON.stringify, normPhone: String, webpush: fakePush(), sendSms: async () => ({ ok: true }) }, {});
  const db = mkDb({ notifications: LIVE_N, waBot: { windowV2Stages: [...LIVE_V2], mode: "live" } });
  boot(db); await flush();
  assert.equal(db.writes.length, 1);
  assert.deepEqual(db.writes[0].n, { whatsappStages: [...LIVE_N.whatsappStages, "pickup_ready"], whatsappReplacesSmsStages: [...LIVE_N.whatsappReplacesSmsStages, "pickup_ready"] });
  assert.deepEqual(db.writes[0].b, { windowV2Stages: [...LIVE_V2, "pickup_ready"] });
  assert.equal(db.settings.waBot.mode, "live", "الدمج || مابيمسحش باقي مفاتيح waBot");
  assert.equal(db.audits.length, 1);
  assert.deepEqual([db.audits[0][0], db.audits[0][1]], ["النظام — ترحيل RT2", "settings.notifications.whatsappStages"]);
  assert.match(db.audits[0][2], /RT2/); assert.match(db.audits[0][2], /جاهز للاستلام/); assert.match(db.audits[0][2], /١٧\/١٠/);
  assert.doesNotMatch(JSON.stringify(db.audits), /5\d{8}/, "مفيش جوال في السجل");
  // الإقلاع التاني (نفس القاعدة)
  const api2 = boot(db); await flush();
  assert.equal(db.writes.length, 1); assert.equal(db.audits.length, 1);
  assert.deepEqual(await api2.migratePickupReady(), { skipped: "already" });
  // قاعدة تانية والقوايم فيها المرحلة أصلاً ⇒ القفل بيتاخد بس مفيش كتابة ولا تدقيق
  const done = mkDb({ notifications: N_ON, waBot: { windowV2Stages: [...V2_ON] } });
  boot(done); await flush();
  assert.deepEqual([done.writes.length, done.audits.length, done.migrations.has("rt2_pickup_ready_stage_v1")], [0, 0, true]);
});

test("wabotrun: pickup_ready في WINDOW_V2_STAGES وفي خيارات المخطط وفي الافتراضي، والمحلّل بيحتفظ بيها", () => {
  assert.ok(BOT.WINDOW_V2_STAGES.includes("pickup_ready"));
  assert.deepEqual(BOT.DEFAULTS.windowV2Stages, ["pickup_ready"]);
  assert.ok(BOT.SCHEMA.windowV2Stages.options.includes("pickup_ready"));
  assert.match(BOT.SCHEMA.windowV2Stages.help, /pickup_ready/); assert.match(BOT.SCHEMA.windowV2Stages.ar, /٢٤ ساعة/);
  assert.deepEqual(BOT.botConfig({}).windowV2Stages, ["pickup_ready"], "مفيش مفتاح ⇒ الافتراضي");
  assert.deepEqual(BOT.botConfig({ waBot: { windowV2Stages: [...V2_ON] } }).windowV2Stages, [...V2_ON]);
  assert.deepEqual(BOT.botConfig({ waBot: { windowV2Stages: [] } }).windowV2Stages, [], "المالك شالها كلها ⇒ فاضية (مش الافتراضي)");
  const row = BOT.schemaFor(BOT.botConfig({})).find((x) => x.key === "windowV2Stages");
  assert.deepEqual([row.group, row.default], ["mode", ["pickup_ready"]]);
});

// ═════════ ٢) notify.orderReady — بوحدة واتساب وهمية ═════════
function notifyWith({ waResult, notifications, order, settings = {} } = {}) {
  const calls = [], sms = [];
  const pool = { async query(sql) {
    const s = String(sql);
    if (/FROM shop_orders/.test(s)) return { rows: order ? [order] : [] };
    return { rows: [], rowCount: 0 };
  } };
  const api = registerNotify(fakeApp(), { pool, requireAdmin: async () => null, jb: JSON.stringify, normPhone: String, webpush: fakePush(),
    getSettingsData: async () => ({ webPushKeys: { publicKey: "p", privateKey: "q" }, notifications, ...settings }),
    sendSms: async (x) => { sms.push(x); } },
  { wa: { sendOrderUpdate: async (o, st, opts) => { calls.push({ no: o.order_no, st, opts }); return typeof waResult === "function" ? waResult(st) : waResult; } } });
  return { api, calls, sms };
}

test("orderReady (استلام) والنافذة مفتوحة: رسالة حرة ⇒ حدث whatsapp ok + free، ومفيش SMS (المرحلة «تغني عن الـSMS»)", async () => {
  const { api, calls, sms } = notifyWith({ waResult: { ok: true, wamid: "wamid.F1", free: true }, notifications: N_ON, order: PICKUP });
  const cap = capture();
  try {
    await api.orderReady(NO); await flush();
    assert.deepEqual(calls, [{ no: NO, st: "pickup_ready", opts: { fallbackSms: `فريش كاتس: طلبك ${NO} جاهز للاستلام من الفرع` } }], "MJ2b: النص البديل دايماً مع الطلب (لو الواتساب فشل بعدين من الويب هوك)");
    const wa = cap.of("pickup_ready", "whatsapp");
    assert.equal(wa.length, 1); assert.deepEqual([wa[0].ok, wa[0].data.free, wa[0].orderNo], [true, true, NO]);
    assert.equal(sms.length, 0);
    assert.equal(cap.of("pickup_ready", "sms").length, 0, "واتساب وصل ⇒ مفيش صف SMS");
    assert.doesNotMatch(JSON.stringify(cap.events), /5\d{8}/);
  } finally { cap.stop(); }
});

test("orderReady والنافذة مقفولة والقالب مرفوض: template_not_approved بيتسجّل باسم القالب وحالته، وSMS البديل بيطلع بس لو المرحلة في smsStages", async () => {
  const notApproved = { ok: false, skipped: "template_not_approved", template: "fc_order_ready_pickup", status: "REJECTED" };
  // (أ) المالك علّم «جاهز للاستلام» في رسايل SMS ⇒ SMS بالنص البديل (fallbackSms بتاع الكتالوج) + حدثين
  {
    const { api, calls, sms } = notifyWith({ waResult: notApproved, notifications: { ...N_ON, smsStages: [...LIVE_N.smsStages, "pickup_ready"] }, order: PICKUP });
    const cap = capture();
    try {
      await api.orderReady(NO); await flush();
      assert.equal(calls[0].opts.fallbackSms, `فريش كاتس: طلبك ${NO} جاهز للاستلام من الفرع`);
      assert.equal(sms.length, 1);
      assert.deepEqual([sms[0].phoneNorm, sms[0].body, sms[0].kind, sms[0].ref], [CUST, `فريش كاتس: طلبك ${NO} جاهز للاستلام من الفرع`, "order_status", `${NO}:pickup_ready`]);
      const wa = cap.of("pickup_ready", "whatsapp")[0];
      assert.deepEqual([wa.ok, wa.data.error, wa.data.template, wa.data.status], [false, "template_not_approved", "fc_order_ready_pickup", "REJECTED"]);
      assert.deepEqual(cap.of("pickup_ready", "sms").map((e) => e.ok), [true]);
    } finally { cap.stop(); }
  }
  // (ب) MJ2b (عمر ٢٣/١٠ «تتبعت لما الواتساب يفشل بس»): من غير pickup_ready في القايمة ⇒ SMS البديل برضه لأن واتساب فشل
  {
    const { api, sms } = notifyWith({ waResult: notApproved, notifications: N_ON, order: PICKUP });
    const cap = capture();
    try {
      await api.orderReady(NO); await flush();
      assert.equal(sms.length, 1);
      assert.deepEqual(cap.of("pickup_ready", "sms").map((e) => e.ok), [true]);
    } finally { cap.stop(); }
  }
  // (ج) RT2 مراجعة: pickup_ready **مش** في الافتراضي ولا في القايمة الفاضية — SMS بفلوس = تعليم صريح من شاشة SMS (لو كانت في الافتراضي ومسح المالك القايمة كانت هتبدأ لوحدها)
  assert.ok(!smsStagesOf({}).includes("pickup_ready"));
  assert.ok(!smsStagesOf({ smsStages: [] }).includes("pickup_ready"));
  assert.ok(!smsStagesOf(LIVE_N).includes("pickup_ready"), "القايمة الحيّة زي ما هي");
  assert.ok(smsStagesOf({ smsStages: [...LIVE_N.smsStages, "pickup_ready"] }).includes("pickup_ready"), "المالك علّمها ⇒ موجودة");
});

test("orderReady: no_template_for_stage / stage_off / whatsapp_off بتتسجّل بدل ما تتبلع", async () => {
  const cases = [
    [{ ok: false, skipped: "no_template_for_stage" }, N_ON, "no_template_for_stage", 1, 1],
    [{ ok: true }, LIVE_N, "stage_off", 0, LIVE_N.smsEnabled === true ? 1 : 0],   // MJ2b: واتساب ماتبعتش ⇒ SMS البديل لو SMS شغّال
    [{ ok: true }, { ...N_ON, whatsappEnabled: false }, "whatsapp_off", 0, N_ON.smsEnabled === true ? 1 : 0],
    [{ ok: false, policy: true, skipped: "order_cap" }, N_ON, "order_cap", 1, 0],   // السياسة شالته عمداً ⇒ مفيش SMS
  ];
  for (const [waResult, notifications, error, nCalls, nSms] of cases) {
    const { api, calls, sms } = notifyWith({ waResult, notifications: { ...notifications, pushEnabled: false }, order: PICKUP });
    const cap = capture();
    try {
      await api.orderReady(NO); await flush();
      assert.equal(calls.length, nCalls, error);
      assert.deepEqual(cap.of("pickup_ready", "whatsapp").map((e) => [e.ok, e.data.error]), [[false, error]], error);
      assert.equal(sms.length, nSms, error);
    } finally { cap.stop(); }
  }
});

test("orderReady: طلب التوصيل مالوش «جاهز» (0 ومفيش واتساب)، وطلب الطاولة Push بس زي الأول", async () => {
  for (const [order, expectWa] of [[DELIVERY, 0], [TABLE, 0]]) {
    const { api, calls } = notifyWith({ waResult: { ok: true }, notifications: N_ON, order });
    const cap = capture();
    try {
      await api.orderReady(order.order_no); await flush();
      assert.equal(calls.length, expectWa, order.option);
      assert.equal(cap.of("pickup_ready").length, 0, order.option);
    } finally { cap.stop(); }
  }
});

// ═════════ ٣) لحظة «اتسلّم» (collected) ═════════
test("collected: دعوة التقييم جاية خلال collectedSkipIfReviewWithinMin (٦٠ افتراضياً) ⇒ covered_by_review (مش stage_not_applicable) ومفيش إرسال — وده اللي بيحصل بالافتراضيات (التقييم بعد ٤٥)؛ المالك ينزّل المفتاح ⇒ رسالة حرة", async () => {
  const N_COL = { ...N_ON, whatsappStages: [...N_ON.whatsappStages, "collected"] };
  // المسار القديم للتقييم (reviewFlow مقفول) عشان الحساب ثابت ومش بيتأثر بساعات الهدوء وقت تشغيل الاختبار
  const flowOff = (askAfterMinutes, extra = {}) => ({ reviews: { askAfterMinutes }, waBot: { reviewFlow: { enabled: false }, ...extra } });
  // (أ) التقييم بعد ٢٠ د (≤ ٦٠) ⇒ covered — والفاصل المسجّل هو المفتاح الجديد مش reviewPaidGapMin
  {
    const { api, calls } = notifyWith({ waResult: { ok: true, free: true }, notifications: N_COL, order: PICKUP, settings: flowOff(20) });
    const cap = capture();
    try {
      await api.orderStatusChanged(NO, "delivered"); await flush();
      assert.equal(calls.filter((c) => c.st === "collected").length, 0);
      assert.equal(calls.filter((c) => c.st === "delivered").length, 0, "قالب التوصيل مش بتاع الاستلام — مابنجرّبوش");
      const ev = cap.of("collected", "whatsapp");
      assert.equal(ev.length, 1); assert.deepEqual([ev[0].ok, ev[0].data.error, ev[0].data.reviewInMin, ev[0].data.gapMin], [false, "covered_by_review", 20, 60]);
      assert.equal(cap.events.some((e) => e.data.error === "stage_not_applicable"), false);
    } finally { cap.stop(); }
  }
  // (ب) RT2 مراجعة — **التوقيت الافتراضي بصراحة**: التقييم بعد ٤٥ د (pickupMin) والمفتاح ٦٠ ⇒ covered حتى لو المالك شغّل المرحلة: رسالة واحدة بس (التقييم)
  {
    const { api, calls } = notifyWith({ waResult: { ok: true, free: true }, notifications: N_COL, order: PICKUP, settings: flowOff(45) });
    const cap = capture();
    try {
      await api.orderStatusChanged(NO, "delivered"); await flush();
      assert.equal(calls.length, 0, "بالافتراضيات مفيش رسالة شكر — التقييم جاي خلال ٤٥");
      assert.deepEqual([cap.of("collected")[0].data.error, cap.of("collected")[0].data.reviewInMin, cap.of("collected")[0].data.gapMin], ["covered_by_review", 45, 60]);
    } finally { cap.stop(); }
  }
  // (ج) المالك نزّل المفتاح لـ٣٠ («عايز الشكر والتقييم الاتنين») ⇒ نفس الـ٤٥ بقت بعيدة ⇒ رسالة حرة + حدث ok؛ وصفر = الشكر دايماً
  for (const gap of [30, 0]) {
    const { api, calls } = notifyWith({ waResult: { ok: true, free: true }, notifications: N_COL, order: PICKUP, settings: flowOff(45, { collectedSkipIfReviewWithinMin: gap }) });
    const cap = capture();
    try {
      await api.orderStatusChanged(NO, "delivered"); await flush();
      assert.deepEqual(calls.map((c) => c.st), ["collected"], `gap ${gap}`);
      const ev = cap.of("collected", "whatsapp");
      assert.deepEqual([ev[0].ok, ev[0].data.free, ev[0].data.reviewInMin], [true, true, 45]);
    } finally { cap.stop(); }
  }
  // (ج٢) reviewPaidGapMin لوحده مابقاش بيأثّر على القرار ده
  {
    const { api, calls } = notifyWith({ waResult: { ok: true, free: true }, notifications: N_COL, order: PICKUP, settings: flowOff(45, { reviewPaidGapMin: 0, collectedSkipIfReviewWithinMin: 60 }) });
    const cap = capture();
    try { await api.orderStatusChanged(NO, "delivered"); await flush(); assert.equal(calls.length, 0); assert.equal(cap.of("collected")[0].data.error, "covered_by_review"); } finally { cap.stop(); }
  }
  // (د) المرحلة مقفولة (الوضع الحي بعد الترحيل — collected مش مشغّلة) والتقييم بعيد (المفتاح ٣٠) ⇒ stage_off بميعاد التقييم، مفيش إرسال
  {
    const { api, calls } = notifyWith({ waResult: { ok: true, free: true }, notifications: N_ON, order: PICKUP, settings: flowOff(45, { collectedSkipIfReviewWithinMin: 30 }) });
    const cap = capture();
    try { await api.orderStatusChanged(NO, "delivered"); await flush(); assert.equal(calls.length, 0); assert.deepEqual([cap.of("collected")[0].data.error, cap.of("collected")[0].data.reviewInMin], ["stage_off", 45]); } finally { cap.stop(); }
  }
  // (هـ) طلب التقييم مقفول من اللوحة ⇒ مش covered ⇒ المرحلة بتتبعت
  {
    const { api, calls } = notifyWith({ waResult: { ok: true, free: true }, notifications: N_COL, order: PICKUP, settings: { reviews: { askAfterDelivery: false } } });
    const cap = capture();
    try { await api.orderStatusChanged(NO, "delivered"); await flush(); assert.deepEqual(calls.map((c) => c.st), ["collected"]); } finally { cap.stop(); }
  }
  // (و) المسار الجديد للتقييم شغّال بس نوع «استلام» مقفول فيه ⇒ kind_off ⇒ مش covered
  {
    const { api, calls } = notifyWith({ waResult: { ok: true, free: true }, notifications: N_COL, order: PICKUP, settings: { waBot: { reviewFlow: { enabled: true, pickup: false } } } });
    const cap = capture();
    try { await api.orderStatusChanged(NO, "delivered"); await flush(); assert.deepEqual(calls.map((c) => c.st), ["collected"]); } finally { cap.stop(); }
  }
  // (ز) النافذة مقفولة ⇒ whatsapp.js بيرجّع window_closed ⇒ بيتسجّل زي ما هو، ومفيش SMS (مرحلة حرة بس)
  {
    const { api, sms } = notifyWith({ waResult: { ok: false, skipped: "window_closed" }, notifications: { ...N_COL, smsStages: [...LIVE_N.smsStages, "delivered"] }, order: PICKUP, settings: flowOff(45, { collectedSkipIfReviewWithinMin: 30 }) });
    const cap = capture();
    try {
      await api.orderStatusChanged(NO, "delivered"); await flush();
      assert.equal(cap.of("collected")[0].data.error, "window_closed");
      assert.equal(sms.length, 1, "SMS «اتسلّم» القديمة (مرحلة delivered في smsStages) زي ما هي — مش بتاعة collected");
      assert.match(sms[0].body, /بالهنا والشفا/);
    } finally { cap.stop(); }
  }
});

test("collected: التوصيل والطاولة زي ما هم — delivered بيروح لقالب التوصيل، ومفيش حدث collected", async () => {
  for (const order of [DELIVERY, TABLE]) {
    const { api, calls } = notifyWith({ waResult: { ok: true }, notifications: { ...N_ON, whatsappStages: [...N_ON.whatsappStages, "collected"] }, order, settings: { reviews: { askAfterMinutes: 45 }, waBot: { reviewFlow: { enabled: false } } } });
    const cap = capture();
    try {
      await api.orderStatusChanged(order.order_no, "delivered"); await flush();
      assert.deepEqual(calls.map((c) => c.st), ["delivered"], order.option);
      assert.equal(cap.of("collected").length, 0, order.option);
    } finally { cap.stop(); }
  }
});

// ═════════ ٤) whatsapp.js الحقيقي: الرسالة الحرة بصياغة المالك، والقالب بس لو معتمد ═════════
function world({ settings = {}, optins = {}, inbound = [], orders = {}, metaList = null, metaOk = true } = {}) {
  const db = { settings: { waMaster: { enabled: true }, ...settings }, msgs: [], sms: [] };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: inbound.includes(p[0]) ? [{}] : [] };
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: optins[p[0]] ? [optins[p[0]]] : [] };
    if (/FROM shop_orders/i.test(s)) return { rows: orders[p[0]] ? [{ ...orders[p[0]], order_no: p[0] }] : [] };
    if (/^INSERT INTO wa_messages/i.test(s)) { db.msgs.push({ wamid: p[0], phone_norm: p[1], template: p[2], status: p[6], body: p[8], source: p[10] }); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const calls = [], reads = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (/message_templates/.test(u)) { reads.push(u); return metaOk && metaList ? { ok: true, status: 200, json: async () => ({ data: metaList }) } : { ok: false, status: 500, json: async () => ({ error: { message: "meta down", code: 2 } }) }; }
    if ((init.method || "GET") === "GET") return { ok: true, status: 200, json: async () => ({}) };
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.S${calls.length}` }] }) };
  };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: JSON.stringify,
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(fakeApp(), ctx, { fetch, sendSms: async () => ({ ok: true }) });
  C.register(fakeApp(), ctx, { wa, fetch, sessionUser: async () => ({ name: "عمر", role: "owner" }) });
  const notify = registerNotify(fakeApp(), { ...ctx, webpush: fakePush(), sendSms: async (m) => { db.sms.push(m); return { ok: true }; } }, { wa, sendSms: async (m) => { db.sms.push(m); return { ok: true }; } });
  return { db, wa, notify, calls, reads };
}
const ROW = Object.freeze({ name: "أحمد", option: "pickup", total: 96, refund_id: null, table_no: null, phone_norm: CUST, created_at: AGO(45), is_test: false });
const ORDERS = Object.freeze({ [NO]: ROW, W1790022222222: { ...ROW, option: "delivery" } });
const OPT = { [CUST]: { updates: true, marketing: false } };
const META = (over = []) => [...Object.entries(W.STAGE_TEMPLATES).map(([, n]) => ({ name: n, language: "ar", category: "UTILITY", status: n === "fc_order_ready_pickup" ? "REJECTED" : "APPROVED" })), ...over];
const OWNER_TEXT = `طلبك رقم ${NO} جاهز للاستلام من فريش كاتس 📍 تفضّل إلى الفرع واذكر رقم طلبك.`;

test("النافذة مفتوحة: «جاهز للاستلام» رسالة حرة ببلاش بصياغة المالك + زر «تفاصيل الطلب» لرابط التتبع — مفيش قالب ولا SMS", withEnv(ALLOW, async () => {
  const w = world({ settings: { notifications: N_ON, waBot: { windowV2Stages: [...V2_ON], windowFreeUpdates: true } }, optins: OPT, inbound: [CUST], orders: ORDERS, metaList: META() });
  const cap = capture();
  try {
    await w.notify.orderReady(NO); await flush();
    assert.equal(w.calls.length, 1);
    const pl = w.calls[0].body;
    assert.deepEqual([pl.type, pl.interactive.type, pl.to], ["interactive", "cta_url", `966${CUST}`]);
    assert.equal(pl.interactive.body.text, OWNER_TEXT);
    assert.deepEqual(pl.interactive.action.parameters, { display_text: "تفاصيل الطلب", url: `https://freshcuts.sa/track/${NO}` });
    assert.deepEqual(w.db.msgs.map((m) => [m.template, m.source, m.status]), [[null, "window", "accepted"]]);
    assert.deepEqual(cap.of("pickup_ready", "whatsapp").map((e) => [e.ok, e.data.free]), [[true, true]]);
    assert.equal(w.db.sms.length, 0);
    // من غير pickup_ready في windowV2Stages: نفس المسار الحر بس بنص القالب القديم (مش كسر لحد)
    const old = world({ settings: { notifications: N_ON, waBot: { windowV2Stages: [...LIVE_V2] } }, optins: OPT, inbound: [CUST], orders: ORDERS, metaList: META() });
    await old.notify.orderReady(NO); await flush();
    assert.equal(old.calls.length, 1); assert.match(old.calls[0].body.interactive.body.text, /جاهز للاستلام ✅/);
  } finally { cap.stop(); }
}));

test("النافذة مقفولة وميتا بتقول مش معتمد: مفيش طلب لميتا ولا صف فاشل، السبب template_not_approved بيتسجّل، وSMS البديل لو المرحلة في smsStages", withEnv(ALLOW, async () => {
  for (const [v2, expectTpl, expectStatus] of [[V2_ON, "fc_order_pickup_ready", "NOT_SUBMITTED"], [LIVE_V2, "fc_order_ready_pickup", "REJECTED"]]) {
    const w = world({ settings: { notifications: { ...N_ON, smsStages: [...LIVE_N.smsStages, "pickup_ready"] }, waBot: { windowV2Stages: [...v2] } }, optins: OPT, inbound: [], orders: ORDERS, metaList: META() });
    const cap = capture();
    try {
      await w.notify.orderReady(NO); await flush();
      assert.equal(w.calls.length, 0, `${expectTpl}: nothing reached Meta`);
      assert.ok(w.reads.length >= 1, "read the template list once");
      assert.equal(w.db.msgs.length, 0, "no failed row");
      const ev = cap.of("pickup_ready", "whatsapp")[0];
      assert.deepEqual([ev.ok, ev.data.error, ev.data.template, ev.data.status], [false, "template_not_approved", expectTpl, expectStatus]);
      assert.deepEqual(w.db.sms.map((m) => m.body), [`فريش كاتس: طلبك ${NO} جاهز للاستلام من الفرع`]);
      assert.deepEqual(cap.of("pickup_ready", "sms").map((e) => e.ok), [true]);
    } finally { cap.stop(); }
  }
}));

test("ميتا اعتمدت fc_order_pickup_ready (بعد ما المالك يقدّمه): بره النافذة القالب الجديد بيطلع برقم الطلب، ومفيش SMS", withEnv(ALLOW, async () => {
  const w = world({ settings: { notifications: { ...N_ON, smsStages: [...LIVE_N.smsStages, "pickup_ready"] }, waBot: { windowV2Stages: [...V2_ON] } }, optins: OPT, inbound: [], orders: ORDERS,
    metaList: META([{ name: "fc_order_pickup_ready", language: "ar", category: "UTILITY", status: "APPROVED" }]) });
  const cap = capture();
  try {
    await w.notify.orderReady(NO); await flush();
    assert.equal(w.calls.length, 1);
    const t = w.calls[0].body.template;
    assert.deepEqual([t.name, t.language.code], ["fc_order_pickup_ready", "ar"]);
    assert.deepEqual(t.components.find((c) => c.type === "body").parameters.map((p) => p.text), [NO]);
    /* MJ2 (٢٢/١٠): النسخة المعتمدة عند ميتا BODY بس — مفيش مكوّن زر في الحمولة (الزر كان سبب WA_132018)، والنص المحفوظ = النص المعتمد */
    assert.equal(t.components.find((c) => c.type === "button"), undefined);
    assert.deepEqual(w.db.msgs.map((m) => [m.template, m.body]), [["fc_order_pickup_ready", `تحديث طلبك رقم ${NO}: طلبك جاهز للاستلام من الفرع. يرجى ذكر رقم الطلب عند الاستلام.`]]);
    assert.deepEqual(cap.of("pickup_ready", "whatsapp").map((e) => e.ok), [true]);
    assert.equal(w.db.sms.length, 0, "واتساب وصل والمرحلة تغني عن الـSMS");
  } finally { cap.stop(); }
}));

test("ميتا مش مقروءة: زي الأول — بنحاول القالب وميتا بتقرر (مفيش قفل أعمى)", withEnv(ALLOW, async () => {
  const w = world({ settings: { notifications: N_ON, waBot: { windowV2Stages: [...LIVE_V2] } }, optins: OPT, inbound: [], orders: ORDERS, metaOk: false });
  await w.notify.orderReady(NO); await flush();
  assert.equal(w.calls.length, 1); assert.equal(w.calls[0].body.template.name, "fc_order_ready_pickup");
}));

test("whatsapp.sendOrderUpdate: collected رسالة حرة بس (نافذة مفتوحة)، window_closed لما تقفل، stage_not_applicable للتوصيل، وstage_off لما المالك مايشغّلهاش", withEnv(ALLOW, async () => {
  const N_COL = { ...N_ON, whatsappStages: [...N_ON.whatsappStages, "collected"] };
  const open = world({ settings: { notifications: N_COL, waBot: {} }, optins: OPT, inbound: [CUST], orders: ORDERS, metaList: META() });
  const r = await open.wa.sendOrderUpdate({ order_no: NO, phone_norm: CUST, option: "pickup" }, "collected");
  assert.deepEqual([r.ok, r.free], [true, true]);
  assert.deepEqual(open.calls[0].body.text, { body: "بالهنا والشفا 🌟 تقييمك يهمنا", preview_url: false });
  assert.deepEqual(open.db.msgs.map((m) => [m.template, m.source]), [[null, "window"]]);
  assert.deepEqual(await open.wa.sendOrderUpdate({ order_no: "W1790022222222", phone_norm: CUST, option: "delivery" }, "collected"), { ok: false, skipped: "stage_not_applicable" });
  const closed = world({ settings: { notifications: N_COL, waBot: {} }, optins: OPT, inbound: [], orders: ORDERS, metaList: META() });
  assert.deepEqual(await closed.wa.sendOrderUpdate({ order_no: NO, phone_norm: CUST, option: "pickup" }, "collected"), { ok: false, skipped: "window_closed" });
  assert.equal(closed.calls.length, 0, "مفيش قالب يتبعت بداله");
  const off = world({ settings: { notifications: N_ON, waBot: {} }, optins: OPT, inbound: [CUST], orders: ORDERS, metaList: META() });
  assert.deepEqual(await off.wa.sendOrderUpdate({ order_no: NO, phone_norm: CUST, option: "pickup" }, "collected"), { ok: false, skipped: "stage_off" });
  const noOpt = world({ settings: { notifications: N_COL, waBot: {} }, optins: {}, inbound: [CUST], orders: ORDERS, metaList: META() });
  assert.deepEqual(await noOpt.wa.sendOrderUpdate({ order_no: NO, phone_norm: CUST, option: "pickup" }, "collected"), { ok: false, skipped: "no_optin" });
  assert.deepEqual(await noOpt.wa.sendOrderUpdate({ order_no: NO, phone_norm: CUST, option: "pickup" }, "nope"), { ok: false, skipped: "no_template_for_stage" });
}));

// ═════════ ٥) الكتالوج والمخطط والتسميات ═════════
test("الكتالوج: fc_order_pickup_ready = النسخة المعتمدة عند ميتا (ar + en، BODY بس — MJ2)، صياغة المالك للرسالة الحرة، صالح لميتا، لسه HOLD ومش في أي دفعة", () => {
  const ar = CAT.findTemplate("fc_order_pickup_ready", "ar"), en = CAT.findTemplate("fc_order_pickup_ready", "en");
  assert.equal(CAT.bodyOf(ar), "تحديث طلبك رقم {{1}}: طلبك جاهز للاستلام من الفرع. يرجى ذكر رقم الطلب عند الاستلام.");
  assert.equal(CAT.bodyOf(en), "Order {{1}} update: your order is ready for pickup at the branch. Please mention your order number when collecting.");
  assert.equal(ar.meta.windowBody, "طلبك رقم {{1}} جاهز للاستلام من فريش كاتس 📍 تفضّل إلى الفرع واذكر رقم طلبك.", "صياغة المالك فضلت للرسالة الحرة جوّه النافذة");
  assert.equal(en.meta.windowBody, "Your order {{1}} is ready for pickup from Fresh Cuts 📍 Please come to the branch and mention your order number.");
  for (const t of [ar, en]) { assert.deepEqual(CAT.validateTemplate(t), []); assert.equal(t.category, "UTILITY"); assert.equal(t.meta.stageWhenApproved, "pickup_ready"); }
  assert.doesNotMatch(CAT.bodyOf(ar), /السلامة|جدة|خرائط/, "مفيش حي ولا مدينة — سبب الرفضين السابقين");
  assert.ok(CAT.HOLD.fc_order_pickup_ready); assert.match(CAT.HOLD.fc_order_pickup_ready, /١٧\/١٠|RT2/);
  assert.ok(!CAT.SUBMIT_BATCHES.flat().includes("fc_order_pickup_ready"));
  const sub = CAT.submissionBody(ar);
  assert.deepEqual(Object.keys(sub), ["name", "language", "category", "components"]);
  assert.deepEqual(sub.components.map((c) => c.type), ["BODY"], "MJ2: زي المعتمد عند ميتا — من غير زر");
  assert.deepEqual(sub.components[0].example, { body_text: [["W1790012345678"]] });
  assert.equal(W.v2TemplateOf("pickup_ready", "fc_order_ready_pickup"), "fc_order_pickup_ready");
  assert.equal(W.v2TemplateOf("delivered", "fc_order_delivered"), "fc_order_delivered_v2");
  assert.equal(W.STAGE_TEMPLATES.pickup_ready, "fc_order_ready_pickup", "ربط المرحلة نفسه ماتغيّرش (wa-catalog)");
});

test("التسميات والصفوف: «جاهز للاستلام (استلام من الفرع)»، صف collected حر وقابل للتشغيل، وحفظ المراحل بيقبله؛ كتالوج SMS فيه order.pickup_ready بنفس نص notify", () => {
  assert.equal(SW.STAGE_LABELS.pickup_ready, "جاهز للاستلام (استلام من الفرع)");
  assert.ok(SW.STAGE_LABELS.collected); assert.ok(SW.isFreeStage("collected")); assert.ok(!SW.isFreeStage("pickup_ready"));
  const rows = SW.stageRows({ stageTemplates: W.STAGE_TEMPLATES, notifications: N_ON, metaList: META(), metaOk: true, mandatorySms: SW.MANDATORY_SMS_STAGES });
  const by = Object.fromEntries(rows.map((r) => [r.stage, r]));
  assert.deepEqual([by.pickup_ready.enabled, by.pickup_ready.replacesSms, by.pickup_ready.metaStatus, by.pickup_ready.canEnable], [true, true, "REJECTED", false], "مشغّلة (بالترحيل) رغم إن القالب مرفوض — الشيل مسموح والإضافة من اللوحة لأ");
  assert.deepEqual([by.collected.free, by.collected.template, by.collected.canEnable, by.collected.enabled, by.collected.metaStatus], [true, null, true, false, null]);
  assert.match(by.collected.note, /رسالة حرة/);
  assert.equal(SW.stagesProblem({ want: [...N_ON.whatsappStages, "collected"], current: N_ON.whatsappStages, stageTemplates: W.STAGE_TEMPLATES, metaList: META(), metaOk: true }), null, "إضافة collected مش محتاجة قالب");
  assert.equal(SW.stagesProblem({ want: ["pickup_ready"], current: ["pickup_ready"], stageTemplates: W.STAGE_TEMPLATES, metaList: META(), metaOk: true }), null, "المرحلة اللي الترحيل شغّلها بتفضل");
  assert.equal(SW.stagesProblem({ want: ["pickup_ready"], current: [], stageTemplates: W.STAGE_TEMPLATES, metaList: META(), metaOk: true }).error, "template_not_approved");
  const sms = SMS.CATALOGUE.find((t) => t.id === "order.pickup_ready");
  assert.deepEqual([sms.stage, sms.group, sms.label], ["pickup_ready", "order", "جاهز للاستلام (استلام من الفرع)"]);
  assert.equal(sms.def.replace("{order_no}", NO), statusSmsText("pickup_ready", { order_no: NO }));
  assert.equal(SMS.previewOf("order.pickup_ready", sms.def).parts, 1, "جزء UCS-2 واحد");
});

// ═════════ ٦) RT2 مراجعة (١٧/١٠) ═════════
const SHOP_DELIVERY = { quote: async () => ({ deliverable: true, fee: 0 }), shipmentOf: async () => null, cancelShipment: async () => null, dispatchGate: async () => ({ mode: "manual" }), canAutoDispatch: async () => false };
const shopCtx = (pool) => ({ pool, requireAdmin: async () => null, requireCashierOrAdmin: async () => null, getSettingsData: async () => ({}), jb: JSON.stringify, normPhone: String });
test("shop.js: «جاهز» من غير محطات ويبهوك (الكنس الاحتياطي) — طلب الاستلام: حدث pos_ready واحد + notify.orderReady ⇒ notify_sent واتساب pickup_ready واحد؛ التوصيل: الحدث من غير رسالة؛ الكتابة مرة واحدة", async () => {
  const { register: registerShop } = await import("./shop.js");
  const prev = process.env.SHOP_SWEEP_SECONDS; process.env.SHOP_SWEEP_SECONDS = "0";
  try {
    for (const [order, expectWa] of [[PICKUP, 1], [DELIVERY, 0]]) {
      const n = notifyWith({ waResult: { ok: true, wamid: "wamid.R1", free: true }, notifications: { ...N_ON, pushEnabled: false }, order });
      const events = [], queries = [];
      const pool = { async query(sql, vals) {
        const s = String(sql); queries.push({ s, vals });
        if (/pos_ready_at IS NULL\s+OR \(option='delivery'/.test(s)) return { rows: [{ order_no: order.order_no, pos_order_id: "88", branch_id: "1", option: order.option, pos_ready_at: null, handed_at: null, handed_source: null }], rowCount: 1 };
        if (/approval_status' AS approval/.test(s)) return { rows: [], rowCount: 0 };           // مفيش محطات ويبهوك ⇒ المسار الاحتياطي (الطلب نزل من مسار المتجر العادي)
        if (/jsonb_build_object\('resource'/.test(s)) return { rows: [{ payload: { resource: { statuses_slugs: { approval_status: "pickup_ready" } } } }], rowCount: 1 };
        if (/pos_ready_at = NOW\(\)[\s\S]*pos_ready_at IS NULL/.test(s)) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      } };
      const shop = registerShop(fakeApp(), shopCtx(pool), { pay: { configured: () => true }, delivery: SHOP_DELIVERY, emitOrder: (name, opts) => events.push({ name, ...opts }), journey: () => ({ emit() {} }), notify: n.api });
      const cap = capture();
      try {
        await shop.sweep(); await flush();
        const ready = events.filter((e) => e.name === "pos_ready");
        assert.equal(ready.length, 1, order.option); assert.deepEqual([ready[0].orderNo, ready[0].data.approval], [order.order_no, "pickup_ready"]);
        const up = queries.filter((q) => /pos_ready_at = NOW\(\)/.test(q.s));
        assert.equal(up.length, 1); assert.match(up[0].s, /WHERE order_no = \$1 AND pos_ready_at IS NULL/); assert.deepEqual(up[0].vals, [order.order_no, "pickup_ready"]);
        assert.deepEqual(n.calls.map((c) => c.st), expectWa ? ["pickup_ready"] : [], order.option);
        const wa = cap.of("pickup_ready", "whatsapp");
        assert.equal(wa.length, expectWa, order.option);
        if (expectWa) assert.deepEqual([wa[0].ok, wa[0].data.free, wa[0].orderNo], [true, true, order.order_no]);
      } finally { cap.stop(); }
      // الكتابة اتعملت قبل كده (rowCount 0 — حد تاني سبقنا) ⇒ لا حدث ولا رسالة — نفس حارس applyPosMilestones
      const n2 = notifyWith({ waResult: { ok: true, free: true }, notifications: { ...N_ON, pushEnabled: false }, order });
      const ev2 = [];
      const pool2 = { async query(sql) { const s = String(sql);
        if (/pos_ready_at IS NULL\s+OR \(option='delivery'/.test(s)) return { rows: [{ order_no: order.order_no, pos_order_id: "88", branch_id: "1", option: order.option, pos_ready_at: null, handed_at: null, handed_source: null }], rowCount: 1 };
        if (/jsonb_build_object\('resource'/.test(s)) return { rows: [{ payload: { resource: { statuses_slugs: { approval_status: "ready" } } } }], rowCount: 1 };
        return { rows: [], rowCount: 0 }; } };
      const shop2 = registerShop(fakeApp(), shopCtx(pool2), { pay: { configured: () => true }, delivery: SHOP_DELIVERY, emitOrder: (name, opts) => ev2.push({ name, ...opts }), journey: () => ({ emit() {} }), notify: n2.api });
      await shop2.sweep(); await flush();
      assert.equal(ev2.filter((e) => e.name === "pos_ready").length, 0); assert.equal(n2.calls.length, 0);
    }
  } finally { if (prev === undefined) delete process.env.SHOP_SWEEP_SECONDS; else process.env.SHOP_SWEEP_SECONDS = prev; }
});

test("حالة ميتا: REJECTED / NOT_SUBMITTED / DISABLED / PENDING_DELETION بس اللي بتقفل من غير نداء؛ PENDING (بعد تعديل) / IN_APPEAL / PAUSED بيكمّلوا للقالب وميتا بتقرر", withEnv(ALLOW, async () => {
  assert.deepEqual([...W.TEMPLATE_BLOCKING_STATUSES], ["REJECTED", "NOT_SUBMITTED", "DISABLED", "PENDING_DELETION", "DELETED"]);
  const N_SMS = { ...N_ON, smsStages: [...LIVE_N.smsStages, "pickup_ready"] };
  for (const status of ["PENDING", "IN_APPEAL", "PAUSED"]) {
    const w = world({ settings: { notifications: N_SMS, waBot: { windowV2Stages: [...V2_ON] } }, optins: OPT, inbound: [], orders: ORDERS,
      metaList: META([{ name: "fc_order_pickup_ready", language: "ar", category: "UTILITY", status }]) });
    const cap = capture();
    try {
      await w.notify.orderReady(NO); await flush();
      assert.equal(w.calls.length, 1, status); assert.equal(w.calls[0].body.template.name, "fc_order_pickup_ready", status);
      assert.deepEqual(cap.of("pickup_ready", "whatsapp").map((e) => e.ok), [true], status);
      assert.equal(w.db.sms.length, 0, `${status}: واتساب اتقبل ⇒ مفيش SMS (الويب هوك failed هو اللي يبعتها لو ميتا رفضت)`);
    } finally { cap.stop(); }
  }
  for (const status of ["DISABLED", "PENDING_DELETION"]) {
    const w = world({ settings: { notifications: N_SMS, waBot: { windowV2Stages: [...V2_ON] } }, optins: OPT, inbound: [], orders: ORDERS,
      metaList: META([{ name: "fc_order_pickup_ready", language: "ar", category: "UTILITY", status }]) });
    const cap = capture();
    try {
      await w.notify.orderReady(NO); await flush();
      assert.equal(w.calls.length, 0, status);
      assert.deepEqual([cap.of("pickup_ready", "whatsapp")[0].data.error, cap.of("pickup_ready", "whatsapp")[0].data.status], ["template_not_approved", status]);
      assert.equal(w.db.sms.length, 1, `${status}: SMS البديل`);
    } finally { cap.stop(); }
  }
}));

test("نص «اتسلّم من الفرع» من اللوحة: السجل الواحد (FREE_STAGES ⇔ FREE_STAGE_TEXT ⇔ TEXTS.collected_thanks)، النص المخصّص بيطلع في الرسالة الحرة، والفاضي/الطويل = الافتراضي", withEnv(ALLOW, async () => {
  assert.deepEqual(Object.keys(W.FREE_STAGE_TEXT), Object.keys(SW.FREE_STAGES), "مرحلة حرة في اللوحة لازم whatsapp.js يعرف يبعتها");
  const f = SW.FREE_STAGES.collected;
  assert.equal(f.textKey, "collected_thanks");
  assert.equal(BOT.TEXTS[f.textKey].ar, f.text.ar); assert.equal(BOT.TEXTS[f.textKey].en, f.text.en);
  assert.ok(BOT.TEXT_KEYS.includes(f.textKey), "بيظهر في شاشة النصوص");
  assert.equal(BOT.textProblem(f.textKey, "ar", "شكراً لزيارتك 🌟"), null);
  assert.equal(SW.freeStageText("collected", {}), "بالهنا والشفا 🌟 تقييمك يهمنا");
  assert.equal(SW.freeStageText("collected", { waBot: { texts: { collected_thanks: { ar: "  شكراً لزيارتك 🌟 نسعد بتقييمك  " } } } }), "شكراً لزيارتك 🌟 نسعد بتقييمك");
  assert.equal(SW.freeStageText("collected", { waBot: { texts: { collected_thanks: { ar: "   " } } } }), f.text.ar, "فاضي = الافتراضي");
  assert.equal(SW.freeStageText("collected", { waBot: { texts: { collected_thanks: { ar: "x".repeat(301) } } } }), f.text.ar, "أطول من ٣٠٠ = الافتراضي");
  assert.equal(SW.freeStageText("nope", {}), null);
  const N_COL = { ...N_ON, whatsappStages: [...N_ON.whatsappStages, "collected"] };
  const w = world({ settings: { notifications: N_COL, waBot: { texts: { collected_thanks: { ar: "شكراً لزيارتك 🌟 نسعد بتقييمك" } } } }, optins: OPT, inbound: [CUST], orders: ORDERS, metaList: META() });
  const r = await w.wa.sendOrderUpdate({ order_no: NO, phone_norm: CUST, option: "pickup" }, "collected");
  assert.deepEqual([r.ok, r.free], [true, true]);
  assert.deepEqual(w.calls[0].body.text, { body: "شكراً لزيارتك 🌟 نسعد بتقييمك", preview_url: false });
  assert.match(SW.FREE_STAGES.collected.note, /كل إعدادات البوت/, "صف المرحلة بيقول فين النص والمفتاح");
}));

test("مفتاح «اتسلّم من الفرع: مابنبعتش لو التقييم جاي خلال» في المخطط (orderMsgs، ٠..٢٤٠ دقيقة، ٦٠ افتراضياً)، في config، والحفظ بيرفض بره المدى", () => {
  const s = BOT.SCHEMA.collectedSkipIfReviewWithinMin;
  assert.ok(s); assert.deepEqual([s.group, s.type, s.min, s.max, s.unit], ["orderMsgs", "number", 0, 240, "دقيقة"]); assert.match(s.ar, /اتسلّم من الفرع/); assert.match(s.help, /٤٥/);
  assert.equal(BOT.DEFAULTS.collectedSkipIfReviewWithinMin, 60);
  assert.equal(BOT.botConfig({}).collectedSkipIfReviewWithinMin, 60);
  assert.equal(BOT.botConfig({ waBot: { collectedSkipIfReviewWithinMin: 30 } }).collectedSkipIfReviewWithinMin, 30);
  assert.equal(BOT.botConfig({ waBot: { collectedSkipIfReviewWithinMin: 999 } }).collectedSkipIfReviewWithinMin, 60, "بره المدى = الافتراضي");
  assert.equal(BOT.botConfig({ waBot: { collectedSkipIfReviewWithinMin: 0 } }).collectedSkipIfReviewWithinMin, 0);
  const row = BOT.schemaFor(BOT.botConfig({})).find((x) => x.key === "collectedSkipIfReviewWithinMin");
  assert.deepEqual([row.default, row.value], [60, 60]);
  assert.deepEqual(BOT.configFromBody({ collectedSkipIfReviewWithinMin: 30 }).value.collectedSkipIfReviewWithinMin, 30);
  assert.equal(BOT.configFromBody({ collectedSkipIfReviewWithinMin: 999 }).ok, false);
});

test("orderReady: الـPush (مجاني وفوري) بيطلع من غير ما يستنى مسار واتساب — ولو واتساب رمى، الـPush بيرجع برضه", async () => {
  const seq = [];
  let release; const gate = new Promise((r) => { release = r; });
  const pool = { async query(sql) {
    const s = String(sql);
    if (/FROM push_subs/.test(s)) { seq.push("push_lookup"); return { rows: [] }; }
    if (/FROM shop_orders/.test(s)) return { rows: [PICKUP] };
    return { rows: [], rowCount: 0 };
  } };
  const mk = (sendOrderUpdate) => registerNotify(fakeApp(), { pool, requireAdmin: async () => null, jb: JSON.stringify, normPhone: String, webpush: fakePush(),
    getSettingsData: async () => ({ webPushKeys: { publicKey: "p", privateKey: "q" }, notifications: { ...N_ON, pushEnabled: true } }), sendSms: async () => {} }, { wa: { sendOrderUpdate } });
  const api = mk(async () => { seq.push("wa_start"); await gate; seq.push("wa_done"); return { ok: true, free: true }; });
  const p = api.orderReady(NO);
  for (let i = 0; i < 30 && !seq.includes("push_lookup"); i++) await new Promise((r) => setImmediate(r));
  assert.ok(seq.includes("push_lookup") && !seq.includes("wa_done"), `الـPush اتبعت وواتساب لسه مستني: ${seq.join(" > ")}`);
  release(); await p; await flush();
  assert.deepEqual(seq.filter((x) => x !== "wa_start"), ["push_lookup", "wa_done"]);
  // واتساب رمى ⇒ orderReady مابيرميش (الـPush اتعمل وفيه حدث بالسبب)
  const api2 = mk(async () => { throw new Error("meta down"); });
  const cap = capture();
  try { assert.equal(await api2.orderReady(NO), 0); await flush(); assert.equal(cap.of("pickup_ready", "whatsapp")[0].data.error, "send_failed"); } finally { cap.stop(); }
});
