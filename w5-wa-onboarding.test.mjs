// W5 (12/10): the WhatsApp number may land on a NEW account id / phone-number id (popup run with a new business portfolio).
// The one-time contact + history sync must not be lost. Three gaps (runbook, section 2) + active ids from the onboarding.
// Offline: Graph is a fake fetch, the database a fake pool. Nothing is sent to Meta, nothing is sent to a customer.
// Run: node --test w5-wa-onboarding.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
const W = await import("./whatsapp.js");
const C = await import("./wacloud.js");

const OLD = { phone: "1102069402989468", waba: "2047231412843417" };
const NEW = { phone: "880011223344556", waba: "990011223344557", biz: "770011223344558" };
const OURS = "966546715683";

/* ── recorded-shape payloads (Meta's webhook envelope: entry[].changes[].value.metadata) ── */
const hook = (field, value, entryId = NEW.waba) => ({ object: "whatsapp_business_account", entry: [{ id: entryId, changes: [{ field, value }] }] });
const meta = (pid, display = "966546715683") => ({ display_phone_number: display, phone_number_id: pid });
const HISTORY_NEW = hook("history", { messaging_product: "whatsapp", metadata: meta(NEW.phone), history: [{ metadata: { phase: 0, chunk_order: 1, progress: 55 },
  threads: [{ id: "966500000001", messages: [{ from: "966500000001", id: "wamid.H1", timestamp: "1790000000", type: "text", text: { body: "السلام عليكم" }, history_context: { status: "READ" } }] }] }] });
const CONTACTS_NEW = hook("smb_app_state_sync", { messaging_product: "whatsapp", metadata: meta(NEW.phone),
  state_sync: [{ type: "contact", contact: { full_name: "سارة العتيبي", first_name: "سارة", phone_number: "966500000001" }, action: "add", metadata: { timestamp: "1790000000" } }] });
const MESSAGE_NEW = hook("messages", { messaging_product: "whatsapp", metadata: meta(NEW.phone), contacts: [{ wa_id: "966500000001", profile: { name: "Sara" } }],
  messages: [{ from: "966500000001", id: "wamid.M1", timestamp: "1790000100", type: "text", text: { body: "هلا" } }] });
const MESSAGE_OTHER = hook("messages", { messaging_product: "whatsapp", metadata: meta("111122223333444", "966511111111"),
  messages: [{ from: "966500000009", id: "wamid.X1", timestamp: "1790000100", type: "text", text: { body: "not ours" } }] });
const PARTNER_ADDED = hook("account_update", { event: "PARTNER_ADDED", waba_info: { waba_id: NEW.waba, owner_business_id: NEW.biz } }, "2187605684886350");

/* ═══ G1 — the webhook filter ═══ */
test("G1 (the defect): with only the env id, every event of a new phone-number id was dropped", () => {
  const p = W.parseWebhook(HISTORY_NEW, { phoneId: OLD.phone });
  assert.equal(p.history.length, 0);
  assert.equal(p.fields[0].ignored, "other_phone");
});

test("G1: events for the phone id of the latest onboarding are accepted and stored", () => {
  const opt = { phoneId: OLD.phone, phoneIds: [NEW.phone], ownNumbers: [] };
  const h = W.parseWebhook(HISTORY_NEW, opt);
  assert.equal(h.history.length, 1);
  assert.equal(h.history[0].customer, "966500000001");
  assert.deepEqual(h.historyMeta[0], { phase: 0, chunk: 1, progress: 55 });
  assert.equal(h.fields[0].via, "onboarding");
  assert.equal(W.parseWebhook(CONTACTS_NEW, opt).contacts[0].fullName, "سارة العتيبي");
  assert.equal(W.parseWebhook(MESSAGE_NEW, opt).messages[0].wamid, "wamid.M1");
});

test("G1: events whose display number is ours are accepted even before any onboarding row exists", () => {
  const p = W.parseWebhook(HISTORY_NEW, { phoneId: OLD.phone, phoneIds: [], ownNumbers: [OURS] });
  assert.equal(p.history.length, 1);
  assert.equal(p.fields[0].via, "number");
  assert.match(p.fields[0].note, /via:number phone_id:880011223344556/, "which rule matched is written to the health note");
  // formatting of the display number does not matter
  assert.equal(W.acceptPhone(NEW.phone, "+966 54 671 5683", { phoneId: OLD.phone, ownNumbers: ["966546715683"] }).via, "number");
});

test("G1: the env id still works, and an unrelated number is still rejected", () => {
  const opt = { phoneId: OLD.phone, phoneIds: [NEW.phone], ownNumbers: [OURS] };
  const same = hook("messages", { messaging_product: "whatsapp", metadata: meta(OLD.phone), messages: [{ from: "966500000002", id: "wamid.O1", timestamp: "1790000100", type: "text", text: { body: "old id" } }] });
  assert.equal(W.parseWebhook(same, opt).fields[0].via, "env");
  const other = W.parseWebhook(MESSAGE_OTHER, opt);
  assert.equal(other.messages.length, 0);
  assert.equal(other.fields[0].ignored, "other_phone");
  assert.equal(other.fields[0].phoneId, "111122223333444");
  // no filter at all (no env, nothing recorded) keeps the old behaviour: everything is accepted
  assert.equal(W.parseWebhook(MESSAGE_OTHER, {}).messages.length, 1);
});

test("account_update (PARTNER_ADDED) is kept with its payload", () => {
  const p = W.parseWebhook(PARTNER_ADDED, { phoneId: OLD.phone, phoneIds: [], ownNumbers: [OURS] });
  assert.deepEqual(p.accountEvents, [{ event: "PARTNER_ADDED", wabaId: NEW.waba, ownerBusinessId: NEW.biz, entryId: "2187605684886350" }]);
  assert.match(p.fields[0].note, /"event":"PARTNER_ADDED"/);
  assert.match(p.fields[0].note, new RegExp(NEW.waba));
});

/* ── harness for the routes ── */
function fakeApp() { const routes = {}; const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; }
const ctx = (json = {}, query = {}) => ({ req: { text: async () => "", json: async () => json, header: () => undefined, query: (n) => query[n], param: () => undefined },
  json: (body, status = 200) => ({ body, status }), text: (body, status = 200) => ({ body, status }) });
function fakePool() {
  const db = { recs: [], settings: {}, sql: [] };
  return { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    db.sql.push(s.slice(0, 90));
    if (/^CREATE TABLE/i.test(s)) return { rows: [] };
    if (/^INSERT INTO wa_onboarding\(created_by, event, waba_id, phone_id, business_id, same_phone/i.test(s)) {
      const r = { id: db.recs.length + 1, created_at: new Date().toISOString(), created_by: p[0], event: "onboard", waba_id: p[1], phone_id: p[2], business_id: p[3], same_phone: p[4], same_waba: p[5], status: p[6], steps: {}, biz_token: null };
      db.recs.push(r); return { rows: [r] };
    }
    if (/^INSERT INTO wa_onboarding\(created_by, event, waba_id, business_id, info, status\)/i.test(s)) { db.recs.push({ id: db.recs.length + 1, created_by: "webhook", event: p[0], waba_id: p[1], business_id: p[2], info: JSON.parse(p[3]), status: "recorded", steps: {} }); return { rows: [] }; }
    if (/^UPDATE wa_onboarding SET biz_token/i.test(s)) { db.recs.find((r) => r.id === p[0]).biz_token = p[1]; return { rows: [] }; }
    if (/^UPDATE wa_onboarding SET phone_id/i.test(s)) { Object.assign(db.recs.find((r) => r.id === p[0]), { phone_id: p[1], same_phone: p[2] }); return { rows: [] }; }
    if (/^UPDATE wa_onboarding SET steps/i.test(s)) { Object.assign(db.recs.find((r) => r.id === p[0]), { steps: JSON.parse(p[1]), status: p[2] }); return { rows: [] }; }
    if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{waCloudActive\}'/i.test(s)) { db.settings.waCloudActive = JSON.parse(p[0]); return { rows: [] }; }
    if (/SELECT DISTINCT phone_id FROM/i.test(s)) return { rows: db.recs.filter((r) => r.event === "onboard" && r.phone_id && ["running", "done", "partial"].includes(r.status)).slice(-5).map((r) => ({ phone_id: r.phone_id })) };
    if (/FROM wa_onboarding WHERE event='onboard' ORDER BY id DESC LIMIT 10/i.test(s)) return { rows: db.recs.filter((r) => r.event === "onboard").slice().reverse() };
    if (/FROM wa_onboarding WHERE event='onboard' ORDER BY id DESC LIMIT 1/i.test(s)) return { rows: db.recs.filter((r) => r.event === "onboard").slice(-1) };
    if (/FROM wa_onboarding/i.test(s)) return { rows: db.recs.filter((r) => r.waba_id || r.phone_id).slice(-1) };
    return { rows: [], rowCount: 0 };
  } };
}
function graphFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", auth: init.headers?.Authorization || null, body: init.body ? JSON.parse(init.body) : null });
    const r = handler(String(url), init) || {};
    return { ok: !r.error, status: r.error ? 400 : 200, json: async () => r };
  };
  f.calls = calls;
  return f;
}
const KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "META_CAPI_TOKEN", "WHATSAPP_ONBOARD_WRITE", "WHATSAPP_APP_ID", "WHATSAPP_BOT_ENABLED", "WHATSAPP_DISPLAY_NUMBER", "WHATSAPP_TEMPLATES_WRITE"];
const withEnv = (vals, fn) => async () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vals);
  try { await fn(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
// WHATSAPP_ENABLED is deliberately NOT set anywhere in this file
const ENV = { META_CAPI_TOKEN: "systok", WHATSAPP_PHONE_ID: OLD.phone, WHATSAPP_WABA_ID: OLD.waba, WHATSAPP_APP_SECRET: "sec", WHATSAPP_ONBOARD_WRITE: "1" };
/* a small stand-in for whatsapp.js's returned api: the real id/accept logic, no sending */
function fakeWa() {
  let active = { phoneId: null, wabaId: null }; let accept = () => ({ phoneIds: [], ownNumbers: [] }); const hooks = {};
  return { token: () => process.env.META_CAPI_TOKEN, gate: async () => null, sent: [],
    phoneId: () => active.phoneId || process.env.WHATSAPP_PHONE_ID, wabaId: () => active.wabaId || process.env.WHATSAPP_WABA_ID,
    setActiveIds(a) { active = a ? { phoneId: a.phoneId || null, wabaId: a.wabaId || null } : { phoneId: null, wabaId: null }; },
    idsInUse() { return { phoneId: this.phoneId(), wabaId: this.wabaId(), phoneSource: active.phoneId ? "onboarding" : "env", wabaSource: active.wabaId ? "onboarding" : "env", envPhoneId: process.env.WHATSAPP_PHONE_ID || null, envWabaId: process.env.WHATSAPP_WABA_ID || null }; },
    setWebhookAccept(fn) { accept = fn; }, accept: () => accept(), on(ev, fn) { (hooks[ev] ||= []).push(fn); }, hooks };
}
function setup(fetch, settings = {}) {
  const app = fakeApp(), pool = fakePool(), wa = fakeWa();
  Object.assign(pool.db.settings, settings);
  const api = C.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => pool.db.settings, jb: JSON.stringify }, { fetch, wa });
  return { app, pool, wa, api, post: (path, json) => app.routes["POST " + path](ctx(json)), get: (path, q) => app.routes["GET " + path](ctx({}, q || {})) };
}
const REFUSED = { error: { code: 131000, error_subcode: 10, message: "This API is only available to WhatsApp Business App phone numbers onboarded on to WhatsApp Business Platform" } };

/* ═══ G2 — token order ═══ */
test("G2: with a business token, subscribe and both syncs use it FIRST; each step records the token and the full response", withEnv(ENV, async () => {
  const fetch = graphFetch((url) => (/oauth\/access_token/.test(url) ? { access_token: "biztok" } : /subscribed_apps/.test(url) ? { success: true } : { messaging_product: "whatsapp", request_id: "rq-" + (/"history"/.test("") ? "h" : "x") }));
  const { post, pool } = setup(fetch);
  const r = await post("/api/cms/wa-cloud/onboard", { code: "AQB", waba_id: NEW.waba, phone_number_id: NEW.phone, business_id: NEW.biz });
  assert.equal(r.body.ok, true);
  const graphCalls = fetch.calls.filter((c) => !/oauth/.test(c.url));
  assert.deepEqual(graphCalls.map((c) => c.auth), ["Bearer biztok", "Bearer biztok", "Bearer biztok"], "no system-token call when the business token works");
  const st = r.body.onboarding.steps;
  for (const k of ["subscribe", "sync_contacts", "sync_history"]) { assert.equal(st[k].ok, true); assert.equal(st[k].via, "business"); assert.deepEqual(st[k].tried, ["business"]); assert.ok(st[k].data, k + " keeps the full response"); }
  assert.equal(st.sync_contacts.data.request_id, "rq-x");
  assert.ok(!JSON.stringify(r.body).includes("biztok"), "the token itself never leaves the server");
  assert.equal(pool.db.recs[0].biz_token, "biztok");
}));

test("G2: the refusal we really get (131000 / 10) with one token is retried with the other — it is not an auth code", withEnv(ENV, async () => {
  // old behaviour to beat: system first, fall back only on codes 10/100/190/200/3/33 ⇒ 131000 was never retried
  const fetch = graphFetch((url, init) => {
    if (/oauth\/access_token/.test(url)) return { access_token: "biztok" };
    if (/smb_app_data/.test(url) && init.headers.Authorization === "Bearer systok") return REFUSED;
    return /subscribed_apps/.test(url) ? { success: true } : { request_id: "ok" };
  });
  const a = setup(fetch);
  const r = await a.post("/api/cms/wa-cloud/onboard", { code: "AQB", waba_id: NEW.waba, phone_number_id: NEW.phone });
  assert.equal(r.body.ok, true, "the business token is tried first, so the system token's refusal never happens");
  assert.ok(!fetch.calls.some((c) => c.auth === "Bearer systok"));
  // the reverse: business refused ⇒ system tried, and both errors are kept
  const fetch2 = graphFetch((url, init) => {
    if (/oauth\/access_token/.test(url)) return { access_token: "biztok" };
    if (/smb_app_data/.test(url)) return REFUSED;
    return { success: true };
  });
  const b = setup(fetch2);
  const r2 = await b.post("/api/cms/wa-cloud/onboard", { code: "AQB", waba_id: NEW.waba, phone_number_id: NEW.phone });
  const s = r2.body.onboarding.steps.sync_history;
  assert.equal(r2.body.ok, false);
  assert.equal(r2.body.status, "partial");
  assert.equal(s.ok, false);
  assert.deepEqual(s.tried, ["business", "system"]);
  assert.equal(s.businessError.code, 131000); assert.equal(s.businessError.sub, 10);
  assert.equal(s.systemError.code, 131000);
  assert.match(s.error, /only available to WhatsApp Business App/);
}));

test("G2: without a business token (no code) the system token is used, as before", withEnv(ENV, async () => {
  const fetch = graphFetch(() => ({ success: true }));
  const { post } = setup(fetch);
  const r = await post("/api/cms/wa-cloud/onboard", { waba_id: NEW.waba, phone_number_id: NEW.phone });
  assert.equal(r.body.onboarding.steps.exchange.skipped, "no_code");
  assert.deepEqual(fetch.calls.map((c) => c.auth), ["Bearer systok", "Bearer systok", "Bearer systok"]);
  assert.equal(r.body.onboarding.steps.sync_contacts.via, "system");
}));

/* ═══ G3 — the finish event carries only the waba_id ═══ */
test("G3: no phone id in the finish event ⇒ it is read from the account with the business token, stored, and the syncs run", withEnv(ENV, async () => {
  const fetch = graphFetch((url) => {
    if (/oauth\/access_token/.test(url)) return { access_token: "biztok" };
    if (/\/phone_numbers\?/.test(url)) return { data: [{ id: "555000111222333", display_phone_number: "+966 50 000 0000", status: "CONNECTED" }, { id: NEW.phone, display_phone_number: "+966 54 671 5683", verified_name: "Fresh Cuts", status: "CONNECTED", platform_type: "CLOUD_API", is_on_biz_app: true }] };
    return /subscribed_apps/.test(url) ? { success: true } : { request_id: "rq" };
  });
  const { post, pool } = setup(fetch);
  const r = await post("/api/cms/wa-cloud/onboard", { code: "AQB", waba_id: NEW.waba });   // exactly what Meta's coexistence page shows
  assert.equal(r.body.ok, true);
  const urls = fetch.calls.map((c) => c.url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, "").split("?")[0]);
  assert.deepEqual(urls, ["oauth/access_token", `${NEW.waba}/subscribed_apps`, `${NEW.waba}/phone_numbers`, `${NEW.phone}/smb_app_data`, `${NEW.phone}/smb_app_data`]);
  assert.equal(fetch.calls[2].auth, "Bearer biztok");
  assert.equal(fetch.calls[2].method, "GET");
  const lk = r.body.onboarding.steps.lookup_phone;
  assert.equal(lk.ok, true); assert.equal(lk.by, "number"); assert.equal(lk.phoneId, NEW.phone); assert.equal(lk.via, "business");
  assert.equal(pool.db.recs[0].phone_id, NEW.phone, "stored on the onboarding row");
  assert.equal(r.body.onboarding.phoneId, NEW.phone);
  assert.equal(r.body.onboarding.steps.sync_contacts.ok, true);
  assert.equal(r.body.envHint.WHATSAPP_PHONE_ID, NEW.phone);
  assert.equal(r.body.envHint.changePhone, true);
  assert.ok(!fetch.calls.some((c) => /\/register$/.test(c.url)), "never calls /register");
}));

test("G3: choosing the number — ours by display number, else the only one, else nothing (never a guess)", () => {
  assert.deepEqual(C.pickPhoneId([{ id: "1", display_phone_number: "+966 50 000 0000" }, { id: "2", display_phone_number: "966546715683" }]), { id: "2", by: "number", count: 2 });
  assert.deepEqual(C.pickPhoneId([{ id: "9", display_phone_number: "+1 555 000" }]), { id: "9", by: "only", count: 1 });
  assert.deepEqual(C.pickPhoneId([{ id: "1", display_phone_number: "+966 50 000 0000" }, { id: "3", display_phone_number: "+966 51 111 1111" }]), { id: null, by: "ambiguous", count: 2 });
  assert.deepEqual(C.pickPhoneId([]), { id: null, by: "empty", count: 0 });
  assert.deepEqual(C.pickPhoneId(null), { id: null, by: "empty", count: 0 });
});

test("G3: the number is not on that account ⇒ the syncs say missing_id and the lookup says why (no call on a guessed id)", withEnv(ENV, async () => {
  const fetch = graphFetch((url) => (/oauth/.test(url) ? { access_token: "biztok" } : /phone_numbers/.test(url) ? { data: [{ id: "1", display_phone_number: "+966 50 000 0000" }, { id: "2", display_phone_number: "+966 51 111 1111" }] } : { success: true }));
  const { post } = setup(fetch);
  const r = await post("/api/cms/wa-cloud/onboard", { code: "AQB", waba_id: NEW.waba });
  const st = r.body.onboarding.steps;
  assert.equal(st.lookup_phone.ok, false); assert.equal(st.lookup_phone.error, "number_not_found_on_waba"); assert.equal(st.lookup_phone.numbers.length, 2);
  assert.equal(st.sync_contacts.error, "missing_id"); assert.equal(st.sync_history.error, "missing_id");
  assert.ok(!fetch.calls.some((c) => /smb_app_data/.test(c.url)));
  assert.equal(fetch.calls.filter((c) => /phone_numbers/.test(c.url)).length, 1, "looked up once (the business token answered) — not once per sync step");
}));

/* ═══ active ids, the webhook accept list, retry ═══ */
test("after a successful pass on a new account the active ids are the new ones (stored in settings), env is the fallback", withEnv(ENV, async () => {
  const fetch = graphFetch((url) => (/oauth/.test(url) ? { access_token: "biztok" } : /subscribed_apps/.test(url) ? { success: true } : { request_id: "rq" }));
  const { post, pool, wa, get } = setup(fetch);
  assert.deepEqual([wa.phoneId(), wa.wabaId()], [OLD.phone, OLD.waba], "before: the env ids");
  const r = await post("/api/cms/wa-cloud/onboard", { code: "AQB", waba_id: NEW.waba, phone_number_id: NEW.phone });
  assert.deepEqual([wa.phoneId(), wa.wabaId()], [NEW.phone, NEW.waba], "sending / templates / inbox read these");
  assert.equal(pool.db.settings.waCloudActive.phoneId, NEW.phone);
  assert.equal(pool.db.settings.waCloudActive.wabaId, NEW.waba);
  assert.equal(pool.db.settings.waCloudActive.onboardingId, 1);
  assert.equal(r.body.ids.phoneSource, "onboarding"); assert.equal(r.body.ids.envPhoneId, OLD.phone);
  // the webhook accepts the new id from now on (and our display number always)
  assert.deepEqual(await wa.accept(), { phoneIds: [NEW.phone], ownNumbers: [OURS] });
  // the status page says which ids and which token
  const s = await get("/api/cms/wa-cloud/status");
  assert.equal(s.body.ids.phoneId, NEW.phone); assert.equal(s.body.ids.wabaSource, "onboarding");
  assert.equal(s.body.tokens.sendingKind, "system"); assert.equal(s.body.tokens.business.stored, true);
  assert.deepEqual(s.body.tokens.syncOrder, ["business", "system"]);
  assert.ok(!JSON.stringify(s.body).includes("biztok"));
  // owner switches back to the env ids, and forward again
  let a = await post("/api/cms/wa-cloud/active", { use: "env" });
  assert.equal(a.body.ids.phoneId, OLD.phone); assert.equal(pool.db.settings.waCloudActive, null);
  a = await post("/api/cms/wa-cloud/active", { use: "onboarding" });
  assert.equal(a.body.ids.phoneId, NEW.phone);
  assert.equal((await post("/api/cms/wa-cloud/active", { use: "x" })).status, 400);
}));

test("a pass whose subscribe failed does NOT switch the active ids; boot reads the stored ids", withEnv(ENV, async () => {
  const fetch = graphFetch((url) => (/oauth/.test(url) ? { access_token: "biztok" } : { error: { code: 200, message: "Permissions error" } }));
  const a = setup(fetch);
  await a.post("/api/cms/wa-cloud/onboard", { code: "AQB", waba_id: NEW.waba, phone_number_id: NEW.phone });
  assert.deepEqual([a.wa.phoneId(), a.wa.wabaId()], [OLD.phone, OLD.waba]);
  assert.equal(a.pool.db.settings.waCloudActive, undefined);
  assert.equal(C.activeFromRecord({ id: 3, waba_id: NEW.waba, phone_id: NEW.phone, steps: { subscribe: { ok: false } } }), null);
  assert.equal(C.activeFromRecord({ id: 3, waba_id: NEW.waba, phone_id: null, steps: { subscribe: { ok: true } } }), null);
  // boot with ids already stored in settings
  const b = setup(graphFetch(() => ({})), { waCloudActive: { phoneId: NEW.phone, wabaId: NEW.waba, onboardingId: 7 } });
  await b.api.activeReady;
  assert.deepEqual([b.wa.phoneId(), b.wa.wabaId()], [NEW.phone, NEW.waba]);
}));

test("retry sync: re-runs contacts + history on the last pass with the stored business token, and says if 24 h have passed", withEnv(ENV, async () => {
  let refuse = true;
  const fetch = graphFetch((url) => {
    if (/oauth/.test(url)) return { access_token: "biztok" };
    if (/smb_app_data/.test(url) && refuse) return REFUSED;
    return /subscribed_apps/.test(url) ? { success: true } : { request_id: "rq2" };
  });
  const { post, pool } = setup(fetch);
  const first = await post("/api/cms/wa-cloud/onboard", { code: "AQB", waba_id: NEW.waba, phone_number_id: NEW.phone });
  assert.equal(first.body.status, "partial");
  refuse = false;
  const before = fetch.calls.length;
  const r = await post("/api/cms/wa-cloud/onboard/retry", { steps: ["sync_contacts", "sync_history"] });
  assert.equal(r.body.ok, true); assert.equal(r.body.status, "done"); assert.equal(r.body.late, false); assert.equal(r.body.usedBusinessToken, true);
  assert.deepEqual(fetch.calls.slice(before).map((c) => [c.auth, c.body.sync_type]), [["Bearer biztok", "smb_app_state_sync"], ["Bearer biztok", "history"]]);
  pool.db.recs[0].created_at = new Date(Date.now() - 25 * 3600e3).toISOString();
  assert.equal((await post("/api/cms/wa-cloud/onboard/retry", { steps: ["sync_history"] })).body.late, true);
  assert.equal((await post("/api/cms/wa-cloud/onboard/retry", { steps: ["nope"] })).body.error, "bad_step");
}));

test("PARTNER_ADDED from the webhook leaves a row with the ids Meta sent", withEnv(ENV, async () => {
  const { pool, wa } = setup(graphFetch(() => ({})));
  for (const fn of wa.hooks.account) await fn({ event: "PARTNER_ADDED", wabaId: NEW.waba, ownerBusinessId: NEW.biz, entryId: "2187605684886350" });
  const row = pool.db.recs.at(-1);
  assert.equal(row.event, "account_update:PARTNER_ADDED"); assert.equal(row.waba_id, NEW.waba); assert.equal(row.business_id, NEW.biz);
}));

/* ═══ the real whatsapp.js wiring: nothing is sent, the gate is untouched ═══ */
test("whatsapp.js: active ids override env for sending/templates only when set; clearing returns to env; no message is sent by any of this", withEnv({ META_CAPI_TOKEN: "systok", WHATSAPP_PHONE_ID: OLD.phone, WHATSAPP_WABA_ID: OLD.waba }, async () => {
  const calls = [];
  const app = fakeApp();
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const api = W.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => ({ notifications: {} }), jb: JSON.stringify, normPhone: (x) => String(x || "") },
    { fetch: async (url, init) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; }, sendSms: async () => ({ ok: true }) });
  await api.ready;
  assert.deepEqual([api.phoneId(), api.wabaId()], [OLD.phone, OLD.waba]);
  assert.equal(api.idsInUse().phoneSource, "env");
  api.setActiveIds({ phoneId: NEW.phone, wabaId: NEW.waba, source: "onboarding" });
  assert.deepEqual([api.phoneId(), api.wabaId()], [NEW.phone, NEW.waba]);
  assert.deepEqual(api.idsInUse(), { phoneId: NEW.phone, wabaId: NEW.waba, phoneSource: "onboarding", wabaSource: "onboarding", envPhoneId: OLD.phone, envWabaId: OLD.waba });
  assert.equal(await api.gate(), "disabled", "WHATSAPP_ENABLED is not set: the sending gate stays closed whatever the ids are");
  // webhooks: the new id (set as active), the old env id, and our display number are accepted; a stranger is not
  api.setWebhookAccept(async () => ({ phoneIds: [], ownNumbers: [OURS] }));
  assert.equal((await api.processWebhook(HISTORY_NEW)).history.length, 1);
  assert.equal((await api.processWebhook(hook("messages", { messaging_product: "whatsapp", metadata: meta(OLD.phone), messages: [] }))).fields[0].via, "env");
  assert.equal((await api.processWebhook(MESSAGE_OTHER)).fields[0].ignored, "other_phone");
  api.setActiveIds(null);
  assert.deepEqual([api.phoneId(), api.wabaId()], [OLD.phone, OLD.waba]);
  assert.ok(!calls.some((u) => /\/messages$/.test(u)), "no message was sent");
}));
