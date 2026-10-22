/* 🧭 OPS1 — تقرير الوردية + «قفل من غير رد» + checklist الوردية · node --test opsreport.test.mjs
   قاعدة وهمية + ساعة وهمية + واتساب/SMS/إشعار وهميين — أرقام وهمية بس (5000000xx)، مفيش شبكة ولا إرسال. */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  opsCfg, OPS_DEFAULTS, settingsProblem, slotsOf, dueSlots, nextSlot, shiftWindow, dayWindow, shiftAt, pickSilent, shapeReport, flagsOf,
  reportText, shiftEntry, register, SQL, bizMinOfHHMM,
} from "./opsreport.js";
import { kpiTargets } from "./staffkpi.js";
import { smsInfo } from "./staffalerts.js";
import { SERVER_OWNED_PATHS } from "./settings-guard.js";
import { sectionOf } from "./cms.js";

const T = kpiTargets({});
const Z = (s) => new Date(s).toISOString();
/* اليوم التشغيلي ٢٠/١٠ بيبدأ ٠٤:٠٠ الرياض = ٠١:٠٠Z */
const AT_1910 = Date.parse("2026-10-20T16:10:00Z");     // ١٩:١٠ الرياض — نهاية الوردية الأولى + ١٠ د
const AT_0330 = Date.parse("2026-10-21T00:30:00Z");     // ٠٣:٣٠ الرياض — لسه يوم ٢٠/١٠ التشغيلي
const TEAM = { members: [
  { phone: "0500000011", name: "منى", role: "cashier" }, { phone: "0500000012", name: "أحمد", role: "manager" },
  { phone: "0500000013", name: "عمر", role: "owner" }, { phone: "0500000015", name: "قديم", role: "manager", active: false }] };

/* ── الإعدادات ── */
test("الإعدادات الافتراضية: الإرسال والتنبيه مقفولين، الرصد والـchecklist شغّالين، ورديتين", () => {
  const c = opsCfg({});
  assert.equal(c.enabled, false, "مفيش إرسال مجدول إلا لما المالك يفتحه");
  assert.equal(c.silentAlert, false); assert.equal(c.silentAlertWa, false);
  assert.equal(c.silentEnabled, true); assert.equal(c.checklistEnabled, true);
  assert.deepEqual(c.roles, ["manager", "owner"]);
  assert.deepEqual(c.shifts.map((s) => [s.key, s.from, s.to]), [["s1", "11:00", "19:00"], ["s2", "19:00", "03:00"]]);
  assert.equal(c.checklistStart.length, 4); assert.equal(c.checklistEnd.length, 4);
});
test("opsCfg بتقصّ الأرقام وبتنضّف الأدوار والبنود والورديات", () => {
  const c = opsCfg({ opsReport: { sendDelayMin: 999, smsMaxParts: 0, roles: ["owner", "hacker", "owner"], silentAlertRoles: "manager",
    checklistEnd: [{ key: "a", label: "  بند  " }, { key: "a", label: "مكرر" }, { label: "" }, { key: "BAD KEY", label: "تاني" }],
    shifts: [{ key: "x", name: "", from: "9:00", to: "25:00" }, { key: "y", from: "12:00", to: "20:00" }] } });
  assert.equal(c.sendDelayMin, 90); assert.equal(c.smsMaxParts, 1);
  assert.deepEqual(c.roles, ["owner"]); assert.deepEqual(c.silentAlertRoles, ["manager"], "مش قايمة ⇒ الافتراضي");
  assert.deepEqual(c.checklistEnd, [{ key: "a", label: "بند" }, { key: "i2", label: "تاني" }]);
  assert.deepEqual(c.shifts.map((s) => s.key), ["y"], "وردية بساعة غلط بتتشال");
});
test("فحص الحفظ: أرقام برّه الحدود، ورديات متداخلة أو بالعكس، أدوار غلط، checklist طويل", () => {
  assert.match(settingsProblem({ captainWaitMin: 2 }), /من 5 لـ60/);
  assert.match(settingsProblem({ enabled: "yes" }), /تشغيل\/إيقاف/);
  assert.match(settingsProblem({ dailyAt: "3pm" }), /ساعة:دقيقة/);
  assert.match(settingsProblem({ roles: ["owner", "kitchen"] }), /المدير \/ المالك \/ الكاشير/);
  assert.match(settingsProblem({ shifts: [{ from: "19:00", to: "11:00" }] }), /النهاية لازم بعد البداية/);
  assert.match(settingsProblem({ shifts: [{ from: "11:00", to: "20:00" }, { from: "19:00", to: "03:00" }] }), /داخلين في بعض/);
  assert.match(settingsProblem({ checklistStart: Array.from({ length: 11 }, (_, i) => ({ label: `ب${i}` })) }), /أقصى 10/);
  assert.equal(settingsProblem({ shifts: [{ from: "11:00", to: "19:00" }, { from: "19:00", to: "03:00" }], enabled: true, dailyAt: "03:30", roles: ["manager"] }), null);
});

/* ── المواعيد ── */
test("الورديات بتوقيت الرياض: ١٩:٠٠ ← ٠٣:٠٠ جوّه نفس اليوم التشغيلي", () => {
  const [s1, s2] = opsCfg({}).shifts;
  assert.deepEqual(shiftWindow("2026-10-20", s1), { start: Z("2026-10-20T08:00:00Z"), end: Z("2026-10-20T16:00:00Z") });
  assert.deepEqual(shiftWindow("2026-10-20", s2), { start: Z("2026-10-20T16:00:00Z"), end: Z("2026-10-21T00:00:00Z") });
  assert.deepEqual(dayWindow("2026-10-20"), { start: Z("2026-10-20T01:00:00Z"), end: Z("2026-10-21T01:00:00Z") });
  assert.equal(shiftAt(Date.parse("2026-10-20T12:00:00Z"), opsCfg({})).key, "s1");
  assert.equal(shiftAt(Date.parse("2026-10-20T23:59:00Z"), opsCfg({})).key, "s2");
  assert.equal(shiftAt(Date.parse("2026-10-20T03:00:00Z"), opsCfg({})), null, "٦ الصبح مفيش وردية");
});
test("مواعيد الإرسال: آخر الوردية + المهلة، وكارت اليوم ٠٣:٣٠ = نفس اليوم، و٠٩:٠٠ = امبارح", () => {
  const cfg = opsCfg({ opsReport: { enabled: true } });
  const sl = slotsOf(AT_1910, cfg);
  assert.deepEqual(sl.map((s) => [s.key, s.target, s.dueMin]), [["shift:s1", "2026-10-20", bizMinOfHHMM("19:10")], ["shift:s2", "2026-10-20", bizMinOfHHMM("03:00") + 10], ["daily", "2026-10-20", bizMinOfHHMM("03:30")]]);
  assert.deepEqual(dueSlots(AT_1910, cfg).map((s) => s.key), ["shift:s1"]);
  assert.deepEqual(dueSlots(AT_1910, cfg, new Set(["2026-10-20|shift:s1"])), [], "اتبعت قبل كده");
  assert.deepEqual(dueSlots(AT_1910 + 61 * 60_000, cfg), [], "عدّى أكتر من graceMin (السيرفر كان واقف) ⇒ مايتبعتش متأخر");
  assert.deepEqual(dueSlots(AT_0330, cfg).map((s) => s.key), ["shift:s2", "daily"]);
  const morning = opsCfg({ opsReport: { dailyAt: "09:00" } });
  assert.equal(slotsOf(Date.parse("2026-10-21T06:00:00Z"), morning).find((s) => s.key === "daily").target, "2026-10-20", "الصبح قبل الفتح ⇒ عن امبارح");
  assert.equal(nextSlot(AT_1910 - 60_000, cfg).key, "shift:s1");
});

/* ── «قفل من غير رد» ── */
const sil = (o) => ({ id: 1, kind: "done", at: "2026-10-20T15:00:00Z", by_name: "منى", role: "cashier", phone_norm: "500000099", since: "2026-10-20T14:58:00Z", reason: "asked_human", outcome: "answered", close_note: null, human: 0, ...o });
test("قفل من غير رد: بيستبعد الرد المكتوب، «مش عميل»، التقييمات، الملاحظة، والقفل الآلي — وبيعدّ الباقي باسم اللي قفل", () => {
  const got = pickSilent([
    sil({ id: 1 }),
    sil({ id: 2, phone_norm: "500000098", human: 2 }),
    sil({ id: 3, phone_norm: "500000097", outcome: "not_customer" }),
    sil({ id: 4, phone_norm: "500000096", reason: "review_low" }),
    sil({ id: 5, phone_norm: "500000095", close_note: "كلمته تليفون" }),
    sil({ id: 6, phone_norm: "500000094", by_name: "اترد على العميل" }),
    sil({ id: 7, phone_norm: "500000093", by_name: "أحمد", role: "manager", kind: "ack" }),
  ]);
  assert.deepEqual(got.map((g) => [g.ref, g.by, g.ref4]), [["done:1", "منى", "0099"], ["ack:7", "أحمد", "0093"]]);
});
test("قفل من غير رد: نفس الرقم (تحويل «تم» + محادثة «خلصت») خلال ٣٠ د = مرة واحدة", () => {
  const got = pickSilent([sil({ id: 1, kind: "ack", at: "2026-10-20T15:00:00Z" }), sil({ id: 9, kind: "done", at: "2026-10-20T15:00:10Z" }),
    sil({ id: 10, kind: "done", at: "2026-10-20T16:00:00Z" })]);
  assert.deepEqual(got.map((g) => g.ref), ["ack:1", "done:10"]);
});
test("SQL «قفل من غير رد» بيعدّ رد البوابة ورد تطبيق واتساب (echo مش auto) وبيقرا ملاحظة القفل", () => {
  for (const k of ["silentDone", "silentAck"]) {
    assert.match(SQL[k], /wa_staff_replies/); assert.match(SQL[k], /source = 'echo' AND COALESCE\(m\.echo_kind, 'staff'\) <> 'auto'/);
    assert.match(SQL[k], /close_note/); assert.match(SQL[k], /make_interval\(mins => \$3::int\)/);
  }
  assert.match(SQL.handovers, /right\(h\.phone_norm, 4\)/, "التقرير بياخد آخر ٤ أرقام بس");
  assert.doesNotMatch(SQL.handovers, /h\.phone_norm AS/);
});

/* ── التشكيل ── */
function rows14() {
  const o = (n, paid, acc, ack, ready, extra = {}) => ({ order_no: `W17920000${n}`, option: "delivery", status: "delivered", total: "100", paid_at: paid, accepted_at: acc,
    portal_ack_at: ack, portal_ack_by: ack ? "أحمد" : null, pos_ready_at: ready, created_at: paid, scheduled_for: null, ...extra });
  return {
    orders: [
      o("0001", "2026-10-20T10:00:00Z", "2026-10-20T10:00:15Z", null, "2026-10-20T10:20:00Z"),
      o("0002", "2026-10-20T11:00:00Z", "2026-10-20T11:09:00Z", "2026-10-20T11:08:00Z", "2026-10-20T11:45:00Z"),        // قبول ٨ د + تحضير ٣٧
      o("0003", "2026-10-20T12:00:00Z", "2026-10-20T12:00:10Z", null, null, { option: "pickup" }),
      o("0004", "2026-10-20T12:00:00Z", "2026-10-20T13:30:00Z", null, null, { scheduled_for: "2026-10-20T13:30:00Z" }),     // طلب مسبق — مايتحسبش في القبول
    ],
    escalations: [{ order_no: "W1792000002", step: 2 }],
    breaches: [{ code: "our_handover_late", over_min: 12, claimable: false }, { code: "our_handover_late", over_min: 6, claimable: false }, { code: "deliver_late", over_min: 9, claimable: true }],
    handovers: [
      { id: 1, reason: "asked_human", at: "2026-10-20T10:00:00Z", acked_at: "2026-10-20T10:01:00Z", acked_by: "منى", ref4: "0001", first_reply_at: "2026-10-20T10:02:00Z" },
      { id: 2, reason: "complaint", at: "2026-10-20T11:00:00Z", acked_at: "2026-10-20T11:00:30Z", acked_by: "منى", ref4: "0002", first_reply_at: null },
      { id: 3, reason: "media", at: "2026-10-20T12:00:00Z", acked_at: null, acked_by: null, ref4: "0003", first_reply_at: "2026-10-20T12:40:00Z" },
      { id: 4, reason: "review_low", at: "2026-10-20T12:00:00Z", acked_at: null, acked_by: null, ref4: "0004", first_reply_at: null },
      { id: 5, reason: "asked_human", at: "2026-10-20T15:59:00Z", acked_at: null, acked_by: null, ref4: "0005", first_reply_at: null },       // لسه جوّه المهلة
    ],
    silent: pickSilent([sil({ id: 2, phone_norm: "500000002", at: "2026-10-20T11:00:30Z", kind: "ack" })]),
    reviews: [{ id: 1, rating: 2, created_at: "2026-10-20T10:00:00Z", resolved: false, first_action_at: null, first_by: null }],
    presence: [{ staff_id: "st1", staff_name: "منى", role: "cashier", minutes: 50, visible_minutes: 30 }, { staff_id: "st2", staff_name: "أحمد", role: "manager", minutes: 400, visible_minutes: 300 }],
    offline: [{ kind: "cashier", n: 12 }],
    pos: [
      { staff_name: "احمد السيد", order_type: "Created", has_cust: true }, { staff_name: "احمد السيد", order_type: "Created", has_cust: false },
      { staff_name: "احمد السيد", order_type: "External", has_cust: false }, { staff_name: "احمد السيد", order_type: "Void", has_cust: true },
      { staff_name: "اسامه فوزي", order_type: "Table", has_cust: true },
    ],
    notices: [{ role: "cashier", n: 3, acked: 2, med: 95 }],
    tableCalls: [{ n: 0, done: 0, med: null }],
    incidents: null,
    shiftLog: [{ id: 1, at: "2026-10-20T08:05:00Z", staff_name: "منى", role: "cashier", action: "start", missing: [], mismatch: [] },
      { id: 2, at: "2026-10-20T15:58:00Z", staff_name: "منى", role: "cashier", action: "end", missing: ["عدّيت الكاش"], mismatch: ["مفيش تحويل مفتوح (الحقيقة: 1 مفتوح)"], cash_diff: -20 }],
  };
}
test("التقرير: القبول/التحضير/الكابتن/التحويلات/الكاشير بأرقام صح ومصدر واقع = «غير متاح» مش صفر", () => {
  const cfg = opsCfg({});
  const r = shapeReport(rows14(), { targets: T, cfg, kind: "shift", label: "الوردية الأولى", day: "2026-10-20", now: Date.parse("2026-10-20T16:00:00Z") });
  assert.equal(r.orders.n, 4); assert.equal(r.orders.ack.n, 3, "الطلب المسبق برّه القبول");
  assert.equal(r.orders.ack.slowN, 1); assert.deepEqual(r.orders.ack.slow[0], { ref: "0002", min: 8 });
  assert.equal(r.orders.prep.overN, 1); assert.equal(r.orders.prep.over[0].min, 36);
  assert.equal(r.orders.escalated, 1); assert.equal(r.orders.escalatedStep2, 1);
  assert.deepEqual([r.courier.captainWaited, r.courier.captainWaitedOver, r.courier.theirLate], [2, 1, 1]);
  assert.equal(r.handovers.n, 4, "تحويل التقييم ليه مساره"); assert.equal(r.handovers.replied, 1);
  assert.equal(r.handovers.noReply, 1, "اللي لسه جوّه مهلة الرد مايتحسبش «من غير رد»"); assert.equal(r.handovers.late, 1);
  assert.equal(r.silent.n, 1); assert.deepEqual(r.silent.by, { "منى": 1 });
  assert.deepEqual(r.pos.byStaff.find((b) => b.name === "احمد السيد"), { name: "احمد السيد", invoices: 4, own: 2, noCustomer: 1, voids: 1, refunds: 0 });
  assert.equal(r.pos.coveragePct, 67);
  assert.ok(r.unavailable.includes("مشاكل المندوب"), "incidents = null ⇒ غير متاح");
  assert.equal(r.incidents, undefined);
  assert.equal(r.people["منى"].silent, 1); assert.equal(r.people["أحمد"].acks, 1);
  assert.deepEqual(r.checklist.cash, [{ by: "منى", diff: -20 }]);
});
test("أهم الحاجات بالأولوية: الحرج الأول، ومفيش سطر حضور إلا في كارت اليوم", () => {
  const cfg = opsCfg({});
  const sh = shapeReport(rows14(), { targets: T, cfg, kind: "shift", day: "2026-10-20", now: Date.parse("2026-10-20T16:00:00Z") });
  const lv = sh.flags.map((f) => f.level);
  assert.deepEqual(lv, [...lv].sort((a, b) => ["crit", "warn", "info"].indexOf(a) - ["crit", "warn", "info"].indexOf(b)));
  assert.ok(sh.flags.some((f) => /اتقفلت من غير ولا رسالة مكتوبة: منى 1/.test(f.text)));
  assert.ok(sh.flags.some((f) => /فرق كاش: منى -20 ر/.test(f.text)));
  assert.ok(sh.flags.some((f) => /اتعلّم عليه وهو مش صح/.test(f.text)));
  assert.ok(!sh.flags.some((f) => /البوابة كانت مفتوحة/.test(f.text)));
  const day = shapeReport(rows14(), { targets: T, cfg, kind: "daily", day: "2026-10-20", now: Date.parse("2026-10-21T00:30:00Z") });
  const pres = day.flags.find((f) => /البوابة كانت مفتوحة/.test(f.text));
  assert.ok(pres && /منى 30 د/.test(pres.text) && !/أحمد/.test(pres.text), "الكاشير ٣٠ د < ٢٤٠ — المدير ٣٠٠ د تمام");
  const clean = shapeReport({ orders: [], handovers: [], silent: [], pos: [] }, { targets: T, cfg, kind: "custom" });
  assert.deepEqual(clean.flags, []);
});
test("النص: واتساب فيه الأسماء والأرقام، والـSMS من غير إيموجي وجوّه أقصى أجزاء", () => {
  const cfg = opsCfg({});
  const r = shapeReport(rows14(), { targets: T, cfg, kind: "shift", label: "الوردية الأولى", day: "2026-10-20", now: Date.parse("2026-10-20T16:00:00Z") });
  const t = reportText(r, { maxParts: 2 });
  assert.match(t.wa, /^🧭 تقرير الوردية الأولى — 20\/10/);
  assert.match(t.wa, /👤 منى \(الكاشير\): تحويلات 2 · قفل من غير رد 1 · البوابة 30 د · checklist ✓بداية ✓نهاية/);
  assert.match(t.wa, /🧾 نقطة البيع: احمد السيد 4 \(من غير عميل 1\) · فويد\/مرتجع 1/);
  assert.match(t.wa, /ℹ️ غير متاح: مشاكل المندوب/);
  assert.ok(smsInfo(t.sms).segments <= 2);
  assert.doesNotMatch(t.sms, /[\u{1F300}-\u{1FAFF}]/u);
  assert.doesNotMatch(t.wa + t.sms, /500000/, "مفيش رقم عميل كامل في النص");
});

/* ── checklist ── */
test("checklist: الناقص بالاسم، «مش صح» لما الحقيقة عكس اللي اتعلّم عليه، وفرق الكاش لازم رقم", () => {
  const cfg = opsCfg({});
  const e = shiftEntry({ action: "end", answers: { no_open_handovers: true, no_open_orders: true, cash_counted: true }, cashDiff: "-15.5", note: "  تمام  " }, cfg, { openHandovers: 2, openOrders: 0 });
  assert.equal(e.ok, true);
  assert.deepEqual(e.row.missing, ["سلّمت الوردية الجاية وكتبت الملاحظات"]);
  assert.deepEqual(e.row.mismatch, ["مفيش تحويل واتساب مفتوح من غير رد (الحقيقة: 2 مفتوح)"]);
  assert.equal(e.row.cashDiff, -15.5); assert.equal(e.row.note, "تمام");
  assert.equal(shiftEntry({ action: "end", cashDiff: "كتير" }, cfg).error, "bad_cash");
  assert.equal(shiftEntry({ action: "lunch" }, cfg).error, "bad_action");
  assert.equal(shiftEntry({ action: "start", answers: {}, cashDiff: 50 }, cfg).row.cashDiff, null, "فرق الكاش في النهاية بس");
});

/* ── الربط: مسار الإعدادات وصلاحيات اللوحة ── */
test("opsReport مفتاح سيرفر (الحفظ الكامل للإعدادات مايمسحوش) والمسارات في الأقسام الصح", () => {
  assert.ok(SERVER_OWNED_PATHS.includes("opsReport"));
  assert.equal(sectionOf("/api/cms/ops-report"), "orders");
  assert.equal(sectionOf("/api/cms/ops-report/settings"), "settings");
});

/* ── المسارات + الجدولة + الرصد (قاعدة وهمية) ── */
function world({ settings = {}, wa = "open", smsFail = false } = {}) {
  const db = { settings: { waTeam: TEAM, ...settings }, rows: {}, silentDone: [], silentAck: [], log: [], silent: [], shift: [], seq: 0, saved: null,
    waSent: [], smsSent: [], pushed: [], openNow: { handovers: 0, reviews: 0, incidents: 0, orders: 0 }, now: AT_1910, beforeClaim: null };
  const pool = {
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (/^CREATE /i.test(s)) return { rows: [], rowCount: 0 };
      const tag = (/^\/\*ops:(\w+)\*\//.exec(s) || [])[1];
      if (tag === "silentDone") return { rows: db.silentDone };
      if (tag === "silentAck") return { rows: db.silentAck };
      if (tag === "openNow") return { rows: [db.openNow] };
      if (tag === "shiftLog") return { rows: db.shift.filter((r) => r.at >= p[0] && r.at < p[1]) };
      if (tag) return { rows: db.rows[tag] || [] };
      if (/^SELECT day::text AS day, slot FROM ops_report_log/.test(s)) return { rows: db.log.filter((r) => r.kind !== "test").map((r) => ({ day: r.day, slot: r.slot })) };
      if (/^INSERT INTO ops_report_log\(day, slot, kind\) VALUES/.test(s)) {
        if (db.beforeClaim) { db.beforeClaim(p); db.beforeClaim = null; }
        if (db.log.some((r) => r.kind !== "test" && r.day === p[0] && r.slot === p[1])) return { rows: [] };
        const id = ++db.seq; db.log.push({ id, day: p[0], slot: p[1], kind: p[2], status: "claimed" }); return { rows: [{ id }] };
      }
      if (/^UPDATE ops_report_log SET status/.test(s)) { const r = db.log.find((x) => x.id === p[0]); Object.assign(r, { status: p[1], reason: p[2], text: p[3], sms: p[4], via: JSON.parse(p[5]), flags: JSON.parse(p[6]) }); return { rowCount: 1 }; }
      if (/^INSERT INTO ops_report_log\(day, slot, kind, status/.test(s)) { db.log.push({ id: ++db.seq, day: p[0], slot: p[1], kind: "test", status: p[2] }); return { rowCount: 1 }; }
      if (/^SELECT id, day::text AS day, slot, kind, at, status/.test(s)) return { rows: db.log.slice().reverse() };
      if (/^SELECT 1 FROM ops_silent_closes WHERE phone_norm/.test(s)) return { rows: db.silent.filter((r) => r.phone_norm === p[0] && Math.abs(Date.parse(r.at) - Date.parse(p[1])) < 1800e3) };
      if (/^INSERT INTO ops_silent_closes/.test(s)) { if (db.silent.some((r) => r.ref === p[0])) return { rows: [] }; db.silent.push({ ref: p[0], kind: p[1], at: p[2], by: p[3], phone_norm: p[5], alerted_at: null }); return { rows: [{ ref: p[0] }] }; }
      if (/^SELECT count\(\*\)::int AS n FROM ops_silent_closes WHERE alerted_at/.test(s)) return { rows: [{ n: db.silent.filter((r) => r.alerted_at && r.alerted_at > p[0]).length }] };
      if (/^UPDATE ops_silent_closes SET alerted_at/.test(s)) { const r = db.silent.find((x) => x.ref === p[0]); r.alerted_at = new Date(db.now).toISOString(); r.alert = JSON.parse(p[1]); return { rowCount: 1 }; }
      if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{opsReport\}'/.test(s)) { db.saved = JSON.parse(p[0]); db.settings.opsReport = db.saved; return { rowCount: 1 }; }
      if (/^SELECT id, at, action, shift_key, missing, mismatch, cash_diff::float AS cash_diff FROM portal_shift_log WHERE day/.test(s)) return { rows: db.shift.filter((r) => r.day === p[0] && r.staff_id === p[1]) };
      if (/^INSERT INTO portal_shift_log/.test(s)) { const id = ++db.seq; db.shift.push({ id, at: p[0], day: p[1], staff_id: p[2], staff_name: p[3], role: p[4], action: p[5], shift_key: p[6], missing: JSON.parse(p[8]), mismatch: JSON.parse(p[9]), cash_diff: p[10], note: p[11] }); return { rows: [{ id }] }; }
      throw new Error(`fake db: unexpected SQL: ${s.slice(0, 120)}`);
    },
  };
  const waApi = { async sendFreeform(m) { db.waSent.push(m); return wa === "open" ? { ok: true } : { ok: false, skipped: wa }; } };
  const sendSms = async (m) => { db.smsSent.push(m); if (smsFail) throw new Error("down"); return { ok: true }; };
  const push = { PORTAL_URL: "https://x/portal/", async sendToSubs(payload, opts) { db.pushed.push({ payload, opts }); return { sent: 1, of: 1 }; } };
  const portalUser = { current: { id: "st1", name: "منى", role: "cashier" } };
  const requirePortal = async (c, role) => {
    if (c.req.header("x-portal") !== "1") return { res: c.json({ ok: false }, 401) };
    if (role === "manager" && portalUser.current.role !== "manager") return { res: c.json({ ok: false, error: "forbidden" }, 403) };
    return { user: portalUser.current };
  };
  const app = new Hono();
  const ctx = { pool, requireAdmin: async (c) => (c.req.header("x-admin") === "1" ? null : c.json({ ok: false }, 401)), getSettingsData: async () => db.settings,
    isOwner: async (c) => c.req.header("x-owner") === "1", log: { error: () => {} } };
  const api = register(app, ctx, { wa: waApi, sendSms, push: () => push, requirePortal, schedule: false, now: () => db.now });
  const call = async (method, path, body, h = { "x-admin": "1", "x-owner": "1" }) => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json", ...h }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, j: await r.json() };
  };
  return { db, api, call, portalUser };
}

test("الجدولة مقفولة افتراضياً ⇒ مفيش أي إرسال ولا حجز", async () => {
  const w = world();
  assert.equal((await w.api.tick({ at: AT_1910 })).skipped, "disabled");
  assert.equal(w.db.log.length + w.db.waSent.length + w.db.smsSent.length, 0);
});
test("تقرير آخر الوردية ١٩:١٠: واتساب حر للمدير والمالك من دليل الفريق (مش الكاشير ولا الموقوف)، مرة واحدة", async () => {
  const w = world({ settings: { opsReport: { enabled: true } } });
  const r = await w.api.tick({ at: AT_1910 });
  assert.equal(r.due, 1); assert.equal(r.results[0].sent, 2);
  assert.deepEqual(w.db.waSent.map((m) => m.phoneNorm).sort(), ["500000012", "500000013"]);
  assert.equal(w.db.waSent[0].payload.type, "text", "رسالة حرة — مش قالب مدفوع");
  assert.match(w.db.waSent[0].payload.text.body, /🧭 تقرير الوردية الأولى — 20\/10/);
  assert.equal(w.db.smsSent.length, 0);
  assert.deepEqual([w.db.log[0].day, w.db.log[0].slot, w.db.log[0].status], ["2026-10-20", "shift:s1", "sent"]);
  assert.equal((await w.api.tick({ at: AT_1910 + 60_000 })).due, 0, "نفس الميعاد مايتبعتش تاني");
  assert.equal(w.db.waSent.length, 2);
});
test("النافذة مقفولة ⇒ SMS قصيرة؛ وSMS مقفولة كمان ⇒ «فشل» متسجّل من غير ما يرمي", async () => {
  const w = world({ settings: { opsReport: { enabled: true } }, wa: "window_closed" });
  await w.api.tick({ at: AT_1910 });
  assert.equal(w.db.smsSent.length, 2); assert.equal(w.db.smsSent[0].kind, "staff"); assert.match(w.db.smsSent[0].ref, /^ops-report shift:s1/);
  const w2 = world({ settings: { opsReport: { enabled: true, sms: false } }, wa: "window_closed" });
  await w2.api.tick({ at: AT_1910 });
  assert.equal(w2.db.smsSent.length, 0); assert.equal(w2.db.log[0].status, "failed");
});
test("حاويتين وقت النشر: الحجز بيمنع إن نفس الميعاد يتبعت مرتين", async () => {
  const w = world({ settings: { opsReport: { enabled: true } } });
  w.db.beforeClaim = (p) => w.db.log.push({ id: ++w.db.seq, day: p[0], slot: p[1], kind: p[2], status: "claimed" });
  const r = await w.api.tick({ at: AT_1910 });
  assert.equal(r.results[0].skipped, "claimed_elsewhere"); assert.equal(w.db.waSent.length, 0);
});
test("مفيش حد بالدور المختار في دليل الفريق ⇒ «اتخطّى: مفيش رقم» من غير إرسال", async () => {
  const w = world({ settings: { opsReport: { enabled: true, roles: ["cashier"] }, waTeam: { members: [] } } });
  await w.api.tick({ at: AT_1910 });
  assert.equal(w.db.log[0].status, "skipped"); assert.equal(w.db.log[0].reason, "no_phones"); assert.equal(w.db.waSent.length, 0);
});

test("رصد «قفل من غير رد»: بيتسجّل من غير أي تنبيه وهو مقفول (الافتراضي)، ومرة واحدة", async () => {
  const w = world();
  w.db.silentDone = [sil({ id: 41, at: "2026-10-20T16:05:00Z" })];
  const r = await w.api.silentTick({ at: AT_1910 });
  assert.deepEqual([r.added, r.alerted], [1, 0]);
  assert.equal(w.db.silent[0].ref, "done:41"); assert.equal(w.db.pushed.length + w.db.waSent.length, 0);
  assert.equal((await w.api.silentTick({ at: AT_1910 + 60_000 })).added, 0, "مايتسجّلش تاني");
});
test("«قفل من غير رد» والتنبيه شغّال ⇒ إشعار لأجهزة دور المدير بس، ومن غير SMS، وبحد أقصى في الساعة", async () => {
  const w = world({ settings: { opsReport: { silentAlert: true, silentAlertWa: true, silentMaxPerHour: 1, silentAlertRoles: ["manager", "owner"] } } });
  w.db.silentAck = [sil({ id: 7, kind: "ack", at: "2026-10-20T16:05:00Z", phone_norm: "500000071" }), sil({ id: 8, kind: "ack", at: "2026-10-20T16:06:00Z", phone_norm: "500000072" })];
  const r = await w.api.silentTick({ at: AT_1910 });
  assert.deepEqual([r.added, r.alerted], [2, 1], "التاني اتسجّل بس من غير تنبيه (الحد ١ في الساعة)");
  assert.equal(w.db.pushed.length, 1); assert.deepEqual(w.db.pushed[0].opts, { role: "manager" }, "المالك مالوش أجهزة بوابة");
  assert.match(w.db.pushed[0].payload.title, /اتقفلت من غير رد — …0071/);
  assert.deepEqual(w.db.waSent.map((m) => m.phoneNorm).sort(), ["500000012", "500000013"]);
  assert.equal(w.db.smsSent.length, 0, "تنبيه السكوت عمره ما SMS");
});
test("رصد «قفل من غير رد» مقفول من اللوحة ⇒ مفيش قراية ولا تسجيل", async () => {
  const w = world({ settings: { opsReport: { silentEnabled: false } } });
  w.db.silentDone = [sil({ id: 1 })];
  assert.equal((await w.api.silentTick({ at: AT_1910 })).skipped, "disabled");
  assert.equal(w.db.silent.length, 0);
});

test("GET /api/cms/ops-report: من غير دخول 401 · الوردية الحالية افتراضياً · ?day = اليوم كله · وردية مش موجودة 400", async () => {
  const w = world();
  w.db.now = Date.parse("2026-10-20T12:00:00Z");
  assert.equal((await w.call("GET", "/api/cms/ops-report", null, {})).status, 401);
  const a = await w.call("GET", "/api/cms/ops-report");
  assert.equal(a.status, 200); assert.equal(a.j.window.kind, "shift"); assert.equal(a.j.window.shift.key, "s1");
  assert.equal(a.j.cfg.enabled, false); assert.equal(a.j.next, null, "مقفول ⇒ مفيش «الجاي»");
  assert.match(a.j.text.wa, /تقرير الوردية الأولى/);
  const d = await w.call("GET", "/api/cms/ops-report?day=2026-10-19");
  assert.equal(d.j.window.kind, "daily"); assert.equal(d.j.window.start, Z("2026-10-19T01:00:00Z"));
  assert.equal((await w.call("GET", "/api/cms/ops-report?shift=zzz")).status, 400);
  assert.ok(a.j.recipients.masked.every((m) => /^\*\*\*\d{4}$/.test(m)), "الأرقام متخبّية");
});
test("حفظ الإعدادات: غير المالك 403 · قيمة غلط 400 بالعربي · الصح بيتحفظ متنضّف في settings.opsReport", async () => {
  const w = world();
  assert.equal((await w.call("POST", "/api/cms/ops-report/settings", { enabled: true }, { "x-admin": "1" })).status, 403);
  const bad = await w.call("POST", "/api/cms/ops-report/settings", { captainWaitMin: 1 });
  assert.equal(bad.status, 400); assert.match(bad.j.message, /الكابتن استنّانا أكتر من/);
  const ok = await w.call("POST", "/api/cms/ops-report/settings", { enabled: true, roles: ["manager"], silentAlert: true, junk: 1 });
  assert.equal(ok.status, 200);
  assert.equal(w.db.saved.enabled, true); assert.deepEqual(w.db.saved.roles, ["manager"]); assert.equal(w.db.saved.silentAlert, true);
  assert.equal(w.db.saved.junk, undefined, "مفاتيح مش معروفة مابتتحفظش");
  assert.equal(w.db.saved.captainWaitMin, OPS_DEFAULTS.captainWaitMin);
});
test("التجربة: المالك بس، ولأرقام المالك بس بعلامة 🧪، ومابتحجزش ميعاد", async () => {
  const w = world();
  assert.equal((await w.call("POST", "/api/cms/ops-report/test", {}, { "x-admin": "1" })).status, 403);
  const r = await w.call("POST", "/api/cms/ops-report/test", {});
  assert.equal(r.j.ok, true); assert.deepEqual(w.db.waSent.map((m) => m.phoneNorm), ["500000013"]);
  assert.match(w.db.waSent[0].payload.text.body, /^🧪 تجربة/);
  assert.equal(w.db.log[0].kind, "test");
  w.db.settings.opsReport = { enabled: true };
  await w.api.tick({ at: AT_1910 });
  assert.equal(w.db.log.filter((x) => x.kind !== "test").length, 1, "التجربة ماأخدتش مكان ميعاد الوردية");
});
test("البوابة: تقرير الوردية للمدير بس · checklist بداية/نهاية بيتسجّل باسم الموظف ومعاه «مش صح» من الحقيقة", async () => {
  const w = world();
  const H = { "x-portal": "1" };
  assert.equal((await w.call("GET", "/api/portal/ops-report", null, H)).status, 403, "الكاشير مايشوفش تقرير الفريق");
  w.portalUser.current = { id: "st2", name: "أحمد", role: "manager" };
  const rep = await w.call("GET", "/api/portal/ops-report", null, H);
  assert.equal(rep.status, 200); assert.equal(rep.j.log, undefined, "سجل الإرسال والأرقام للوحة بس"); assert.equal(rep.j.recipients, undefined);
  w.portalUser.current = { id: "st1", name: "منى", role: "cashier" };
  const g = await w.call("GET", "/api/portal/shift", null, H);
  assert.equal(g.j.enabled, true); assert.equal(g.j.open, false); assert.equal(g.j.start.length, 4);
  const s = await w.call("POST", "/api/portal/shift", { action: "start", answers: { portal_open: true, pos_ok: true, open_items: true, soldout: true } }, H);
  assert.equal(s.status, 200); assert.deepEqual(s.j.missing, []);
  w.db.openNow = { handovers: 1, reviews: 0, incidents: 0, orders: 0 };
  const e = await w.call("POST", "/api/portal/shift", { action: "end", answers: { no_open_handovers: true, no_open_orders: true, cash_counted: true, handover_note: true }, cashDiff: 0 }, H);
  assert.equal(e.status, 200); assert.equal(e.j.mismatch.length, 1, "قال مفيش تحويل مفتوح وفيه واحد");
  assert.deepEqual(w.db.shift.map((r) => [r.staff_name, r.role, r.action, r.shift_key]), [["منى", "cashier", "start", "s2"], ["منى", "cashier", "end", "s2"]], "١٩:١٠ = الوردية التانية");
  assert.equal((await w.call("GET", "/api/portal/shift", null, H)).j.today.length, 2);
  assert.equal((await w.call("POST", "/api/portal/shift", { action: "start" }, {})).status, 401);
  w.db.settings.opsReport = { checklistEnabled: false };
  assert.equal((await w.call("POST", "/api/portal/shift", { action: "start" }, H)).status, 409);
});
test("مفيش SQL كتابة على جداول التشغيل: كل استعلامات التقرير SELECT بس", () => {
  for (const [k, v] of Object.entries(SQL)) assert.match(v.replace(/^\/\*ops:\w+\*\/\s*/, ""), /^SELECT\s/, k);
});
test("flagsOf من غير مصادر ⇒ مفيش سطر مخترع", () => {
  assert.deepEqual(flagsOf({ unavailable: [], people: {} }, { targets: T, cfg: opsCfg({}), kind: "daily" }), []);
});
