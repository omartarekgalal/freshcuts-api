/* AUTO1 — محرّك الفلوهات الجديدة (autoflows.js) بالكامل على فيكس: مفيش داتابيز ولا إرسال حقيقي.
     node --test autoflows.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { validateDef, makeEngine, memStore, scheduleSlot, nextScheduleTimes, render, holdoutHash, condOk, describeDef, foldStats, pgStore } from "./autoflows.js";

const SEG = new Set(["lapsed_21", "loyal", "vip"]);
const base = (over = {}) => ({
  trigger: { type: "segment_entry", segment: "lapsed_21" },
  steps: [{ id: "s1", type: "send", channel: "push", text: "وحشتنا يا {name}" }],
  goal: { type: "order", withinDays: 7 }, holdoutPct: 0, ...over,
});

/* بيئة كاملة: شريحة متغيّرة، حراس، هدوء، مرسلين مزيفين بيسجّلوا بس */
function env({ seg = [], quiet = null, guard = () => ({ ok: true }), ordered = () => ({ n: 0, revenue: 0 }), now = "2026-10-22T15:00:00Z", events = [] } = {}) {
  const store = memStore();
  const sent = [];
  const st = { seg: [...seg], now: new Date(now) };
  const sender = (ch) => async (pn, payload, meta) => { sent.push({ ch, pn, payload, meta }); return { ok: true }; };
  const engine = makeEngine({
    store, now: () => st.now, getSettings: async () => ({}),
    segmentPhones: async () => st.seg,
    eventsSince: async (type, since) => events.filter((e) => e.type === type && e.at > since),
    profiles: async (pns) => new Map(pns.map((p) => [p, { name: "عبدالرحمن الغامدي", orders: Number(p.slice(-1)), daysSinceLast: 25, spent: 300 }])),
    guard: async (ch, pn) => guard(ch, pn), quietUntil: async (ch, s, t) => (quiet ? quiet(ch, t) : null),
    send: { push: sender("push"), sms: sender("sms"), wa_template: sender("wa_template"), wa_text: sender("wa_text"), staff_alert: sender("staff_alert") },
    ordered: async (pn, a, b) => ordered(pn, a, b), clicked: async () => false, replied: async () => false,
  });
  return { store, sent, st, engine };
}
const mk = async (e, def) => { const f = await e.store.createFlow({ name: "تجربة", def: validateDef(def).def }); return f; };

test("التحقق: الفلو الناقص بيترفض بأخطاء عربي، والصح بيتنضّف وحدوده بتتقص", () => {
  const bad = validateDef({ trigger: { type: "x" }, steps: [] }, { segments: SEG });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.path === "trigger.type"));
  assert.ok(bad.errors.some((e) => e.path === "steps"));
  assert.equal(validateDef(base({ trigger: { type: "segment_entry", segment: "nope" } }), { segments: SEG }).ok, false, "شريحة مش موجودة");
  const ok = validateDef(base({ caps: { reenterDays: 9999, perRun: 0, perDay: "x" }, holdoutPct: 90, steps: [
    { id: "s1", type: "send", channel: "push", text: "اهلا" }, { id: "w", type: "wait", minutes: 1 },
    { id: "b", type: "branch", check: "ordered", yes: "exit", no: "next" }, { id: "s2", type: "send", channel: "sms", text: "x".repeat(900) }] }), { segments: SEG });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.def.caps, { reenterDays: 365, perRun: 1, perDay: 200 });
  assert.equal(ok.def.holdoutPct, 50);
  assert.equal(ok.def.steps[1].minutes, 5, "أقل انتظار ٥ دقايق");
  assert.equal(ok.def.steps[3].text.length, 320, "SMS مقصوص");
  assert.equal(ok.def.respectQuiet, true);
  assert.equal(validateDef(base({ respectQuiet: false })).def.respectQuiet, true, "ساعات الهدوء مش مفتاح");
  const br = validateDef(base({ steps: [{ id: "s1", type: "send", channel: "push", text: "x" }, { id: "b", type: "branch", check: "ordered", yes: "zz", no: "next" }] }));
  assert.ok(br.errors.some((e) => /مش موجودة/.test(e.error)));
  const tpl = validateDef(base({ steps: [{ id: "s1", type: "send", channel: "wa_template", template: "fc_new" }] }), { templates: new Set(["fc_ok"]) });
  assert.ok(tpl.errors.some((e) => /مش معتمد/.test(e.error)), "قالب واتساب لازم يكون معتمد");
  const sch = validateDef({ trigger: { type: "schedule", segment: "vip", days: [4, 4, 9], at: "25:00" }, steps: [{ type: "send", channel: "push", text: "x" }] });
  assert.ok(sch.errors.some((e) => e.path === "trigger.at"));
  assert.deepEqual(sch.def.trigger.days, [4]);
});

test("دخول شريحة: أول دورة نقطة بداية من غير إرسال، وبعدين الداخلين الجداد بس", async () => {
  const e = env({ seg: ["500000001", "500000002"] });
  const f = await mk(e, base());
  await e.store.updateFlow(f.id, { active: true });
  const r1 = await e.engine.tick();
  assert.equal(e.sent.length, 0, "الموجودين وقت التشغيل مايتبعتلهمش");
  assert.match(r1.res[0].note, /baseline:2/);
  e.st.seg.push("500000003");
  e.st.now = new Date("2026-10-22T16:00:00Z");
  await e.engine.tick();
  assert.deepEqual(e.sent.map((x) => x.pn), ["500000003"]);
  assert.equal(e.sent[0].payload.body, "وحشتنا يا عبدالرحمن", "{name} = الاسم الأول");
  await e.engine.tick();
  assert.equal(e.sent.length, 1, "مايتبعتش مرتين");
});

test("الفلو المقفول مابيشتغلش خالص (الافتراضي)", async () => {
  const e = env({ seg: ["500000001"] });
  await mk(e, base());
  const r = await e.engine.tick();
  assert.deepEqual(r, { flows: 0 });
  assert.equal(e.sent.length, 0);
});

test("انتظار ثم رسالة تانية، والهدف (طلب) بيخرّج العميل قبل الرسالة التانية", async () => {
  let orderedAfter = null;
  const e = env({ seg: [], ordered: (pn, a, b) => (orderedAfter && b >= orderedAfter ? { n: 1, revenue: 120 } : { n: 0 }) });
  const f = await mk(e, base({ steps: [{ id: "s1", type: "send", channel: "push", text: "اهلا" }, { id: "w1", type: "wait", minutes: 120 }, { id: "s2", type: "send", channel: "sms", text: "لسه مستنيينك" }] }));
  await e.store.updateFlow(f.id, { active: true, baseline_at: "2026-10-01T00:00:00Z" });
  e.st.seg = ["500000011", "500000012"];
  await e.engine.tick();
  assert.equal(e.sent.filter((x) => x.ch === "push").length, 2);
  e.st.now = new Date("2026-10-22T16:00:00Z");
  await e.engine.tick();
  assert.equal(e.sent.filter((x) => x.ch === "sms").length, 0, "لسه في الانتظار");
  orderedAfter = "2026-10-22T16:30:00Z";
  e.st.now = new Date("2026-10-22T17:05:00Z");
  await e.engine.tick();
  assert.equal(e.sent.filter((x) => x.ch === "sms").length, 0, "طلب ⇒ خرج بالهدف");
  const st = await e.store.stats(f.id);
  assert.equal(st.converted, 2);
  assert.equal(st.revenue, 240);
  assert.equal(st.sent.push, 2);
});

test("التفرّع: ماطلبش ⇒ الخطوة الجاية، طلب ⇒ خروج", async () => {
  const e = env({ ordered: (pn) => (pn.endsWith("1") ? { n: 1, revenue: 50 } : { n: 0 }) });
  const f = await mk(e, base({ goal: null, steps: [{ id: "s1", type: "send", channel: "push", text: "x" }, { id: "b", type: "branch", check: "ordered", yes: "exit", no: "next" }, { id: "s2", type: "send", channel: "sms", text: "y" }] }));
  await e.store.updateFlow(f.id, { active: true, baseline_at: "2026-10-01T00:00:00Z" });
  e.st.seg = ["500000021", "500000022"];
  await e.engine.tick();
  assert.deepEqual(e.sent.filter((x) => x.ch === "sms").map((x) => x.pn), ["500000022"]);
  assert.equal(e.store._s.enroll.find((x) => x.phone_norm === "500000021").status, "exited");
});

test("ساعات الهدوء: الرسالة بتتأجل للميعاد المسموح ومابتضيعش؛ تنبيه الفريق مش متأثر", async () => {
  const open = new Date("2026-10-23T09:00:00Z");
  const e = env({ quiet: (ch, t) => (t < open ? open : null) });
  const f = await mk(e, base({ steps: [{ id: "s1", type: "send", channel: "sms", text: "x" }, { id: "s2", type: "send", channel: "staff_alert", text: "دخل عميل" }] }));
  await e.store.updateFlow(f.id, { active: true, baseline_at: "2026-10-01T00:00:00Z" });
  e.st.seg = ["500000031"];
  const r = await e.engine.tick();
  assert.equal(e.sent.length, 0);
  assert.equal(r.res[0].deferred.quiet, 1);
  e.st.now = new Date("2026-10-23T09:05:00Z");
  await e.engine.tick();
  assert.deepEqual(e.sent.map((x) => x.ch), ["sms", "staff_alert"]);
});

test("الحراس (إيقاف/موظف/فاصل): العميل بيتشال بالسبب، والفلو يكمّل للباقي", async () => {
  const e = env({ guard: (ch, pn) => (pn === "500000041" ? { ok: false, reason: "opted_out" } : { ok: true }) });
  const f = await mk(e, base());
  await e.store.updateFlow(f.id, { active: true, baseline_at: "2026-10-01T00:00:00Z" });
  e.st.seg = ["500000041", "500000042"];
  const r = await e.engine.tick();
  assert.deepEqual(e.sent.map((x) => x.pn), ["500000042"]);
  assert.equal(r.res[0].skipped.opted_out, 1);
  assert.equal((await e.store.stats(f.id)).skipped.opted_out, 1);
});

test("السقوف: perRun بيوقف الدورة ويكمّل الدورة الجاية، reenterDays بيمنع الدخول تاني", async () => {
  const e = env();
  const f = await mk(e, base({ trigger: { type: "schedule", segment: "vip", days: [4], at: "18:00" }, caps: { perRun: 2, reenterDays: 30, perDay: 100 } }));
  await e.store.updateFlow(f.id, { active: true });
  e.st.seg = ["500000051", "500000052", "500000053"];
  e.st.now = new Date("2026-10-22T15:10:00Z");      // الخميس ١٨:١٠ الرياض
  const r = await e.engine.tick();
  assert.equal(e.sent.length, 2);
  assert.equal(r.res[0].deferred.run_cap, 1);
  e.st.now = new Date("2026-10-22T15:20:00Z");
  await e.engine.tick();
  assert.equal(e.sent.length, 3, "الباقي في الدورة الجاية");
  e.st.now = new Date("2026-10-29T15:05:00Z");      // الخميس الجاي: لسه جوه ٣٠ يوم
  const r3 = await e.engine.tick();
  assert.equal(e.sent.length, 3);
  assert.equal(r3.res[0].skipped.reenter, 3);
});

test("الجدول: خانة واحدة لكل ميعاد (مايتكررش في نفس الساعة)، والمواعيد الجاية للتايم لاين", async () => {
  const tr = { type: "schedule", days: [4, 5], at: "17:00" };
  assert.equal(scheduleSlot(tr, new Date("2026-10-22T14:30:00Z")), "2026-10-22T17:00");
  assert.equal(scheduleSlot(tr, new Date("2026-10-22T13:59:00Z")), null, "قبل الميعاد");
  assert.equal(scheduleSlot(tr, new Date("2026-10-21T14:30:00Z")), null, "الأربع مش في الأيام");
  const next = nextScheduleTimes(tr, new Date("2026-10-22T15:00:00Z"), 3);
  assert.deepEqual(next, ["2026-10-23T14:00:00.000Z", "2026-10-29T14:00:00.000Z", "2026-10-30T14:00:00.000Z"]);
  const e = env({ seg: ["500000061"], now: "2026-10-22T14:05:00Z" });
  const f = await mk(e, base({ trigger: { type: "schedule", segment: "vip", days: [4], at: "17:00" } }));
  await e.store.updateFlow(f.id, { active: true });
  await e.engine.tick(); await e.engine.tick();
  assert.equal(e.sent.length, 1);
});

test("الحدث: طلب مدفوع بعد التشغيل بس، والشروط بتفلتر", async () => {
  const events = [
    { type: "order_paid", pn: "500000071", at: "2026-10-22T10:00:00.000Z" },      // قبل التشغيل
    { type: "order_paid", pn: "500000073", at: "2026-10-22T14:00:00.000Z" },
    { type: "order_paid", pn: "500000071", at: "2026-10-22T14:10:00.000Z" },
  ];
  const e = env({ events });
  const f = await mk(e, base({ trigger: { type: "event", event: "order_paid" }, conditions: [{ field: "orders", op: "gte", value: 2 }] }));
  await e.store.updateFlow(f.id, { active: true, activated_at: "2026-10-22T12:00:00.000Z" });
  const r = await e.engine.tick();
  assert.deepEqual(e.sent.map((x) => x.pn), ["500000073"], "…071 عنده طلب واحد (الشرط ≥٢)");
  assert.equal(r.res[0].skipped.conditions, 1);
  await e.engine.tick();
  assert.equal(e.sent.length, 1, "مفيش أحداث جديدة");
});

test("holdout: ثابت بالهاش، المحجوز مابيتبعتلوش وبيتعدّ في الأرقام", async () => {
  assert.equal(holdoutHash("a1", "500000081", 0), false);
  const pns = Array.from({ length: 400 }, (_, i) => `5${String(i).padStart(8, "0")}`);
  const n = pns.filter((p) => holdoutHash("a1", p, 10)).length;
  assert.ok(n > 20 && n < 70, `~10% (${n})`);
  assert.equal(holdoutHash("a1", pns[3], 10), holdoutHash("a1", pns[3], 10));
  const e = env();
  const f = await mk(e, base({ holdoutPct: 50 }));
  await e.store.updateFlow(f.id, { active: true, baseline_at: "2026-10-01T00:00:00Z" });
  e.st.seg = pns.slice(0, 40);
  const r = await e.engine.tick();
  assert.equal(r.res[0].holdout + e.sent.length, 40);
  assert.ok(r.res[0].holdout > 5);
  const st = await e.store.stats(f.id);
  assert.equal(st.holdout, r.res[0].holdout);
  assert.equal(st.entered, 40);
});

test("«جرّب على موبايلي»: رقم تجربة بس، ومايدخلش الفلو", async () => {
  const e = env();
  const f = await mk(e, base({ steps: [{ id: "s1", type: "send", channel: "sms", text: "اهلا {name}" }] }));
  const no = await e.engine.testSend(f, "500000099", { allowed: new Set(["500000001"]) });
  assert.equal(no.ok, false);
  assert.equal(no.error, "not_test_phone");
  assert.equal(e.sent.length, 0);
  const yes = await e.engine.testSend(f, "500000001", { allowed: new Set(["500000001"]) });
  assert.equal(yes.ok, true);
  assert.equal(e.sent[0].meta.test, true);
  assert.equal(e.sent[0].payload.text, "اهلا عمر");
  assert.equal(e.store._s.enroll.length, 0);
  assert.equal((await e.store.stats(f.id)).tests, 1);
});

test("فشل الإرسال بيتسجّل ومابيوقعش الدورة", async () => {
  const e = env();
  e.engine; // eslint
  const f = await mk(e, base());
  await e.store.updateFlow(f.id, { active: true, baseline_at: "2026-10-01T00:00:00Z" });
  e.st.seg = ["500000101"];
  const eng = makeEngine({ ...{ store: e.store, now: () => e.st.now, getSettings: async () => ({}), segmentPhones: async () => e.st.seg,
    profiles: async () => new Map(), guard: async () => ({ ok: true }), quietUntil: async () => null, ordered: async () => ({ n: 0 }) },
  send: { push: async () => { throw new Error("boom"); } } });
  const r = await eng.tick();
  assert.equal(r.res[0].failed, 1);
  assert.equal((await e.store.stats(f.id)).failed, 1);
});

test("أدوات: render / الشروط / الوصف / تجميع الأرقام", () => {
  assert.equal(render("هلا {name}، اطلب: {link}", { name: "سارة محمد" }, { link: "freshcuts.sa" }), "هلا سارة، اطلب: freshcuts.sa");
  assert.equal(render("هلا {name}  !", {}), "هلا !");
  assert.equal(condOk([{ field: "spent", op: "gte", value: 100 }], { spent: 99 }), false);
  assert.equal(condOk([{ field: "orders", op: "eq", value: 1 }], { orders: 1 }), true);
  assert.equal(condOk([{ field: "orders", op: "lte", value: 1 }], {}), false);
  const d = describeDef(validateDef({ trigger: { type: "schedule", segment: "vip", days: [4, 5], at: "17:00" }, steps: [{ type: "send", channel: "push", text: "x" }, { type: "send", channel: "sms", text: "y" }] }).def, () => "كبار العملاء");
  assert.equal(d.trigger, "الخميس والجمعة الساعة 17:00 لـ«كبار العملاء»");
  assert.deepEqual(d.channels, ["push", "sms"]);
  const s = foldStats([{ kind: "sent", channel: "sms", n: 30, cost: 2.4, rev: 0 }, { kind: "goal", n: 6, cost: 0, rev: 600.4 }],
    [{ holdout: false, n: 30, ordered7: 6 }, { holdout: true, n: 20, ordered7: 2 }]);
  assert.equal(s.entered, 50); assert.equal(s.holdout, 20); assert.equal(s.lift7, 10); assert.equal(s.liftReliable, true); assert.equal(s.revenue, 600);
});

test("pgStore: الجمل بتستخدم بارامترات بس (مفيش قيمة جوه SQL)، وdef بيتخزن JSON", async () => {
  const calls = [];
  const pool = { query: async (sql, p) => { calls.push({ sql, p }); return { rows: [{ id: 1, n: 0 }] }; } };
  const s = pgStore(pool);
  await s.createFlow({ name: "x'; DROP", def: { v: 1 }, createdBy: "omar" });
  await s.updateFlow(1, { active: true, def: { v: 1 }, evil: "x" });
  const ins = calls.find((c) => /INSERT INTO auto_flows/.test(c.sql));
  assert.ok(!/DROP/.test(ins.sql));
  assert.equal(ins.p[2], '{"v":1}');
  const up = calls.find((c) => /UPDATE auto_flows/.test(c.sql));
  assert.match(up.sql, /active = \$2, def = \$3::jsonb/);
  assert.ok(!/evil/.test(up.sql), "عمود مش معروف بيتشال");
});
