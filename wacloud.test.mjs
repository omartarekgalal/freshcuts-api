/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات واتساب Cloud API — Coexistence (٢٨/٩)
     ١) الويب هوك: صدى الموبايل/جهات الاتصال/التاريخ/القوالب/فلتر الرقم
     ٢) ترتيب الحالات (read قبل delivered ماتبوظش)
     ٣) القوالب: قواعد ميتا + باراميترات الحملة لكل عميل + تنضيف القيم
     ٤) حدود قناة Cloud (يومي/ساعة/٢٥٠ في ٢٤ ساعة مع حجز الطلبات) وأكواد الأخطاء
     ٥) المعالجة: idempotent، الصدى من غير رد آلي، التاريخ من غير «غير مقروء» وبسقف
     ٦) الطابور: إرسال Cloud، حالات الويب هوك، فشل ⇒ سبب/بديل/إيقاف، الردود والإيقاف
     ٧) مساعد الربط: مقفول بالمفتاح، توكن النظام الأول، توكن البزنس احتياطي
   node --test wacloud.test.mjs
═══════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const W = await import("./whatsapp.js");
const C = await import("./wacloud.js");
const S = await import("./wasender.js");

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const AT_17 = Date.parse("2026-09-26T14:00:00Z"); // ٥ العصر الرياض (سبت)
const AT_03 = Date.parse("2026-09-26T00:00:00Z");

function fakeApp() {
  const routes = {};
  const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
}
function fakeCtx({ raw = "", headers = {}, query = {}, json = {}, params = {} } = {}) {
  return {
    req: { text: async () => raw, json: async () => json, header: (n) => headers[String(n).toLowerCase()],
      query: (n) => query[n], param: (n) => params[n] },
    json: (body, status = 200) => ({ body, status }),
    text: (body, status = 200) => ({ body, status }),
  };
}
const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN", "META_CAPI_TOKEN", "WHATSAPP_ONBOARD_WRITE", "WHATSAPP_HISTORY_MAX", "WHATSAPP_APP_ID", "WHATSAPP_BOT_ENABLED"];
function withEnv(vals, fn) {
  return async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, vals);
    try { await fn(); } finally {
      for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  };
}
const ON = { WHATSAPP_ENABLED: "1", META_CAPI_TOKEN: "systok", WHATSAPP_PHONE_ID: "1102069402989468",
  WHATSAPP_WABA_ID: "2047231412843417", WHATSAPP_APP_SECRET: "sec", WHATSAPP_VERIFY_TOKEN: "vt" };
const PID = "1102069402989468";
const BIZ = "966546715683";

const change = (field, value) => ({ object: "whatsapp_business_account",
  entry: [{ id: "2047231412843417", changes: [{ field, value: { messaging_product: "whatsapp",
    metadata: { display_phone_number: BIZ, phone_number_id: PID }, ...value } }] }] });

/* ══ ١) تفكيك الويب هوك ══════════════════════════════════════════════════ */
test("echo: message sent from the phone app parses as an outbound echo", () => {
  const p = W.parseWebhook(change("smb_message_echoes", { message_echoes: [
    { from: BIZ, to: "966512345678", id: "wamid.E1", timestamp: "1790000000", type: "text", text: { body: "تمام، طلبك جاهز" } },
    { from: BIZ, to: "966512345678", id: "wamid.E2", timestamp: "1790000001", type: "image", image: { caption: "" } },
  ] }));
  assert.equal(p.echoes.length, 2);
  assert.deepEqual({ ...p.echoes[0], at: undefined }, { wamid: "wamid.E1", from: BIZ, to: "966512345678", type: "text", text: "تمام، طلبك جاهز", at: undefined });
  assert.equal(p.echoes[1].text, "[صورة]");
  assert.equal(p.messages.length, 0, "echoes are never inbound");
});

test("state sync: contact add/remove with names", () => {
  const p = W.parseWebhook(change("smb_app_state_sync", { state_sync: [
    { type: "contact", contact: { full_name: "محمد العتيبي", first_name: "محمد", phone_number: "966512345678" }, action: "add", metadata: { timestamp: "1790000000" } },
    { type: "contact", contact: { phone_number: "966598765432" }, action: "remove", metadata: { timestamp: "1790000001" } },
    { type: "contact", contact: {}, action: "add" },
  ] }));
  assert.equal(p.contacts.length, 2);
  assert.equal(p.contacts[0].fullName, "محمد العتيبي");
  assert.equal(p.contacts[1].action, "remove");
});

test("history: direction from the business number, errors and progress captured", () => {
  const p = W.parseWebhook(change("history", { history: [
    { metadata: { phase: 0, chunk_order: 1, progress: 40 }, threads: [{ id: "966512345678", messages: [
      { from: "966512345678", id: "wamid.H1", timestamp: "1789990000", type: "text", text: { body: "السلام عليكم" }, history_context: { status: "READ" } },
      { from: BIZ, to: "966512345678", id: "wamid.H2", timestamp: "1789990100", type: "text", text: { body: "وعليكم السلام" }, history_context: { status: "DELIVERED" } },
    ] }] },
    { errors: [{ code: 2593109, title: "History sharing is turned off by the business" }] },
  ] }));
  assert.equal(p.history.length, 2);
  assert.equal(p.history[0].direction, "in");
  assert.equal(p.history[1].direction, "out");
  assert.equal(p.history[1].customer, "966512345678");
  assert.equal(p.history[1].status, "delivered");
  assert.equal(p.historyErrors[0].code, 2593109);
  assert.equal(p.historyMeta[0].progress, 40);
});

test("messages: quick-reply «إيقاف» and free-text opt-out are stop; reactions never are", () => {
  const p = W.parseWebhook(change("messages", {
    contacts: [{ wa_id: "966512345678", profile: { name: "Abu Fahad" } }],
    messages: [
      { from: "966512345678", id: "wamid.M1", timestamp: "1790000000", type: "button", button: { text: "إيقاف", payload: "إيقاف" } },
      { from: "966512345678", id: "wamid.M2", timestamp: "1790000001", type: "text", text: { body: "لا ترسلوا لي رسائل" } },
      { from: "966512345678", id: "wamid.M3", timestamp: "1790000002", type: "reaction", reaction: { emoji: "👍" } },
      { from: "966512345678", id: "wamid.M4", timestamp: "1790000003", type: "text", text: { body: "ممكن ايقاف الطلب؟" } },
    ] }));
  assert.deepEqual(p.messages.map((m) => m.intent), ["stop", "stop", null, null]);
  assert.equal(p.messages[2].text, "[تفاعل 👍]");
  assert.deepEqual(p.profiles, [{ waId: "966512345678", name: "Abu Fahad" }]);
});

test("template status + phone filter: other numbers on the same WABA are ignored", () => {
  const t = W.parseWebhook(change("message_template_status_update", { event: "APPROVED", message_template_name: "fc_offer_img", message_template_language: "ar", message_template_id: 123 }));
  assert.equal(t.templateEvents[0].event, "APPROVED");
  const other = change("messages", { messages: [{ from: "966512345678", id: "x", type: "text", text: { body: "hi" } }] });
  other.entry[0].changes[0].value.metadata.phone_number_id = "999";
  const p = W.parseWebhook(other, { phoneId: PID });
  assert.equal(p.messages.length, 0);
  assert.equal(p.fields[0].ignored, "other_phone");
  assert.equal(W.parseWebhook(other).messages.length, 1, "no filter when phone id unknown");
});

test("garbage in → empty, never throws", () => {
  for (const b of [null, {}, { entry: [{}] }, { entry: [{ changes: [{ value: { history: [{ threads: [{}] }] } }] }] }]) {
    const p = W.parseWebhook(b);
    assert.equal(p.messages.length + p.echoes.length + p.history.length, 0);
  }
});

/* ══ ٢) ترتيب الحالات ════════════════════════════════════════════════════ */
test("status ordering: late 'delivered' never overwrites 'read'; failed only before delivery", () => {
  assert.equal(W.nextStatus("accepted", "sent"), "sent");
  assert.equal(W.nextStatus("read", "delivered"), "read");
  assert.equal(W.nextStatus("delivered", "sent"), "delivered");
  assert.equal(W.nextStatus("sent", "failed"), "failed");
  assert.equal(W.nextStatus("read", "failed"), "read");
  assert.equal(W.nextStatus("failed", "delivered"), "delivered");
  assert.equal(W.nextStatus(null, "read"), "read");
});

/* ══ ٣) القوالب ══════════════════════════════════════════════════════════ */
test("Meta template rules: no variable at body start/end, URL variable only at the end with an example", () => {
  for (const [name, t] of Object.entries(W.TEMPLATES)) {
    if (t.category === "AUTHENTICATION") continue;
    const body = t.components.find((c) => c.type === "BODY").text;
    assert.doesNotMatch(body, /^\s*\{\{\d+\}\}/, `${name} starts with a variable`);
    assert.doesNotMatch(body, /\{\{\d+\}\}\s*[.!؟?]?\s*$/, `${name} ends with a variable`);
    const nums = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    assert.deepEqual(nums, nums.map((_, i) => i + 1), `${name} variables must be sequential`);
    for (const b of t.components.find((c) => c.type === "BUTTONS")?.buttons || []) {
      if (b.type !== "URL") continue;
      if (/\{\{/.test(b.url)) {
        assert.match(b.url, /^https:\/\/freshcuts\.sa\/[^{]*\{\{1\}\}$/, `${name} URL variable must be at the end`);
        assert.ok(Array.isArray(b.example) && b.example[0], `${name} URL example`);
      }
    }
  }
});

test("campaign templates: opt-out footer + «إيقاف» quick reply + tracked /l/ link; cart → /c/", () => {
  const camp = C.CAMPAIGN_TEMPLATES();
  assert.deepEqual(camp.sort(), ["fc_offer_img", "fc_winback"]);
  for (const n of [...camp, "fc_cart_reminder"]) {
    const t = W.TEMPLATES[n];
    assert.equal(t.components.find((c) => c.type === "FOOTER").text, "للإيقاف ردّ: إيقاف", n);
    const btns = t.components.find((c) => c.type === "BUTTONS").buttons;
    assert.ok(btns.some((b) => b.type === "QUICK_REPLY" && b.text === "إيقاف"), n);
  }
  assert.equal(W.TEMPLATES.fc_offer_img.components[0].format, "IMAGE");
  assert.match(W.TEMPLATES.fc_winback.components.find((c) => c.type === "BUTTONS").buttons[0].url, /\/l\/\{\{1\}\}$/);
  assert.match(W.TEMPLATES.fc_cart_reminder.components.find((c) => c.type === "BUTTONS").buttons[0].url, /\/c\/\{\{1\}\}$/);
  // مفيش قالب طلبات متكرر (fc_order_ready/fc_order_status موجودين بأسماء المراحل)
  assert.equal(Object.keys(W.TEMPLATES).filter((n) => /^fc_order_/.test(n)).length, 6);
  assert.ok(!W.TEMPLATES.fc_offer, "old fc_offer replaced by fc_offer_img");
});

test("params are cleaned: no newline/tab/4 spaces, never empty (Meta 132018)", () => {
  assert.equal(W.cleanParam("كفتة\nمشوية\t  جداً     "), "كفتة مشوية جداً");
  assert.equal(W.cleanParam(""), "-");
  assert.equal(W.cleanParam(null), "-");
  const p = W.buildTemplatePayload("fc_winback", "966512345678", { body: ["محمد\n", "", "W1ABC"], button: ["w1-abc123"] });
  assert.deepEqual(p.template.components[0].parameters.map((x) => x.text), ["محمد", "-", "W1ABC"]);
  assert.deepEqual(p.template.components[1], { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "w1-abc123" }] });
});

test("campaignParams: per-recipient link suffix = our /l/<slug>-<code> scheme", () => {
  const row = { vars: { name: "محمد العتيبي", first_name: "محمد", fav_dish: "كفتة مشوية" }, link_code: "a1b2c3", coupon: "W12K7Q2M" };
  const job = { link_slug: "w12", image_url: "https://freshcuts-api.o2m8.me/api/content/media/9.jpg", cloud_vars: { offer: "كيلو مشاوي بـ96" } };
  const a = C.campaignParams("fc_offer_img", row, job);
  assert.deepEqual(a.params.header, { image: job.image_url });
  assert.deepEqual(a.params.body, ["محمد", "كيلو مشاوي بـ96"]);
  assert.deepEqual(a.params.button, ["w12-a1b2c3"]);
  assert.match(a.text, /^أهلاً محمد 👋\nكيلو مشاوي بـ96\n/);
  const b = C.campaignParams("fc_winback", row, job);
  assert.deepEqual(b.params.body, ["محمد", "كفتة مشوية", "W12K7Q2M"]);
  const payload = W.buildTemplatePayload("fc_offer_img", "966512345678", a.params);
  assert.equal(payload.template.components[0].type, "header");
  assert.equal(payload.template.components[2].parameters[0].text, "w12-a1b2c3");
  // من غير اسم ⇒ «عميلنا»، من غير طبق ⇒ نص محايد
  assert.deepEqual(C.campaignParams("fc_winback", { vars: {}, link_code: "x", coupon: "C" }, job).params.body, ["عميلنا", "أكلتك المفضّلة", "C"]);
});

test("cloud job validation", () => {
  const base = { cloudTemplate: "fc_offer_img", cloudVars: { offer: "كيلو بـ96" }, imageUrl: "https://x/y.jpg", offer: null, link: {} };
  assert.equal(C.cloudJobProblem(base), null);
  assert.equal(C.cloudJobProblem({ ...base, cloudTemplate: "fc_order_delivered" })[0], "bad_template");
  assert.equal(C.cloudJobProblem({ ...base, imageUrl: null })[0], "image_required");
  assert.equal(C.cloudJobProblem({ ...base, cloudVars: { offer: "" } })[0], "offer_line_required");
  assert.equal(C.cloudJobProblem({ ...base, cloudVars: { offer: "a\nb" } })[0], "offer_line_newline");
  assert.equal(C.cloudJobProblem({ ...base, cloudTemplate: "fc_winback" })[0], "coupon_required");
  assert.equal(C.cloudJobProblem({ ...base, cloudTemplate: "fc_winback", link: { coupon: "BACK" } }), null);
  assert.equal(C.cloudJobProblem({ ...base, cloudTemplate: "fc_winback", offer: { oneTime: true } }), null);
  // jobInput: القناة بتتحفظ والغلط بيطلع
  const hosts = ["freshcuts-api.o2m8.me"];
  const ok = S.jobInput({ template: "", channel: "wa_cloud", cloudTemplate: "fc_offer_img", cloudVars: { offer: "عرض" },
    imageUrl: "https://freshcuts-api.o2m8.me/api/content/media/1.jpg", fallback: "wa_web" }, { hosts });
  assert.deepEqual(ok.errs, []);
  assert.equal(ok.channel, "wa_cloud"); assert.equal(ok.fallback, "wa_web");
  assert.equal(S.jobInput({ channel: "wa_cloud", cloudTemplate: "fc_offer_img" }, { hosts }).errs[0][0], "image_required");
  const web = S.jobInput({ fallback: "sms" }, { hosts });
  assert.equal(web.channel, "wa_web"); assert.equal(web.fallback, "none");
});

/* ══ ٤) الحدود والأخطاء ══════════════════════════════════════════════════ */
test("cloud pacing: caps, the 250/24h unverified limit with a reserve for order updates", () => {
  const cc = C.cloudCfg({ waCloud: { enabled: true, dailyCap: 150, hourCap: 60, perTick: 5, tierLimit: 250, reserveUtility: 50 } });
  const idle = { today: 0, lastHour: 0, uniq24h: 0 };
  assert.equal(C.cloudPacing(C.cloudCfg({}), idle, true).reason, "disabled");
  assert.equal(C.cloudPacing(cc, idle, false).reason, "outside_hours");
  assert.equal(C.cloudPacing(cc, { ...idle, stoppedReason: "payment_issue" }, true).reason, "stopped");
  assert.equal(C.cloudPacing(cc, { ...idle, today: 150 }, true).reason, "daily_cap");
  assert.equal(C.cloudPacing(cc, { ...idle, lastHour: 60 }, true).reason, "hour_cap");
  assert.equal(C.cloudPacing(cc, { ...idle, uniq24h: 200 }, true).reason, "tier_limit");
  assert.equal(C.cloudPacing(cc, { ...idle, uniq24h: 198 }, true).allow, 2);
  assert.equal(C.cloudPacing(cc, { ...idle, today: 148 }, true).allow, 2);
  assert.equal(C.cloudPacing(cc, idle, true).allow, 5);
  // الحجز مايعدّيش الحد نفسه، والأرقام الغلط بتتظبط
  const odd = C.cloudCfg({ waCloud: { tierLimit: 100, reserveUtility: 500, perTick: 999, configId: "abc" } });
  assert.equal(odd.reserveUtility, 100); assert.equal(odd.perTick, 50); assert.equal(odd.configId, C.DEFAULT_CONFIG_ID);
  assert.equal(C.DEFAULT_CONFIG_ID, "1100099832721217");
});

test("Meta error codes → reason / stop / retry / invalid / fallback", () => {
  assert.equal(C.classifyError(131049).reason, "meta_marketing_limit");
  assert.equal(C.classifyError(131026).invalid, true);
  assert.equal(C.classifyError(131050).optout, true);
  assert.equal(C.classifyError(132001).stop, true);
  assert.equal(C.classifyError(131042).stop, true);
  assert.equal(C.classifyError(130429).retry, true);
  assert.equal(C.classifyError(987654).reason, "meta_987654");
  assert.equal(C.classifyError(null).reason, "send_failed");
  assert.equal(C.fallbackFor(C.classifyError(131049), "wa_web"), "wa_web");
  assert.equal(C.fallbackFor(C.classifyError(131026), "wa_web"), null, "not on WhatsApp ⇒ WA Web can't help");
  assert.equal(C.fallbackFor(C.classifyError(131026), "sms"), "sms");
  assert.equal(C.fallbackFor(C.classifyError(131050), "sms"), null, "customer opted out ⇒ no SMS either");
  assert.equal(C.fallbackFor(C.classifyError(131049), "none"), null);
});

test("default channel: cloud only when gate is open and the number is CONNECTED", () => {
  assert.equal(C.defaultChannel({ gate: null, phoneStatus: "CONNECTED" }), "wa_cloud");
  assert.equal(C.defaultChannel({ gate: null, phoneStatus: "DISCONNECTED" }), "wa_web");
  assert.equal(C.defaultChannel({ gate: "disabled", phoneStatus: "CONNECTED" }), "wa_web");
});

/* ══ ٥) المعالجة (whatsapp.js + wainbox.js مع بعض) ═══════════════════════ */
function waPool() {
  const db = { msgs: [], threads: {}, names: {}, health: {}, hist: { imported: 0, skipped: 0, chunks: 0 }, optins: {}, contacts: {}, tplEvents: [] };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE|^CREATE INDEX|^ALTER TABLE/i.test(s)) return { rows: [] };
    if (/^INSERT INTO wa_messages/i.test(s)) {
      if (db.msgs.some((m) => m.wamid && m.wamid === p[0])) return { rows: [], rowCount: 0 };
      let m;
      if (/source, msg_type, created_at\) VALUES \(\$1,'out',\$2,'sent'/.test(s)) m = { wamid: p[0], direction: "out", phone_norm: p[1], status: "sent", body: p[2], source: "echo", created_at: p[4] };
      else if (/'history'/.test(s)) m = { wamid: p[0], direction: p[1], phone_norm: p[2], status: p[3], body: p[4], source: "history", created_at: p[6] };
      else if (/'in'/.test(s)) m = { wamid: p[0], direction: "in", phone_norm: p[1], status: "received", body: p[2], source: "api" };
      else m = { wamid: p[0], direction: "out", phone_norm: p[1], template: p[2], status: p[6], body: p[8], source: p[10] };
      db.msgs.push(m);
      return { rows: [{ id: db.msgs.length }], rowCount: 1 };
    }
    if (/^UPDATE wa_messages SET status/i.test(s)) {
      const m = db.msgs.find((x) => x.wamid === p[0]);
      if (!m) return { rows: [], rowCount: 0 };
      m.status = W.nextStatus(m.status, p[1]);
      return { rows: [{ id: 1, ...m }], rowCount: 1 };
    }
    if (/^INSERT INTO wa_threads/i.test(s)) {
      const [pn, inbound, at, text, dir, , silent] = p;
      const when = at || new Date().toISOString();
      const cur = db.threads[pn] || { unread: 0, last_at: "1970-01-01T00:00:00.000Z" };
      const newer = when >= cur.last_at;
      db.threads[pn] = { ...cur, last_at: newer ? when : cur.last_at, last_text: newer ? text : cur.last_text,
        last_in_at: inbound ? (cur.last_in_at && cur.last_in_at > when ? cur.last_in_at : when) : cur.last_in_at,
        unread: silent ? cur.unread : inbound ? cur.unread + 1 : 0 };
      return { rows: [] };
    }
    if (/^INSERT INTO wa_contact_names\(phone_norm, full_name/i.test(s)) { db.names[p[0]] = { full: p[1], first: p[2], removed: p[3] }; return { rows: [] }; }
    if (/^INSERT INTO wa_contact_names\(phone_norm, profile_name/i.test(s)) { db.names[p[0]] = { ...(db.names[p[0]] || {}), profile: p[1] }; return { rows: [] }; }
    if (/^INSERT INTO wa_webhook_health/i.test(s)) { db.health[p[0] || "_bad_signature"] = (db.health[p[0] || "_bad_signature"] || 0) + 1; return { rows: [] }; }
    if (/SELECT imported FROM wa_history_state/i.test(s)) return { rows: [{ imported: db.hist.imported }] };
    if (/^UPDATE wa_history_state/i.test(s)) { db.hist.imported += p[0]; db.hist.skipped += p[1]; db.hist.chunks++; db.hist.errors = p[3]; return { rows: [] }; }
    if (/^INSERT INTO wa_template_events/i.test(s)) { db.tplEvents.push(p); return { rows: [] }; }
    if (/FROM wa_optins WHERE/i.test(s)) return { rows: db.optins[p[0]] ? [db.optins[p[0]]] : [] };
    if (/^INSERT INTO wa_optins/i.test(s)) { db.optins[p[0]] = { updates: p[1] ?? false, marketing: p[2] ?? false, source: p[3] }; return { rows: [] }; }
    if (/^UPDATE cms_contacts/i.test(s)) { db.contacts[p[0]] = "out"; return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  } };
  return pool;
}
async function setupWa({ fetch, notifications = { whatsappEnabled: true } } = {}) {
  const WI = await import("./wainbox.js");
  const pool = waPool();
  const app = fakeApp();
  const calls = [];
  const f = fetch || (async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.OUT" }] }) }; });
  const api = W.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => ({ notifications }),
    jb: (x) => JSON.stringify(x), normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") }, { fetch: f, sendSms: async () => ({}) });
  const inbox = WI.register({ pool, getSettingsData: async () => ({ notifications }) }, { wa: api });
  api.setInbox(inbox);
  await api.ready;
  return { app, api, pool, calls };
}

test("duplicate webhook delivery: one message, unread +1 once, hooks fire once", withEnv(ON, async () => {
  const { api, pool } = await setupWa();
  const seen = [];
  api.on("inbound", (m) => seen.push(m.wamid));
  const body = change("messages", { messages: [{ from: "966512345678", id: "wamid.IN1", timestamp: "1790000000", type: "text", text: { body: "عندكم مشاوي؟" } }] });
  await api.processWebhook(body);
  await api.processWebhook(body);
  assert.equal(pool.db.msgs.filter((m) => m.wamid === "wamid.IN1").length, 1);
  assert.equal(pool.db.threads["512345678"].unread, 1);
  assert.deepEqual(seen, ["wamid.IN1"]);
  assert.equal(pool.db.health.messages, 2);
}));

test("phone echo: stored as outbound in the same thread, clears unread, and NEVER triggers the auto-reply", withEnv(ON, async () => {
  const { api, pool, calls } = await setupWa({ notifications: { whatsappEnabled: true, whatsappAutoReply: true } });
  await api.processWebhook(change("messages", { messages: [{ from: "966512345678", id: "wamid.IN2", timestamp: "1790000000", type: "text", text: { body: "مرحبا" } }] }));
  const autoReplies = calls.length;           // الرد الآلي على الوارد (المفتاح مفتوح في الاختبار ده)
  const ts = String(Math.floor(Date.now() / 1000) + 5);
  await api.processWebhook(change("smb_message_echoes", { message_echoes: [
    { from: BIZ, to: "966512345678", id: "wamid.ECHO1", timestamp: ts, type: "text", text: { body: "أهلاً، تفضل" } }] }));
  await api.processWebhook(change("smb_message_echoes", { message_echoes: [
    { from: BIZ, to: "966512345678", id: "wamid.ECHO1", timestamp: ts, type: "text", text: { body: "أهلاً، تفضل" } }] }));
  assert.equal(calls.length, autoReplies, "echo must not cause any Graph call");
  const echo = pool.db.msgs.filter((m) => m.wamid === "wamid.ECHO1");
  assert.equal(echo.length, 1);
  assert.equal(echo[0].direction, "out"); assert.equal(echo[0].source, "echo");
  assert.equal(pool.db.threads["512345678"].unread, 0);
  assert.equal(pool.db.threads["512345678"].last_text, "أهلاً، تفضل");
}));

test("history: imported silently (no unread), idempotent, capped", withEnv({ ...ON, WHATSAPP_HISTORY_MAX: "3" }, async () => {
  const { api, pool } = await setupWa();
  const msgs = [1, 2, 3, 4].map((i) => ({ from: i % 2 ? "966512345678" : BIZ, to: i % 2 ? BIZ : "966512345678", id: `wamid.H${i}`,
    timestamp: String(1780000000 + i), type: "text", text: { body: `رسالة ${i}` } }));
  const body = change("history", { history: [{ metadata: { phase: 1, chunk_order: 1, progress: 100 }, threads: [{ id: "966512345678", messages: msgs }] }] });
  await api.processWebhook(body);
  await api.processWebhook(body);
  const hist = pool.db.msgs.filter((m) => m.source === "history");
  assert.equal(hist.length, 3, "cap = 3");
  assert.equal(pool.db.threads["512345678"].unread, 0, "old messages never raise unread");
  assert.equal(pool.db.hist.imported, 3);
  assert.deepEqual(hist.map((m) => m.direction), ["in", "out", "in"]);
}));

test("history: a recent «إيقاف» in the past opts out; history-sharing-off error is recorded", withEnv(ON, async () => {
  const { api, pool } = await setupWa();
  const ts = String(Math.floor(Date.now() / 1000) - 3600);
  await api.processWebhook(change("history", { history: [
    { threads: [{ id: "966598765432", messages: [{ from: "966598765432", id: "wamid.HS", timestamp: ts, type: "text", text: { body: "إيقاف" } }] }] },
    { errors: [{ code: 2593109, title: "History sharing is turned off by the business" }] }] }));
  assert.equal(pool.db.optins["598765432"]?.marketing, false);
  assert.match(pool.db.hist.errors, /2593109/);
}));

test("contacts sync + profile names land in wa_contact_names; template events logged", withEnv(ON, async () => {
  const { api, pool } = await setupWa();
  await api.processWebhook(change("smb_app_state_sync", { state_sync: [
    { type: "contact", contact: { full_name: "محمد العتيبي", first_name: "محمد", phone_number: "966512345678" }, action: "add", metadata: { timestamp: "1790000000" } }] }));
  await api.processWebhook(change("messages", { contacts: [{ wa_id: "966598765432", profile: { name: "Sara" } }], messages: [] }));
  await api.processWebhook(change("message_template_status_update", { event: "REJECTED", message_template_name: "fc_winback", reason: "INCORRECT_CATEGORY" }));
  assert.equal(pool.db.names["512345678"].full, "محمد العتيبي");
  assert.equal(pool.db.names["598765432"].profile, "Sara");
  assert.equal(pool.db.tplEvents[0][3], "REJECTED");
}));

test("webhook route: bad signature → 200 ignored (logged), good signature → processed async", withEnv(ON, async () => {
  const { app, pool } = await setupWa();
  const raw = JSON.stringify(change("messages", { messages: [{ from: "966512345678", id: "wamid.SIG", timestamp: "1790000000", type: "text", text: { body: "hi" } }] }));
  const bad = await app.routes["POST /api/wa/webhook"](fakeCtx({ raw, headers: { "x-hub-signature-256": "sha256=00" } }));
  assert.equal(bad.status, 200); assert.equal(bad.body.ignored, "signature");
  await flush();
  assert.equal(pool.db.msgs.length, 0);
  const sig = "sha256=" + crypto.createHmac("sha256", "sec").update(raw, "utf8").digest("hex");
  const good = await app.routes["POST /api/wa/webhook"](fakeCtx({ raw, headers: { "x-hub-signature-256": sig } }));
  assert.equal(good.status, 200); assert.equal(good.body.ok, true);
  await flush();
  assert.equal(pool.db.msgs.length, 1);
  const v = await app.routes["GET /api/wa/webhook"](fakeCtx({ query: { "hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "42" } }));
  assert.deepEqual(v, { body: "42", status: 200 });
}));

test("campaign send logs the rendered template text (inbox shows what the customer saw)", withEnv(ON, async () => {
  const { api, pool, calls } = await setupWa();
  const { params, text } = C.campaignParams("fc_winback", { vars: { first_name: "محمد", fav_dish: "كفتة" }, link_code: "abc123", coupon: "W1X" }, { link_slug: "w1" });
  const r = await api.sendTemplate({ phoneNorm: "512345678", template: "fc_winback", params, requireOptIn: false, source: "campaign", body: text });
  assert.equal(r.ok, true);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.template.name, "fc_winback");
  assert.equal(calls[0].init.headers.Authorization, "Bearer systok", "permanent system-user token by default");
  const m = pool.db.msgs.find((x) => x.wamid === "wamid.OUT");
  assert.equal(m.source, "campaign");
  assert.match(m.body, /آخر مرة طلبت كفتة/);
}));

/* ══ ٦) الطابور على قناة Cloud (wasender) ════════════════════════════════ */
function senderPool({ jobs, queue, optedOut = [], invalid = [], recent = [] }) {
  const db = { jobs, queue, contactLog: [], invalid: new Set(invalid), state: { 1: {}, 2: {} }, replies: [], optouts: [], coupons: [] };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    const job = (id) => db.jobs.find((j) => j.id === Number(id));
    const qrow = (id) => db.queue.find((q) => q.id === Number(id));
    if (/^CREATE TABLE|^ALTER TABLE|^CREATE INDEX|^INSERT INTO wa_sender_state\(id\)/i.test(s)) return { rows: [] };
    if (/^SELECT \* FROM wa_sender_state WHERE id=\$1/i.test(s)) return { rows: [{ stopped_reason: db.state[p[0]].stopped_reason || null }] };
    if (/FROM wa_send_queue WHERE status='sent' AND sent_at > NOW\(\) - INTERVAL '2 days'/i.test(s)) {
      const n = db.queue.filter((q) => q.status === "sent" && (q.channel || "wa_web") === p[0]).length;
      return { rows: [{ today: n, last_hour: n }] };
    }
    if (/count\(DISTINCT phone_norm\)::int AS n FROM wa_messages/i.test(s)) return { rows: [{ n: db.uniq || 0 }] };
    if (/^UPDATE wa_send_queue SET status='pending' WHERE status='sending'/i.test(s)) return { rows: [] };
    if (/^UPDATE wa_send_queue SET status='sending'/i.test(s)) {
      const ch = /'wa_cloud'/.test(s) ? "wa_cloud" : "wa_web";
      const q = db.queue.find((x) => x.status === "pending" && job(x.job_id).status === "running" && (x.channel || job(x.job_id).channel || "wa_web") === ch);
      if (!q) return { rows: [] };
      Object.assign(q, { status: "sending", channel: ch, attempts: (q.attempts || 0) + 1 });
      return { rows: [{ ...q }] };
    }
    if (/^UPDATE wa_send_jobs j SET status='done'/i.test(s)) return { rows: [] };
    if (/^SELECT id, cloud_template/i.test(s)) return { rows: [job(p[0])] };
    if (/^SELECT id, fallback FROM wa_send_jobs/i.test(s)) return { rows: [job(p[0])] };
    if (/^SELECT offer FROM wa_send_jobs/i.test(s)) return { rows: [job(p[0])] };
    if (/FROM cms_contacts WHERE phone_norm=\$1 AND opted_out_at/i.test(s)) return { rowCount: optedOut.includes(p[0]) || db.optouts.includes(p[0]) ? 1 : 0, rows: [] };
    if (/FROM wa_invalid_numbers WHERE phone_norm = ANY/i.test(s)) return { rows: p[0].filter((x) => db.invalid.has(x)).map((x) => ({ phone_norm: x })) };
    if (/FROM wa_contact_log WHERE phone_norm = ANY/i.test(s)) return { rows: p[0].filter((x) => recent.includes(x) || db.contactLog.some((l) => l.pn === x)).map((x) => ({ pn: x })) };
    if (/sms_ad_blocked|cms_campaign_sends|cms_flow_log|sms_log/i.test(s)) throw Object.assign(new Error("missing"), { code: "42P01" });
    if (/FROM shop_orders/i.test(s)) return { rows: [] };
    if (/^UPDATE wa_send_queue SET status='sent'/i.test(s)) { Object.assign(qrow(p[0]), { status: "sent", channel: p[3], wamid: p[4], cloud_status: p[4] ? "accepted" : null }); return { rows: [] }; }
    if (/^INSERT INTO wa_contact_log/i.test(s)) { db.contactLog.push({ pn: p[0], job: p[1], by: p[2] ?? (/'sms_fallback'/.test(s) ? "sms_fallback" : null) }); return { rows: [] }; }
    if (/^DELETE FROM wa_contact_log/i.test(s)) { db.contactLog = db.contactLog.filter((l) => !(l.pn === p[0] && l.job === p[1] && l.by === "cloud")); return { rows: [] }; }
    if (/^UPDATE wa_sender_state SET stopped_reason=\$1/i.test(s)) { db.state[2].stopped_reason = p[0]; return { rows: [] }; }
    if (/^UPDATE wa_sender_state/i.test(s)) return { rows: [] };
    if (/^UPDATE wa_send_queue SET status='failed', reason=\$2, error_code=\$3, cloud_status='failed'/i.test(s)) { Object.assign(qrow(p[0]), { status: "failed", reason: p[1], error_code: p[2], cloud_status: "failed" }); return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='pending', channel='wa_web'/i.test(s)) { const q = qrow(p[0]); if (q.status === "failed") Object.assign(q, { status: "pending", channel: "wa_web", reason: null, fallback_from: p[1] }); return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='pending', reason=\$2/i.test(s)) { Object.assign(qrow(p[0]), { status: "pending", reason: p[1] }); return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='pending', attempts/i.test(s)) { Object.assign(qrow(p[0]), { status: "pending" }); return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='skipped', reason=\$2 WHERE id/i.test(s)) { Object.assign(qrow(p[0]), { status: "skipped", reason: p[1] }); return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='skipped', reason='opted_out' WHERE phone_norm/i.test(s)) { for (const q of db.queue) if (q.phone_norm === p[0] && q.status === "pending") Object.assign(q, { status: "skipped", reason: "opted_out" }); return { rows: [] }; }
    if (/^INSERT INTO wa_invalid_numbers/i.test(s)) { db.invalid.add(p[0]); return { rows: [] }; }
    if (/^UPDATE shop_coupons SET active=false/i.test(s)) { db.coupons.push(["off", p[0]]); return { rows: [] }; }
    if (/^UPDATE shop_coupons SET active=true/i.test(s)) { db.coupons.push(["on", p[0]]); return { rows: [] }; }
    if (/^SELECT id, job_id, phone_norm, status, cloud_status/i.test(s)) { const q = db.queue.find((x) => x.wamid === p[0]); return { rows: q ? [{ ...q }] : [] }; }
    if (/^UPDATE wa_send_queue SET cloud_status=\$2/i.test(s)) { Object.assign(qrow(p[0]), { cloud_status: p[1], ...(p[1] === "read" ? { read: true } : {}) }); return { rows: [] }; }
    if (/^SELECT id, job_id FROM wa_send_queue WHERE phone_norm=\$1 AND status='sent'/i.test(s)) {
      const q = db.queue.filter((x) => x.phone_norm === p[0] && x.status === "sent").pop(); return { rows: q ? [q] : [] };
    }
    if (/^SELECT 1 FROM wa_replies/i.test(s)) return { rowCount: db.replies.some((r) => r.pn === p[0] && r.text === p[1]) ? 1 : 0, rows: [] };
    if (/^INSERT INTO wa_replies/i.test(s)) {
      if (db.replies.some((r) => r.pn === p[0] && r.ext === p[2])) return { rowCount: 0, rows: [] };
      db.replies.push({ pn: p[0], text: p[1], ext: p[2], optout: p[5] }); return { rowCount: 1, rows: [{ id: 1 }] };
    }
    if (/^UPDATE wa_send_queue SET replied_at/i.test(s)) { qrow(p[0]).replied = true; return { rows: [] }; }
    if (/^INSERT INTO cms_contacts/i.test(s)) return { rows: [] };
    if (/^UPDATE cms_contacts SET opted_out_at/i.test(s)) { db.optouts.push(p[0]); return { rows: [{ phone_norm: p[0] }], rowCount: 1 }; }
    if (/^UPDATE wa_send_queue SET optout_at/i.test(s)) return { rows: [] };
    if (/^UPDATE wa_send_queue SET note=\$2, fallback_from=\$3/i.test(s)) { Object.assign(qrow(p[0]), { note: p[1], fallback_from: p[2] }); return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  } };
  return pool;
}
function fakeWa(script = []) {
  const hooks = { status: [], inbound: [] };
  const sent = [];
  let i = 0;
  return { sent, hooks, gate: async () => null, on: (ev, fn) => hooks[ev].push(fn),
    async sendTemplate(a) { sent.push(a); const r = script[i++] || { ok: true, wamid: `wamid.C${i}` }; return r; } };
}
const cloudJob = (x = {}) => ({ id: 1, status: "running", channel: "wa_cloud", cloud_template: "fc_offer_img",
  cloud_vars: { offer: "كيلو بـ96" }, image_url: "https://freshcuts-api.o2m8.me/api/content/media/1.jpg", link_slug: "w1", offer: null, fallback: "none", ...x });
const qr = (id, pn, x = {}) => ({ id, job_id: 1, phone_norm: pn, status: "pending", channel: null, name: "محمد", vars: { first_name: "محمد" }, link_code: `c${id}xxxx`.slice(0, 6), coupon: null, message: "أهلاً محمد\n\nلو ما تبي رسايلنا ردّ بكلمة: إيقاف", attempts: 0, ...x });
function setupSender({ pool, wa, waCloud = { enabled: true, perTick: 5 }, cms = null }) {
  const app = fakeApp();
  const api = S.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => ({ waCloud, waSender: {} }) },
    { wa, cloudLoop: false, lock: false, now: () => AT_17, cms: () => cms });
  return { app, api };
}

test("cloud tick: sends the right template per row, skips opted-out/recent/invalid, respects perTick", async () => {
  const pool = senderPool({ jobs: [cloudJob()], queue: [qr(1, "511111111"), qr(2, "522222222"), qr(3, "533333333"), qr(4, "544444444"), qr(5, "555555555"), qr(6, "566666666")],
    optedOut: ["522222222"], recent: ["533333333"], invalid: ["544444444"] });
  const wa = fakeWa();
  const { api } = setupSender({ pool, wa, waCloud: { enabled: true, perTick: 2 } });
  await api.schemaReady;
  const r = await api.cloudTick();
  assert.equal(r.sent, 2);
  assert.deepEqual(pool.db.queue.map((q) => q.status), ["sent", "skipped", "skipped", "skipped", "sent", "pending"]);
  assert.deepEqual(pool.db.queue.slice(1, 4).map((q) => q.reason), ["opted_out", "gap_3d", "invalid_number"]);
  assert.equal(wa.sent[0].template, "fc_offer_img");
  assert.equal(wa.sent[0].requireOptIn, false);
  assert.deepEqual(wa.sent[0].params.button, ["w1-c1xxxx"]);
  assert.equal(pool.db.queue[0].wamid, "wamid.C1");
  assert.equal(pool.db.contactLog.filter((l) => l.by === "cloud").length, 2, "3-day rule sees cloud sends");
});

test("cloud tick: wa_web rows are left for the extension; outside hours / disabled send nothing", async () => {
  const pool = senderPool({ jobs: [cloudJob({ channel: "wa_web" })], queue: [qr(1, "511111111")] });
  const wa = fakeWa();
  const { api } = setupSender({ pool, wa });
  await api.schemaReady;
  await api.cloudTick();
  assert.equal(wa.sent.length, 0);
  assert.equal(pool.db.queue[0].status, "pending");
  const off = setupSender({ pool: senderPool({ jobs: [cloudJob()], queue: [qr(1, "511111111")] }), wa, waCloud: { enabled: false } });
  assert.equal((await off.api.cloudTick()).reason, "disabled");
});

test("statuses from the webhook update the queue row; out-of-order read stays read", async () => {
  const pool = senderPool({ jobs: [cloudJob()], queue: [qr(1, "511111111")] });
  const wa = fakeWa();
  const { api } = setupSender({ pool, wa });
  await api.schemaReady;
  await api.cloudTick();
  await api.onCloudStatus({ wamid: "wamid.C1", status: "read", at: "2026-09-26T14:01:00Z" });
  await api.onCloudStatus({ wamid: "wamid.C1", status: "delivered", at: "2026-09-26T14:00:30Z" });
  assert.equal(pool.db.queue[0].cloud_status, "read");
  assert.equal(pool.db.queue[0].status, "sent");
  assert.equal(wa.hooks.status.length, 1, "wasender subscribed to whatsapp.js status hook");
});

test("async failure 131049 + fallback wa_web → row goes back to the extension, contact log released, coupon closed", async () => {
  const pool = senderPool({ jobs: [cloudJob({ fallback: "wa_web" })], queue: [qr(1, "511111111", { coupon: "W1ABCDE" })] });
  const wa = fakeWa();
  const { api } = setupSender({ pool, wa });
  await api.schemaReady;
  await api.cloudTick();
  await api.onCloudStatus({ wamid: "wamid.C1", status: "failed", code: 131049 });
  const q = pool.db.queue[0];
  assert.equal(q.status, "pending"); assert.equal(q.channel, "wa_web");
  assert.equal(q.fallback_from, "wa_cloud:meta_marketing_limit");
  assert.equal(pool.db.contactLog.length, 0);
  assert.deepEqual(pool.db.coupons.at(-1), ["off", "W1ABCDE"]);
});

test("async failure 131026 → invalid number, no WA Web fallback; SMS fallback when chosen", async () => {
  const pool = senderPool({ jobs: [cloudJob({ fallback: "sms" })], queue: [qr(1, "511111111")] });
  const wa = fakeWa();
  const smsCalls = [];
  const cms = { waFallbackSms: async (a) => { smsCalls.push(a); return { ok: true }; } };
  const { api } = setupSender({ pool, wa, cms });
  await api.schemaReady;
  await api.cloudTick();
  await api.onCloudStatus({ wamid: "wamid.C1", status: "failed", code: 131026 });
  assert.equal(pool.db.queue[0].status, "failed");
  assert.equal(pool.db.queue[0].reason, "undeliverable");
  assert.ok(pool.db.invalid.has("511111111"));
  assert.equal(smsCalls.length, 1);
  assert.equal(smsCalls[0].text, "أهلاً محمد", "WhatsApp opt-out footer stripped for SMS");
  assert.equal(pool.db.contactLog.at(-1).by, "sms_fallback", "the SMS counts for the 3-day rule");
});

test("sync errors: config error stops the channel; rate limit retries; 131050 opts out", async () => {
  const pool = senderPool({ jobs: [cloudJob()], queue: [qr(1, "511111111"), qr(2, "522222222"), qr(3, "533333333")] });
  const wa = fakeWa([{ ok: false, error: "WA_130429", code: 130429 }]);
  const { api } = setupSender({ pool, wa });
  await api.schemaReady;
  const r1 = await api.cloudTick();
  assert.equal(r1.reason, "rate_limited");
  assert.equal(pool.db.queue[0].status, "pending", "retry → back to queue");

  const pool2 = senderPool({ jobs: [cloudJob()], queue: [qr(1, "511111111"), qr(2, "522222222")] });
  const wa2 = fakeWa([{ ok: false, error: "WA_132001", code: 132001 }]);
  const s2 = setupSender({ pool: pool2, wa: wa2 });
  await s2.api.schemaReady;
  const r2 = await s2.api.cloudTick();
  assert.equal(r2.stopped, true);
  assert.equal(pool2.db.state[2].stopped_reason, "template_missing");
  assert.equal(pool2.db.queue[1].status, "pending", "nothing else sent after a stop");
  assert.equal(C.cloudPacing(C.cloudCfg({ waCloud: { enabled: true } }), { stoppedReason: "template_missing" }, true).reason, "stopped");

  const pool3 = senderPool({ jobs: [cloudJob()], queue: [qr(1, "511111111")] });
  const s3 = setupSender({ pool: pool3, wa: fakeWa([{ ok: false, error: "WA_131050", code: 131050 }]) });
  await s3.api.schemaReady;
  await s3.api.cloudTick();
  assert.ok(pool3.db.optouts.includes("511111111"));
});

test("cloud replies land in the replies table once; «إيقاف» opts out and clears pending rows", async () => {
  const pool = senderPool({ jobs: [cloudJob()], queue: [qr(1, "511111111"), qr(2, "511111111", { job_id: 1, status: "pending" })] });
  pool.db.queue[1].id = 2;
  const wa = fakeWa();
  const { api } = setupSender({ pool, wa, waCloud: { enabled: true, perTick: 1 } });
  await api.schemaReady;
  await api.cloudTick();
  await api.onCloudInbound({ phoneNorm: "511111111", wamid: "wamid.R1", text: "شكراً", intent: null });
  await api.onCloudInbound({ phoneNorm: "511111111", wamid: "wamid.R1", text: "شكراً", intent: null });
  assert.equal(pool.db.replies.length, 1);
  await api.onCloudInbound({ phoneNorm: "511111111", wamid: "wamid.R2", text: "إيقاف", intent: "stop" });
  assert.equal(pool.db.replies[1].optout, true);
  assert.ok(pool.db.optouts.includes("511111111"));
  assert.equal(pool.db.queue[1].status, "skipped");
});

/* ══ ٧) مساعد الربط ══════════════════════════════════════════════════════ */
function onboardPool() {
  const db = { recs: [] };
  return { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE/i.test(s)) return { rows: [] };
    if (/^INSERT INTO wa_onboarding\(created_by, event, waba_id, phone_id, business_id, same_phone/i.test(s)) {
      const r = { id: db.recs.length + 1, created_at: new Date().toISOString(), created_by: p[0], event: "onboard", waba_id: p[1], phone_id: p[2],
        business_id: p[3], same_phone: p[4], same_waba: p[5], status: p[6], steps: {}, biz_token: null };
      db.recs.push(r); return { rows: [r] };
    }
    if (/^UPDATE wa_onboarding SET biz_token/i.test(s)) { db.recs.find((r) => r.id === p[0]).biz_token = p[1]; return { rows: [] }; }
    if (/^UPDATE wa_onboarding SET steps/i.test(s)) { Object.assign(db.recs.find((r) => r.id === p[0]), { steps: JSON.parse(p[1]), status: p[2] }); return { rows: [] }; }
    if (/FROM wa_onboarding/i.test(s)) return { rows: db.recs.length ? [db.recs.at(-1)] : [] };
    return { rows: [] };
  } };
}
function graphFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method, auth: init.headers?.Authorization || null, body: init.body ? JSON.parse(init.body) : null });
    const r = handler(url, init) || {};
    return { ok: !r.error, status: r.error ? 400 : 200, json: async () => r };
  };
  f.calls = calls;
  return f;
}
function setupOnboard(fetch) {
  const app = fakeApp();
  const pool = onboardPool();
  C.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => ({}), jb: JSON.stringify },
    { fetch, wa: { token: () => process.env.WHATSAPP_TOKEN || process.env.META_CAPI_TOKEN, gate: async () => null } });
  return { app, pool };
}
const signup = { code: "AQB-code", waba_id: "2047231412843417", phone_number_id: "1102069402989468", business_id: "2187605684886350" };

test("onboard: write switch off → ids recorded, ZERO Graph calls", withEnv(ON, async () => {
  const fetch = graphFetch(() => ({}));
  const { app, pool } = setupOnboard(fetch);
  const r = await app.routes["POST /api/cms/wa-cloud/onboard"](fakeCtx({ json: signup }));
  assert.equal(r.status, 200);
  assert.equal(r.body.error, "onboard_write_disabled");
  assert.equal(fetch.calls.length, 0);
  assert.equal(pool.db.recs[0].status, "write_disabled");
  assert.equal(r.body.recorded.samePhone, true, "same phone id 1102069402989468 recognised");
  assert.equal(r.body.envHint.changePhone, false);
}));

test("onboard: exchange → subscribe → contacts sync → history sync, system token first", withEnv({ ...ON, WHATSAPP_ONBOARD_WRITE: "1" }, async () => {
  const fetch = graphFetch((url) => (/oauth\/access_token/.test(url) ? { access_token: "biztok" } : /subscribed_apps/.test(url) ? { success: true } : { request_id: "rq1" }));
  const { app, pool } = setupOnboard(fetch);
  const r = await app.routes["POST /api/cms/wa-cloud/onboard"](fakeCtx({ json: signup }));
  assert.equal(r.body.ok, true);
  const [ex, sub, c1, c2] = fetch.calls;
  assert.match(ex.url, /oauth\/access_token\?client_id=1073414588466040&client_secret=sec&code=AQB-code/);
  assert.equal(ex.auth, null, "code exchange sends no bearer token");
  assert.match(sub.url, /\/2047231412843417\/subscribed_apps$/); assert.equal(sub.method, "POST"); assert.equal(sub.auth, "Bearer systok");
  assert.match(c1.url, /\/1102069402989468\/smb_app_data$/); assert.deepEqual(c1.body, { messaging_product: "whatsapp", sync_type: "smb_app_state_sync" });
  assert.deepEqual(c2.body, { messaging_product: "whatsapp", sync_type: "history" });
  assert.equal(fetch.calls.length, 4);
  assert.ok(!fetch.calls.some((c) => /\/register$/.test(c.url)), "never calls /register");
  assert.equal(pool.db.recs[0].biz_token, "biztok");
  assert.equal(JSON.stringify(r.body).includes("biztok"), false, "business token never leaves the server");
  assert.equal(r.body.onboarding.steps.sync_history.via, "system");
}));

test("onboard: system token refused → retried with the business token", withEnv({ ...ON, WHATSAPP_ONBOARD_WRITE: "1" }, async () => {
  const fetch = graphFetch((url, init) => {
    if (/oauth\/access_token/.test(url)) return { access_token: "biztok" };
    if (init.headers?.Authorization === "Bearer systok" && /smb_app_data/.test(url)) return { error: { code: 200, message: "Permissions error" } };
    return { success: true };
  });
  const { app } = setupOnboard(fetch);
  const r = await app.routes["POST /api/cms/wa-cloud/onboard"](fakeCtx({ json: signup }));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.onboarding.steps.sync_contacts.via, "business");
  assert.equal(r.body.onboarding.steps.subscribe.via, "system");
}));

test("onboard: a different phone id is reported so the env can be updated", withEnv({ ...ON, WHATSAPP_ONBOARD_WRITE: "1" }, async () => {
  const fetch = graphFetch(() => ({ success: true }));
  const { app } = setupOnboard(fetch);
  const r = await app.routes["POST /api/cms/wa-cloud/onboard"](fakeCtx({ json: { ...signup, code: "", phone_number_id: "555", waba_id: "777" } }));
  assert.equal(r.body.envHint.changePhone, true);
  assert.equal(r.body.envHint.WHATSAPP_PHONE_ID, "555");
  assert.equal(r.body.onboarding.samePhone, false);
  assert.equal(r.body.onboarding.steps.exchange.skipped, "no_code");
}));

test("status endpoint: read-only GETs only, always HTTP 200", withEnv(ON, async () => {
  const fetch = graphFetch((url) => {
    if (/message_templates/.test(url)) return { data: [{ name: "fc_offer_img", status: "APPROVED", category: "MARKETING", language: "ar" }] };
    if (/subscribed_apps/.test(url)) return { data: [{ whatsapp_business_api_data: { id: "1073414588466040", name: "FreshCuts Autopilot" } }] };
    return { status: "CONNECTED", platform_type: "CLOUD_API", is_on_biz_app: true, quality_rating: "GREEN", messaging_limit_tier: "TIER_250", throughput: { level: "STANDARD" } };
  });
  const { app } = setupOnboard(fetch);
  const r = await app.routes["GET /api/cms/wa-cloud/status"](fakeCtx({ query: {} }));
  assert.equal(r.status, 200);
  assert.ok(fetch.calls.every((c) => (c.method || "GET") === "GET"));
  assert.equal(r.body.phone.isOnBizApp, true);
  assert.equal(r.body.phone.tier, "TIER_250");
  assert.equal(r.body.subscribedApps.ours, true);
  assert.equal(r.body.templates.ours.find((t) => t.name === "fc_offer_img").status, "APPROVED");
  assert.equal(r.body.templates.ours.find((t) => t.name === "fc_winback").status, "NOT_SUBMITTED");
  assert.equal(r.body.defaultChannel, "wa_cloud");
  const errFetch = graphFetch(() => ({ error: { code: 190, message: "token expired" } }));
  const e = await setupOnboard(errFetch).app.routes["GET /api/cms/wa-cloud/status"](fakeCtx({ query: {} }));
  assert.equal(e.status, 200); assert.equal(e.body.phone.ok, false); assert.equal(e.body.defaultChannel, "wa_web");
}));

/* ══ ٨) كتالوج قوالب خارجي + البوت (تسليم لإنسان) ═══════════════════════ */
test("registerTemplates: plugs a catalogue in without clobbering existing names", () => {
  const def = { category: "UTILITY", components: [{ type: "BODY", text: "طلبك {{1}} اتأخر شوي، نعتذر", example: { body_text: [["W1"]] } }], bind: (o) => ({ body: [o.order_no] }) };
  const r = W.registerTemplates({ fc_test_delay: def, fc_winback: { ...def }, "Bad Name": def, fc_broken: { category: "X" } });
  assert.deepEqual(r.added, ["fc_test_delay"]);
  assert.deepEqual(r.skipped.sort(), ["Bad Name", "fc_broken", "fc_winback"].sort());
  assert.equal(W.TEMPLATES.fc_winback.campaign.label, "اشتقنا لك + كود", "existing kept");
  assert.equal(W.templateSubmission("fc_test_delay").category, "UTILITY");
  delete W.TEMPLATES.fc_test_delay;
});

test("inbound hook: full event shape; bot replies unless staff answered from the phone recently", withEnv({ ...ON, WHATSAPP_BOT_ENABLED: "1" }, async () => {
  const { api, pool, calls } = await setupWa();
  const events = [];
  api.on("inbound", (e) => events.push(e));
  const asked = [];
  api.setBot({ matchIntent: (text, ctx) => { asked.push(ctx); return /منيو/.test(text) ? "menu" : null; },
    buildReply: (intent) => ({ type: "text", text: { body: "المنيو: https://freshcuts.sa/menu" } }) });
  const now = Math.floor(Date.now() / 1000);
  await api.processWebhook(change("messages", { messages: [{ from: "966512345678", id: "wamid.B1", timestamp: String(now), type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: "menu_btn", title: "ابي المنيو" } } }] }));
  assert.equal(calls.length, 1, "bot replied");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.to, "966512345678"); assert.equal(sent.messaging_product, "whatsapp");
  assert.equal(pool.db.msgs.find((m) => m.source === "bot")?.body, "المنيو: https://freshcuts.sa/menu");
  assert.deepEqual(Object.keys(events[0]).filter((k) => ["phone", "text", "interactiveId", "referral", "isEcho", "ts"].includes(k)).sort(),
    ["interactiveId", "isEcho", "phone", "referral", "text", "ts"]);
  assert.equal(events[0].interactiveId, "menu_btn"); assert.equal(events[0].isEcho, false);
  // الكاشير رد من الموبايل ⇒ البوت يسكت
  await api.processWebhook(change("smb_message_echoes", { message_echoes: [{ from: BIZ, to: "966512345678", id: "wamid.HUMAN", timestamp: String(now + 1), type: "text", text: { body: "معك محمد من المطعم" } }] }));
  assert.equal(events.at(-1).isEcho, true);
  pool.query = ((orig) => async (sql, p) => (/source='echo' AND created_at >/.test(String(sql)) ? { rowCount: pool.db.msgs.some((m) => m.phone_norm === p[0] && m.source === "echo") ? 1 : 0, rows: [] } : orig(sql, p)))(pool.query.bind(pool));
  await api.processWebhook(change("messages", { messages: [{ from: "966512345678", id: "wamid.B2", timestamp: String(now + 2), type: "text", text: { body: "ابي المنيو" } }] }));
  assert.equal(calls.length, 1, "human handoff: no bot reply");
  assert.equal((await api.runBot({ phone: "512345678", text: "ابي المنيو", isEcho: false })).skipped, "human_handoff");
  // «إيقاف» مابيروحش للبوت
  assert.equal((await api.runBot({ phone: "598765432", text: "إيقاف", intent: "stop" })).skipped, "off");
}));
