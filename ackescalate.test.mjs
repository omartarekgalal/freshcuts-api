/* 🔔 RG2 — طلب جديد ما اتشافش ⇒ تصعيد · node --test ackescalate.test.mjs
   قاعدة وهمية + ساعة وهمية + واتساب/SMS/إشعار وهميين — أرقام وهمية بس (5000000xx)، مفيش شبكة ولا إرسال. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ackEscCfg, ACK_ESC_DEFAULTS, ackStateOf, decide, restaurantClosed, makeAckEscalator, register, SQL,
  staffWaText, staffTplLine, staffSms, pushFor, waitAr,
} from "./ackescalate.js";
import { smsInfo } from "./staffalerts.js";
import { buildTimeline } from "./portal-core.js";
import { ORDER_EVENTS, buildOrderEvent } from "./order-events.js";
import { FIELD_BY_PATH, validatePatch, effectiveOf } from "./deliverycontrol.js";
import { shapeKpis, collect, kpiTargets, kpiRange, directoryOf, SQL as KPI_SQL, SOURCE_AR } from "./staffkpi.js";

const PRE = ["paid", "pos_created", "paid_pos_failed"];
const ms = (v) => (v == null ? NaN : new Date(v).getTime());
const iso = (v) => new Date(v).toISOString();
const ALL_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const HOURS = { enabled: true, days: Object.fromEntries(ALL_DAYS.map((d) => [d, { open: "13:00", close: "02:00" }])) };
const TEAM = { members: [
  { phone: "0500000011", name: "منى", role: "cashier" }, { phone: "0500000012", name: "أحمد", role: "manager" },
  { phone: "0500000013", name: "عمر", role: "owner" }, { phone: "0500000015", name: "قديم", role: "cashier", active: false }] };
const SETTINGS = () => ({ hours: HOURS, waTeam: TEAM, delivery: { alertPhones: ["0500000013", "0500000014"], staffSmsLanguage: "en" } });

/* ── قاعدة وهمية بتفهم استعلامات RG2 بالعلامة ── */
function fakeDb() {
  const orders = new Map(), esc = new Map(), webhooks = new Map(), pushLog = [];
  const queries = [];
  const paidAt = (o) => { const h = (o.history || []).find((x) => x.status === "paid"); return h ? h.at : o.created_at; };
  const pool = {
    orders, esc, webhooks, pushLog, queries,
    async query(sql, p = []) {
      const s = String(sql).trim();
      queries.push([s, p]);
      if (/^CREATE /i.test(s)) return { rows: [], rowCount: 0 };
      if (/^UPDATE portal_push_log/.test(s)) { pushLog.push(p); return { rows: [], rowCount: 1 }; }
      const tag = (/^\/\*rg2:(\w+)\*\//.exec(s) || [])[1];
      switch (tag) {
        case "stale": { let n = 0; for (const e of esc.values()) if (!e.stopped_at && ms(e.started_at) < ms(p[1])) { e.stopped_at = p[0]; e.stop_reason = "too_old"; n++; } return { rows: [], rowCount: n }; }
        case "candidates": {
          const rows = [];
          for (const o of orders.values()) {
            if (!(ms(o.created_at) > ms(p[0]))) continue;
            const e = esc.get(o.order_no);
            const waiting = PRE.includes(o.status) && !o.portal_ack_at && !o.accepted_at && !o.is_test;
            if (!(waiting || (e && !e.stopped_at && e.step > 0))) continue;
            rows.push({ ...o, is_test: Boolean(o.is_test), paid_at: paidAt(o), esc_step: e ? e.step : null, esc_stopped_at: e ? e.stopped_at : null });
          }
          return { rows, rowCount: rows.length };
        }
        case "approval": { const a = webhooks.get(String(p[0])); return { rows: a ? [{ a }] : [], rowCount: a ? 1 : 0 }; }
        case "claim": {
          const e = esc.get(p[0]);
          if (!e) { esc.set(p[0], { order_no: p[0], paid_at: p[1], step: p[2], steps: [], started_at: p[3], updated_at: p[3], stopped_at: null }); return { rows: [{ order_no: p[0] }], rowCount: 1 }; }
          if (e.step < p[2] && !e.stopped_at) { e.step = p[2]; e.updated_at = p[3]; return { rows: [{ order_no: p[0] }], rowCount: 1 }; }
          return { rows: [], rowCount: 0 };
        }
        case "record": { const e = esc.get(p[0]); if (e) e.steps.push(...JSON.parse(p[1])); return { rows: [], rowCount: e ? 1 : 0 }; }
        case "stop": {
          const e = esc.get(p[0]);
          if (!e || e.stopped_at) return { rows: [], rowCount: 0 };
          Object.assign(e, { stopped_at: p[1], stop_reason: p[2], stopped_after_sec: p[3] });
          return { rows: [{ step: e.step }], rowCount: 1 };
        }
        case "recent": return { rows: [...esc.values()].slice(0, p[0]), rowCount: esc.size };
        default: throw new Error(`unexpected SQL: ${s.slice(0, 80)}`);
      }
    },
  };
  return pool;
}
function world({ settings = SETTINGS(), team = true, pushClaims = null } = {}) {
  const pool = fakeDb();
  const clock = { t: new Date("2026-10-18T20:22:55Z") };   // = ٢٣:٢٢:٥٥ الرياض (لحظة دفع W1792354906756)
  const pushes = [], staff = [], sms = [], events = [];
  const claimed = pushClaims || new Set();
  const push = { PORTAL_URL: "https://example.test/portal/",
    async claim(no, key) { const k = `${no}|${key}`; if (claimed.has(k)) return false; claimed.add(k); return true; },
    async sendToSubs(payload) { pushes.push(payload); return { sent: 6, of: 6 }; } };
  const teamApi = { async sendToStaff(cfg, m, msg) { staff.push({ cfg, m, msg }); return m.role === "manager" ? { ok: true, via: "sms" } : { ok: true, via: "wa_free" }; } };
  const s = { value: settings };
  const esc = makeAckEscalator({
    pool, getSettingsData: async () => s.value, push: () => push, team: team ? () => teamApi : () => null,
    sendSms: async (x) => { sms.push(x); return { ok: true }; },
    emit: (name, opts) => { const e = buildOrderEvent(name, opts); assert.ok(e, `حدث مرفوض: ${name}`); events.push(e); return e; },
    now: () => clock.t, log: { error() {}, log() {} },
  });
  const at = (sec) => { clock.t = new Date(ms("2026-10-18T20:22:55Z") + sec * 1000); };
  return { pool, clock, at, esc, pushes, staff, sms, events, s, claimed };
}
const INCIDENT = (x = {}) => ({ order_no: "W1792354906756", status: "pos_created", option: "delivery", total: 187.5, items: [{}, {}, {}], table_no: null,
  created_at: "2026-10-18T20:21:40Z", history: [{ status: "paid", at: "2026-10-18T20:22:55Z" }], portal_ack_at: null, accepted_at: null,
  pos_approval: null, pos_order_id: "9001", is_test: false, scheduled_for: null, ...x });

/* ── الإعداد ── */
test("الإعداد: الافتراضيات (٩٠/١٨٠/٣٦٠، شغّال، الأدوار)، القص على الحدود، والترتيب بيتزق بـ٣٠ ث", () => {
  const c = ackEscCfg({});
  assert.deepEqual([c.enabled, c.escalateAfterSec, c.step2AfterSec, c.step3AfterSec, c.maxAgeMin, c.quietWhenClosed], [true, 90, 180, 360, 30, true]);
  assert.deepEqual(c.step2Roles, ["cashier", "manager"]); assert.deepEqual(c.step3Roles, ["manager", "owner"]); assert.equal(c.step3AlertPhones, true);
  const x = ackEscCfg({ delivery: { ackEscalation: { escalateAfterSec: 5, step2AfterSec: 40, step3AfterSec: "x", step2Cashier: false, step3Owner: false, enabled: "yes" } } });
  assert.equal(x.escalateAfterSec, 30, "أقل حد"); assert.equal(x.step2AfterSec, 60, "أقل حد ٦٠"); assert.equal(x.step3AfterSec, 360, "مش رقم ⇒ الافتراضي");
  assert.deepEqual(x.step2Roles, ["manager"]); assert.deepEqual(x.step3Roles, ["manager"]); assert.equal(x.enabled, true, "مش boolean ⇒ الافتراضي");
  const o = ackEscCfg({ delivery: { ackEscalation: { escalateAfterSec: 300, step2AfterSec: 120, step3AfterSec: 100 } } });
  assert.deepEqual(o.delays, [300, 330, 360], "بالعكس ⇒ كل خطوة بعد اللي قبلها بـ٣٠ ث");
  assert.equal(ACK_ESC_DEFAULTS.enabled, true);
});

test("حالة «حد شافه؟»: شفته / قبول / الحالة اتحركت / approval / إلغاء / مسبق / تجريبي", () => {
  const o = INCIDENT();
  assert.equal(ackStateOf(o), null);
  assert.equal(ackStateOf({ ...o, portal_ack_at: "x" }), "acked");
  assert.equal(ackStateOf({ ...o, accepted_at: "x" }), "accepted");
  assert.equal(ackStateOf({ ...o, status: "accepted" }), "accepted");
  assert.equal(ackStateOf({ ...o, status: "courier_assigned" }), "accepted");
  assert.equal(ackStateOf({ ...o, status: "rejected_refunded" }), "cancelled");
  assert.equal(ackStateOf(o, "accepted"), "accepted"); assert.equal(ackStateOf(o, "pickup_ready"), "accepted");
  assert.equal(ackStateOf(o, "rejected"), "cancelled"); assert.equal(ackStateOf({ ...o, pos_approval: "cancelled" }), "cancelled");
  assert.equal(ackStateOf(o, "pending"), null, "approval لسه مستني");
  assert.equal(ackStateOf({ ...o, scheduled_for: "2026-10-19T12:00:00Z" }), "scheduled");
  assert.equal(ackStateOf({ ...o, is_test: true }), "test");
});

test("القرار: قبل ٩٠ ث مستني · ٩٠ ⇒ ١ · ١٨٠ ⇒ ٢ · بعد وقفة ٤٠٠ ث ⇒ ١+٢+٣ سوا · مقفول ⇒ هدوء · أقدم من الحد ⇒ لا", () => {
  const cfg = ackEscCfg({}), order = INCIDENT({ paid_at: "2026-10-18T20:22:55Z" }), t0 = ms("2026-10-18T20:22:55Z");
  const at = (s) => new Date(t0 + s * 1000);
  assert.deepEqual(decide({ order, cfg, now: at(89) }), { action: "wait", why: "not_yet" });
  assert.deepEqual(decide({ order, cfg, now: at(90) }).steps, [1]);
  assert.deepEqual(decide({ order, chain: { step: 1 }, cfg, now: at(185) }).steps, [2]);
  assert.deepEqual(decide({ order, chain: { step: 2 }, cfg, now: at(300) }), { action: "wait", why: "not_yet" });
  assert.deepEqual(decide({ order, cfg, now: at(400) }).steps, [1, 2, 3]);
  assert.deepEqual(decide({ order, chain: { step: 3 }, cfg, now: at(900) }), { action: "wait", why: "done" });
  assert.deepEqual(decide({ order, cfg, now: at(95), closed: true }), { action: "wait", why: "closed" });
  assert.deepEqual(decide({ order, cfg, now: at(31 * 60) }), { action: "wait", why: "too_old" });
  assert.deepEqual(decide({ order, chain: { step: 2 }, cfg, now: at(31 * 60) }), { action: "stop", reason: "too_old" });
  assert.deepEqual(decide({ order: { ...order, accepted_at: "x" }, chain: { step: 1 }, cfg, now: at(200) }), { action: "stop", reason: "accepted" });
  assert.deepEqual(decide({ order: { ...order, accepted_at: "x" }, cfg, now: at(200) }), { action: "wait", why: "accepted" }, "من غير سلسلة ⇒ مفيش حدث وقفة");
  assert.deepEqual(decide({ order, chain: { step: 1 }, cfg: ackEscCfg({ delivery: { ackEscalation: { enabled: false } } }), now: at(200) }), { action: "stop", reason: "disabled" });
});

test("المطعم مقفول بمواعيده (الرياض، وردية بعد نص الليل) — ومن غير مواعيد ⇒ مش مقفول", () => {
  assert.equal(restaurantClosed(new Date("2026-10-18T20:22:55Z"), { hours: HOURS }), false, "٢٣:٢٢ مفتوح");
  assert.equal(restaurantClosed(new Date("2026-10-18T22:45:00Z"), { hours: HOURS }), false, "١:٤٥ الفجر لسه مفتوح (من غير «يقف قبل القفل»)");
  assert.equal(restaurantClosed(new Date("2026-10-19T03:00:00Z"), { hours: HOURS }), true, "٦ الصبح مقفول");
  assert.equal(restaurantClosed(new Date("2026-10-19T03:00:00Z"), {}), false);
  assert.equal(restaurantClosed(new Date("2026-10-19T03:00:00Z"), { hours: HOURS, waSendHours: { enabled: false } }), true, "مش مربوط بمفتاح واتساب الآلي");
});

/* ── الحادثة ١٨/١٠ من أولها لآخرها ── */
test("إعادة حادثة W1792354906756: ٩٠ ث إشعار تاني ⇒ ١٨٠ ث واتساب الكاشير+المدير ⇒ ٣٦٠ ث SMS الإدارة ⇒ القبول ٢٣:٣٨:٣٧ يوقف السلسلة", async () => {
  const w = world();
  w.pool.orders.set("W1792354906756", INCIDENT());
  w.at(65); assert.equal((await w.esc.tick()).steps, 0);
  assert.equal(w.pushes.length, 0);

  w.at(95);
  const r1 = await w.esc.tick();
  assert.equal(r1.steps, 1);
  assert.equal(w.pushes.length, 1);
  const p = w.pushes[0];
  assert.equal(p.tag, "order-W1792354906756-esc1", "tag مختلف عن order-W… ⇒ بيظهر تاني");
  assert.equal(p.renotify, true); assert.equal(p.requireInteraction, true); assert.equal(p.urgency, "high"); assert.equal(p.kind, "new");
  assert.match(p.title, /W1792354906756/); assert.match(p.url, /#order=W1792354906756$/);
  assert.equal(w.staff.length, 0); assert.equal(w.sms.length, 0);
  assert.ok(w.claimed.has("W1792354906756|ack_esc:1")); assert.deepEqual(w.pool.pushLog[0], ["W1792354906756", "ack_esc:1", 6, 6]);
  assert.equal(w.events.length, 1); assert.equal(w.events[0].name, "ack_escalation"); assert.equal(w.events[0].data.step, 1);
  assert.match(w.events[0].summary, /تصعيد ١/);

  w.at(150); assert.equal((await w.esc.tick()).steps, 0, "مفيش تكرار قبل الخطوة الجاية");

  w.at(185);
  await w.esc.tick();
  assert.equal(w.staff.length, 2, "الكاشير والمدير (الفعّالين بس) — المالك لأ في الخطوة ٢");
  assert.deepEqual(w.staff.map((x) => x.m.role).sort(), ["cashier", "manager"]);
  for (const x of w.staff) {
    assert.equal(x.cfg.outsideWindow, "template", "برّه النافذة ⇒ القالب ثم SMS، مش «إشعار بورتال بس»");
    assert.equal(x.msg.topic, "ack_escalation"); assert.equal(x.msg.urgent, true);
    assert.ok(x.msg.body.startsWith("🔔 طلب جديد W1792354906756 ما اتقبلش من ٣ دقايق — افتح البورتال/الكاشير"), x.msg.body);
    assert.equal(x.msg.templates[0].name, "fc_staff_team_notice");
    assert.ok(!/\n/.test(x.msg.templates[0].data.notice.text));
    assert.equal(smsInfo(x.msg.sms).segments, 1);
  }
  assert.equal(w.pushes.length, 2); assert.equal(w.pushes[1].tag, "order-W1792354906756-esc2");
  const e2 = w.events[1];
  assert.equal(e2.data.step, 2); assert.equal(e2.data.waTo, 2); assert.equal(e2.data.waSent, 2); assert.equal(e2.data.waViaSms, 1);
  assert.match(e2.summary, /واتساب لـالكاشير والمدير/);

  w.at(365);
  await w.esc.tick();
  assert.deepEqual(w.sms.map((x) => x.phoneNorm).sort(), ["500000012", "500000013", "500000014"], "المدير + المالك + أرقام الإنذارات (من غير تكرار)");
  for (const x of w.sms) { assert.equal(x.kind, "staff"); assert.equal(smsInfo(x.body).segments, 1); assert.match(x.body, /URGENT.*W1792354906756/); }
  assert.equal(w.events[2].data.smsTo, 3); assert.equal(w.events[2].data.smsSent, 3);

  w.at(600); await w.esc.tick();
  assert.equal(w.sms.length, 3); assert.equal(w.pushes.length, 3, "بعد الخطوة ٣ مفيش حاجة تانية");

  w.pool.orders.get("W1792354906756").accepted_at = "2026-10-18T20:38:37Z";
  w.pool.orders.get("W1792354906756").status = "accepted";
  w.at(944);
  const r = await w.esc.tick();
  assert.equal(r.stopped, 1);
  const stop = w.events.at(-1);
  assert.equal(stop.data.step, "stop"); assert.equal(stop.data.reason, "accepted"); assert.equal(stop.data.afterSec, 944); assert.equal(stop.data.lastStep, 3);
  assert.match(stop.summary, /اتقبل على نقطة البيع/);
  const e = w.pool.esc.get("W1792354906756");
  assert.equal(e.step, 3); assert.equal(e.steps.length, 3); assert.equal(e.stop_reason, "accepted");
  w.at(1000); await w.esc.tick();
  assert.equal(w.events.length, 4, "حدث وقفة واحد بس");
  /* مفيش جوال في أي حدث متخزّن */
  assert.ok(!/5\d{8}/.test(JSON.stringify(w.events.map((x) => x.data))));
});

test("«شفته» على البوابة بعد الخطوة ١ ⇒ وقفة acked ومفيش واتساب", async () => {
  const w = world();
  w.pool.orders.set("W1", INCIDENT({ order_no: "W1" }));
  w.at(95); await w.esc.tick();
  w.pool.orders.get("W1").portal_ack_at = new Date(w.clock.t.getTime() + 5000).toISOString();
  w.at(185); const r = await w.esc.tick();
  assert.equal(r.stopped, 1); assert.equal(w.staff.length, 0);
  assert.equal(w.events.at(-1).data.reason, "acked");
});

test("ويبهوك نقطة البيع قال accepted قبل ما الكنس يكتب accepted_at ⇒ مفيش تصعيد خالص (ولا حدث)", async () => {
  const w = world();
  w.pool.orders.set("W2", INCIDENT({ order_no: "W2", pos_order_id: "77" }));
  w.pool.webhooks.set("77", "accepted");
  w.at(200); const r = await w.esc.tick();
  assert.equal(r.steps, 0); assert.equal(w.pushes.length, 0); assert.equal(w.events.length, 0);
  /* ويبهوك rejected والسلسلة مفتوحة ⇒ وقفة cancelled */
  const v = world();
  v.pool.orders.set("W3", INCIDENT({ order_no: "W3", pos_order_id: "78" }));
  v.at(95); await v.esc.tick();
  v.pool.webhooks.set("78", "rejected");
  v.at(120); assert.equal((await v.esc.tick()).stopped, 1);
  assert.equal(v.events.at(-1).data.reason, "cancelled");
});

test("بعد وقفة سيرفر (٤٠٠ ث ومفيش ولا خطوة) ⇒ الخطوات التلاتة في دورة واحدة وإشعار بوابة واحد بس", async () => {
  const w = world();
  w.pool.orders.set("W4", INCIDENT({ order_no: "W4" }));
  w.at(400); const r = await w.esc.tick();
  assert.equal(r.steps, 3); assert.equal(w.pushes.length, 1); assert.equal(w.pushes[0].tag, "order-W4-esc3");
  assert.equal(w.staff.length, 2); assert.equal(w.sms.length, 3);
});

test("حاويتين (rollover) على نفس القاعدة ⇒ كل خطوة مرة واحدة", async () => {
  const a = world();
  a.pool.orders.set("W5", INCIDENT({ order_no: "W5" }));
  const pushes = [];
  const b = makeAckEscalator({ pool: a.pool, getSettingsData: async () => SETTINGS(), now: () => a.clock.t, log: { error() {} },
    push: () => ({ claim: async () => true, sendToSubs: async (x) => { pushes.push(x); return { sent: 1, of: 1 }; } }),
    team: () => ({ sendToStaff: async () => ({ ok: true, via: "wa_free" }) }), sendSms: async () => ({}), emit: () => null });
  a.at(95);
  await Promise.all([a.esc.tick(), b.tick()]);
  assert.equal(a.pushes.length + pushes.length, 1);
  a.at(185);
  await Promise.all([b.tick(), a.esc.tick()]);
  assert.equal(a.pushes.length + pushes.length, 2);
});

test("مقفول من اللوحة / المطعم مقفول / طلب تجريبي / طلب مسبق ⇒ ولا إرسال", async () => {
  const off = world({ settings: { ...SETTINGS(), delivery: { ackEscalation: { enabled: false } } } });
  off.pool.orders.set("W6", INCIDENT({ order_no: "W6" }));
  off.at(400); await off.esc.tick();
  assert.equal(off.pushes.length + off.staff.length + off.sms.length, 0);

  const closed = world();
  closed.clock.t = new Date("2026-10-19T03:00:00Z");      // ٦ الصبح الرياض
  closed.pool.orders.set("W7", INCIDENT({ order_no: "W7", created_at: "2026-10-19T02:50:00Z", history: [{ status: "paid", at: "2026-10-19T02:55:00Z" }] }));
  const r = await closed.esc.tick();
  assert.equal(r.quiet, true); assert.equal(closed.pushes.length, 0);

  const t = world();
  t.pool.orders.set("W8", INCIDENT({ order_no: "W8", is_test: true }));
  t.pool.orders.set("W9", INCIDENT({ order_no: "W9", scheduled_for: "2026-10-19T13:00:00Z" }));
  t.at(400); await t.esc.tick();
  assert.equal(t.pushes.length, 0); assert.equal(t.events.length, 0);
});

test("من غير دليل فريق / من غير wateam ⇒ الخطوة ٢ بتتسجّل «مفيش حد» ومابتوقعش، والخطوة ٣ لأرقام الإنذارات", async () => {
  const w = world({ settings: { hours: HOURS, waTeam: { members: [] }, delivery: { alertPhones: ["0500000014"], staffSmsLanguage: "ar" } } });
  w.pool.orders.set("W10", INCIDENT({ order_no: "W10" }));
  w.at(400); await w.esc.tick();
  const e2 = w.events.find((e) => e.data.step === 2);
  assert.equal(e2.data.waTo, 0); assert.equal(e2.data.note, "no_members");
  assert.deepEqual(w.sms.map((x) => x.phoneNorm), ["500000014"]);
  assert.equal(smsInfo(w.sms[0].body).segments, 1); assert.match(w.sms[0].body, /فريش كاتس عاجل/);
  const n = world({ team: false });
  n.pool.orders.set("W11", INCIDENT({ order_no: "W11" }));
  n.at(200); await n.esc.tick();
  assert.equal(n.events.find((e) => e.data.step === 2).data.note, "no_team");
});

/* ── النصوص ── */
test("النصوص: SMS رسالة واحدة (عربي وإنجليزي)، سطر القالب ≤١٢٠ من غير سطر جديد، الإشعار بـtag الخطوة", () => {
  const o = INCIDENT();
  for (const lang of ["ar", "en"]) for (const step of [2, 3]) assert.equal(smsInfo(staffSms(o, 365, lang, step)).segments, 1, `${lang}/${step}`);
  const line = staffTplLine(o, 185);
  assert.ok(line.length <= 120 && !/\n/.test(line)); assert.match(line, /٣ دقايق/);
  assert.equal(staffWaText(o, 185).split("\n")[0], "🔔 طلب جديد W1792354906756 ما اتقبلش من ٣ دقايق — افتح البورتال/الكاشير");
  assert.match(staffWaText({ ...o, table_no: 4, option: "pickup" }, 185), /طاولة 4/);
  assert.equal(waitAr(90), "دقيقتين"); assert.equal(waitAr(60), "دقيقة"); assert.equal(waitAr(720), "١٢ دقيقة");
  assert.equal(pushFor(o, 2, 185, "https://x/").tag, "order-W1792354906756-esc2");
});

/* ── التايملاين والأحداث ── */
test("ack_escalation حدث مسموح، وبيظهر في تايملاين الطلب بسطره، وسطر portal_push_log المكرر بيتشال", () => {
  assert.ok(ORDER_EVENTS.includes("ack_escalation"));
  const ev = (step, summary, at) => ({ at, name: "ack_escalation", source: "system", summary, data: { step } });
  const tl = buildTimeline({
    order: { created_at: "2026-10-18T20:21:40Z" },
    events: [ev(1, "🔔 تصعيد ١: الطلب ما اتشافش من ١ د ٣٥ ث", "2026-10-18T20:24:30Z"), ev("stop", "✅ التصعيد وقف: اتقبل على نقطة البيع بعد ١٥ د ٤٢ ث من الدفع", "2026-10-18T20:38:40Z")],
    pushLog: [{ kind: "new", at: "2026-10-18T20:22:55Z", sent: 6, of: 6 }, { kind: "ack_esc:1", at: "2026-10-18T20:24:30Z", sent: 6, of: 6 }],
  });
  const labels = tl.map((x) => x.label_ar);
  assert.ok(labels.some((l) => /تصعيد ١/.test(l)));
  assert.ok(labels.some((l) => /التصعيد وقف/.test(l)));
  assert.ok(labels.includes("إشعار للبوابة: طلب جديد"));
  assert.ok(!labels.some((l) => /ack_esc/.test(l)), "سطر الإشعار المكرر اتشال");
  const only = buildTimeline({ order: {}, events: [], pushLog: [{ kind: "ack_esc:2", at: "2026-10-18T20:26:00Z" }] });
  assert.match(only[0].label_ar, /تصعيد 2/);
});

/* ── الإعدادات في لوحة التوصيل ── */
test("لوحة التوصيل: ١١ خانة RG2 في «تنبيهات ومسؤولين» بأسماء عربي، الحفظ بيتحقق من الحدود، والفعّال من ackEscCfg", () => {
  const keys = ["enabled", "escalateAfterSec", "step2AfterSec", "step3AfterSec", "step2Cashier", "step2Manager", "step3Manager", "step3Owner", "step3AlertPhones", "quietWhenClosed", "maxAgeMin"];
  for (const k of keys) {
    const f = FIELD_BY_PATH[`delivery.ackEscalation.${k}`];
    assert.ok(f, k); assert.equal(f.group, "alerts"); assert.ok(/[؀-ۿ]/.test(f.label), k);
  }
  assert.equal(validatePatch({ "delivery.ackEscalation.escalateAfterSec": 10 }).ok, false);
  assert.equal(validatePatch({ "delivery.ackEscalation.escalateAfterSec": 120, "delivery.ackEscalation.step2Cashier": false }).ok, true);
  assert.equal(effectiveOf("delivery.ackEscalation.step3AfterSec", {}), 360);
  assert.equal(effectiveOf("delivery.ackEscalation.step2AfterSec", { delivery: { ackEscalation: { escalateAfterSec: 300, step2AfterSec: 100 } } }), 330);
});

/* ── KPI «تأخير القبول» ── */
test("KPI: «تأخير القبول» يومي (وسيط/أقصى ثواني + كام اتصعّد) في team.ackDelay، والاستعلامات معلّمة وبهدف «شفته»", async () => {
  assert.match(KPI_SQL.ackDelay, /LEAST\(o\.portal_ack_at, o\.accepted_at\)/);
  assert.ok(SOURCE_AR.ackDelay && SOURCE_AR.ackEsc);
  const range = kpiRange({ from: "2026-10-17", to: "2026-10-18" }, new Date("2026-10-19T05:00:00Z"));
  const T = kpiTargets({});
  const rows = {
    ackDelay: [{ day: null, n: 40, med_sec: 64.4, p90_sec: 300, max_sec: 942, within: 31 }, { day: "2026-10-18", n: 22, med_sec: 70, p90_sec: 400, max_sec: 942, within: 15 }],
    ackEsc: [{ day: null, n: 5, step2: 2, step3: 1 }, { day: "2026-10-18", n: 4, step2: 2, step3: 1 }],
  };
  const out = shapeKpis({ directory: directoryOf({}), targets: T, range, rows });
  const a = out.team.ackDelay;
  assert.equal(a.label, "تأخير القبول"); assert.equal(a.medianSec, 64); assert.equal(a.maxSec, 942); assert.equal(a.escalated, 5); assert.equal(a.pct, 77.5);
  assert.deepEqual(a.daily.map((d) => d.day), ["2026-10-17", "2026-10-18"]);
  assert.deepEqual([a.daily[0].n, a.daily[0].medianSec, a.daily[0].escalated], [0, null, 0]);
  assert.deepEqual([a.daily[1].n, a.daily[1].maxSec, a.daily[1].step3], [22, 942, 1]);
  const seen = [];
  const pool = { async query(sql, p) { const k = /^\/\*kpi:(\w+)\*\//.exec(String(sql).trim())[1]; seen.push([k, p]); if (k === "ackEsc") throw new Error("relation does not exist"); return { rows: [] }; } };
  const c = await collect(pool, range, T, { log: { error() {} } });
  assert.deepEqual(seen.find(([k]) => k === "ackDelay")[1].slice(2), [T.ackMin]);
  assert.deepEqual(c.failed, ["ackEsc"]);
  const o2 = shapeKpis({ directory: directoryOf({}), targets: T, range, rows: c.rows, failed: c.failed });
  assert.equal(o2.team.ackDelay.escalated, null, "الجدول لسه مااتعملش ⇒ «غير متاح» مش صفر");
});

/* ── المسار ── */
test("GET /api/cms/ack-escalations: أدمن بس، بيرجّع الإعداد الفعّال والسلاسل", async () => {
  const routes = {};
  const app = { get: (p, h) => { routes[p] = h; } };
  const pool = fakeDb();
  pool.esc.set("W1", { order_no: "W1", step: 2, steps: [], started_at: iso(Date.now()), stopped_at: null });
  let admin = false;
  const ctx = { pool, getSettingsData: async () => ({}), requireAdmin: async () => (admin ? null : { status: 401 }), log: { error() {} } };
  register(app, ctx, { timers: false });
  const mk = () => ({ req: { query: () => undefined }, json: (body, status = 200) => ({ body, status }) });
  assert.equal((await routes["/api/cms/ack-escalations"](mk())).status, 401);
  admin = true;
  const r = await routes["/api/cms/ack-escalations"](mk());
  assert.equal(r.status, 200); assert.equal(r.body.config.escalateAfterSec, 90); assert.equal(r.body.rows.length, 1);
  assert.ok(SQL.recent.includes("LIMIT $1"));
});
