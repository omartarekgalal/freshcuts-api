// WO (12/10): consent for «order updates on WhatsApp» — an actual choice by the customer on an OTP-verified number, stored
// with time, wording version, the wording itself and the source. Recording only: nothing is sent.
// Run: node --test waconsent.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
const WC = await import("./waconsent.js");
const shop = readFileSync(new URL("./shop.js", import.meta.url), "utf8");
const wasrc = readFileSync(new URL("./whatsapp.js", import.meta.url), "utf8");
const index = readFileSync(new URL("./index.js", import.meta.url), "utf8");

function fakePool(seed = {}) {
  const db = { optins: { ...seed }, log: [] };
  return { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE IF NOT EXISTS wa_optins/i.test(s)) return { rows: [] };
    if (/^INSERT INTO wa_optins/i.test(s)) {
      const prev = db.optins[p[0]] || { marketing: false, order_no: null };
      db.optins[p[0]] = { ...prev, updates: p[1], source: p[2], order_no: p[3] ?? prev.order_no, updates_answered_at: new Date().toISOString(), updates_version: p[4] };
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT INTO wa_optin_log/i.test(s)) { db.log.push({ phone: p[0], kind: "updates", value: p[1], version: p[2], text: p[3], source: p[4], order_no: p[5], ip: p[6], ua: p[7] }); return { rows: [] }; }
    if (/^SELECT updates, updates_answered_at, updates_version FROM wa_optins/i.test(s)) return { rows: db.optins[p[0]] ? [db.optins[p[0]]] : [] };
    throw new Error("unexpected SQL: " + s.slice(0, 70));
  } };
}
const PN = "512345678";
const V = WC.WA_UPDATES_CURRENT;

test("the wording says who writes, what is sent, on which channel, and how to stop — and names the business", () => {
  const t = WC.WA_UPDATES_TEXTS[V];
  assert.match(t.ar, /فريش كاتس/); assert.match(t.ar, /واتساب/);
  assert.match(t.ar, /تأكيد الطلب/); assert.match(t.ar, /جاهزيته/); assert.match(t.ar, /المندوب/);
  assert.match(t.ar, /توقفها في أي وقت/); assert.match(t.ar, /«إيقاف»/);
  assert.match(t.en, /Fresh Cuts/); assert.match(t.en, /WhatsApp/); assert.match(t.en, /Stop any time/);
  for (const w of ["عروض", "خصم", "تسويق"]) assert.ok(!t.ar.includes(w), "this consent is for order updates only, not marketing: " + w);
  for (const w of ["دلوقتي", "عايز", "مش ", "بتاع", "كده"]) assert.ok(!(t.ar + t.yes + t.no).includes(w), "white dialect: " + w);
  assert.ok(Object.isFrozen(WC.WA_UPDATES_TEXTS) && Object.isFrozen(t), "a recorded wording never changes — a new wording is a new version");
});

test("only a real choice with a known wording version counts", () => {
  assert.deepEqual(WC.parseWaUpdates({ updates: true, version: V, source: "otp_step" }), { value: true, version: V, source: "otp_step" });
  assert.deepEqual(WC.parseWaUpdates({ updates: false, version: V, source: "summary" }), { value: false, version: V, source: "summary" });
  assert.equal(WC.parseWaUpdates({ updates: "true", version: V }), null, "a string is not a choice");
  assert.equal(WC.parseWaUpdates({ updates: 1, version: V }), null);
  assert.equal(WC.parseWaUpdates({ version: V }), null, "no answer ⇒ nothing is recorded (never a default)");
  assert.equal(WC.parseWaUpdates({ updates: true }), null, "no wording version ⇒ no proof ⇒ not recorded");
  assert.equal(WC.parseWaUpdates({ updates: true, version: "made-up" }), null);
  assert.equal(WC.parseWaUpdates({ updates: true, version: V, source: "evil" }).source, "checkout", "unknown source falls back to a neutral one");
  assert.equal(WC.parseWaUpdates(null), null);
});

test("recording: the choice, the time, the version, the wording, the source, the order, ip and ua — yes and no alike", async () => {
  WC._resetSchemaForTests();
  const pool = fakePool();
  let r = await WC.recordWaUpdates(pool, { phoneNorm: PN, answer: { value: true, version: V, source: "otp_step" }, orderNo: "W1", ip: "51.36.1.1", ua: "Mozilla/5.0 (iPhone)" });
  assert.deepEqual(r, { ok: true, updates: true, version: V });
  assert.equal(pool.db.optins[PN].updates, true);
  assert.ok(pool.db.optins[PN].updates_answered_at);
  assert.equal(pool.db.optins[PN].updates_version, V);
  assert.deepEqual(pool.db.log[0], { phone: PN, kind: "updates", value: true, version: V, text: WC.WA_UPDATES_TEXTS[V].ar, source: "otp_step", order_no: "W1", ip: "51.36.1.1", ua: "Mozilla/5.0 (iPhone)" });
  // «لا» is recorded too — that is what stops us from asking again
  r = await WC.recordWaUpdates(pool, { phoneNorm: PN, answer: { value: false, version: V, source: "summary" } });
  assert.equal(pool.db.optins[PN].updates, false);
  assert.equal(pool.db.log.length, 2, "every answer is a new proof row; nothing is overwritten");
  assert.equal(pool.db.optins[PN].order_no, "W1", "an answer without an order keeps the earlier order reference");
  assert.equal(pool.db.optins[PN].marketing, false, "marketing consent is not touched");
});

test("recording refuses anything that is not a verified-shape phone or a real answer", async () => {
  WC._resetSchemaForTests();
  const pool = fakePool();
  assert.equal((await WC.recordWaUpdates(pool, { phoneNorm: "0512345678", answer: { value: true, version: V, source: "summary" } })).error, "invalid_phone");
  assert.equal((await WC.recordWaUpdates(pool, { phoneNorm: PN, answer: null })).error, "bad_answer");
  assert.equal((await WC.recordWaUpdates(pool, { phoneNorm: PN, answer: { value: true, version: "x", source: "summary" } })).error, "bad_answer");
  assert.equal(pool.db.log.length, 0);
});

test("state: never asked / answered yes / answered no / an old opt-in from before this slice", async () => {
  WC._resetSchemaForTests();
  const pool = fakePool({ "500000002": { updates: true, updates_answered_at: null, updates_version: null }, "500000003": { updates: false, updates_answered_at: null, updates_version: null } });
  assert.deepEqual(await WC.waUpdatesState(pool, PN), { answered: false, updates: null, version: null, at: null });
  await WC.recordWaUpdates(pool, { phoneNorm: PN, answer: { value: false, version: V, source: "summary" } });
  const st = await WC.waUpdatesState(pool, PN);
  assert.equal(st.answered, true); assert.equal(st.updates, false, "answered «no» ⇒ do not ask again");
  assert.deepEqual((({ answered, updates }) => ({ answered, updates }))(await WC.waUpdatesState(pool, "500000002")), { answered: true, updates: true }, "an existing opt-in is respected");
  assert.deepEqual((({ answered, updates }) => ({ answered, updates }))(await WC.waUpdatesState(pool, "500000003")), { answered: false, updates: null }, "a default-false row with no answer time = never asked ⇒ ask once");
});

/* ── routes: the phone comes from the verified session, never from the body ── */
function mk(session = PN) {
  WC._resetSchemaForTests();
  const pool = fakePool();
  const app = new Hono();
  WC.register(app, { pool }, { customerOf: async (c) => ((c.req.header("Authorization") || "") === "Bearer cust:ok" && session ? { phone_norm: session } : null) });
  const call = async (method, body, auth = true, extra = {}) => {
    const r = await app.request("/api/account/wa-updates", { method, headers: { "content-type": "application/json", ...(auth ? { Authorization: "Bearer cust:ok" } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { pool, call };
}

test("GET: a logged-in customer learns whether the question was already answered; a guest gets 401", async () => {
  const { call } = mk();
  assert.equal((await call("GET", undefined, false)).status, 401);
  const r = await call("GET");
  assert.deepEqual(r.body, { ok: true, answered: false, updates: null, version: V });
});

test("POST: the answer is stored for the SESSION's phone with ip and ua; a phone in the body is ignored", async () => {
  const { call, pool } = mk();
  assert.equal((await call("POST", { updates: true, version: V }, false)).status, 401);
  assert.equal((await call("POST", { updates: "yes", version: V })).status, 400);
  assert.equal((await call("POST", { updates: true })).status, 400, "no wording version");
  const r = await call("POST", { updates: true, version: V, source: "otp_step", phone: "599999999" }, true, { "cf-connecting-ip": "51.36.2.2", "user-agent": "UA-test" });
  assert.deepEqual(r.body, { ok: true, updates: true, version: V });
  assert.ok(pool.db.optins[PN] && !pool.db.optins["599999999"]);
  assert.equal(pool.db.log[0].ip, "51.36.2.2"); assert.equal(pool.db.log[0].ua, "UA-test"); assert.equal(pool.db.log[0].source, "otp_step");
  assert.deepEqual((await call("GET")).body, { ok: true, answered: true, updates: true, version: V });
});

test("checkout: the answer travels with the order and is recorded with its proof; marketing stays a separate path", () => {
  const i = shop.indexOf("const waAnswer = parseWaUpdates({ updates: b.waUpdates, version: b.waUpdatesVersion,");
  assert.ok(i > 0);
  const seg = shop.slice(i, i + 900);
  assert.ok(seg.includes("recordWaUpdates(pool, { phoneNorm, answer: waAnswer, orderNo,"));
  assert.ok(seg.includes('if (wa() && typeof b.waMarketing === "boolean")'), "marketing opt-in is not mixed into the updates answer");
  assert.ok(!seg.includes("updates: typeof b.waUpdates"), "the old path that stored updates without proof is gone");
  assert.ok(index.includes("waconsent.register(app, moduleCtx, { customerOf: (c) => accountsApi.customerOf(c) });"));
});

test("the public /api/wa/optin can no longer turn consent ON for an arbitrary phone", () => {
  const i = wasrc.indexOf('app.post("/api/wa/optin"');
  const seg = wasrc.slice(i, i + 1100);
  assert.ok(seg.includes('if (b.updates === true || b.marketing === true) return c.json({ ok: false, error: "optin_needs_verified_phone" }, 403);'));
  assert.ok(seg.includes("updates: b.updates === false ? false : undefined"), "withdrawing is still possible without logging in");
});

test("nothing here sends: the module never touches the send path", () => {
  const src = readFileSync(new URL("./waconsent.js", import.meta.url), "utf8");
  for (const w of ["sendTemplate", "sendText", "graph.facebook.com", "/messages", "fetch("]) assert.ok(!src.includes(w), w);
});
