/* WO1 (١٩/١٠/٢٠٢٦) — «نكمّل لما نفتح»: العميل طلب والمطعم مقفول ⇒ رسالة حرة واحدة وقت الفتح بسلته.
   الوحدة نفسها (waopenfu.js) بقاعدة وساعة ومُرسِل مزيّفين، وأرقام تجربة مقنّعة 5000000xx. الإعادة الكاملة للحادثة جوّه البوت في wabotrun.test.mjs («WO1 …»).
   node --test wo1-open-followup.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as OF from "./waopenfu.js";
import * as R from "./wabotrun.js";
import * as AR from "./waassistrun.js";
import { PROACTIVE_KEYS, PROACTIVE_JOB_KINDS } from "./wajourney.js";
import { FU_PROACTIVE_KEYS, FU_OTHER_JOBS } from "./wafollow.js";

const HOURS = { enabled: true, days: Object.fromEntries(["sun", "mon", "tue", "wed", "sat"].map((d) => [d, { open: "12:00", close: "02:00" }]).concat([["thu", { open: "12:00", close: "03:00" }], ["fri", { open: "12:00", close: "03:00" }]])) };
const SETTINGS = { hours: HOURS };
const AT = new Date("2026-10-19T07:36:51Z");          // الاثنين ١٠:٣٦ الرياض — الحادثة
const P = "500000021";
const SNAP = { subtotal: 34, lines: [{ name: "وجبة نصف دجاجة على الفحم", qty: 1 }, { name: "بطاطس محمرة", qty: 1 }], input: { items: [{ id: "13", qty: 1 }, { id: "79", qty: 1 }] } };

test("المواعيد: مقفول ١٠:٣٦ ⇒ الفتح ١٢:٠٠ + دقيقتين؛ يوم مقفول بعده الفتح بعد ٣٣ ساعة ⇒ النافذة هتقفل؛ مفتوح ⇒ مفيش خطة؛ المواعيد مش متعرّفة ⇒ مفيش تسجيل", () => {
  assert.equal(OF.closedNow(AT, SETTINGS), true);
  assert.deepEqual(OF.openingPlan({ now: AT, settings: SETTINGS, lastInMs: AT.getTime(), delayMin: 2 }), { ok: true, openAt: "2026-10-19T09:00:00.000Z", dueAt: "2026-10-19T09:02:00.000Z" });
  assert.equal(OF.openingPlan({ now: AT, settings: SETTINGS, lastInMs: AT.getTime(), delayMin: 0 }).dueAt, "2026-10-19T09:00:00.000Z");
  const monOff = { hours: { ...HOURS, days: { ...HOURS.days, mon: { open: "12:00", close: "02:00", closed: true } } } };
  const w = OF.openingPlan({ now: new Date("2026-10-19T00:30:00Z"), settings: monOff, lastInMs: Date.parse("2026-10-19T00:30:00Z"), delayMin: 2 });
  assert.deepEqual([w.ok, w.reason, w.openAt], [false, "window_would_close", "2026-10-20T09:00:00.000Z"]);
  assert.deepEqual(OF.openingPlan({ now: new Date("2026-10-19T12:00:00Z"), settings: SETTINGS, lastInMs: 0 }), { ok: false, reason: "open_now" });
  assert.equal(OF.closedNow(AT, {}), false); assert.deepEqual(OF.openingPlan({ now: AT, settings: {}, lastInMs: 0 }), { ok: false, reason: "hours_unknown" });
  // after midnight, still inside Sunday's shift (closes 02:00) = open; 02:30 = closed, opens today 12:00
  assert.equal(OF.closedNow(new Date("2026-10-18T22:30:00Z"), SETTINGS), false);
  assert.equal(OF.openingPlan({ now: new Date("2026-10-18T23:30:00Z"), settings: SETTINGS, lastInMs: Date.parse("2026-10-18T23:30:00Z") }).openAt, "2026-10-19T09:00:00.000Z");
});

test("صورة السلة: من جلسة الحادثة نفسها (cartNow + lastInput) ومن رابط build_cart؛ سطر السلة بالكميات والأوزان", () => {
  const state = { cartNow: { subtotal: 34, lines: [{ name: "وجبة نصف دجاجة على الفحم", qty: 1 }, { name: "بطاطس محمرة", qty: 1 }] }, lastInput: { items: [{ id: "13", qty: 1 }, { id: "79", qty: 1 }], option: "pickup" } };      // نفس wa_assist_chats للرقم …6102 ١٩/١٠
  const s = OF.cartSnapshotOf({ state });
  assert.deepEqual(s, SNAP, "option is not kept (the model passes a default); the opening message asks delivery or pickup");
  assert.equal(OF.cartSnapshotOf({ state: { cartNow: state.cartNow } }), null, "no inputs ⇒ nothing to price again ⇒ no cart");
  const built = OF.cartSnapshotOf({ cart: { code: "rc000009", subtotal: 40, lines: [{ name: "بطاطس محمرة", name_en: "Fries", qty: 2 }] }, state: {}, trace: { tools: [{ name: "build_cart", input: { option: "pickup", items: [{ id: "79", qty: 2 }] }, result: { ok: true, saved: true } }] } });
  assert.deepEqual(built, { code: "rc000009", subtotal: 40, lines: [{ name: "بطاطس محمرة", name_en: "Fries", qty: 2 }], input: { items: [{ id: "79", qty: 2 }] } });
  assert.equal(OF.cartLine(SNAP.lines), "وجبة نصف دجاجة على الفحم + بطاطس محمرة");
  assert.equal(OF.cartLine([{ name: "كفتة", qty: 2, weight: "نصف كيلو", weight_en: "half kilo", name_en: "Kofta" }, { name: "بطاطس محمرة", name_en: "Fries", qty: 1 }], "en"), "2 × Kofta (half kilo) + Fries");
});

test("الإعدادات في اللوحة: المفتاح + التأخير + من غير سلة + السقف — في مخطط البوت بمجموعتها، والحفظ بيرفض اللي بره الحدود؛ والنصوص الثلاثة في «النصوص» بلهجة بيضاء من غير أرقام", () => {
  const c = R.botConfig({});
  assert.deepEqual([c.openFollowUp, c.openFollowUpDelayMin, c.openFollowUpPlain, c.openFollowUpDailyCap], [true, 2, true, 60]);
  assert.deepEqual(R.botConfig({ waBot: { openFollowUp: false, openFollowUpDelayMin: 99 } }).openFollowUpDelayMin, 60);
  for (const k of Object.keys(OF.OF_DEFAULTS)) { assert.ok(R.SCHEMA[k] && R.SCHEMA[k].ar, k); assert.equal(R.SCHEMA[k].group, OF.OF_GROUP); }
  assert.equal(R.SCHEMA_GROUPS[OF.OF_GROUP], OF.OF_GROUP_AR);
  assert.ok(R.schemaFor(c).some((r) => r.key === "openFollowUpDelayMin" && r.value === 2 && r.default === 2 && r.groupAr === OF.OF_GROUP_AR), "the bot settings screen renders it from the schema");
  assert.deepEqual(R.configFromBody({ openFollowUp: false, openFollowUpDelayMin: 5, openFollowUpPlain: false, openFollowUpDailyCap: 10 }, {}), { ok: true, value: { openFollowUp: false, openFollowUpDelayMin: 5, openFollowUpPlain: false, openFollowUpDailyCap: 10 } });
  assert.equal(R.configFromBody({ openFollowUpDelayMin: 61 }, {}).ok, false); assert.equal(R.configFromBody({ openFollowUpDailyCap: -1 }, {}).ok, false);
  for (const k of ["open_fu_cart", "open_fu_link", "open_fu_plain"]) for (const lang of ["ar", "en"]) {
    const t = R.TEXTS[k][lang];
    assert.equal(R.textProblem(k, lang, t), null, `${k}.${lang}`); assert.doesNotMatch(t, /[0-9٠-٩]/, "no hard-coded numbers");
    if (lang === "ar") assert.doesNotMatch(t, /دلوقتي|عايز|عاوز|كده|مفيش|\sمش\s|النهارده|هنبعت|إحنا|احنا/, "white dialect, not Egyptian");
  }
  assert.equal(R.fill("open_fu_cart", R.TEXTS.open_fu_cart.ar, { cart: OF.cartLine(SNAP.lines), total: "34" }), "فتحنا الحين 👋 سلتك جاهزة: وجبة نصف دجاجة على الفحم + بطاطس محمرة = 34 ر.س.\nتوصيل ولا استلام؟");
  assert.equal(R.textProblem("open_fu_cart", "ar", "فتحنا {cart} {code}"), "unknown_placeholder:code", "the owner's edit is validated like every bot text");
});

test("نفس أقفال الرسايل المبادِرة: الهدوء بعد آخر رسالة (CJ1a)، «متابعتين ماحدش رد عليهم» و«متابعة تانية في نفس النافذة» (FU1)، وحارس النافذة و«أنا معك» بيعدّوها", () => {
  assert.ok(PROACTIVE_KEYS.has("open_followup")); assert.ok(PROACTIVE_JOB_KINDS.includes("open_followup"));
  assert.ok(FU_PROACTIVE_KEYS.includes("open_followup")); assert.ok(FU_OTHER_JOBS.includes("open_followup"));
  const src = fs.readFileSync(new URL("./wabotrun.js", import.meta.url), "utf8");
  assert.match(src, /kind IN \('assist_followup','assist_nudge','lead_followup','window_keep','assist_reminder','\$\{FU_KIND\}','\$\{OF_KIND\}'\)/, "window keeper counts it");
  assert.match(src, /kind IN \('assist_nudge','lead_followup','assist_followup','\$\{FU_KIND\}','\$\{OF_KIND\}'\)/, "the nudge counts it");
  assert.match(src, /if \(j\.kind === OF_KIND\) \{ await openFu\.run\(/, "runDueJobs dispatches it");
  assert.match(src, /session\.state\.seed === "opening"/, "the seeded session after the opening message is a first turn");
  assert.match(src, /await pool\.query\(OF_DDL\)/);
  assert.match(src, /wa\.sendFreeform/); assert.doesNotMatch(fs.readFileSync(new URL("./waopenfu.js", import.meta.url), "utf8"), /sendTemplate|template:/, "free text only — never a paid template");
});

test("كلام المساعد وهو مقفول: «أول ما نفتح أرسل لك سلتك» بس لما الرسالة هتتبعت فعلاً؛ غير كده القاعدة القديمة زي ما هي", () => {
  const closed = { open_now: false, opens: "اليوم الساعة 12 ظهراً" };
  assert.equal(AR.buildContext({ hours: closed }).closed_rule, "we are closed now: say so in this reply with the opening time, and offer to prepare the cart for when we open");
  assert.equal(AR.buildContext({ hours: closed, openFollow: true }).closed_rule, AR.CTX_RULES.closedFollow);
  assert.match(AR.CTX_RULES.closedFollow, /ONE message/); assert.match(AR.CTX_RULES.closedFollow, /أول ما نفتح أرسل لك سلتك/);
  assert.equal(AR.buildContext({ hours: { open_now: true, closes_at: "02:00" }, openFollow: true }).closed_rule, undefined);
  assert.ok(AR.ORDER_RE.test("السلام عليكم ورحمة الله عايز نص دجاج فحم وباكت بطاطس".replace(/[ًٌٍَُِّْ]/g, "")), "the incident message is an order intent");
});

/* ── الوحدة بقاعدة مزيّفة ─────────────────────────────────────────────────────── */
function fakeWorld({ at = AT, settings = SETTINGS, cfg: cfgIn = {} } = {}) {
  let nowMs = at.getTime();
  const clock = { now: () => new Date(nowMs), set: (iso) => { nowMs = Date.parse(iso); } };
  const db = { jobs: [], of: [], ordered: false, optout: false, hold: false, complaint: false, others: false, ignored: 0, cartOk: true, brake: { on: false } };
  const T = (v) => Date.parse(v);
  const q = async (sql, p = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    const tag = (/^\/\*(of|fu|t):([a-z_]+)\*\//.exec(s) || [])[0] || s.slice(0, 40);
    const led = (k) => db.of.find((x) => x.job_key === k);
    switch (tag) {
      case "/*of:replace*/": for (const j of db.jobs) if (j.phone_norm === p[0] && j.status === "pending" && j.wamid !== p[1]) Object.assign(j, { status: "cancelled", reason: "replaced" }); return [];
      case "/*of:replace_ledger*/": for (const x of db.of) if (x.phone_norm === p[0] && x.status === "pending" && x.job_key !== p[1]) Object.assign(x, { status: "skipped", reason: "replaced" }); return [];
      case "/*of:upsert_job*/": { const j = db.jobs.find((x) => x.wamid === p[0]); if (j) { if (j.status !== "pending") return []; Object.assign(j, { due_at: p[2], ev: JSON.parse(p[3]) }); return [{ id: j.id }]; }
        const n = { id: db.jobs.length + 1, wamid: p[0], phone_norm: p[1], kind: OF.OF_KIND, due_at: p[2], ev: JSON.parse(p[3]), status: "pending" }; db.jobs.push(n); return [{ id: n.id }]; }
      case "/*of:ledger_plan*/": { const x = led(p[0]); const v = { msg_at: p[2], open_at: p[3], due_at: p[4], status: p[7], reason: p[8], updated_at: clock.now().toISOString() }; if (!x) db.of.push({ job_key: p[0], phone_norm: p[1], ...v }); else if (["pending", "skipped"].includes(x.status)) Object.assign(x, v); return []; }
      case "/*of:skip*/": { const x = led(p[0]); if (!x) db.of.push({ job_key: p[0], phone_norm: p[1], status: "skipped", reason: p[2] }); else if (["pending", "skipped"].includes(x.status)) Object.assign(x, { status: "skipped", reason: p[2] }); return []; }
      case "/*of:reserve*/": { const x = led(p[0]); if (!x) { db.of.push({ job_key: p[0], phone_norm: p[1], status: "sending", via: p[2] }); return [{ id: 1 }]; } if (x.status !== "pending") return []; Object.assign(x, { status: "sending", via: p[2] }); return [{ id: 1 }]; }
      case "/*of:unreserve*/": { const x = led(p[0]); if (x && x.status === "sending") Object.assign(x, { status: "pending", reason: p[1] }); return []; }
      case "/*of:mark*/": Object.assign(led(p[0]), { status: p[1], wamid: p[2], error: p[3], text: p[4], cart_code: p[5], total: p[6], sent_at: clock.now().toISOString() }); return [];
      case "/*of:sent_since*/": return db.of.filter((x) => x.phone_norm === p[0] && ["sending", "sent"].includes(x.status) && x.job_key !== p[2]).map(() => ({}));
      case "/*of:others_since*/": return db.others ? [{}] : [];
      case "/*of:hold*/": return db.hold ? [{}] : [];
      case "/*of:day_count*/": return [{ n: db.of.filter((x) => ["sending", "sent"].includes(x.status)).length + (db.dayBase || 0) }];
      case "/*fu:ordered*/": return db.ordered ? [{}] : [];
      case "/*fu:opted_out*/": return db.optout ? [{}] : [];
      case "/*fu:ignored*/": return [{ n: db.ignored }];
      case "/*fu:cart_ok*/": return db.cartOk ? [{}] : [];
      case "/*fu:defer*/": { const j = db.jobs.find((x) => x.id === p[0]); Object.assign(j, { status: "pending", due_at: p[1], reason: p[2] }); return []; }
      case "/*t:complaint*/": return db.complaint ? [{}] : [];
      default: if (/^UPDATE wa_bot_chats SET last_disclosed_at/.test(s)) return []; throw new Error(`fake q: ${s.slice(0, 80)}`);
    }
  };
  const sent = [], turns = [], sessions = new Map();
  const gate = { why: null, wrote: 0, staff: 0, marketing_off_at: null, chat: {} };
  let live = { ok: true, option: "delivery", subtotal: 34, problems: [], lines: [{ name: "وجبة نصف دجاجة على الفحم", qty: 1 }, { name: "بطاطس محمرة", qty: 1 }] };
  let sendResult = (n) => ({ err: null, wamid: `wamid.OF${n}` });
  const cfg = { ...R.botConfig({ waBot: { mode: "live" } }), ...cfgIn };
  const fu = OF.makeOpenFollowUp({ q, STORE: "https://freshcuts.sa", log: () => {},
    store: { addTurn: async (t) => { turns.push(t); return turns.length; }, saveSession: async (ph, s) => { sessions.set(ph, s); } },
    assist: { build_cart: async () => (typeof live === "function" ? live() : live) },
    sendOwnX: async (phone, _cfg, _now, rep, lang, key, detail) => { const r = sendResult(sent.length + 1); if (!r.until) sent.push({ phone, rep, lang, key, detail }); return r; },
    ownGate: async () => [gate.why, { wrote: gate.wrote, staff: gate.staff, last_in: AT.toISOString() }, gate.chat, { marketing_off_at: gate.marketing_off_at }],
    brakeState: async () => db.brake, audience: async () => ({ on: true }), complaintSql: "/*t:complaint*/",
    text: (c, key, lang, vars) => R.fill(key, R.textOf(c, key, lang), vars), modeButtons: (c, lang) => R.assistExtras(c, lang, { buttons: { kind: "mode" } }),
    newSession: (now) => AR.newSession(now) });
  /* نسخة من runDueJobs: الشغلات المستحقة، حجز ذري (pending ⇒ running)، وend */
  async function tick(iso) {
    if (iso) clock.set(iso);
    const now = clock.now(); let ran = 0;
    for (const j of db.jobs.filter((x) => x.status === "pending" && T(x.due_at) <= now.getTime())) {
      if (j.status !== "pending") continue; j.status = "running";
      await fu.run(j, settings, cfg, now, async (status, reason) => { Object.assign(j, { status, reason }); }); ran++;
    }
    return ran;
  }
  const record = (o = {}) => fu.record({ phone: P, settings, cfg, now: clock.now(), msgAt: new Date(clock.now().getTime() - 9000).toISOString(), snapshot: SNAP, intent: true, lang: "ar", ...o });
  return { db, clock, sent, turns, sessions, gate, fu, tick, record, cfg, setLive: (v) => { live = v; }, setSend: (f) => { sendResult = f; } };
}

test("الوحدة: التسجيل وقت القفل ⇒ شغلة ١٢:٠٢؛ مفتوح / من غير سلة ولا كلمة طلب / المفتاح مقفول ⇒ ولا حاجة", async () => {
  const w = fakeWorld();
  assert.deepEqual(await w.record(), { ok: true, key: `of:${P}:${Date.parse("2026-10-19T09:00:00Z")}`, dueAt: "2026-10-19T09:02:00.000Z" });
  assert.deepEqual(await w.record(), { ok: true, key: `of:${P}:${Date.parse("2026-10-19T09:00:00Z")}`, dueAt: "2026-10-19T09:02:00.000Z" }, "a second reply while closed refreshes the same job");
  assert.equal(w.db.jobs.length, 1);
  assert.equal((await w.record({ snapshot: null, intent: false })).reason, "no_order_intent");
  assert.equal((await fakeWorld({ cfg: { openFollowUp: false } }).record()).reason, "off");
  assert.equal((await fakeWorld({ at: new Date("2026-10-19T12:00:00Z") }).record()).reason, "open_now");
  assert.equal((await fakeWorld({ cfg: { openFollowUpPlain: false } }).record({ snapshot: null })).reason, "no_order_intent", "plain off ⇒ an intent without a cart is not recorded");
});

test("الوحدة: مرة واحدة لكل شغلة — تنفيذين لنفس الشغلة (حاويتين) ⇒ رسالة واحدة بالحجز في الدفتر", async () => {
  const w = fakeWorld(); await w.record();
  w.clock.set("2026-10-19T09:02:00Z");
  const j = w.db.jobs[0], ends = [];
  const now = w.clock.now();
  await Promise.all([w.fu.run({ ...j }, SETTINGS, w.cfg, now, async (s, r) => ends.push([s, r])), w.fu.run({ ...j }, SETTINGS, w.cfg, now, async (s, r) => ends.push([s, r]))]);
  assert.equal(w.sent.length, 1);
  assert.deepEqual(ends.map((e) => e[1]).sort(), ["already_reserved", "sent:cart"]);
  assert.equal(w.db.of[0].status, "sent");
});

test("الوحدة: كل سبب منع ⇒ مفيش إرسال والسبب مكتوب (الدفتر + سجل المساعد)", async () => {
  const cases = [
    ["customer_wrote", (w) => { w.gate.wrote = 1; }], ["staff_in_chat", (w) => { w.gate.staff = 1; }], ["window_closed", (w) => { w.gate.why = "window_closed"; }], ["stopped", (w) => { w.gate.why = "stopped"; }],
    ["never_reply", (w) => { w.gate.why = "never_reply"; }], ["muted", (w) => { w.gate.why = "muted"; }], ["stopped", (w) => { w.gate.marketing_off_at = "2026-10-19T08:00:00Z"; }],
    ["opted_out", (w) => { w.db.optout = true; }], ["staff_hold", (w) => { w.db.hold = true; }], ["handover_open", (w) => { w.gate.chat = { handoff_at: "2026-10-19T08:30:00Z" }; }],
    ["complaint_today", (w) => { w.db.complaint = true; }], ["ordered", (w) => { w.db.ordered = true; }], ["window_used", (w) => { w.db.others = true; }], ["ignored", (w) => { w.db.ignored = 2; }],
    ["braked", (w) => { w.db.brake = { on: true }; }], ["daily_cap", (w) => { w.db.dayBase = 60; }],
  ];
  for (const [why, set] of cases) {
    const w = fakeWorld(); await w.record(); set(w);
    await w.tick("2026-10-19T09:02:00Z");
    assert.equal(w.sent.length, 0, why); assert.deepEqual([w.db.jobs[0].status, w.db.jobs[0].reason], ["cancelled", why], why);
    assert.deepEqual([w.db.of[0].status, w.db.of[0].reason], ["skipped", why], why);
    assert.equal(w.turns.at(-1).outcome, `open_followup_skip:${why}`, why);
  }
});

test("الوحدة: صنف خلص وقت الفتح ⇒ سطر من غير سلة ولا أسعار (أو ولا حاجة لو «من غير سلة» مقفول)؛ رابط اتعمل وهو مقفول ⇒ نفس الرابط بالزر وبالسعر الحي", async () => {
  const w = fakeWorld(); await w.record();
  w.setLive({ ok: true, option: "delivery", subtotal: 28, problems: [{ id: "79", error: "sold_out_today" }], lines: [{ name: "وجبة نصف دجاجة على الفحم", qty: 1 }] });
  await w.tick("2026-10-19T09:02:00Z");
  assert.equal(w.sent.length, 1); assert.equal(w.sent[0].rep.body, R.TEXTS.open_fu_plain.ar); assert.equal(w.sent[0].detail, "plain:cart_changed:sold_out_today");
  assert.equal(w.db.jobs[0].reason, "sent:plain:cart_changed:sold_out_today");
  const off = fakeWorld({ cfg: { openFollowUpPlain: false } }); await off.record();
  off.setLive({ ok: true, subtotal: 28, problems: [{ id: "79", error: "sold_out_today" }], lines: [{ name: "x", qty: 1 }] });
  await off.tick("2026-10-19T09:02:00Z");
  assert.equal(off.sent.length, 0); assert.equal(off.db.jobs[0].reason, "cart_changed:sold_out_today");
  const ln = fakeWorld(); await ln.record({ snapshot: { ...SNAP, code: "rc000042" } });
  ln.setLive({ ok: true, subtotal: 36, problems: [], lines: SNAP.lines });      // السعر اتغيّر من ساعتها ⇒ الحي
  await ln.tick("2026-10-19T09:02:00Z");
  assert.equal(ln.sent[0].rep.body, "فتحنا الحين 👋 سلتك جاهزة: وجبة نصف دجاجة على الفحم + بطاطس محمرة = 36 ر.س.\nاضغط الزر وكمّل طلبك 👇");
  assert.deepEqual(ln.sent[0].rep.cta, { title: R.TEXTS.cta_reorder.ar, url: "https://freshcuts.sa/c/rc000042" });
  assert.deepEqual([ln.db.of[0].via, ln.db.of[0].cart_code, ln.db.of[0].total], ["link", "rc000042", 36]);
});

test("الوحدة: المطعم لسه مقفول وقت الميعاد (المواعيد اتغيّرت) ⇒ تأجيل للفتح الجاي جوّه النافذة؛ الهدوء بعد آخر رسالة ⇒ تأجيل مش إلغاء", async () => {
  const later = { hours: { ...HOURS, days: { ...HOURS.days, mon: { open: "14:00", close: "02:00" } } } };
  const w = fakeWorld(); await w.record();
  const now = new Date("2026-10-19T09:02:00Z"), j = w.db.jobs[0]; j.status = "running";
  assert.equal(await w.fu.run(j, later, w.cfg, now, async () => assert.fail("not ended")), "deferred");
  assert.deepEqual([j.status, j.due_at, j.reason], ["pending", "2026-10-19T11:02:00.000Z", "wait:closed"]);
  const h = fakeWorld(); await h.record();
  h.setSend(() => ({ err: "skipped:burst_hold", wamid: null, until: new Date("2026-10-19T09:10:00Z") }));
  await h.tick("2026-10-19T09:02:00Z");
  assert.equal(h.sent.length, 0); assert.deepEqual([h.db.jobs[0].status, h.db.jobs[0].due_at, h.db.of[0].status], ["pending", "2026-10-19T09:10:00.000Z", "pending"]);
  h.setSend((n) => ({ err: null, wamid: `wamid.OF${n}` }));
  await h.tick("2026-10-19T09:10:00Z");
  assert.equal(h.sent.length, 1); assert.equal(h.db.of[0].status, "sent");
});

test("الوحدة: الإرسال فشل ⇒ «failed» في الدفتر والشغلة اتقفلت (مفيش إعادة لوحدها)", async () => {
  const w = fakeWorld(); await w.record();
  w.setSend(() => ({ err: "send_failed", wamid: null }));
  await w.tick("2026-10-19T09:02:00Z");
  assert.deepEqual([w.db.of[0].status, w.db.jobs[0].status, w.db.jobs[0].reason], ["failed", "cancelled", "send_failed:send_failed"]);
  assert.equal(await w.tick("2026-10-19T09:05:00Z"), 0);
});
