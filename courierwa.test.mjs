/* CW1 (١٦/١٠) — أزرار المندوب الخارجي على واتساب (courierwa.js + حارس القالب في whatsapp.js).
   node --test courierwa.test.mjs — أرقام وهمية بس. */
import test from "node:test";
import assert from "node:assert/strict";
import * as CW from "./courierwa.js";
import * as W from "./whatsapp.js";
import * as CAT from "./watemplates.js";

W.registerCatalog(CAT);

const COURIER = "500000731";       // جوال مندوب وهمي
const OTHER = "500000732";
const HASH = "a".repeat(64), HASH2 = "b".repeat(64);
const runOf = (x = {}) => ({ id: 41, shipment_id: 9, order_no: "W1790000000041", token_hash: HASH, courier_name: "سالم", courier_phone: `0${COURIER}`,
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(),
  started_at: null, arrived_at: null, delivered_at: null, revoked_at: null, wa_phone: null, wa_sent_at: null, ...x });
const ORDER = { order_no: "W1790000000041", total: 88.5, option: "delivery", status: "courier_assigned", phone_norm: "500000799",
  customer: { name: "عميل تجربة", phone: "0500000799" },
  address: { area: "السلامة", street: "شارع تجربة", building: "3", latitude: 21.6147, longitude: 39.1450, delivery_notes: "البوابة الخلفية", leave_at_door: false } };

/* ── الإعدادات ─────────────────────────────────────────────────────────── */
test("config: defaults on (free messages), template off until Meta approves", () => {
  const c = CW.courierJobConfig({});
  assert.equal(c.enabled, true); assert.equal(c.useTemplate, false); assert.equal(c.templateName, "fc_courier_job_v1");
  assert.equal(c.confirmMin, 3);
  assert.equal(CW.courierJobConfig({ enabled: false, confirmMin: 99 }).confirmMin, 30);
  const ok = CW.courierJobFromBody({ useTemplate: true, confirmMin: 0 }, c);
  assert.equal(ok.ok, true); assert.equal(ok.value.useTemplate, true); assert.equal(ok.value.confirmMin, 0);
  assert.equal(CW.courierJobFromBody({ templateName: "fc_other" }, c).ok, false);
  assert.equal(CW.courierJobFromBody({ enabled: "yes" }, c).ok, false);
  assert.equal(CW.courierJobFromBody({ nope: true }, c).ok, false);
  for (const [k, s] of Object.entries(CW.COURIER_JOB_SCHEMA)) {
    assert.ok(k.startsWith("courierJob."), k);
    assert.ok(s.ar && s.help, `${k}: Arabic label + explanation`);
  }
});

/* ── التوقيع ───────────────────────────────────────────────────────────── */
test("payload: signed per run+action+token; tampering, other run, new token ⇒ rejected", () => {
  const run = runOf();
  const pl = CW.cwPayload(run, "p");
  assert.match(pl, /^cw1\.41\.p\.[A-Za-z0-9]{16}$/);
  assert.ok(pl.length <= 256);
  const p = CW.parseCwPayload(pl);
  assert.deepEqual([p.runId, p.act], [41, "p"]);
  assert.equal(CW.verifyCw(p, run), true);
  assert.equal(CW.verifyCw({ ...p, act: "d" }, run), false, "same sig, other action");
  assert.equal(CW.verifyCw(p, { ...run, id: 42 }), false, "other run");
  assert.equal(CW.verifyCw(p, { ...run, token_hash: HASH2 }), false, "«رابط جديد» kills old buttons");
  assert.equal(CW.verifyCw({ ...p, sig: "A".repeat(16) }, run), false);
  assert.equal(CW.parseCwPayload("cw1.41.p.short"), null);
  assert.equal(CW.parseCwPayload("استلمت الطلب"), null);
  assert.equal(CW.parseCwPayload("cw1.41.z.AAAAAAAAAAAAAAAA"), null);
});

test("opener code: wa.me line to our number carries a signed run code", () => {
  const run = runOf();
  const line = CW.openerLine(run, run.order_no, "966500000700");
  assert.match(line, /https:\/\/wa\.me\/966500000700\?text=/);
  const text = decodeURIComponent(line.split("?text=")[1]);
  const o = CW.parseOpener(text);
  assert.equal(o.runId, 41);
  assert.equal(CW.verifyOpener(o, run), true);
  assert.equal(CW.verifyOpener(o, { ...run, token_hash: HASH2 }), false);
  assert.equal(CW.parseOpener("أبي أطلب"), null);
});

/* ── الأزرار والنصوص ───────────────────────────────────────────────────── */
test("buttons: stage flow, never more than 3, titles fit Meta's 20 chars", () => {
  const cfg = CW.courierJobConfig({});
  assert.deepEqual(CW.buttonsFor("new", cfg), ["p", "x"]);
  assert.deepEqual(CW.buttonsFor("started", cfg), ["a", "d", "x"]);
  assert.deepEqual(CW.buttonsFor("arrived", cfg), ["d", "x"]);
  assert.deepEqual(CW.buttonsFor("delivered", cfg), []);
  assert.deepEqual(CW.buttonsFor("started", CW.courierJobConfig({ arrivedButton: false, problemButton: false })), ["d"]);
  for (const t of Object.values(CW.BTN)) { assert.ok([...t].length <= 20, t); assert.equal(CAT.buttonTextProblem(t), null, t); }
  const m = CW.cwMessage("body", ["a", "d", "x"], runOf());
  assert.equal(m.type, "interactive");
  assert.equal(m.interactive.action.buttons.length, 3);
  assert.ok(m.interactive.action.buttons.every((b) => CW.verifyCw(CW.parseCwPayload(b.reply.id), runOf())));
  assert.equal(CW.cwMessage("شكراً", [], runOf()).type, "text");
});

test("job card: same essentials as the courier API text (address, map, door notes, prepaid), ≤1024 chars", () => {
  const t = CW.jobCardText(ORDER, { link: "https://freshcuts.sa/d/tok" });
  assert.ok(t.includes(ORDER.order_no));
  assert.ok(t.includes("https://maps.google.com/?q=21.614700,39.145000"));
  assert.ok(t.includes("البوابة الخلفية"));
  assert.ok(t.includes("مدفوع مسبقاً"));
  assert.ok(t.includes("استلمت الطلب"));
  assert.ok([...t].length <= 1024);
});

test("template params: 5 body values + 3 signed quick replies; payload carries them as quick_reply buttons", () => {
  const run = runOf();
  const p = CW.templateParams(ORDER, run);
  assert.equal(p.body.length, 5);
  assert.equal(W.paramProblem("fc_courier_job_v1", p), null);
  const pl = W.buildTemplatePayload("fc_courier_job_v1", "966500000731", p, "ar");
  const qr = pl.template.components.filter((c) => c.sub_type === "quick_reply");
  assert.deepEqual(qr.map((c) => c.index), ["0", "1", "2"]);
  assert.deepEqual(qr.map((c) => CW.parseCwPayload(c.parameters[0].payload).act), ["p", "a", "d"]);
  assert.equal(W.TEMPLATES.fc_courier_job_v1.group, "courier");
  assert.equal(W.TEMPLATES.fc_courier_job_v1.category, "UTILITY");
});

/* ── التكامل: register() بعالم وهمي ──────────────────────────────────────── */
function rig({ run = runOf(), window = true, cfg = {}, sendFails = false } = {}) {
  const state = { run: { ...run }, sends: [], templates: [], stages: [], updates: [], claims: [] };
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ");
    if (/^ ?ALTER TABLE/i.test(s.trim())) return { rows: [] };
    if (/FROM dl_ext_runs r JOIN dl_shipments sh ON sh.id = r.shipment_id WHERE r.order_no=\$1/.test(s)) return { rows: p[0] === state.run.order_no ? [{ ...state.run }] : [] };
    if (/right\(regexp_replace/.test(s)) {
      const r = state.run; const ph = String(r.courier_phone || "").replace(/\D/g, "").slice(-9);
      const live = !r.revoked_at && !r.delivered_at && new Date(r.expires_at).getTime() > Date.now();
      return { rows: ph === p[0] && live ? [{ ...r }] : [] };
    }
    if (/^ ?UPDATE dl_ext_runs SET wa_phone/.test(s)) { state.run.wa_phone = p[1]; if (p[4]) state.run.wa_sent_at = new Date().toISOString(); state.updates.push(p); return { rows: [] }; }
    if (/^ ?UPDATE dl_ext_runs SET courier_phone/.test(s)) { state.run.courier_phone = p[1]; return { rows: [] }; }
    if (/^ ?UPDATE dl_ext_runs SET problem_at/.test(s)) { state.run.problem_at = new Date().toISOString(); return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  } };
  const wa = {
    hooks: [],
    on(ev, fn) { if (ev === "claim") this.hooks.push(fn); },
    async sendFreeform(x) { state.sends.push(x); if (sendFails) return { ok: false, error: "WA_500" }; return window ? { ok: true, wamid: `w${state.sends.length}` } : { ok: false, skipped: "window_closed" }; },
    async sendTemplate(x) { state.templates.push(x); return { ok: true, wamid: "t1" }; },
  };
  const courierLive = {
    ensureSchema: async () => true,
    runById: async (id) => (Number(id) === Number(state.run.id) ? { ...state.run } : null),
    extStart: async () => { state.stages.push("start"); state.run.started_at = state.run.started_at || new Date().toISOString(); return { ok: true }; },
    extArrived: async () => { state.stages.push("arrived"); state.run.arrived_at = new Date().toISOString(); return { ok: true }; },
    extDelivered: async () => { state.stages.push("delivered"); state.run.delivered_at = new Date().toISOString(); return { ok: true, stage: "delivered" }; },
  };
  const events = [];
  const api = CW.register({ post() {} }, { pool, getSettingsData: async () => ({ waBot: { courierJob: cfg } }), jb: JSON.stringify, log: { error() {}, warn() {} } },
    { wa, courierLive, shop: { getOrderRow: async (no) => (no === ORDER.order_no ? { ...ORDER } : null) }, portal: { scheduleRefresh() {}, push: { sendToSubs: async (pl, o) => { state.push = { pl, o }; return { sent: 1 }; } } },
      emitOrder: (n, e) => events.push(e), boot: false });
  state.events = events;
  const tap = (act, from = COURIER, r = state.run) => wa.hooks[0]({ phoneNorm: from, interactiveId: CW.cwPayload(r, act), text: CW.BTN[act], type: "interactive" });
  return { api, state, wa, tap };
}

test("sendJob: window open ⇒ free interactive message with «استلمت الطلب» + «عندي مشكلة», logged on the order", async () => {
  const { api, state } = rig();
  const r = await api.sendJob(ORDER.order_no, { link: "https://freshcuts.sa/d/x", by: "مدير" });
  assert.equal(r.sent, true); assert.equal(r.via, "free");
  assert.equal(state.sends.length, 1);
  const s = state.sends[0];
  assert.equal(s.phoneNorm, COURIER); assert.equal(s.source, "courier");
  assert.equal(s.orderNo, undefined, "not an order message for the customer reports (wapolicy) — the order timeline gets its own line");
  assert.ok(s.preview.includes(ORDER.order_no));
  assert.deepEqual(s.payload.interactive.action.buttons.map((b) => b.reply.title), ["استلمت الطلب", "عندي مشكلة"]);
  assert.ok(state.events.some((e) => /واتساب بالأزرار/.test(e.summary)));
});

test("sendJob: window closed + template off ⇒ not sent (portal falls back to wa.me); template on ⇒ courier template", async () => {
  const a = rig({ window: false });
  const r = await a.api.sendJob(ORDER.order_no, {});
  assert.equal(r.sent, false); assert.equal(r.reason, "window_closed"); assert.equal(r.opener, true);
  assert.equal(a.state.templates.length, 0);
  const b = rig({ window: false, cfg: { useTemplate: true } });
  const r2 = await b.api.sendJob(ORDER.order_no, {});
  assert.equal(r2.sent, true); assert.equal(r2.via, "template");
  assert.equal(b.state.templates[0].courier, true);
  assert.equal(b.state.templates[0].template, "fc_courier_job_v1");
  assert.equal(b.state.templates[0].params.quickReplies.length, 3);
});

test("sendJob: disabled / no phone / non-Saudi / revoked ⇒ nothing sent", async () => {
  assert.equal((await rig({ cfg: { enabled: false } }).api.sendJob(ORDER.order_no)).reason, "disabled");
  assert.equal((await rig({ run: runOf({ courier_phone: null }) }).api.sendJob(ORDER.order_no)).reason, "no_phone");
  assert.equal((await rig({ run: runOf({ courier_phone: "+201000000731" }) }).api.sendJob(ORDER.order_no)).reason, "not_saudi_mobile");
  const rv = rig({ run: runOf({ revoked_at: new Date().toISOString() }) });
  assert.equal((await rv.api.sendJob(ORDER.order_no)).reason, "not_live");
  assert.equal(rv.state.sends.length, 0);
});

test("taps: «استلمت» ⇒ picked + next buttons; «وصلت» ⇒ arrived; early «تم التسليم» asks to confirm; «إيه، سلّمته» ⇒ delivered", async () => {
  const { state, tap } = rig();
  assert.equal(await tap("p"), true);
  assert.deepEqual(state.stages, ["start"]);
  assert.deepEqual(state.sends.at(-1).payload.interactive.action.buttons.map((b) => b.reply.title), ["وصلت عند العميل", "تم التسليم", "عندي مشكلة"]);
  await tap("a");
  assert.deepEqual(state.stages, ["start", "arrived"]);
  await tap("d");      // بعد الاستلام بثواني ⇒ تأكيد
  assert.deepEqual(state.stages, ["start", "arrived"]);
  assert.deepEqual(state.sends.at(-1).payload.interactive.action.buttons.map((b) => b.reply.title), ["إيه، سلّمته", "لا، لسا"]);
  await tap("D");
  assert.deepEqual(state.stages, ["start", "arrived", "delivered"]);
  assert.equal(state.sends.at(-1).payload.type, "text");
  await tap("p");      // بعد التسليم: مفيش مرحلة تانية
  assert.deepEqual(state.stages, ["start", "arrived", "delivered"]);
  assert.match(state.sends.at(-1).payload.text.body, /متسلّم من قبل/);
});

test("taps: «تم التسليم» with confirmMin 0 ⇒ delivered at once; «وصلت» before «استلمت» also starts the run", async () => {
  const a = rig({ cfg: { confirmMin: 0 } });
  await a.tap("d");
  assert.deepEqual(a.state.stages, ["delivered"]);
  const b = rig();
  await b.tap("a");
  assert.deepEqual(b.state.stages, ["start", "arrived"]);
});

test("taps: wrong phone, forged sig, revoked, expired ⇒ no stage change (and the bot stays quiet)", async () => {
  const a = rig();
  assert.equal(await a.tap("p", OTHER), true);
  assert.deepEqual(a.state.stages, []);
  assert.equal(await a.wa.hooks[0]({ phoneNorm: COURIER, interactiveId: "cw1.41.p.AAAAAAAAAAAAAAAA" }), true);
  assert.deepEqual(a.state.stages, []);
  const rv = rig({ run: runOf({ revoked_at: new Date().toISOString() }) });
  await rv.tap("p");
  assert.deepEqual(rv.state.stages, []);
  assert.match(rv.state.sends.at(-1).payload.text.body, /ما عاد مسجّل عليك/);
  const ex = rig({ run: runOf({ expires_at: new Date(Date.now() - 1000).toISOString(), started_at: new Date(Date.now() - 3600_000).toISOString() }) });
  await ex.tap("p");
  assert.deepEqual(ex.state.stages, []);
  await ex.tap("d");      // التسليم بيعدّي بعد الانتهاء (نفس قاعدة /d/)
  assert.deepEqual(ex.state.stages, ["delivered"]);
});

test("«عندي مشكلة» ⇒ manager push + order timeline, reply keeps the stage buttons", async () => {
  const { state, tap } = rig();
  await tap("x");
  assert.equal(state.push.o.role, "manager");
  assert.match(state.push.pl.title, /مشكلة/);
  assert.ok(state.events.some((e) => /عندي مشكلة/.test(e.summary)));
  assert.deepEqual(state.sends.at(-1).payload.interactive.action.buttons.map((b) => b.reply.title), ["استلمت الطلب"]);
});

test("inbound: courier on a live run ⇒ claimed (bot quiet) + card once per 10 min; strangers untouched", async () => {
  const { state, wa } = rig();
  assert.equal(await wa.hooks[0]({ phoneNorm: COURIER, text: "السلام عليكم وصلت المطعم" }), true);
  assert.equal(state.sends.length, 1);
  assert.equal(await wa.hooks[0]({ phoneNorm: COURIER, text: "؟" }), true);
  assert.equal(state.sends.length, 1, "no second card within 10 minutes");
  assert.equal(await wa.hooks[0]({ phoneNorm: OTHER, text: "أبي أطلب" }), false);
  assert.equal(await wa.hooks[0]({ phoneNorm: COURIER, isEcho: true, text: "x" }), false);
});

test("opener: a group-posted run with no phone binds the first sender, then a second sender is refused", async () => {
  const { state, wa } = rig({ run: runOf({ courier_phone: null }) });
  const msg = decodeURIComponent(CW.openerLine(state.run, state.run.order_no).split("?text=")[1]);
  assert.equal(await wa.hooks[0]({ phoneNorm: COURIER, text: msg }), true);
  assert.equal(state.run.courier_phone, `0${COURIER}`);
  assert.equal(state.sends.at(-1).phoneNorm, COURIER);
  assert.equal(state.sends.at(-1).payload.type, "interactive");
  assert.equal(await wa.hooks[0]({ phoneNorm: OTHER, text: msg }), true);
  assert.match(state.sends.at(-1).payload.text.body, /مندوب ثاني/);
});

test("opener: a run registered to a non-Saudi number is never taken over by whoever holds the code", async () => {
  const { state, wa } = rig({ run: runOf({ courier_phone: "+201000000731" }) });
  const msg = decodeURIComponent(CW.openerLine(state.run, state.run.order_no).split("?text=")[1]);
  assert.equal(await wa.hooks[0]({ phoneNorm: OTHER, text: msg }), true);
  assert.equal(state.run.courier_phone, "+201000000731");
  assert.match(state.sends.at(-1).payload.text.body, /مندوب ثاني/);
});

test("inbound courier text lands in the order timeline without long numbers", async () => {
  const { state, wa } = rig();
  await wa.hooks[0]({ phoneNorm: COURIER, text: "العميل ما يرد رقمه 0500000799" });
  const e = state.events.find((x) => /رسالة من المندوب/.test(x.summary));
  assert.ok(e); assert.ok(!/0500000799/.test(e.summary));
});

/* ── حارس القالب في whatsapp.js ─────────────────────────────────────────── */
function waWorld({ live = true } = {}) {
  const db = { settings: { notifications: { whatsappEnabled: true }, waMaster: { enabled: true } }, msgs: [] };
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/FROM dl_ext_runs WHERE right\(regexp_replace/.test(s)) return { rows: live && p[0] === COURIER ? [{}] : [] };
    if (/^INSERT INTO wa_messages/i.test(s)) { db.msgs.push(p); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.C1" }] }) }; };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: JSON.stringify,
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register({ get() {}, post() {}, put() {}, delete() {} }, ctx, { fetch, sendSms: async () => ({ ok: true }) });
  return { wa, calls, db };
}
const ENV = { WHATSAPP_ENABLED: "1", WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1" };
const withEnv = (fn) => async () => {
  const saved = {}; for (const k of Object.keys(ENV)) { saved[k] = process.env[k]; process.env[k] = ENV[k]; }
  try { await fn(); } finally { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

test("guard: courier template only to a phone on a live external run, only courier-group UTILITY templates", withEnv(async () => {
  const { wa, calls } = waWorld();
  const params = CW.templateParams(ORDER, runOf());
  const ok = await wa.sendTemplate({ phoneNorm: COURIER, template: "fc_courier_job_v1", params, orderNo: ORDER.order_no, source: "courier", courier: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.template.components.filter((c) => c.sub_type === "quick_reply").length, 3);
  const stranger = await wa.sendTemplate({ phoneNorm: OTHER, template: "fc_courier_job_v1", params, source: "courier", courier: true });
  assert.equal(stranger.skipped, "not_courier");
  const wrongTpl = await wa.sendTemplate({ phoneNorm: COURIER, template: "fc_order_preparing", params: W.TEMPLATES.fc_order_preparing.bind({ order_no: "W1" }), courier: true });
  assert.equal(wrongTpl.skipped, "not_courier_template");
  const noFlag = await wa.sendTemplate({ phoneNorm: COURIER, template: "fc_courier_job_v1", params, source: "courier" });
  assert.equal(noFlag.skipped, "no_optin", "without courier:true it is just a stranger with no consent");
  assert.equal(calls.length, 1);
  const dead = waWorld({ live: false });
  assert.equal((await dead.wa.sendTemplate({ phoneNorm: COURIER, template: "fc_courier_job_v1", params, courier: true })).skipped, "not_courier");
}));

test("claim hook: a claimed inbound never reaches the bot runtime", withEnv(async () => {
  const { wa } = waWorld();
  let botSaw = 0;
  wa.setBotRuntime(async () => { botSaw++; return true; });
  wa.on("claim", async (ev) => ev.interactiveId === "cw1.mine");
  const body = (id, wamid) => ({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PHONE1" },
    messages: [{ from: "966500000731", id: wamid, timestamp: "1760000000", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "استلمت الطلب" } } }] } }] }] });
  await wa.processWebhook(body("cw1.mine", "wamid.IN1"));
  assert.equal(botSaw, 0);
  await wa.processWebhook(body("other", "wamid.IN2"));
  assert.equal(botSaw, 1);
}));
