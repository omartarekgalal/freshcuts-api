/* رد الموظف على محادثة واتساب (wastaff.js) — بالحارس الحقيقي بتاع whatsapp.js وfetch وهمي بيسجّل كل طلب لـGraph.
   node --test wastaff.test.mjs  — مفيش شبكة حقيقية ولا أي إرسال. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

const W = await import("./whatsapp.js");
const S = await import("./wastaff.js");

const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN", "WHATSAPP_TEST_PHONE_ID"];
function withEnv(vals, fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, vals);
    try { await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
}
const CONFIGURED = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1" };
const ALLOW = { ...CONFIGURED, WHATSAPP_ENABLED: "1" };
const CUST = "512345678", TESTER = "544775082", SALT = "salt-1";
const keyOf = (pn) => crypto.createHash("md5").update(`${SALT}:${pn}`).digest("hex");

function fakeApp() { const routes = {}; const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; }
const call = (app, route, { json = {}, query = {}, param = {} } = {}) => app.routes[route]({
  req: { json: async () => { if (json === "BAD") throw new Error("bad"); return json; }, header: () => undefined, query: (n) => query[n], param: (n) => param[n] },
  json: (body, status = 200) => ({ body, status }) });

function world({ settings = {}, optins = {}, inbound = [CUST, TESTER], threads = [CUST, TESTER], portalUser = { id: "p1", name: "سلمى", role: "cashier" }, faq = null } = {}) {
  const db = { settings: { notifications: { whatsappEnabled: true }, waMaster: { enabled: true }, waBot: { testPhones: ["0" + TESTER], faq: faq || {} }, ...settings },
    optins: { ...optins }, inbound: [...inbound], msgs: [], staff: [], read: [], sql: [] };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim(); db.sql.push(s);
    if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: db.inbound.includes(p[0]) ? [{}] : [] };
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: db.optins[p[0]] ? [db.optins[p[0]]] : [] };
    if (/FROM cms_contacts/i.test(s)) return { rows: [], rowCount: 0 };
    if (/^INSERT INTO wa_messages/i.test(s)) { db.msgs.push({ wamid: p[0], phone_norm: p[1], status: p[6], body: p[8], source: p[10] }); return { rows: [], rowCount: 1 }; }
    if (/^INSERT INTO wa_staff_replies/i.test(s)) { db.staff.push({ phone_norm: p[0], wamid: p[1], by_name: p[2], role: p[3], via: p[4], test: p[5], chars: p[6] }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_threads SET unread=0/i.test(s)) { db.read.push({ pn: p[0], by: p[1] }); return { rows: [], rowCount: 1 }; }
    if (/^SELECT phone_norm FROM wa_threads WHERE md5/i.test(s)) { const hit = threads.find((t) => keyOf(t) === p[1] && p[0] === SALT); return { rows: hit ? [{ phone_norm: hit }] : [] }; }
    if (/^SELECT wamid, by_name, role, via FROM wa_staff_replies/i.test(s)) return { rows: db.staff.filter((x) => p[0].includes(x.wamid)) };
    return { rows: [], rowCount: 0 };
  } };
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.G${calls.length}` }] }) }; };
  const waApp = fakeApp();
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(waApp, ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const hubCalls = [];
  const hub = { listThreads: async (o) => { hubCalls.push(["list", o]); return { ok: true, counts: { waiting: 1 }, threads: [{ key: keyOf(CUST), phone: "0" + CUST }], nextBefore: null }; },
    getThread: async (pn, o) => { hubCalls.push(["get", pn, o]); return threads.includes(pn) ? { ok: true, key: keyOf(pn), phone: "0" + pn, window: { open: db.inbound.includes(pn) },
      messages: [{ id: "wamid.G1", dir: "out", source: "echo", text: "x" }, { id: "wamid.PHONE", dir: "out", source: "echo", text: "من الموبايل" }, { id: "m-in", dir: "in", source: "api", text: "هلا" }] } : { ok: false, error: "not_found" }; } };
  const audits = [];
  const app = fakeApp();
  const requirePortal = async (c) => (portalUser ? (portalUser.role === "kitchen" ? { res: c.json({ ok: false, error: "kitchen_only" }, 403) } : { user: portalUser }) : { res: c.json({ ok: false, error: "unauthorized" }, 401) });
  const st = S.register(app, ctx, { wa, hub: () => hub, requirePortal, audit: (...a) => audits.push(a), keySalt: SALT, log: { error() {} } });
  return { db, app, st, wa, calls, hubCalls, audits };
}

test("الباب الوحيد: الملف مابيكلّمش Graph ولا بيعمل تذكرة — sendFreeform بس", () => {
  const src = fs.readFileSync(new URL("./wastaff.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(src, /graph\.facebook\.com|\/messages|fetch\(|\.deliver\(|\.guardSend\(/);
  assert.equal((src.match(/wa\.sendFreeform\(/g) || []).length, 1);
});

test("القناة مفتوحة والنافذة مفتوحة: الرد بيتبعت، بيتسجّل كرد موظف (echo) ومين رد", withEnv(ALLOW, async () => {
  const w = world();
  const r = await w.st.reply({ phoneNorm: "0" + CUST, text: "  حيّاك، نرسلها لك الحين  ", by: "منى", role: "operations", via: "dashboard" });
  assert.deepEqual(r, { ok: true, wamid: "wamid.G1", test: false });
  assert.equal(w.calls.length, 1);
  assert.match(w.calls[0].url, /\/PHONE1\/messages$/);
  assert.deepEqual(w.calls[0].body, { type: "text", text: { body: "حيّاك، نرسلها لك الحين", preview_url: false }, messaging_product: "whatsapp", recipient_type: "individual", to: "966" + CUST });
  /* إشارة «الموظف رد» للبوت = صف صادر source='echo' — نفس أثر رد الكاشير من موبايل المطعم */
  assert.deepEqual(w.db.msgs.map((m) => [m.phone_norm, m.status, m.source, m.body]), [[CUST, "accepted", "echo", "حيّاك، نرسلها لك الحين"]]);
  assert.deepEqual(w.db.staff, [{ phone_norm: CUST, wamid: "wamid.G1", by_name: "منى", role: "operations", via: "dashboard", test: false, chars: 22 }]);
  assert.deepEqual(w.db.read, [{ pn: CUST, by: "منى" }]);
  assert.deepEqual(await w.st.sendStateFor(CUST), { ok: true, gate: null, test: false });
}));

test("الرفض باسم القفل ومن غير أي طلب شبكة: الخادم، مفتاح المالك، الإشعارات، النافذة، «إيقاف»، نص فاضي/طويل", async () => {
  const run = (env, opts, phone = CUST, text = "هلا") => withEnv(env, async () => { const w = world(opts); const r = await w.st.reply({ phoneNorm: phone, text, by: "x", role: "kitchen", via: "portal" });
    assert.equal(w.calls.length, 0, JSON.stringify(r)); assert.equal(w.db.msgs.length, 0); assert.equal(w.db.staff.length, 0); w.out = r; run.last = { r, w }; })();
  await run(CONFIGURED, {}); assert.deepEqual([run.last.r.error, run.last.r.gate], ["disabled", "disabled"]);
  await run({ ...CONFIGURED, WHATSAPP_ENABLED: "0" }, {}); assert.equal(run.last.r.gate, "disabled");
  await run({ WHATSAPP_ENABLED: "1" }, {}); assert.equal(run.last.r.gate, "unconfigured");
  await run(ALLOW, { settings: { waMaster: { enabled: false } } }); assert.equal(run.last.r.gate, "master_off");
  await run(ALLOW, { settings: { notifications: { whatsappEnabled: false } } }); assert.equal(run.last.r.gate, "settings_off");
  await run(ALLOW, { inbound: [] }); assert.equal(run.last.r.gate, "window_closed");
  await run(ALLOW, { optins: { [CUST]: { stopped_at: "2026-10-10T00:00:00Z" } } }); assert.equal(run.last.r.gate, "opted_out");
  await run(ALLOW, {}, CUST, "   "); assert.deepEqual([run.last.r.error, run.last.r.gate], ["empty", null]);
  await run(ALLOW, {}, CUST, "ط".repeat(4097)); assert.equal(run.last.r.error, "too_long");
  await run(ALLOW, {}, "12345"); assert.equal(run.last.r.error, "bad_phone");
  for (const g of S.GATES) assert.ok(S.GATE_AR[g], g);        // كل قفل له سطر عربي
});

test("وضع التجربة: والقناة مقفولة الرد بيعدّي لرقم تجربة بس — بنفس شرط النافذة، ومش مع القفل الصلب", async () => {
  await withEnv(CONFIGURED, async () => {          // مفتاح الخادم مش متفعّل (unset)
    const w = world({ settings: { waMaster: { enabled: false } } });
    assert.deepEqual(await w.st.sendStateFor(TESTER), { ok: true, gate: null, test: true });
    const r = await w.st.reply({ phoneNorm: TESTER, text: "تجربة رد", by: "عمر", role: "owner", via: "dashboard" });
    assert.deepEqual(r, { ok: true, wamid: "wamid.G1", test: true });
    assert.equal(w.calls[0].body.to, "966" + TESTER); assert.equal(w.db.staff[0].test, true); assert.equal(w.db.msgs[0].source, "echo");
    const c = await w.st.reply({ phoneNorm: CUST, text: "هلا", by: "عمر", role: "owner" });       // عميل حقيقي: مرفوض باسم القفل
    assert.equal(c.gate, "disabled"); assert.equal(w.calls.length, 1);
  })();
  await withEnv(CONFIGURED, async () => {          // رقم تجربة بس نافذته مقفولة
    const w = world({ inbound: [] });
    assert.equal((await w.st.reply({ phoneNorm: TESTER, text: "هلا" })).gate, "window_closed"); assert.equal(w.calls.length, 0);
    assert.deepEqual(await w.st.sendStateFor(TESTER), { ok: false, gate: "window_closed", test: true });
  })();
  await withEnv({ ...CONFIGURED, WHATSAPP_ENABLED: "0" }, async () => {     // القفل الصلب: ولا حتى رقم التجربة
    const w = world();
    assert.equal((await w.st.reply({ phoneNorm: TESTER, text: "هلا" })).gate, "disabled"); assert.equal(w.calls.length, 0);
  })();
  await withEnv(ALLOW, async () => {               // رقم تجربة وقّف الرسايل: مرفوض زي أي عميل
    const w = world({ optins: { [TESTER]: { stopped_at: "2026-10-10T00:00:00Z" } } });
    assert.equal((await w.st.reply({ phoneNorm: TESTER, text: "هلا" })).gate, "opted_out"); assert.equal(w.calls.length, 0);
  })();
});

test("ميتا رفضت الرسالة: مفيش صف رد موظف، والخطأ بيرجع من غير استثناء", withEnv(ALLOW, async () => {
  const w = world();
  w.wa.sendFreeform = async () => ({ ok: false, error: "WA_131047", code: 131047, message: "Re-engagement message" });
  const st = S.register(fakeApp(), { pool: { query: w.db && (async (sql, p) => (/FROM wa_optins/.test(sql) ? { rows: [] } : /direction='in'/.test(sql) ? { rows: [{}] } : (w.db.sql.push(sql), { rows: [] }))) }, requireAdmin: async () => null, getSettingsData: async () => ({}) },
    { wa: w.wa, hub: null, keySalt: SALT, log: { error() {} } });
  const r = await st.reply({ phoneNorm: CUST, text: "هلا" });
  assert.deepEqual([r.ok, r.error, r.gate], [false, "WA_131047", null]);
  assert.ok(!w.db.sql.some((s) => /INSERT INTO wa_staff_replies/.test(s)));
}));

test("البورتال: كاشير ومدير بس، القراءة بتشتغل والإرسال مقفول، والرد بيتسجّل باسم صاحبه", async () => {
  await withEnv(CONFIGURED, async () => {          // الإرسال مقفول: القراءة شغّالة
    const w = world();
    const list = await call(w.app, "GET /api/portal/wa/chats", { query: {} });
    assert.equal(list.status, 200); assert.equal(list.body.threads.length, 1); assert.deepEqual(list.body.send, { ok: false, gate: "disabled" }); assert.equal(list.body.role, "cashier");
    assert.deepEqual(w.hubCalls[0], ["list", { filter: "waiting", q: "", limit: undefined, before: null, full: true, me: { id: "p1", name: "سلمى", role: "cashier", via: "portal" } }]);     // الافتراضي: المستنيين موظف
    const one = await call(w.app, "GET /api/portal/wa/chats/:key", { param: { key: keyOf(CUST) } });
    assert.equal(one.status, 200); assert.deepEqual(one.body.send, { ok: false, gate: "disabled", test: false }); assert.equal(one.body.messages.length, 3);
    const bad = await call(w.app, "POST /api/portal/wa/chats/:key/reply", { param: { key: keyOf(CUST) }, json: { text: "هلا" } });
    assert.equal(bad.status, 409); assert.equal(bad.body.gate, "disabled"); assert.equal(bad.body.message, S.GATE_AR.disabled); assert.equal(w.calls.length, 0);
    assert.equal(w.audits.length, 1); assert.equal(w.audits[0][1], "wa_reply"); assert.equal(w.audits[0][3], false);
  })();
  await withEnv(ALLOW, async () => {
    const w = world({ portalUser: { id: "p2", name: "خالد", role: "manager" } });
    const ok = await call(w.app, "POST /api/portal/wa/chats/:key/reply", { param: { key: "0" + CUST }, json: { text: "تمام، جاري التجهيز" } });       // بالرقم نفسه (رابط التنبيه)
    assert.equal(ok.status, 200); assert.equal(ok.body.ok, true); assert.equal(ok.body.wamid, "wamid.G1"); assert.deepEqual(ok.body.send, { ok: true, gate: null, test: false });
    assert.deepEqual([w.db.staff[0].by_name, w.db.staff[0].role, w.db.staff[0].via], ["خالد", "manager", "portal"]);
    assert.equal(w.audits[0][3], true);
    /* الرسالة اللي اتبعتت من البورتال بتتعلّم في المحادثة؛ رد الموبايل الحقيقي يفضل echo */
    const one = await call(w.app, "GET /api/portal/wa/chats/:key", { param: { key: keyOf(CUST) } });
    assert.deepEqual(one.body.messages.map((m) => [m.id, m.source, m.staff ? m.staff.via : null]), [["wamid.G1", "staff", "portal"], ["wamid.PHONE", "echo", null], ["m-in", "api", null]]);
    assert.equal(one.body.messages[0].staff.by, "خالد");
    assert.equal((await call(w.app, "POST /api/portal/wa/chats/:key/reply", { param: { key: keyOf(CUST) }, json: { text: "" } })).status, 400);
    assert.equal((await call(w.app, "POST /api/portal/wa/chats/:key/reply", { param: { key: keyOf(CUST) }, json: "BAD" })).status, 400);
    assert.equal((await call(w.app, "GET /api/portal/wa/chats/:key", { param: { key: "0".repeat(32) } })).status, 404);
    const rd = await call(w.app, "POST /api/portal/wa/chats/:key/read", { param: { key: keyOf(CUST) } });
    assert.equal(rd.status, 200); assert.equal(w.db.read.at(-1).by, "خالد");
  })();
  for (const [user, code] of [[null, 401], [{ id: "k", name: "مطبخ", role: "kitchen" }, 403]]) {
    await withEnv(ALLOW, async () => {
      const w = world({ portalUser: user });
      for (const r of ["GET /api/portal/wa/chats", "GET /api/portal/wa/chats/:key", "POST /api/portal/wa/chats/:key/reply", "POST /api/portal/wa/chats/:key/read", "GET /api/portal/wa/quick-replies"])
        assert.equal((await call(w.app, r, { param: { key: keyOf(CUST) }, json: { text: "هلا" } })).status, code, r);
      assert.equal(w.calls.length, 0); assert.equal(w.hubCalls.length, 0);
    })();
  }
});

test("الردود السريعة = إجابات المالك للأسئلة الشائعة؛ الفاضية مش بتتعرض", withEnv(ALLOW, async () => {
  assert.deepEqual(S.quickReplies({ waBot: { faq: { halal: { ar: " نعم، كل لحومنا حلال ", en: "" }, meat: { ar: "", en: "" }, parking: { ar: "", en: "Yes" } } } }, { halal: { q: "الأكل حلال؟" } }),
    [{ key: "halal", title: "الأكل حلال؟", text: "نعم، كل لحومنا حلال", textEn: null }, { key: "parking", title: "parking", text: "Yes", textEn: "Yes" }]);
  assert.deepEqual(S.quickReplies(null), []);
  const w = world({ faq: { halal: { ar: "نعم، كل لحومنا حلال", en: "" } } });
  const p = await call(w.app, "GET /api/portal/wa/quick-replies"); assert.equal(p.body.replies.length, 1); assert.equal(p.body.replies[0].text, "نعم، كل لحومنا حلال");
  const d = await call(w.app, "GET /api/cms/wa/threads-quick"); assert.equal(d.body.replies[0].key, "halal");
}));

test("cleanText", () => {
  assert.deepEqual(S.cleanText(" هلا \r\n وسهلا "), { ok: true, body: "هلا \n وسهلا" });
  assert.equal(S.cleanText(null).error, "empty"); assert.equal(S.cleanText("x".repeat(4096)).ok, true); assert.equal(S.cleanText("x".repeat(4097)).error, "too_long");
});
