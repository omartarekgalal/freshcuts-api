/* ═══════════════════════════════════════════════════════════════════════
   🔒 SEC (١٢/١٠) — حارس إرسال واتساب (whatsapp.js: guardSend + deliver)
   «ولا رسالة توصل عميل على واتساب إلا لو: (أ) المفتاح الرئيسي مفتوح، (ب) العميل موافق على نوع الرسالة،
    (ج) دور اللي بيشغّل مسموح له».
     ١) عدّ المواضع: /messages بتاع Graph له موضع واحد في الكود كله (deliver)، وكل نداء لـdeliver وراه guardSend
     ٢) deliver من غير تذكرة / بتذكرة مزوّرة / مستعملة / لرقم تاني ⇒ خطأ ومفيش طلب شبكة
     ٣) المفتاح الرئيسي: الخادم (قفل صلب) × مفتاح المالك × إعداد الإشعارات
     ٤) الموافقة حسب النوع: خدمي / تسويق / تحقق / رد حر + «إيقاف»
     ٥) التجربة: أرقام اللوحة بس — القايمة اللي المنادي بيبعتها بتضيّق وماتوسّعش
     ٦) R1 الأدوار · R2 الحملات · R3 مسارات التجربة · R5 مفتاح المالك ومحميّ من الحفظ العام
   node --test wa-guard.test.mjs
═══════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const W = await import("./whatsapp.js");
const C = await import("./wacloud.js");
const S = await import("./wasender.js");
const N = await import("./notify.js");
const G = await import("./settings-guard.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN", "WHATSAPP_TEST_PHONE_ID"];
function withEnv(vals, fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, vals);
    try { await fn(); } finally {
      for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  };
}
const CONFIGURED = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1" };
const ALLOW = { ...CONFIGURED, WHATSAPP_ENABLED: "1" };

function fakeApp() {
  const routes = {};
  const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
}
const fakeCtx = ({ json = {}, headers = {}, query = {} } = {}) => ({
  req: { json: async () => json, text: async () => "", header: (n) => headers[String(n).toLowerCase()], query: (n) => query[n], param: () => undefined },
  json: (body, status = 200) => ({ body, status }), text: (body, status = 200) => ({ body, status }) });

/* عالم صغير: إعدادات + موافقات + وارد + «إيقاف» التسويق، وfetch بيسجّل كل طلب لـGraph */
function world({ settings = {}, optins = {}, inbound = [], suppressed = [] } = {}) {
  const db = { settings: { notifications: { whatsappEnabled: true }, waMaster: { enabled: true }, waBot: { testPhones: ["0544775082"] }, ...settings },
    optins: { ...optins }, inbound: [...inbound], suppressed: [...suppressed], msgs: [] };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: db.inbound.includes(p[0]) ? [{}] : [] };
    if (/^SELECT 1 FROM wa_messages WHERE wamid=\$1 AND phone_norm=\$2 AND direction='in'/i.test(s)) return { rows: (db.inboundIds || []).includes(`${p[0]}|${p[1]}`) ? [{}] : [] };      // sendTyping: الرسالة واردة من نفس الرقم
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: db.optins[p[0]] ? [db.optins[p[0]]] : [] };
    if (/^INSERT INTO wa_optins/i.test(s)) { const c = db.optins[p[0]] || {}; db.optins[p[0]] = { ...c, updates: p[1] ?? c.updates ?? false, marketing: p[2] ?? c.marketing ?? false }; return { rows: [] }; }
    if (/^UPDATE wa_optins SET stopped_at=NOW\(\)/i.test(s)) { db.optins[p[0]] = { ...(db.optins[p[0]] || {}), stopped_at: new Date().toISOString() }; return { rows: [] }; }
    if (/^UPDATE wa_optins SET stopped_at=NULL/i.test(s)) { db.optins[p[0]] = { ...(db.optins[p[0]] || {}), stopped_at: null }; return { rows: [] }; }
    if (/^SELECT text_version FROM wa_optin_log WHERE kind='terms' AND value AND order_no=\$1 AND phone_norm=\$2/i.test(s)) {
      return { rows: (db.terms || []).filter((t) => t.order === p[0] && t.phone === p[1]).slice(-1).map((t) => ({ text_version: t.version })) };
    }
    if (/FROM shop_orders WHERE order_no=\$1/i.test(s)) return { rows: (db.orders || []).filter((o) => o.order_no === p[0]) };
    if (/FROM cms_contacts/i.test(s)) return { rows: [], rowCount: db.suppressed.includes(p[0]) ? 1 : 0 };
    if (/^INSERT INTO wa_messages/i.test(s)) { db.msgs.push({ wamid: p[0], phone_norm: p[1], status: p[6] }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{waMaster\}'/i.test(s)) { db.settings.waMaster = JSON.parse(p[0]); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{waCloud\}'/i.test(s)) { db.settings.waCloud = JSON.parse(p[0]); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.G${calls.length}` }] }) };
  };
  const app = fakeApp();
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(app, ctx, { fetch, sendSms: async () => ({ ok: true }) });
  return { db, pool, calls, fetch, app, ctx, wa };
}
const CUST = "512345678", STAFF = "544775082";
const utilParams = () => W.TEMPLATES.fc_order_preparing.bind({ order_no: "W1790011111111" });
const text = (body = "أهلاً") => ({ type: "text", text: { body } });

/* ══ ١) عدّ المواضع ═══════════════════════════════════════════════════════ */
function sourceFiles(dir = HERE, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(f, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name) && !/\.test\.(js|mjs)$/.test(e.name)) out.push(f);
  }
  return out;
}
/* الكود من غير التعليقات (بنفس أرقام السطور) — عشان شرح قديم في تعليق مايتحسبش موضع إرسال */
const code = (f) => fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const rel = (f) => path.relative(HERE, f).replace(/\\/g, "/");
/* اسم الدالة اللي السطر جوّاها (آخر «function اسم(» قبله) */
function enclosing(lines, i) {
  for (let k = i; k >= 0; k--) { const m = lines[k].match(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/) || lines[k].match(/app\.(?:post|get|put|delete)\(\s*"([^"]+)"/); if (m) return { name: m[1], at: k }; }
  return { name: null, at: 0 };
}

test("call sites: Graph «/messages» is requested from exactly one place in the whole codebase — deliver()", () => {
  const OTHER_APIS = /api\.taqnyat\.sa|api\.anthropic\.com/;
  const hits = [];
  for (const f of sourceFiles()) {
    const lines = code(f).split(/\r?\n/);
    lines.forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;                                  // تعليق
      if (!/\/messages[`"']/.test(ln) || OTHER_APIS.test(ln)) return;
      if (/app\.(get|post|put|delete)\(\s*["'`]\/api\//.test(ln)) return;        // مسار عندنا اسمه بينتهي بـ/messages
      hits.push(`${rel(f)}:${enclosing(lines, i).name}`);
    });
  }
  assert.deepEqual(hits, ["whatsapp.js:deliver"], "a new low-level WhatsApp send must go through guardSend()+deliver(), not its own Graph call");
});

test("call sites: nobody builds a Graph messages URL by hand, and every deliver() call is fed a ticket from guardSend() in the same function", () => {
  const callers = [];
  for (const f of sourceFiles()) {
    const lines = code(f).split(/\r?\n/);
    lines.forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      if (/graph\.facebook\.com[^"'`]*messages/.test(ln)) assert.fail(`${rel(f)}:${i + 1} builds a Graph messages URL directly`);
      const m = ln.match(/(?:^|[^A-Za-z0-9_.])((?:wa\.|waApi\.|api\.)?deliver)\(([^,)]*)/);
      if (!m || /function\s+deliver\(/.test(ln)) return;
      const enc = enclosing(lines, i);
      const body = lines.slice(enc.at, i + 1).join("\n");
      assert.match(m[2].trim(), /^g\.ticket$/, `${rel(f)}:${i + 1} deliver() must receive g.ticket`);
      assert.match(body, /const g = await (?:wa\.)?guardSend\(/, `${rel(f)}:${i + 1} (${enc.name}) calls deliver() without guardSend() before it`);
      callers.push(`${rel(f)}:${enc.name}`);
    });
  }
  assert.deepEqual(callers.sort(), ["wacloud.js:/api/cms/wa-cloud/demo/send", "whatsapp.js:sendFreeform", "whatsapp.js:sendTemplate", "whatsapp.js:sendText", "whatsapp.js:sendTyping"],
    "the list of functions that may hand a message to Graph — adding one is a deliberate decision, update this list with the review");
  // مفيش حد بره whatsapp.js بيكلّم graphPost بتاعه، والتوكن مابيتبعتش لـ/messages من ملف تاني
  const wsrc = fs.readFileSync(path.join(HERE, "whatsapp.js"), "utf8");
  assert.equal((wsrc.match(/graphPost\(`\$\{[^`]*\/messages`/g) || []).length, 1);
});

/* ══ ٢) deliver من غير تذكرة ═══════════════════════════════════════════════ */
test("deliver(): no ticket, a forged ticket, a used ticket, another phone or another kind ⇒ refused before any network call", withEnv(ALLOW, async () => {
  const w = world({ inbound: [CUST] });
  const payload = { messaging_product: "whatsapp", to: "966512345678", ...text() };
  await assert.rejects(w.wa.deliver(null, payload), (e) => e.code === "WA_NO_GUARD");
  await assert.rejects(w.wa.deliver({ to: "966512345678", phoneNorm: CUST, kind: "session", test: false, at: Date.now() }, payload), (e) => e.code === "WA_NO_GUARD");
  const g1 = await w.wa.guardSend({ phoneNorm: CUST, kind: "session" });
  assert.equal(g1.ok, true);
  await assert.rejects(w.wa.deliver(g1.ticket, { ...payload, to: "966598765432" }), (e) => e.code === "WA_GUARD_MISMATCH");
  await assert.rejects(w.wa.deliver(g1.ticket, payload), (e) => e.code === "WA_NO_GUARD", "a refused ticket is spent");
  const g2 = await w.wa.guardSend({ phoneNorm: CUST, kind: "session" });
  await assert.rejects(w.wa.deliver(g2.ticket, { messaging_product: "whatsapp", to: "966512345678", type: "template", template: { name: "x" } }), (e) => e.code === "WA_GUARD_MISMATCH",
    "a free-form ticket cannot carry a template");
  assert.equal(w.calls.length, 0);
  const g3 = await w.wa.guardSend({ phoneNorm: CUST, kind: "session" });
  await w.wa.deliver(g3.ticket, payload);
  assert.equal(w.calls.length, 1);
  assert.match(w.calls[0].url, /\/PHONE1\/messages$/);
  await assert.rejects(w.wa.deliver(g3.ticket, payload), (e) => e.code === "WA_NO_GUARD", "one ticket = one message");
  assert.equal(w.calls.length, 1);
  assert.equal(Object.isFrozen(g3.ticket), true);
}));

/* ══ ٣) المفتاح الرئيسي ═════════════════════════════════════════════════════ */
test("master: the server flag is a hard kill above the owner's dashboard switch — both must allow, for every kind of message", async () => {
  const optins = { [CUST]: { updates: true, marketing: true } };
  const tries = async (w) => [
    (await w.wa.sendTemplate({ phoneNorm: CUST, template: "fc_order_preparing", params: utilParams() })).skipped || "sent",
    (await w.wa.sendFreeform({ phoneNorm: CUST, payload: text() })).skipped || "sent",
    (await w.wa.sendText({ phoneNorm: CUST, text: "أهلاً" })).skipped || "sent",
    (await w.wa.gate()) || "open",
  ];
  const cases = [
    [{ ...CONFIGURED }, {}, "disabled"],                                                   // الخادم مش مكتوب ⇒ العملاء مقفولين
    [{ ...CONFIGURED, WHATSAPP_ENABLED: "0" }, {}, "disabled"],                            // قفل صريح
    [{ ...CONFIGURED, WHATSAPP_ENABLED: "true" }, {}, "disabled"],                         // أي قيمة غير "1" مش سماح
    [{ WHATSAPP_ENABLED: "1" }, {}, "unconfigured"],
    [ALLOW, { waMaster: { enabled: false } }, "master_off"],
    [ALLOW, { waMaster: undefined }, "master_off"],                                        // الافتراضي مقفول
    [ALLOW, { waMaster: { enabled: "true" } }, "master_off"],                              // true الحقيقية بس
    [ALLOW, { waMaster: true }, "master_off"],
    [ALLOW, { notifications: { whatsappEnabled: false } }, "settings_off"],
  ];
  for (const [env, settings, want] of cases) {
    await withEnv(env, async () => {
      const w = world({ settings, optins, inbound: [CUST] });
      assert.deepEqual(await tries(w), [want, want, want, want], JSON.stringify([env.WHATSAPP_ENABLED, settings]));
      assert.equal(w.calls.length, 0, "no network call while locked");
    })();
  }
  await withEnv(ALLOW, async () => {
    const w = world({ optins, inbound: [CUST] });
    assert.deepEqual(await tries(w), ["sent", "sent", "sent", "open"]);
    assert.equal(w.calls.length, 3);
  })();
});

test("master: settings that cannot be read ⇒ locked (never «assume on»)", withEnv(ALLOW, async () => {
  const w = world({ optins: { [CUST]: { updates: true } }, inbound: [CUST] });
  w.ctx.getSettingsData = async () => { throw new Error("db down"); };
  const wa = W.register(fakeApp(), w.ctx, { fetch: w.fetch, sendSms: async () => ({}) });
  assert.equal((await wa.sendTemplate({ phoneNorm: CUST, template: "fc_order_preparing", params: utilParams() })).skipped, "settings_unreadable");
  assert.equal((await wa.sendFreeform({ phoneNorm: STAFF, payload: text(), test: true })).skipped, "settings_unreadable");
  assert.equal(w.calls.length, 0);
}));

/* ══ ٤) الموافقة حسب النوع ══════════════════════════════════════════════════ */
test("consent: utility needs its own basis; marketing goes to everyone except those who asked to stop; requireOptIn:false changes nothing", withEnv(ALLOW, async () => {
  const marketingTpl = Object.keys(W.TEMPLATES).find((n) => W.TEMPLATES[n].category === "MARKETING");
  assert.ok(marketingTpl, "the registry has a marketing template");
  const send = (w, template, extra = {}) => w.wa.guardSend({ phoneNorm: CUST, kind: "template", template, ...extra });
  const none = world();
  assert.equal((await send(none, "fc_order_preparing")).reason, "no_optin", "an order message without an order or an explicit yes is still refused");
  assert.equal((await none.wa.sendTemplate({ phoneNorm: CUST, template: "fc_order_preparing", params: utilParams(), requireOptIn: false })).skipped, "no_optin");
  assert.equal(none.calls.length, 0);
  // owner's decision 13/10: offers go to every customer unless they asked to stop
  assert.equal((await send(none, marketingTpl)).ok, true, "no consent row at all");
  assert.equal((await send(none, "fc_order_preparing", { source: "campaign" })).ok, true, "a campaign is judged as marketing whatever the template category");
  const upd = world({ optins: { [CUST]: { updates: true, marketing: false } } });
  assert.equal((await send(upd, "fc_order_preparing")).ok, true);
  assert.equal((await send(upd, marketingTpl)).ok, true, "marketing=false with no refusal on record is just «never asked»");
  // every way of saying stop
  const smsOut = world({ optins: { [CUST]: { updates: true, marketing: true } }, suppressed: [CUST] });
  assert.equal((await send(smsOut, marketingTpl)).reason, "opted_out", "stopped marketing by SMS link / cashier");
  assert.equal((await send(smsOut, "fc_order_preparing", { source: "campaign" })).reason, "opted_out");
  assert.equal((await send(smsOut, "fc_order_preparing")).ok, true, "…their order messages are not affected");
  const refused = world({ optins: { [CUST]: { marketing: false, marketing_off_at: "2026-10-13T08:00:00Z" } } });
  assert.equal((await send(refused, marketingTpl)).reason, "opted_out", "explicitly refused offers");
  const stopped = world({ optins: { [CUST]: { marketing: false, stopped_at: "2026-10-13T08:00:00Z" } } });
  assert.equal((await send(stopped, marketingTpl)).reason, "opted_out", "wrote «إيقاف» on WhatsApp");
  assert.equal((await send(none, "no_such_template")).reason, "unknown_template");
  assert.equal((await none.wa.guardSend({ phoneNorm: "123", kind: "template", template: "fc_order_preparing" })).reason, "invalid_phone");
  assert.equal((await none.wa.guardSend({ phoneNorm: CUST, kind: "broadcast" })).reason, "bad_kind");
}));

test("consent: an authentication code needs no consent; used as a campaign it follows the marketing rule (refused only for a customer who stopped)", withEnv(ALLOW, async () => {
  const auth = Object.keys(W.TEMPLATES).find((n) => W.TEMPLATES[n].category === "AUTHENTICATION");
  if (!auth) return;
  const w = world({ optins: { "598765432": { stopped_at: "2026-10-13T08:00:00Z" } } });
  assert.equal((await w.wa.guardSend({ phoneNorm: "598765432", kind: "template", template: auth })).ok, true, "a code the customer asked for goes even after «إيقاف»");
  assert.equal((await w.wa.guardSend({ phoneNorm: "598765432", kind: "template", template: auth, source: "campaign" })).reason, "opted_out");
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: auth, source: "campaign" })).ok, true);
}));

test("consent: a free-form reply needs a real inbound message in the last 24 h — checked by the guard, not left to the caller", withEnv(ALLOW, async () => {
  const w = world({ optins: { [CUST]: { updates: true, marketing: true } } });
  assert.equal((await w.wa.sendText({ phoneNorm: CUST, text: "عرض اليوم" })).skipped, "window_closed");
  assert.equal((await w.wa.sendFreeform({ phoneNorm: CUST, payload: text("عرض اليوم") })).skipped, "window_closed");
  assert.equal((await w.wa.sendFreeform({ phoneNorm: CUST, payload: { type: "template", template: { name: "x" } } })).skipped, "bad_payload", "no template through the free-form door");
  assert.equal(w.calls.length, 0);
  w.db.inbound.push(CUST);
  assert.equal((await w.wa.sendText({ phoneNorm: CUST, text: "أهلاً" })).ok, true);
  assert.equal(w.calls.length, 1);
}));

test("«إيقاف» on WhatsApp silences every template — marketing until «START», updates until a new explicit yes; a later order does not undo it", withEnv(ALLOW, async () => {
  const marketingTpl = Object.keys(W.TEMPLATES).find((n) => W.TEMPLATES[n].category === "MARKETING");
  const w = world({ optins: { [CUST]: { updates: true, marketing: true, updates_answered_at: "2026-10-01T10:00:00Z", answered_at: "2026-10-01T10:00:00Z" } } });
  const util = () => w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing" });
  const mkt = () => w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: marketingTpl });
  assert.equal((await util()).ok, true); assert.equal((await mkt()).ok, true);
  await w.wa.applyIntent(CUST, "stop");
  assert.equal(w.db.optins[CUST].marketing, false);
  assert.ok(w.db.optins[CUST].stopped_at);
  assert.equal((await util()).reason, "opted_out");
  assert.equal((await mkt()).reason, "opted_out");
  // طلب جديد: الشيك أوت بيكتب source فوق القديم (shop.js) — العلامة عمود مستقل فمابتتمسحش
  await w.wa.recordOptIn({ phone: CUST, marketing: undefined, source: "checkout" });
  assert.equal((await util()).reason, "opted_out", "the next order does not quietly re-subscribe them");
  // موافقة صريحة جديدة على التحديثات (بعد الإيقاف) ⇒ التحديثات ترجع، التسويق لأ
  w.db.optins[CUST].answered_at = new Date(Date.now() + 1000).toISOString();
  assert.equal((await util()).ok, true);
  assert.equal((await mkt()).reason, "opted_out");
  await w.wa.applyIntent(CUST, "start");
  assert.equal(w.db.optins[CUST].stopped_at, null);
  assert.equal((await mkt()).ok, true);
}));

/* ══ ٥) التجربة ══════════════════════════════════════════════════════════════ */
test("test sends: only the dashboard's test numbers; a caller's own list can narrow that list but never widen it", withEnv(CONFIGURED, async () => {
  // مفتاح الخادم مش مكتوب ومفتاح المالك مقفول — التجربة لأرقام اللوحة شغّالة، والعميل لأ
  const w = world({ settings: { waMaster: { enabled: false }, notifications: {}, waBot: { testPhones: ["0544775082", "+966561186075"] } } });
  const t = (a) => w.wa.guardSend({ kind: "template", template: "fc_order_preparing", ...a });
  assert.equal((await t({ phoneNorm: STAFF, test: true })).ok, true);
  assert.equal((await t({ phoneNorm: "561186075", allowList: ["561186075"] })).ok, true);
  assert.equal((await t({ phoneNorm: CUST, test: true })).reason, "not_in_allow_list");
  assert.equal((await t({ phoneNorm: CUST, allowList: [CUST] })).reason, "not_in_allow_list", "a caller cannot add a customer to the allow-list");
  assert.equal((await t({ phoneNorm: CUST, allowList: [CUST], test: true })).reason, "not_in_allow_list");
  assert.equal((await t({ phoneNorm: STAFF, allowList: ["561186075"] })).reason, "not_in_allow_list", "the caller's list narrows");
  assert.equal((await t({ phoneNorm: STAFF, allowList: [] })).reason, "not_in_allow_list");
  assert.equal((await t({ phoneNorm: STAFF })).reason, "disabled", "without the test flag a staff phone is a customer like any other");
  assert.equal((await w.wa.sendFreeform({ phoneNorm: CUST, payload: text(), allowList: [CUST] })).skipped, "not_in_allow_list");
  assert.equal(w.calls.length, 0);
  // تذكرة التجربة مابتتبعتش من رقم تاني إلا في وضع التجربة
  const g = await t({ phoneNorm: STAFF, test: true, fromId: "TESTPHONE" });
  assert.equal(g.ticket.fromId, "TESTPHONE");
  const empty = world({ settings: { waBot: {} } });
  assert.equal((await empty.wa.guardSend({ phoneNorm: STAFF, kind: "session", test: true })).reason, "not_in_allow_list", "no list = no test sends");
}));

test("test sends: an explicit server kill (WHATSAPP_ENABLED=0) stops even the test numbers; fromId is ignored outside test mode", async () => {
  await withEnv({ ...CONFIGURED, WHATSAPP_ENABLED: "0" }, async () => {
    const w = world();
    assert.equal((await w.wa.guardSend({ phoneNorm: STAFF, kind: "session", test: true })).reason, "disabled");
    assert.equal(w.wa.envState(), "kill");
  })();
  await withEnv(ALLOW, async () => {
    const w = world({ inbound: [CUST] });
    const g = await w.wa.guardSend({ phoneNorm: CUST, kind: "session", fromId: "OTHER" });
    assert.equal(g.ticket.fromId, null);
    assert.equal(w.wa.envState(), "allow");
  })();
  await withEnv(CONFIGURED, async () => { assert.equal(world().wa.envState(), "unset"); })();
});

/* ══ ٦) R1 — الأدوار ═════════════════════════════════════════════════════════ */
function senderWorld({ role }) {
  const w = world({ settings: { waCloud: { enabled: false, dailyCap: 50 }, waSender: {} } });
  const sessionUser = async () => (role ? { name: "سارة", role } : null);
  const app = fakeApp();
  S.register(app, { pool: w.pool, requireAdmin: async () => null, getSettingsData: w.ctx.getSettingsData },
    { wa: { gate: async () => null, on: () => {}, sendTemplate: async () => ({ ok: true }) }, cloudLoop: false, lock: false, sessionUser, cms: () => null });
  const post = (json) => app.routes["POST /api/cms/wa-sender/cloud"](fakeCtx({ json, headers: { authorization: role ? "Bearer cms:abc" : "Bearer admin-token" } }));
  return { ...w, post };
}

test("R1: the marketing role cannot switch the Cloud campaign channel on or raise its caps from the sender screen — it can only switch it off", async () => {
  for (const role of ["marketing", "manager", "admin"]) {
    const w = senderWorld({ role });
    for (const body of [{ enabled: true }, { dailyCap: 500 }, { enabled: false, hourCap: 900 }, { tierLimit: 100000 }, { reserveUtility: 0 }, {}]) {
      const r = await w.post(body);
      assert.equal(r.status, 403, `${role} ${JSON.stringify(body)}`);
      assert.equal(r.body.error, "owner_only");
    }
    assert.equal(w.db.settings.waCloud.enabled, false);
    assert.equal(w.db.settings.waCloud.dailyCap, 50, "nothing written");
    const off = await w.post({ enabled: false });
    assert.equal(off.status, 200, "switching off is always allowed");
    assert.equal(off.body.cfg.enabled, false);
  }
  for (const role of ["owner", null]) {
    const w = senderWorld({ role });
    const r = await w.post({ enabled: true });
    assert.equal(r.status, 200);
    assert.equal(w.db.settings.waCloud.enabled, true);
  }
});

test("R1: a broken session lookup is «not the owner»", async () => {
  const w = world({ settings: { waCloud: { enabled: false }, waSender: {} } });
  const app = fakeApp();
  S.register(app, { pool: w.pool, requireAdmin: async () => null, getSettingsData: w.ctx.getSettingsData },
    { wa: { gate: async () => null, on: () => {} }, cloudLoop: false, lock: false, sessionUser: async () => { throw new Error("db down"); }, cms: () => null });
  const r = await app.routes["POST /api/cms/wa-sender/cloud"](fakeCtx({ json: { enabled: true }, headers: { authorization: "Bearer cms:abc" } }));
  assert.equal(r.status, 403);
  assert.equal(w.db.settings.waCloud.enabled, false);
});

/* ══ R2 — الحملات ════════════════════════════════════════════════════════════ */
test("R2: the campaign sender asks for the marketing opt-in, and the code no longer contains a send that waives consent for customers", () => {
  const src = code(path.join(HERE, "wasender.js"));
  assert.doesNotMatch(src, /requireOptIn:\s*false/);
  assert.match(src, /requireOptIn: true, source: "campaign"/);
  assert.match(src, /r\.skipped === "no_optin" \|\| r\.skipped === "opted_out"/, "a customer without consent is skipped by reason; the queue goes on");
  // أي requireOptIn:false باقي في الكود = إرسال تجربة للأرقام المسموحة (البوت) أو رد من الصندوق — والحارس بيفرض الموافقة في الحالتين
  for (const f of sourceFiles()) {
    const lines = code(f).split(/\r?\n/);
    lines.forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln) || !/requireOptIn:\s*false/.test(ln)) return;
      assert.ok(["wabotrun.js", "wainbox.js"].includes(rel(f)), `${rel(f)}:${i + 1} asks to waive consent`);
    });
  }
});

test("R2 (as decided 13/10): a campaign row is sent to a customer who never opted in, and skipped for one who stopped", withEnv(ALLOW, async () => {
  const marketingTpl = Object.keys(W.TEMPLATES).find((n) => W.TEMPLATES[n].category === "MARKETING");
  const w = world({ optins: { [CUST]: { updates: true, marketing: false }, "598765432": { marketing: true, stopped_at: "2026-10-13T08:00:00Z" } } });
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: marketingTpl, source: "campaign" })).ok, true);
  const r = await w.wa.sendTemplate({ phoneNorm: "598765432", template: marketingTpl, params: { body: ["x"] }, requireOptIn: false, source: "campaign" });
  assert.equal(r.skipped, "opted_out");
  assert.equal(w.calls.length, 0);
}));

/* ══ R3 — مسارات التجربة ════════════════════════════════════════════════════ */
function notifyWorld(w) {
  const app = fakeApp();
  N.register(app, { ...w.ctx, webpush: { generateVAPIDKeys: () => ({ publicKey: "p", privateKey: "q" }), setVapidDetails() {}, async sendNotification() {} },
    sendSms: async () => ({ ok: true }) }, { wa: w.wa });
  return (json) => app.routes["POST /api/notify/test"](fakeCtx({ json }));
}

test("R3: POST /api/notify/test (whatsapp) reaches the dashboard's test numbers only, through the guard", withEnv(CONFIGURED, async () => {
  const realFetch = globalThis.fetch;
  const direct = [];
  globalThis.fetch = async (u) => { direct.push(String(u)); return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const w = world({ settings: { waMaster: { enabled: false } } });
    w.db.settings.webPushKeys = { publicKey: "p", privateKey: "q" };
    const post = notifyWorld(w);
    const r1 = await post({ channel: "whatsapp", phone: "0512345678", text: "تجربة" });
    assert.equal(r1.status, 403);
    assert.equal(r1.body.error, "not_in_allow_list");
    assert.equal(w.calls.length, 0);
    // رسالة التجربة نص حر ⇒ لازم رقم التجربة يكون كلّمنا في آخر ٢٤ ساعة (نفس قاعدة العملاء)
    const closed = await post({ channel: "whatsapp", phone: "0544775082", text: "تجربة" });
    assert.equal(closed.status, 403); assert.equal(closed.body.error, "window_closed"); assert.equal(w.calls.length, 0);
    w.db.inbound.push("544775082");
    const r2 = await post({ channel: "whatsapp", phone: "0544775082", text: "تجربة" });
    assert.equal(r2.body.ok, true);
    assert.equal(w.calls.length, 1);
    assert.equal(w.calls[0].body.to, "966544775082");
    assert.equal(w.calls[0].body.text.body, "تجربة");
    assert.equal(direct.filter((u) => /graph\.facebook\.com/.test(u)).length, 0, "notify.js has no Graph call of its own");
    const r3 = await post({ channel: "whatsapp", phone: "123" });
    assert.equal(r3.status, 400);
  } finally { globalThis.fetch = realFetch; }
  const nsrc = code(path.join(HERE, "notify.js"));
  assert.doesNotMatch(nsrc, /function sendWhatsApp|graph\.facebook\.com/);
}));

test("R3: an explicit server kill also stops the notify test send", withEnv({ ...CONFIGURED, WHATSAPP_ENABLED: "0" }, async () => {
  const w = world();
  w.db.settings.webPushKeys = { publicKey: "p", privateKey: "q" };
  const r = await notifyWorld(w)({ channel: "whatsapp", phone: "0544775082" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "disabled");
  assert.equal(w.calls.length, 0);
}));

function cloudWorld(w, { role = null } = {}) {
  const app = fakeApp();
  C.register(app, { ...w.ctx }, { fetch: w.fetch, wa: w.wa, sessionUser: async () => (role ? { name: "سارة", role } : null) });
  const hdr = { authorization: role ? "Bearer cms:abc" : "Bearer admin-token" };
  return { app, call: (method, p, json) => app.routes[`${method} ${p}`](fakeCtx({ json, headers: hdr })) };
}

test("R3: wa-cloud/demo/send goes to the dashboard's test numbers only — from the test sender or the live one", withEnv({ ...CONFIGURED, WHATSAPP_TEST_PHONE_ID: "TESTPHONE" }, async () => {
  const w = world({ settings: { waMaster: { enabled: false } } });
  const { call } = cloudWorld(w);
  for (const to of ["966512345678", "201001234567", "14155550100", "966544775083"]) {
    for (const sender of ["test", "live"]) {
      const r = await call("POST", "/api/cms/wa-cloud/demo/send", { to, sender });
      assert.equal(r.status, 403, `${to} ${sender}`);
      assert.match(r.body.error, /not_in_allow_list|invalid_phone/);
    }
  }
  assert.equal(w.calls.length, 0);
  const ok = await call("POST", "/api/cms/wa-cloud/demo/send", { to: "+966 54 477 5082", sender: "test" });
  assert.equal(ok.body.ok, true);
  assert.equal(w.calls.length, 1);
  assert.match(w.calls[0].url, /\/TESTPHONE\/messages$/);
  assert.deepEqual(w.calls[0].body, { messaging_product: "whatsapp", to: "966544775082", type: "template", template: { name: "hello_world", language: { code: "en_US" } } });
  const live = await call("POST", "/api/cms/wa-cloud/demo/send", { to: "966544775082", sender: "live" });
  assert.equal(live.body.ok, true);
  assert.match(w.calls[1].url, /\/PHONE1\/messages$/);
  const marketing = cloudWorld(world(), { role: "marketing" });
  assert.equal((await marketing.call("POST", "/api/cms/wa-cloud/demo/send", { to: "966544775082" })).status, 403);
}));

/* ══ R5 — مفتاح المالك ═══════════════════════════════════════════════════════ */
test("R5: the master switch is a dashboard setting only the owner can write; switching on needs the confirmation; every change is logged", withEnv(ALLOW, async () => {
  const w = world({ settings: { waMaster: undefined }, optins: { [CUST]: { updates: true } } });
  const owner = cloudWorld(w);
  const send = async () => (await w.wa.sendTemplate({ phoneNorm: CUST, template: "fc_order_preparing", params: utilParams() }));
  assert.equal((await send()).skipped, "master_off");
  const v0 = await owner.call("GET", "/api/cms/wa-cloud/master");
  assert.deepEqual([v0.body.master.enabled, v0.body.master.envState, v0.body.master.blockedBy, v0.body.master.sending], [false, "allow", "master_off", false]);
  for (const role of ["marketing", "manager", "admin"]) {
    const other = cloudWorld(w, { role });
    const r = await other.call("POST", "/api/cms/wa-cloud/master", { enabled: true, confirm: true });
    assert.equal(r.status, 403, role);
    assert.equal((await other.call("GET", "/api/cms/wa-cloud/master")).body.ok, true, "anyone on the dashboard can see the state");
  }
  assert.equal(w.db.settings.waMaster, undefined);
  assert.equal((await owner.call("POST", "/api/cms/wa-cloud/master", { enabled: true })).body.error, "confirm_required");
  assert.equal((await owner.call("POST", "/api/cms/wa-cloud/master", { enabled: "yes", confirm: true })).body.error, "bad_enabled");
  assert.equal((await owner.call("POST", "/api/cms/wa-cloud/master", {})).body.error, "bad_enabled");
  assert.equal((await send()).skipped, "master_off");
  const on = await owner.call("POST", "/api/cms/wa-cloud/master", { enabled: true, confirm: true });
  assert.deepEqual([on.body.master.enabled, on.body.master.blockedBy, on.body.master.sending], [true, null, true]);
  assert.equal((await send()).ok, true);
  const off = await owner.call("POST", "/api/cms/wa-cloud/master", { enabled: false });
  assert.equal(off.body.master.enabled, false, "switching off needs no confirmation");
  assert.equal((await send()).skipped, "master_off", "off takes effect on the very next message");
  assert.deepEqual(w.db.settings.waMaster.log.map((l) => l.enabled), [true, false]);
  assert.ok(w.db.settings.waMaster.log.every((l) => l.by && l.at));
}));

test("R5: the server flag still overrides the dashboard switch, and the dashboard says which lock is closed", withEnv(CONFIGURED, async () => {
  const w = world({ optins: { [CUST]: { updates: true } } });
  const owner = cloudWorld(w);
  const on = await owner.call("POST", "/api/cms/wa-cloud/master", { enabled: true, confirm: true });
  assert.deepEqual([on.body.master.enabled, on.body.master.envState, on.body.master.blockedBy, on.body.master.sending], [true, "unset", "disabled", false]);
  assert.equal((await w.wa.sendTemplate({ phoneNorm: CUST, template: "fc_order_preparing", params: utilParams() })).skipped, "disabled");
  assert.equal(w.calls.length, 0);
}));

test("R5: the general settings save and the settings patch route cannot touch the master switch", () => {
  assert.ok(G.SERVER_OWNED_PATHS.includes("waMaster"));
  const merged = G.mergeForPut({ waMaster: { enabled: false }, notifications: {} }, { waMaster: { enabled: true }, notifications: { smsEnabled: true } }, { trusted: true });
  assert.deepEqual(merged.waMaster, { enabled: false }, "a full-settings PUT keeps the server's value");
  const created = G.mergeForPut({ notifications: {} }, { waMaster: { enabled: true }, notifications: {} }, { trusted: true });
  assert.notEqual(created.waMaster && created.waMaster.enabled, true, "…and cannot create it either");
  for (const p of ["waMaster", "waMaster.enabled"]) assert.equal(G.validatePatch([{ path: p, value: true }], {}).ok, false, p);
});

/* ══ الحالة ══════════════════════════════════════════════════════════════════ */
/* «مقروء + جاري الكتابة» (لمساعد الطلبات): مش رسالة، بس بتعدّي من نفس الحارس ونفس deliver — ومفيش «to» في جسم Graph */
test("typing indicator: only on the customer's own inbound message, under the same locks, window and test list as a free-form reply; the Graph body carries no «to»", withEnv(ALLOW, async () => {
  const w = world({ inbound: [CUST, STAFF] }); w.db.inboundIds = [`wamid.IN1|${CUST}`, `wamid.IN2|${STAFF}`];
  assert.deepEqual(await w.wa.sendTyping({ phoneNorm: CUST, wamid: "wamid.IN1" }), { ok: true });
  assert.deepEqual(w.calls.map((c) => [c.url.replace(/^.*\/v[\d.]+\//, ""), c.body]), [["PHONE1/messages", { messaging_product: "whatsapp", status: "read", message_id: "wamid.IN1", typing_indicator: { type: "text" } }]]);
  assert.equal(w.db.msgs.length, 0, "nothing is logged as an outgoing message");
  // not his message, an unknown message, no message id, a bad phone: refused before any network call
  for (const [a, why] of [[{ phoneNorm: CUST, wamid: "wamid.IN2" }, "not_his_message"], [{ phoneNorm: CUST, wamid: "wamid.NOPE" }, "not_his_message"], [{ phoneNorm: CUST, wamid: "" }, "no_message"], [{ phoneNorm: "123", wamid: "wamid.IN1" }, "invalid_phone"]])
    assert.equal((await w.wa.sendTyping(a)).skipped, why, why);
  // the customer wrote, but more than 24 hours ago (the guard's own window)
  const old = world({ inbound: [] }); old.db.inboundIds = [`wamid.IN1|${CUST}`];
  assert.equal((await old.wa.sendTyping({ phoneNorm: CUST, wamid: "wamid.IN1" })).skipped, "window_closed");
  // every lock of a customer send applies
  const off = world({ inbound: [CUST], settings: { waMaster: { enabled: false } } }); off.db.inboundIds = [`wamid.IN1|${CUST}`];
  assert.equal((await off.wa.sendTyping({ phoneNorm: CUST, wamid: "wamid.IN1" })).skipped, "master_off");
  assert.equal(w.calls.length, 1); assert.equal(old.calls.length + off.calls.length, 0);
  // test mode: the dashboard's test numbers only (a caller's list cannot widen it)
  assert.equal((await w.wa.sendTyping({ phoneNorm: CUST, wamid: "wamid.IN1", allowList: [CUST] })).skipped, "not_in_allow_list");
  assert.deepEqual(await w.wa.sendTyping({ phoneNorm: STAFF, wamid: "wamid.IN2", allowList: [STAFF] }), { ok: true });
  // deliver(): a receipt needs a session ticket for the same phone, like any message
  const g = await w.wa.guardSend({ phoneNorm: CUST, kind: "session" });
  await assert.rejects(w.wa.deliver(g.ticket, { messaging_product: "whatsapp", to: "966598765432", status: "read", message_id: "wamid.IN1", typing_indicator: { type: "text" } }), (e) => e.code === "WA_GUARD_MISMATCH");
  await assert.rejects(w.wa.deliver(null, { messaging_product: "whatsapp", to: "966512345678", status: "read", message_id: "wamid.IN1" }), (e) => e.code === "WA_NO_GUARD");
  assert.equal(w.calls.length, 2);
}));
test("typing indicator: the server kill switch stops it for test numbers too", withEnv({ ...CONFIGURED, WHATSAPP_ENABLED: "0" }, async () => {
  const w = world({ inbound: [STAFF] }); w.db.inboundIds = [`wamid.IN2|${STAFF}`];
  assert.equal((await w.wa.sendTyping({ phoneNorm: STAFF, wamid: "wamid.IN2", allowList: [STAFF] })).skipped, "disabled"); assert.equal(w.calls.length, 0);
}));
test("status: /api/wa/status names the closed lock without any secret", withEnv(ALLOW, async () => {
  const w = world({ settings: { waMaster: { enabled: false } } });
  const r = await w.app.routes["GET /api/wa/status"](fakeCtx());
  assert.equal(r.body.envState, "allow");
  assert.equal(r.body.dashMaster, false);
  assert.equal(r.body.blockedBy, "master_off");
  assert.equal(r.body.testPhones, 1);
  assert.doesNotMatch(JSON.stringify(r.body), /"tok"/);
}));


/* ══ فجوة بلّغ عنها مساعد الطلبات (١٣/١٠): تجربة النص الحر كانت بتعدّي الحارس بره نافذة الـ٢٤ ساعة ══ */
test("test sends: a free-form test message needs the 24-hour window like any other; a template test send does not", withEnv(CONFIGURED, async () => {
  const w = world({ settings: { waMaster: { enabled: false } } });
  assert.equal((await w.wa.guardSend({ phoneNorm: STAFF, kind: "session", test: true })).reason, "window_closed");
  assert.equal((await w.wa.sendFreeform({ phoneNorm: STAFF, payload: text(), allowList: [STAFF] })).skipped, "window_closed");
  assert.equal((await w.wa.guardSend({ phoneNorm: STAFF, kind: "template", template: "fc_order_preparing", test: true })).ok, true, "templates are what you send outside the window");
  assert.equal(w.calls.length, 0);
  w.db.inbound.push(STAFF);
  assert.equal((await w.wa.sendFreeform({ phoneNorm: STAFF, payload: text(), allowList: [STAFF] })).ok, true);
  assert.equal(w.calls.length, 1);
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "session", test: true })).reason, "not_in_allow_list", "the allow-list is still checked first");
}));

/* ══ TC (١٣/١٠) — القالب الخدمي: الطلب نفسه اتعمل تحت شروط بتذكر واتساب ════════════════════════════ */
const WC = await import("./waconsent.js");
const TV = WC.TERMS_CURRENT;

test("TC utility: sent for an order placed under terms that name WhatsApp updates — never about an old order, never without an order", withEnv(ALLOW, async () => {
  const w = world();
  w.db.terms = [{ order: "W-NEW", phone: CUST, version: TV }];
  const g = (a) => w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", ...a });
  assert.equal((await g({ orderNo: "W-NEW" })).ok, true);
  assert.equal((await g({ orderNo: "W-OLD" })).reason, "no_optin", "an order from before the new terms has no recorded acceptance");
  assert.equal((await g({})).reason, "no_optin", "no order = nothing to rest the consent on");
  assert.equal((await w.wa.guardSend({ phoneNorm: "598765432", kind: "template", template: "fc_order_preparing", orderNo: "W-NEW" })).reason, "no_optin",
    "the acceptance belongs to the phone that placed the order");
  w.db.terms.push({ order: "W-X", phone: CUST, version: "terms-2026-09-19" });
  assert.equal((await g({ orderNo: "W-X" })).reason, "no_optin", "a terms version that does not name WhatsApp does not count");
  // موافقة صريحة قديمة لسه بتعدّي من غير طلب
  const explicit = world({ optins: { [CUST]: { updates: true } } });
  assert.equal((await explicit.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing" })).ok, true);
}));

test("TC utility: «إيقاف» and an explicit «لا» win over the terms, even for a brand-new order", withEnv(ALLOW, async () => {
  const stopped = world({ optins: { [CUST]: { updates: false, marketing: false, stopped_at: "2026-10-13T08:00:00Z" } } });
  stopped.db.terms = [{ order: "W-NEW", phone: CUST, version: TV }];
  assert.equal((await stopped.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", orderNo: "W-NEW" })).reason, "opted_out");
  const saidNo = world({ optins: { [CUST]: { updates: false, answered_at: "2026-10-12T20:00:00Z" } } });
  saidNo.db.terms = [{ order: "W-NEW", phone: CUST, version: TV }];
  assert.equal((await saidNo.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", orderNo: "W-NEW" })).reason, "no_optin");
  assert.equal(stopped.calls.length + saidNo.calls.length, 0);
}));

test("TC: marketing does not depend on the terms record either way; a terms acceptance does not open free-form messages", withEnv(ALLOW, async () => {
  const marketingTpl = Object.keys(W.TEMPLATES).find((n) => W.TEMPLATES[n].category === "MARKETING");
  const w = world();
  w.db.terms = [{ order: "W-NEW", phone: CUST, version: TV }];
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: marketingTpl, orderNo: "W-NEW" })).ok, true);
  assert.equal((await w.wa.guardSend({ phoneNorm: "598765432", kind: "template", template: marketingTpl })).ok, true, "a customer from before the new terms (owner: offers go to everyone)");
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "session", orderNo: "W-NEW" })).reason, "window_closed");
}));

test("TC end to end: the order-status template goes out for the covered order with its order number, and not for the customer's older order", withEnv(ALLOW, async () => {
  const w = world();
  w.db.terms = [{ order: "W1790000000002", phone: CUST, version: TV }];
  const stage = Object.keys(W.STAGE_TEMPLATES)[0];
  const order = (no) => ({ order_no: no, phone_norm: CUST, option: "delivery", total: 80 });
  w.db.orders = [{ name: "أحمد", option: "delivery", total: 80, refund_id: null, table_no: null, order_no: "W1790000000002" }];
  const results = {};
  for (const st of Object.keys(W.STAGE_TEMPLATES)) {
    const r = await w.wa.sendOrderUpdate(order("W1790000000002"), st);
    if (r.ok) { results.sent = st; break; }
    assert.notEqual(r.skipped, "no_optin", `${st}: a covered order is never refused for consent`);
  }
  assert.ok(results.sent, "at least one wired stage sends for a covered order (first tried: " + stage + ")");
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].body.to, "966512345678");
  const before = w.calls.length;
  const old = await w.wa.sendOrderUpdate(order("W1780000000001"), results.sent);
  assert.equal(old.skipped, "no_optin");
  assert.equal(w.calls.length, before);
}));

/* ══ TC2 (١٣/١٠، قرار المالك): العروض للكل إلا اللي طلب إيقاف ═════════════════════════════════════════ */
test("TC2: «إيقاف» → the bot's two buttons still work with the new rule: «تحديثات طلبي فقط» brings order messages back and keeps offers off; «كل الرسائل والعروض» brings everything back", withEnv(ALLOW, async () => {
  const marketingTpl = Object.keys(W.TEMPLATES).find((n) => W.TEMPLATES[n].category === "MARKETING");
  const w = world();
  w.db.terms = [{ order: "W-NEW", phone: CUST, version: TV }];
  const util = () => w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", orderNo: "W-NEW" });
  const mkt = () => w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: marketingTpl });
  assert.equal((await util()).ok, true); assert.equal((await mkt()).ok, true, "before any stop: both go");
  await w.wa.applyIntent(CUST, "stop");
  assert.equal((await util()).reason, "opted_out"); assert.equal((await mkt()).reason, "opted_out", "«إيقاف» stops everything");
  // button «تحديثات طلبي فقط» (wabotrun: recordWaUpdatesBot yes ⇒ updates=true with a time after the stop)
  Object.assign(w.db.optins[CUST], { updates: true, answered_at: new Date(Date.now() + 1000).toISOString() });
  assert.equal((await util()).ok, true); assert.equal((await mkt()).reason, "opted_out", "order updates only");
  // button «كل الرسائل والعروض» (wabotrun: applyIntent start)
  await w.wa.applyIntent(CUST, "start");
  assert.equal((await util()).ok, true); assert.equal((await mkt()).ok, true);
  const bot = fs.readFileSync(path.join(HERE, "wabotrun.js"), "utf8");
  assert.ok(bot.includes('case "stop": return { body: T("stop"), buttons: [{ id: "resume:updates", title: T("btn_resume_updates") }, { id: "resume:all", title: T("btn_resume_all") }] };'), "the stop reply still carries the two buttons");
}));

test("TC2: an explicit refusal of offers is remembered on its own column (a fresh row is not a refusal), and nothing else about the locks moved", () => {
  const src = fs.readFileSync(path.join(HERE, "whatsapp.js"), "utf8");
  assert.ok(src.includes("ALTER TABLE wa_optins ADD COLUMN IF NOT EXISTS marketing_off_at TIMESTAMPTZ;"));
  assert.ok(src.includes("CASE WHEN $3 IS FALSE THEN NOW() END)"), "set when a new row is created with marketing:false");
  assert.ok(src.includes("marketing_off_at = CASE WHEN $3 IS FALSE THEN COALESCE(wa_optins.marketing_off_at, NOW()) WHEN $3 IS TRUE THEN NULL ELSE wa_optins.marketing_off_at END"), "kept on updates that say nothing about offers; cleared by a yes");
  assert.ok(src.includes("if (o.stopped || o.marketingOff || await marketingSuppressed(pn)) return no(\"opted_out\");"));
  assert.ok(!/if \(!o\.marketing\) return no\("no_optin"\)/.test(src), "no prior opt-in is asked for offers any more");
  for (const keep of ['if (envState() !== "allow") return "disabled";', 'if (!dashMasterOf(s)) return "master_off";', 'if (!testPhonesOf(s).includes(pn)) return no("not_in_allow_list");']) assert.ok(src.includes(keep), keep);
});
