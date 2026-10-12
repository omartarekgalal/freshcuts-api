/* 👥 تواصل الفريق على واتساب (ST1) — node --test wateam.test.mjs
   whatsapp.js الحقيقي (الحارس + deliver) فوق قاعدة وهمية بحالة وfetch بيسجّل كل نداء Graph. مفيش شبكة ولا رسالة حقيقية.
   بيثبت: التوزيع بالدور · نافذة مفتوحة ⇒ حر / مقفولة ⇒ قالب فريق معتمد ⇒ SMS · توقيت حارس النافذة وساعات الهدوء · كل نوع «حاجة غريبة»
   والسقف والملخص · أرقام الفريق مش عملاء وأزرارهم وأوامرهم شغّالة · ومفيش حاجة بتروح لرقم مش في دليل الفريق. */
import test from "node:test";
import assert from "node:assert/strict";

const W = await import("./whatsapp.js");
const C = await import("./watemplates.js");
const T = await import("./wateam.js");
W.registerCatalog(C);

const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN"];
function withEnv(vals, fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, vals);
    try { await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
}
const OPEN = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1", WHATSAPP_ENABLED: "1" };
const H = 3600_000;
/* أرقام وهمية (مش أرقام الفريق الحقيقية) */
const CASH1 = "561000001", CASH2 = "561000002", MGR = "506000003", OWN1 = "544000004", OWN2 = "561000005", CUST = "512345678";
const MEMBERS = [{ phone: `0${CASH1}`, name: "منى", role: "cashier" }, { phone: `0${CASH2}`, name: "سارة", role: "cashier" }, { phone: `0${MGR}`, name: "خالد", role: "manager" },
  { phone: `0${OWN1}`, name: "عمر", role: "owner" }, { phone: `0${OWN2}`, name: "طارق", role: "owner" }];
const NOON = "2026-10-13T12:00:00Z";      // ٣:٠٠ العصر بتوقيت الرياض — بره ساعات الهدوء

function world({ at = NOON, waTeam = { members: MEMBERS }, settings = {}, lastIn = {}, approved = [], chat = [], graphFail = null, flow = null } = {}) {
  let nowMs = Date.parse(at);
  const clock = { now: () => new Date(nowMs), advance: (min) => { nowMs += min * 60_000; }, set: (iso) => { nowMs = Date.parse(iso); } };
  const db = { settings: { waMaster: { enabled: true }, notifications: { whatsappEnabled: false }, delivery: { alertPhones: [], staffSmsLanguage: "en" }, waBot: { testPhones: [] }, ...(waTeam ? { waTeam } : {}), ...settings },
    lastIn: { ...lastIn }, chat: [...chat], state: {}, log: [], odd: [], oddSeq: 0, events: approved.map((name) => ({ name, event: "APPROVED" })), out: [], botFailed: 0 };
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    /* whatsapp.js: نافذة الـ٢٤ ساعة (NOW() = ساعة الاختبار) */
    if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in' AND COALESCE\(source,'api'\) <> 'history' AND created_at > NOW\(\) - INTERVAL '24 hours'/i.test(s)) {
      const li = db.lastIn[p[0]]; return { rows: li && nowMs - Date.parse(li) < 24 * H ? [{}] : [] };
    }
    if (/^SELECT max\(created_at\) AS at FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: [{ at: db.lastIn[p[0]] || null }] };
    if (/^SELECT body FROM wa_messages WHERE phone_norm=\$1 AND direction='in' ORDER BY created_at DESC LIMIT 1/i.test(s)) { const r = db.chat.filter((m) => m.phone === p[0] && m.direction === "in").slice(-1); return { rows: r.map((m) => ({ body: m.body })) }; }
    if (/^SELECT direction, body FROM wa_messages WHERE phone_norm=\$1 AND COALESCE\(source,'api'\) <> 'history' ORDER BY created_at DESC, id DESC LIMIT \$2/i.test(s)) return { rows: db.chat.filter((m) => m.phone === p[0]).slice(-p[1]).reverse().map((m) => ({ direction: m.direction, body: m.body })) };
    if (/^INSERT INTO wa_messages/i.test(s)) { db.out.push({ wamid: p[0], phone_norm: p[1], template: p[2], status: p[6], source: p[10] }); return { rows: [], rowCount: 1 }; }
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: [] };
    if (/^SELECT event FROM wa_template_events WHERE name=\$1/i.test(s)) return { rows: db.events.filter((e) => e.name === p[0]).slice(-1).map((e) => ({ event: e.event })) };
    /* wa_team_state */
    if (/^SELECT free_nudge_at, closed_nudge_at, closed_nudge_via, renewed_at FROM wa_team_state WHERE phone_norm=\$1/i.test(s)) return { rows: db.state[p[0]] ? [{ ...db.state[p[0]] }] : [] };
    { const m = /^INSERT INTO wa_team_state\(phone_norm, (free_nudge_at|closed_nudge_at|renewed_at), updated_at\)/i.exec(s);
      if (m) { db.state[p[0]] = { ...(db.state[p[0]] || {}), [m[1]]: p[1] }; return { rows: [{ phone_norm: p[0] }], rowCount: 1 }; } }
    if (/^INSERT INTO wa_team_state\(phone_norm, closed_nudge_via, updated_at\)/i.test(s)) { const cur = db.state[p[0]] || {}; if (cur.closed_nudge_via === p[1]) return { rows: [], rowCount: 0 }; db.state[p[0]] = { ...cur, closed_nudge_via: p[1] }; return { rows: [{ phone_norm: p[0] }], rowCount: 1 }; }
    if (/^UPDATE wa_team_state SET closed_nudge_via=\$2 WHERE phone_norm=\$1/i.test(s)) { db.state[p[0]] = { ...(db.state[p[0]] || {}), closed_nudge_via: p[1] }; return { rows: [], rowCount: 1 }; }
    /* wa_team_log */
    if (/^INSERT INTO wa_team_log/i.test(s)) { db.log.push({ at: iso(nowMs), phone_norm: p[0], role: p[1], topic: p[2], kind: p[3], via: p[4], ok: p[5], error: p[6], ref4: p[7], urgent: p[8] }); return { rows: [], rowCount: 1 }; }
    if (/^SELECT at, topic, kind, via, ok FROM wa_team_log WHERE phone_norm=\$1/i.test(s)) return { rows: db.log.filter((l) => l.phone_norm === p[0]).slice(-1) };
    if (/^SELECT count\(DISTINCT \(ref4, kind, date_trunc\('minute', at\)\)\)::int AS n/i.test(s)) { const r = db.log.filter((l) => ["handover", "urgent"].includes(l.topic)); const key = (l) => `${l.ref4}|${l.kind}|${l.at.slice(0, 16)}`;
      return { rows: [{ n: new Set(r.map(key)).size, u: new Set(r.filter((l) => l.urgent).map(key)).size, sms: r.filter((l) => l.via === "sms" && l.ok).length }] }; }
    if (/^SELECT via, count\(\*\)::int AS n/i.test(s)) return { rows: [] };
    if (/^SELECT at, right\(phone_norm, 4\) AS to4/i.test(s)) return { rows: db.log.slice(-40).reverse().map((l) => ({ ...l, to4: l.phone_norm.slice(-4), phone_norm: undefined })) };
    /* wa_team_odd */
    if (/^SELECT 1 FROM wa_team_odd WHERE kind=\$1 AND COALESCE\(phone_norm,''\) = \$2 AND at > \$3/i.test(s)) return { rows: db.odd.filter((o) => o.kind === p[0] && (o.phone_norm || "") === p[1] && Date.parse(o.at) > Date.parse(p[2])).slice(0, 1).map(() => ({})) };
    if (/^INSERT INTO wa_team_odd/i.test(s)) { const row = { id: ++db.oddSeq, at: p[0], kind: p[1], phone_norm: p[2], detail: p[3], tried: p[4], status: "pending", sent_at: null }; db.odd.push(row); return { rows: [{ id: row.id }], rowCount: 1 }; }
    if (/^SELECT count\(\*\)::int AS n FROM wa_team_odd WHERE status='sent' AND sent_at > \$1/i.test(s)) return { rows: [{ n: db.odd.filter((o) => o.status === "sent" && Date.parse(o.sent_at) > Date.parse(p[0])).length }] };
    if (/^UPDATE wa_team_odd SET status='held' WHERE id=\$1/i.test(s)) { db.odd.find((o) => o.id === p[0]).status = "held"; return { rows: [] }; }
    if (/^UPDATE wa_team_odd SET status='no_recipients' WHERE id=\$1/i.test(s)) { db.odd.find((o) => o.id === p[0]).status = "no_recipients"; return { rows: [] }; }
    if (/^UPDATE wa_team_odd SET status=\$2, sent_at=\$3 WHERE id=\$1/i.test(s)) { Object.assign(db.odd.find((o) => o.id === p[0]), { status: p[1], sent_at: p[2] }); return { rows: [] }; }
    if (/^SELECT id, at, kind, phone_norm, status FROM wa_team_odd WHERE status = ANY/i.test(s)) return { rows: db.odd.filter((o) => p[0].includes(o.status) && Date.parse(o.at) > Date.parse(p[1])).slice(0, 40).map((o) => ({ ...o })) };
    if (/^UPDATE wa_team_odd SET status='sending' WHERE id = ANY/i.test(s)) { const hit = db.odd.filter((o) => p[0].includes(o.id) && p[1].includes(o.status)); for (const o of hit) o.status = "sending"; return { rows: hit.map((o) => ({ id: o.id })) }; }
    if (/^UPDATE wa_team_odd SET status = CASE WHEN id=\$2 THEN \$3 ELSE 'digest' END, sent_at=\$4/i.test(s)) { for (const o of db.odd.filter((x) => p[0].includes(x.id))) { o.status = o.id === p[1] ? p[2] : "digest"; o.sent_at = p[3]; } return { rows: [] }; }
    if (/^SELECT kind, count\(\*\)::int AS n FROM wa_team_odd WHERE at > \$1 GROUP BY 1/i.test(s)) { const m = {}; for (const o of db.odd) m[o.kind] = (m[o.kind] || 0) + 1; return { rows: Object.entries(m).map(([kind, n]) => ({ kind, n })) }; }
    if (/^SELECT count\(\*\) FILTER \(WHERE status='sent' AND sent_at > \$1\)::int AS sent_hour/i.test(s)) return { rows: [{ sent_hour: db.odd.filter((o) => o.status === "sent").length, pending: db.odd.filter((o) => o.status === "pending").length, held: db.odd.filter((o) => o.status === "held").length }] };
    if (/^SELECT count\(\*\)::int AS n FROM wa_bot_log WHERE decision='failed' AND at > \$1/i.test(s)) return { rows: [{ n: db.botFailed }] };
    if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{waTeam\}'/i.test(s)) { db.settings.waTeam = JSON.parse(p[0]); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const calls = [];
  const fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    if (graphFail && graphFail(body)) return { ok: false, status: 400, json: async () => ({ error: { code: 131000, message: "boom" } }) };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.G${calls.length}` }] }) };
  };
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
  let owner = true, portalUser = { name: "منى", role: "cashier" };
  const ctx = { pool, requireAdmin: async () => null, isOwner: async () => owner, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(app, ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const sms = [];
  const team = T.register(app, ctx, { wa, sendSms: async (x) => { sms.push(x); return { ok: true }; }, now: clock.now, noTimer: true, log: { error() {} }, ...(flow ? { flow: () => flow } : {}),
    requirePortal: async (c) => (portalUser ? { user: portalUser } : { res: c.json({ ok: false }, 401) }) });
  const call = (method, path, json = {}) => routes[`${method} ${path}`]({ req: { json: async () => json, query: () => undefined, param: () => undefined }, json: (body, status = 200) => ({ body, status }) });
  const wrote = (phone, agoH = 0) => { db.lastIn[phone] = new Date(nowMs - agoH * H).toISOString(); };
  const to = () => calls.map((c) => c.body.to);
  return { db, clock, calls, sms, wa, team, call, wrote, to, setOwner: (v) => { owner = v; }, setPortalUser: (u) => { portalUser = u; } };
}
const allOpen = (w) => { for (const m of MEMBERS) w.wrote(m.phone.slice(1), 1); };
const bodyOf = (c) => (c.body.type === "interactive" ? c.body.interactive.body.text : c.body.type === "text" ? c.body.text.body : null);
const wa966 = (p) => `966${p}`;

/* ══ ١) الإعدادات والدليل ═════════════════════════════════════════════════ */
test("config: defaults, limits and the role routing Omar asked for; a missing directory falls back to the alert phones as cashiers", () => {
  const cfg = T.teamConfig({ waTeam: { members: MEMBERS } });
  assert.equal(cfg.enabled, true); assert.equal(cfg.fallback, false);
  assert.deepEqual(cfg.routing, { cashier: ["handover"], manager: ["handover", "odd"], owner: ["urgent", "odd", "digest"] });
  assert.deepEqual([cfg.keeper.enabled, cfg.keeper.renewAtHour, cfg.keeper.quietFrom, cfg.keeper.quietTo], [true, 20, "02:00", "10:00"]);
  assert.deepEqual([cfg.odd.enabled, cfg.odd.perHour, cfg.odd.digest, cfg.odd.excerpt, cfg.odd.smsFallback], [true, 12, false, 6, false]);
  assert.deepEqual(Object.keys(cfg.odd.kinds), T.ODD_KEYS); assert.ok(Object.values(cfg.odd.kinds).every(Boolean));
  assert.deepEqual(T.recipientsFor(cfg, ["handover"]).map((m) => m.phone), [CASH1, CASH2, MGR]);
  assert.deepEqual(T.recipientsFor(cfg, ["handover", "urgent"]).map((m) => m.phone), [CASH1, CASH2, MGR, OWN1, OWN2]);
  assert.deepEqual(T.recipientsFor(cfg, "odd").map((m) => m.phone), [MGR, OWN1, OWN2]);
  assert.deepEqual(T.recipientsFor(cfg, "digest").map((m) => m.phone), [OWN1, OWN2]);
  // out-of-range numbers fall back to the default, never to the raw value
  const odd = T.teamConfig({ waTeam: { members: [], keeper: { renewAtHour: 99, quietFrom: "25:00" }, odd: { perHour: 0, excerpt: 50 } } });
  assert.deepEqual([odd.keeper.renewAtHour, odd.keeper.quietFrom, odd.odd.perHour, odd.odd.excerpt], [20, "02:00", 12, 6]);
  // no directory yet ⇒ the bot's alert phones (else the delivery alert phones), all «cashier» = every handover, flagged
  const fb = T.teamConfig({ waBot: { alertPhones: [`0${CASH1}`, `0${OWN1}`] }, delivery: { alertPhones: [`0${MGR}`] } });
  assert.equal(fb.fallback, true); assert.deepEqual(fb.members.map((m) => [m.phone, m.role]), [[CASH1, "cashier"], [OWN1, "cashier"]]);
  assert.deepEqual(T.teamConfig({ delivery: { alertPhones: [`0${MGR}`] } }).members.map((m) => m.phone), [MGR]);
  assert.equal(T.staffRoleOf({ waTeam: { members: MEMBERS } }, `+966${OWN1}`), "owner");
  assert.equal(T.staffRoleOf({ waTeam: { members: MEMBERS } }, CUST), null);
  assert.equal(T.staffRoleOf({ waTeam: { members: [{ ...MEMBERS[0], active: false }] } }, CASH1), null, "an inactive member is not staff");
});

test("config save: validated field by field; bad phones, roles, topics, hours and ranges are refused with a reason", () => {
  const ok = T.configFromBody({ members: MEMBERS, routing: { owner: ["urgent", "odd"] }, keeper: { quietFrom: "01:00", renewAtHour: 21 }, odd: { perHour: 6, digest: true, kinds: { customer_stopped: false } } }, { enabled: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.routing.owner, ["urgent", "odd"]); assert.equal(ok.value.members.length, 5); assert.equal(ok.value.odd.kinds.customer_stopped, false);
  const cfg = T.teamConfig({ waTeam: ok.value });
  assert.deepEqual([cfg.keeper.quietFrom, cfg.keeper.renewAtHour, cfg.odd.perHour, cfg.odd.digest, cfg.odd.kinds.customer_stopped, cfg.odd.kinds.secret], ["01:00", 21, 6, true, false, true]);
  for (const bad of [{ members: [{ phone: "123", role: "owner" }] }, { members: [{ phone: `0${CASH1}`, role: "boss" }] }, { members: [MEMBERS[0], MEMBERS[0]] }, { routing: { owner: ["everything"] } }, { keeper: { quietFrom: "2am" } },
    { keeper: { renewAtHour: 5 } }, { odd: { perHour: 500 } }, { odd: { kinds: { nonsense: true } } }, { enabled: "yes" }, { templatesApproved: ["fc_cart_1h"] }]) {
    const r = T.configFromBody(bad, {}); assert.equal(r.ok, false, JSON.stringify(bad)); assert.ok(r.errors.length >= 1);
  }
});

/* ══ ٢) الإرسال لموظف: حر ⇒ قالب ⇒ SMS ═══════════════════════════════════ */
test("handover, window open: a free-form message with ONE «جدّد التنبيهات» button through the guard — to cashiers and the manager only; last 4 digits, masked text, portal link", withEnv(OPEN, async () => {
  const w = world({ chat: [{ phone: CUST, direction: "in", body: "الطلب وصل بارد، كلموني على 0551234567" }] });
  allOpen(w);
  const r = await w.team.handover({ phone: CUST, reason: "asked_human", reasonAr: "طلب موظف", urgent: false, orderNo: "W1790000000001", sms: "SMS BODY" });
  assert.deepEqual(r, { sent: 3, wa: 3, sms: 0, failed: 0, to: 3 });
  assert.deepEqual(w.to(), [CASH1, CASH2, MGR].map(wa966), "owners do not get an ordinary handover");
  for (const c of w.calls) {
    assert.match(c.url, /\/PHONE1\/messages$/);
    assert.equal(c.body.type, "interactive");
    assert.deepEqual(c.body.interactive.action.buttons, [{ type: "reply", reply: { id: "team:renew", title: "✅ جدّد التنبيهات" } }]);
  }
  const text = bodyOf(w.calls[0]);
  assert.equal(text, "💬 تحويل لموظف — طلب موظف\nالعميل: …5678 · طلب W1790000000001\nآخر رسالة منه: «الطلب وصل بارد، كلموني على [رقم]»\nرد عليه من البورتال: https://freshcuts-invite.o2m8.me/portal/");
  assert.ok(!text.includes(CUST) && !text.includes("0551234567"), "no full phone number in a staff WhatsApp message");
  assert.equal(w.sms.length, 0);
  assert.deepEqual(w.db.log.map((l) => [l.phone_norm, l.role, l.topic, l.via, l.ok, l.ref4]), [[CASH1, "cashier", "handover", "wa_free", true, "5678"], [CASH2, "cashier", "handover", "wa_free", true, "5678"], [MGR, "manager", "handover", "wa_free", true, "5678"]]);
}));

test("urgent handover: the owners get it too; reminder and reopened say so in Egyptian", withEnv(OPEN, async () => {
  const w = world(); allOpen(w);
  await w.team.handover({ phone: CUST, reason: "complaint", reasonAr: "شكوى", urgent: true });
  assert.deepEqual(w.to(), [CASH1, CASH2, MGR, OWN1, OWN2].map(wa966));
  assert.match(bodyOf(w.calls[0]), /^🚨 تحويل عاجل لموظف — شكوى\nالعميل: …5678\n/);
  assert.ok(w.db.log.every((l) => l.topic === "urgent" && l.urgent === true));
  assert.equal(T.handoverText({ phone: CUST, reasonAr: "طلب موظف", stage: "reminder", waitedMin: 5 }).split("\n")[0], "🔔 تذكير: العميل مستني من 5 دقيقة ومحدش رد — طلب موظف");
  assert.equal(T.handoverText({ phone: CUST, reasonAr: "شكوى", urgent: true, stage: "reopened" }).split("\n")[0], "♻️ عاجل — التحويل اتقفل بـ«تم» من غير رد للعميل — شكوى");
}));

test("window closed: an APPROVED staff template (Arabic, one line, last 4 digits) goes out with no customer opt-in; not approved ⇒ no Graph call, SMS fallback recorded as SMS", withEnv(OPEN, async () => {
  const w = world({ approved: ["fc_staff_team_notice"] });
  w.wrote(CASH1, 1); w.wrote(CASH2, 30);                     // منى مفتوحة · سارة مقفولة · خالد عمره ما كتب
  const r = await w.team.handover({ phone: CUST, reason: "asked_human", reasonAr: "طلب موظف", sms: "Fresh Cuts WhatsApp: customer needs staff" });
  assert.deepEqual(r, { sent: 3, wa: 3, sms: 0, failed: 0, to: 3 });
  assert.equal(w.calls[0].body.type, "interactive");
  for (const c of w.calls.slice(1)) {
    assert.equal(c.body.type, "template");
    assert.deepEqual([c.body.template.name, c.body.template.language.code], ["fc_staff_team_notice", "ar"]);
    assert.deepEqual(c.body.template.components, [{ type: "body", parameters: [{ type: "text", text: "عميل …5678 محتاج موظف (طلب موظف)" }] }]);
  }
  assert.deepEqual(w.db.log.map((l) => l.via), ["wa_free", "wa_template", "wa_template"]);
  assert.equal(w.sms.length, 0);
  // nothing approved ⇒ SMS, and the log says it was the fallback
  const x = world(); x.wrote(CASH1, 1);
  const r2 = await x.team.handover({ phone: CUST, reason: "asked_human", reasonAr: "طلب موظف", sms: "Fresh Cuts WhatsApp: customer needs staff" });
  assert.deepEqual(r2, { sent: 3, wa: 1, sms: 2, failed: 0, to: 3 });
  assert.equal(x.calls.length, 1, "no blind template call to Meta");
  assert.deepEqual(x.sms.map((s) => [s.phoneNorm, s.kind, s.ref, s.body]), [[CASH2, "staff", "wabot asked_human", "Fresh Cuts WhatsApp: customer needs staff"], [MGR, "staff", "wabot asked_human", "Fresh Cuts WhatsApp: customer needs staff"]]);
  assert.deepEqual(x.db.log.map((l) => [l.via, l.ok, l.error]), [["wa_free", true, null], ["sms", true, "fallback after window_closed"], ["sms", true, "fallback after window_closed"]]);
  // the owner confirmed approval in the settings (no webhook event on record) ⇒ the template is used
  const y = world({ waTeam: { members: MEMBERS, templatesApproved: ["fc_staff_wa_handoff"] } });
  await y.team.handover({ phone: CUST, reason: "complaint", reasonAr: "شكوى", urgent: true, orderNo: "W1", sms: "x" });
  assert.equal(y.calls.length, 5); assert.ok(y.calls.every((c) => c.body.template.name === "fc_staff_wa_handoff")); assert.equal(y.sms.length, 0);
  assert.deepEqual(y.calls[0].body.template.components[0].parameters.map((q) => q.text), ["شكوى", "عميل …5678 طلب W1"]);
}));

test("SMS fallback off, team WhatsApp off, or nobody routed ⇒ recorded honestly / handed back to the old SMS path", withEnv(OPEN, async () => {
  const off = world({ waTeam: { members: MEMBERS, smsFallback: false } });
  assert.deepEqual(await off.team.handover({ phone: CUST, reason: "asked_human", sms: "x" }), { sent: 0, wa: 0, sms: 0, failed: 3, to: 3 });
  assert.equal(off.sms.length + off.calls.length, 0);
  assert.deepEqual(off.db.log.map((l) => [l.via, l.ok, l.error]), [["none", false, "window_closed"], ["none", false, "window_closed"], ["none", false, "window_closed"]]);
  assert.equal(await world({ waTeam: { members: MEMBERS, enabled: false } }).team.handover({ phone: CUST, reason: "asked_human", sms: "x" }), null, "disabled ⇒ null ⇒ the caller's legacy SMS");
  assert.equal(await world({ waTeam: { members: MEMBERS, routing: { cashier: [], manager: [] } } }).team.handover({ phone: CUST, reason: "asked_human", sms: "x" }), null, "nobody routed ⇒ null");
  // the channel itself is locked (owner's master switch off) ⇒ no Graph call at all, SMS instead
  const locked = world({ settings: { waMaster: { enabled: false } } }); allOpen(locked);
  await locked.team.handover({ phone: CUST, reason: "asked_human", sms: "x" });
  assert.equal(locked.calls.length, 0); assert.equal(locked.sms.length, 3);
  assert.ok(locked.db.log.every((l) => l.via === "sms" && l.error === "fallback after master_off"));
}));

test("the guard itself: a staff template is refused for a phone that is not in the directory, and a customer / marketing template is refused even for staff — no network call", withEnv(OPEN, async () => {
  const w = world();
  assert.deepEqual(await w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_staff_team_notice", staff: true }), { ok: false, reason: "not_staff" });
  assert.deepEqual(await w.wa.guardSend({ phoneNorm: OWN1, kind: "template", template: "fc_cart_1h", staff: true }), { ok: false, reason: "not_staff_template" });
  assert.deepEqual(await w.wa.guardSend({ phoneNorm: OWN1, kind: "template", template: "fc_order_preparing", staff: true }), { ok: false, reason: "not_staff_template" });
  assert.deepEqual(await w.wa.guardSend({ phoneNorm: OWN1, kind: "template", template: "fc_staff_checkout_watchdog", staff: true }), { ok: false, reason: "not_staff_template" }, "Meta re-classed it as marketing");
  assert.deepEqual(await w.wa.guardSend({ phoneNorm: OWN1, kind: "template", template: "fc_staff_team_notice", staff: true, source: "campaign" }), { ok: false, reason: "not_staff_template" });
  assert.equal((await w.wa.guardSend({ phoneNorm: OWN1, kind: "template", template: "fc_staff_team_notice", staff: true })).ok, true);
  // without the staff flag the same phone is an ordinary recipient: no opt-in ⇒ refused, as before
  assert.deepEqual(await w.wa.guardSend({ phoneNorm: OWN1, kind: "template", template: "fc_staff_team_notice" }), { ok: false, reason: "settings_off" });
  assert.deepEqual(await w.wa.sendStaffTemplate({ phoneNorm: CUST, template: "fc_staff_team_notice", data: { notice: { text: "x" } } }), { ok: false, skipped: "not_staff" });
  // sendToStaff never even tries a phone that is not in the directory
  const cfg = T.teamConfig(w.db.settings);
  assert.deepEqual(await w.team.sendToStaff(cfg, { phone: CUST, role: "owner" }, { topic: "test", body: "x", sms: "x", templates: [{ name: "fc_staff_team_notice", data: { notice: { text: "x" } } }] }), { ok: false, via: "none", error: "not_staff" });
  assert.equal(w.calls.length + w.sms.length, 0);
  // master switch off ⇒ the staff template is locked like everything else
  const off = world({ settings: { waMaster: { enabled: false } } });
  assert.deepEqual(await off.wa.guardSend({ phoneNorm: OWN1, kind: "template", template: "fc_staff_team_notice", staff: true }), { ok: false, reason: "master_off" });
}));

/* ══ ٣) حارس النافذة ═════════════════════════════════════════════════════ */
const K = T.DEFAULTS.keeper;
const plan = (now, lastInAt, state = {}, keeper = K) => T.keeperPlan({ now, lastInAt, state, keeper });
test("keeper timing: nothing before hour 20, one free-form at hour 20, then silence; closed ⇒ the template once, then wait for the tap", () => {
  const li = "2026-10-13T10:00:00Z";      // ١٣:٠٠ الرياض ⇒ الساعة ٢٠ = ٠٩:٠٠ الرياض؟ لأ: ١٠:٠٠Z + ٢٠ = ٠٦:٠٠Z = ٠٩:٠٠ الرياض (جوّه الهدوء) — الحالة دي في الاختبار اللي بعده
  const a = "2026-10-13T14:00:00Z";       // ١٧:٠٠ الرياض ⇒ الساعة ٢٠ = ١٣:٠٠ الرياض تاني يوم (بره الهدوء)
  assert.deepEqual(plan("2026-10-14T09:59:00Z", a), { action: "none", why: "not_due", dueAt: "2026-10-14T10:00:00.000Z" });
  assert.deepEqual(plan("2026-10-14T10:00:00Z", a), { action: "free", why: "renew_due", dueAt: "2026-10-14T10:00:00.000Z" });
  assert.deepEqual(plan("2026-10-14T10:05:00Z", a, { freeNudgeAt: "2026-10-14T10:00:30Z" }), { action: "none", why: "already_nudged" });
  // window closed, never nudged ⇒ the template; nudged since the window closed ⇒ wait; never wrote at all ⇒ the template once
  assert.deepEqual(plan("2026-10-14T14:01:00Z", a, { freeNudgeAt: "2026-10-14T10:00:30Z" }), { action: "closed", why: "window_closed" });
  assert.deepEqual(plan("2026-10-15T14:01:00Z", a, { closedNudgeAt: "2026-10-14T14:01:10Z" }), { action: "none", why: "waiting_tap" });
  assert.deepEqual(plan("2026-10-14T12:00:00Z", null), { action: "closed", why: "never_wrote" });
  assert.deepEqual(plan("2026-10-20T12:00:00Z", null, { closedNudgeAt: "2026-10-14T12:00:00Z" }), { action: "none", why: "waiting_tap" }, "no repeats, however long it takes");
  // a tap (new inbound) after the closed nudge starts a fresh cycle
  assert.deepEqual(plan("2026-10-16T12:00:00Z", "2026-10-16T11:00:00Z", { closedNudgeAt: "2026-10-14T14:01:10Z", freeNudgeAt: "2026-10-14T10:00:30Z" }).why, "not_due");
  assert.deepEqual(plan("2026-10-14T10:00:00Z", a, {}, { ...K, enabled: false }), { action: "none", why: "off" });
  void li;
});

test("keeper + quiet hours (02:00–10:00 Riyadh): hour 20 inside the quiet hours ⇒ sent 15 minutes before they start; nothing is ever sent during them", () => {
  // last inbound 13:00 Riyadh ⇒ hour 20 = 09:00 Riyadh (quiet) ⇒ due 01:45 Riyadh = 22:45Z
  const li = "2026-10-13T10:00:00Z";
  assert.deepEqual(plan("2026-10-13T22:44:00Z", li), { action: "none", why: "not_due", dueAt: "2026-10-13T22:45:00.000Z" });
  assert.deepEqual(plan("2026-10-13T22:45:00Z", li), { action: "free", why: "renew_due", dueAt: "2026-10-13T22:45:00.000Z" });
  // missed that slot (server was down): inside the quiet hours nothing goes out
  assert.deepEqual(plan("2026-10-14T01:00:00Z", li), { action: "none", why: "quiet" });
  // last inbound 07:00 Riyadh (itself in the quiet hours) ⇒ hour 20 = 03:00 Riyadh ⇒ due 01:45 Riyadh the next night
  assert.equal(plan("2026-10-13T12:00:00Z", "2026-10-13T04:00:00Z").dueAt, "2026-10-13T22:45:00.000Z");
  // hour 20 at 01:30 Riyadh is before the quiet hours ⇒ not moved
  assert.equal(plan("2026-10-13T12:00:00Z", "2026-10-13T02:30:00Z").dueAt, "2026-10-13T22:30:00.000Z");
  // a closed window is not nudged during the quiet hours either; it is at 10:00
  assert.deepEqual(plan("2026-10-14T05:00:00Z", "2026-10-12T10:00:00Z"), { action: "none", why: "quiet" });
  assert.deepEqual(plan("2026-10-14T07:00:00Z", "2026-10-12T10:00:00Z"), { action: "closed", why: "window_closed" });
  // quiet hours that do not cross midnight, and «no quiet hours» (from = to)
  assert.equal(plan("2026-10-14T08:00:00Z", "2026-10-13T14:00:00Z", {}, { ...K, quietFrom: "12:00", quietTo: "14:00" }).dueAt, "2026-10-14T08:45:00.000Z");
  assert.equal(plan("2026-10-13T12:00:00Z", li, {}, { ...K, quietFrom: "00:00", quietTo: "00:00" }).dueAt, "2026-10-14T06:00:00.000Z");
  assert.equal(T.quietStartOf(Date.parse("2026-10-14T03:30:00Z"), "02:00", "10:00"), Date.parse("2026-10-13T23:00:00Z"));
  assert.equal(T.quietStartOf(Date.parse("2026-10-14T08:00:00Z"), "02:00", "10:00"), null);
});

test("keeper tick: the renewal goes free-form with the button once per window; a tap renews; a closed window gets the renew template once and then nothing", withEnv(OPEN, async () => {
  const w = world({ waTeam: { members: [MEMBERS[0]], daily: { enabled: false } }, approved: ["fc_staff_alerts_renew"] });
  w.wrote(CASH1, 19.5);
  assert.deepEqual((await w.team.tick()).keeper, [], "not yet hour 20");
  w.clock.advance(31);
  assert.deepEqual((await w.team.tick()).keeper, [{ to: "…0001", action: "free", via: "wa_free", ok: true }]);
  assert.equal(w.calls.length, 1);
  assert.equal(bodyOf(w.calls[0]), "⏰ تنبيهات واتساب المجانية هتقف كمان 4 ساعات.\nاضغط الزر تحت عشان التنبيهات تفضل توصلك هنا ببلاش.");
  assert.equal(w.calls[0].body.interactive.action.buttons[0].reply.title, "✅ جدّد التنبيهات");
  w.clock.advance(60); await w.team.tick(); await w.team.tick();
  assert.equal(w.calls.length, 1, "one renewal per window");
  // he taps: an inbound message ⇒ the window is new, and he gets a one-line confirmation
  w.wrote(CASH1, 0);
  assert.equal(await w.team.inbound({ phone: CASH1, type: "interactive", interactiveId: "team:renew", text: "✅ جدّد التنبيهات" }), true);
  assert.equal(w.calls.length, 2); assert.match(bodyOf(w.calls[1]), /^✅ تمام يا منى — التنبيهات هتوصلك هنا ببلاش لحد بكرة \d\d:\d\d\.$/);
  assert.ok(w.db.state[CASH1].renewed_at);
  // he ignores the next one: the window closes ⇒ the renew template once, then silence until he taps
  w.clock.advance(20 * 60 + 1); await w.team.tick();
  assert.equal(w.calls.length, 3); assert.equal(w.calls[2].body.type, "interactive");
  w.clock.advance(4 * 60 + 5);
  const t = await w.team.tick();
  assert.deepEqual(t.keeper, [{ to: "…0001", action: "closed", via: "wa_template", ok: true }]);
  assert.deepEqual([w.calls[3].body.type, w.calls[3].body.template.name, w.calls[3].body.template.language.code, w.calls[3].body.template.components], ["template", "fc_staff_alerts_renew", "ar", []]);
  for (let i = 0; i < 5; i++) { w.clock.advance(24 * 60); await w.team.tick(); }
  assert.equal(w.calls.length, 4, "no repeats until he taps");
  assert.equal(w.sms.length, 0);
}));

test("keeper, renew template not approved yet: ONE SMS asking for the word, then nothing; SMS nudge off ⇒ nothing at all; keeper off ⇒ nothing", withEnv(OPEN, async () => {
  const w = world({ waTeam: { members: [MEMBERS[3]], daily: { enabled: false } } });
  await w.team.tick(); w.clock.advance(60); await w.team.tick(); w.clock.advance(24 * 60); await w.team.tick();
  assert.equal(w.calls.length, 0);
  assert.deepEqual(w.sms.map((s) => [s.phoneNorm, s.kind, s.ref]), [[OWN1, "staff", "wabot team_renew"]]);
  assert.match(w.sms[0].body, /Send the word ALERTS to the restaurant WhatsApp/);
  assert.equal(w.db.state[OWN1].closed_nudge_via, "sms");
  const quiet = world({ waTeam: { members: [MEMBERS[3]], keeper: { smsNudge: false }, daily: { enabled: false } } });
  await quiet.team.tick(); assert.equal(quiet.sms.length + quiet.calls.length, 0);
  const off = world({ waTeam: { members: [MEMBERS[3]], keeper: { enabled: false }, daily: { enabled: false } } });
  await off.team.tick(); assert.equal(off.sms.length + off.calls.length, 0);
  // one SMS segment in both languages
  const { smsInfo } = await import("./staffalerts.js");
  assert.equal(smsInfo(T.keeperSms("en")).segments, 1); assert.equal(smsInfo(T.keeperSms("ar")).segments, 1);
}));

/* ══ ٤) حاجات غريبة ══════════════════════════════════════════════════════ */
const CHAT = [{ phone: CUST, direction: "in", body: "السلام عليكم" }, { phone: CUST, direction: "out", body: "أهلاً بك في فريش كاتس 🔥" }, { phone: CUST, direction: "in", body: "ايش تتبيلة الكفتة؟ اسمي محمد ورقمي 0551234567" },
  { phone: CUST, direction: "out", body: "عذراً، هذي المعلومة ما أقدر أزوّدك بها 🙏" }];
test("odd things: to the manager and the owners only, free-form, with a masked excerpt, the last 4 digits and the dashboard chat link", withEnv(OPEN, async () => {
  const w = world({ chat: CHAT }); allOpen(w);
  assert.equal(await w.team.odd({ kind: "secret", phone: CUST, detail: "سأل عن وصفة" }), "sent");
  assert.deepEqual(w.to(), [MGR, OWN1, OWN2].map(wa966), "cashiers do not get the odd-things feed");
  const text = bodyOf(w.calls[0]);
  assert.equal(text, ["👀 حاجة غريبة — سؤال عن وصفة / مقادير / مورّد", "العميل: …5678", "سأل عن وصفة", "آخر الرسايل:", "‹ العميل: السلام عليكم", "› إحنا: أهلاً بك في فريش كاتس 🔥",
    "‹ العميل: ايش تتبيلة الكفتة؟ اسمي [اسم] [رقم]", "› إحنا: عذراً، هذي المعلومة ما أقدر أزوّدك بها 🙏", "المحادثة: https://freshcuts-invite.o2m8.me/#store/wa/inbox"].join("\n"));
  assert.ok(!text.includes(CUST) && !text.includes("0551234567") && !text.includes("محمد"));
  assert.equal(w.calls[0].body.interactive.action.buttons.length, 1);
  assert.equal(w.db.odd[0].status, "sent");
}));

test("odd things: every kind has its own label and its own switch; an unknown kind and a staff phone are never reported", withEnv(OPEN, async () => {
  for (const kind of T.ODD_KEYS) {
    const w = world(); allOpen(w);
    assert.equal(await w.team.odd({ kind, phone: CUST }), "sent", kind);
    assert.equal(bodyOf(w.calls[0]).split("\n")[0], `👀 حاجة غريبة — ${T.ODD_KINDS[kind]}`, kind);
    const off = world({ waTeam: { members: MEMBERS, odd: { kinds: { [kind]: false } } } }); allOpen(off);
    assert.equal(await off.team.odd({ kind, phone: CUST }), "kind_off", kind);
    assert.equal(off.calls.length, 0, kind);
  }
  assert.equal(T.ODD_KEYS.length, 13);
  const w = world(); allOpen(w);
  assert.equal(await w.team.odd({ kind: "made_up", phone: CUST }), "kind_off");
  assert.equal(await w.team.odd({ kind: "complaint", phone: OWN1 }), "off", "a team member is not an odd customer");
  assert.equal(await world({ waTeam: { members: MEMBERS, odd: { enabled: false } } }).team.odd({ kind: "complaint", phone: CUST }), "off");
  assert.equal(w.calls.length, 0);
}));

test("odd things: an assistant reply the validator refused is reported with what it tried to say; the same kind for the same customer is not repeated inside 30 minutes", withEnv(OPEN, async () => {
  const w = world(); allOpen(w);
  assert.equal(await w.team.odd({ kind: "assist_refused", phone: CUST, tried: "نتبّل الكفتة بالبهارات السبعة", detail: "سبب الرفض: recipe_disclosure" }), "sent");
  assert.match(bodyOf(w.calls[0]), /\nسبب الرفض: recipe_disclosure\nالمساعد كان هيقول: «نتبّل الكفتة بالبهارات السبعة»\n/);
  assert.equal(await w.team.odd({ kind: "assist_refused", phone: CUST, tried: "x" }), "repeat");
  assert.equal(await w.team.odd({ kind: "complaint", phone: CUST }), "sent", "another kind is another thing");
  w.clock.advance(31);
  assert.equal(await w.team.odd({ kind: "assist_refused", phone: CUST, tried: "y" }), "sent");
  // budget / daily cap: once a day, however often the bot hits it
  assert.equal(await w.team.odd({ kind: "budget_cap", detail: "سقف اليوم", repeatMin: 1440 }), "sent");
  w.clock.advance(600);
  assert.equal(await w.team.odd({ kind: "budget_cap", detail: "سقف اليوم", repeatMin: 1440 }), "repeat");
  assert.ok(!bodyOf(w.calls[w.calls.length - 1]).includes("المحادثة:"), "no chat link when there is no customer");
}));

test("odd things, hourly cap: 12 go out, the rest are held and leave as ONE summary when the hour frees", withEnv(OPEN, async () => {
  const w = world({ waTeam: { members: [MEMBERS[2]], daily: { enabled: false }, keeper: { enabled: false } } }); w.wrote(MGR, 1);
  const res = [];
  for (let i = 0; i < 15; i++) res.push(await w.team.odd({ kind: "complaint", phone: `5123400${String(i).padStart(2, "0")}` }));
  assert.deepEqual([res.filter((r) => r === "sent").length, res.filter((r) => r === "held").length], [12, 3]);
  assert.equal(w.calls.length, 12);
  await w.team.tick();
  assert.equal(w.calls.length, 12, "still inside the capped hour");
  w.clock.advance(61);
  assert.equal((await w.team.tick()).odd, 3);
  assert.equal(w.calls.length, 13);
  assert.equal(bodyOf(w.calls[12]), ["👀 3 حاجة غريبة اتأجّلت بسبب سقف الساعة", "• شكوى — …0012 · 15:00", "• شكوى — …0013 · 15:00", "• شكوى — …0014 · 15:00", "التفاصيل: https://freshcuts-invite.o2m8.me/#store/wa/inbox"].join("\n"));
  assert.deepEqual(w.db.odd.slice(12).map((o) => o.status), ["sent", "digest", "digest"], "the summary counts as one message in the cap");
  await w.team.tick(); assert.equal(w.calls.length, 13);
}));

test("odd things, digest mode: nothing goes one by one; one batch every digestEveryMin", withEnv(OPEN, async () => {
  const w = world({ waTeam: { members: MEMBERS, odd: { digest: true, digestEveryMin: 30 }, daily: { enabled: false }, keeper: { enabled: false } } }); allOpen(w);
  assert.equal(await w.team.odd({ kind: "secret", phone: CUST }), "queued");
  assert.equal(await w.team.odd({ kind: "customer_stopped", phone: "512000099" }), "queued");
  assert.equal(w.calls.length, 0);
  assert.equal((await w.team.tick()).odd, 2);
  assert.deepEqual(w.to(), [MGR, OWN1, OWN2].map(wa966));
  assert.match(bodyOf(w.calls[0]), /^👀 ملخص الحاجات الغريبة \(2\)\n• سؤال عن وصفة \/ مقادير \/ مورّد — …5678 · 15:00\n• عميل وقّف الرسايل — …0099 · 15:00\n/);
  assert.equal(await w.team.odd({ kind: "complaint", phone: CUST }), "queued");
  w.clock.advance(10); assert.equal((await w.team.tick()).odd, 0, "not before the next batch time");
  w.clock.advance(21); assert.equal((await w.team.tick()).odd, 1);
  assert.equal(w.calls.length, 6);
}));

test("odd things with the window closed: the approved staff template (one line, no customer text); never by SMS unless the owner switches that on", withEnv(OPEN, async () => {
  const w = world({ approved: ["fc_staff_team_notice"], chat: CHAT });
  assert.equal(await w.team.odd({ kind: "secret", phone: CUST }), "sent");
  assert.ok(w.calls.every((c) => c.body.type === "template" && c.body.template.components[0].parameters[0].text === "سؤال عن وصفة / مقادير / مورّد — عميل …5678"));
  const none = world();
  assert.equal(await none.team.odd({ kind: "secret", phone: CUST }), "failed");
  assert.equal(none.sms.length + none.calls.length, 0);
  assert.ok(none.db.log.every((l) => l.via === "none" && l.error === "window_closed"));
  const sms = world({ waTeam: { members: MEMBERS, odd: { smsFallback: true } } });
  assert.equal(await sms.team.odd({ kind: "secret", phone: CUST }), "sent");
  assert.deepEqual(sms.sms.map((s) => s.phoneNorm), [MGR, OWN1, OWN2]);
  assert.ok(!sms.sms[0].body.includes(CUST));
}));

test("a streak of failed bot sends is reported once; the daily digest goes to the owners at its time, once a day", withEnv(OPEN, async () => {
  const w = world({ at: "2026-10-13T07:59:00Z", waTeam: { members: MEMBERS, keeper: { enabled: false } } }); allOpen(w);      // ١٠:٥٩ الرياض
  w.db.botFailed = 3;
  await w.team.tick();
  assert.deepEqual(w.to(), [MGR, OWN1, OWN2].map(wa966));
  assert.match(bodyOf(w.calls[0]), /^👀 حاجة غريبة — رسايل ورا بعض فشلت في الإرسال\n3 رد فشل إرساله في آخر 15 دقيقة$/);
  await w.team.tick(); assert.equal(w.calls.length, 3, "not repeated");
  w.db.botFailed = 0;
  await w.team.handover({ phone: CUST, reason: "complaint", reasonAr: "شكوى", urgent: true });
  const before = w.calls.length;
  w.clock.advance(1);                                             // ١١:٠٠ الرياض
  const t = await w.team.tick();
  assert.deepEqual(t.daily, { sent: 2, wa: 2, sms: 0, failed: 0, to: 2 });
  assert.deepEqual(w.to().slice(before), [OWN1, OWN2].map(wa966));
  assert.equal(bodyOf(w.calls[before]), ["🗒 ملخص واتساب — آخر ٢٤ ساعة", "تحويلات لموظف: 1 (منها 1 عاجل)", "حاجات غريبة: 1", "• رسايل ورا بعض فشلت في الإرسال: 1", "اللوحة: https://freshcuts-invite.o2m8.me/#store/wa/inbox"].join("\n"));
  w.clock.advance(5); await w.team.tick(); w.clock.advance(20); await w.team.tick();
  assert.equal(w.calls.length, before + 2, "once a day");
}));

/* ══ ٥) أرقام الفريق مش عملاء ═════════════════════════════════════════════ */
test("staff inbound: the renew tap and the few commands work; anything else is swallowed in silence; a customer is not touched", withEnv(OPEN, async () => {
  const w = world(); allOpen(w);
  assert.equal(await w.team.inbound({ phone: CUST, type: "text", text: "تنبيهات" }), false, "a customer typing the word is still a customer");
  assert.equal(await w.team.inbound({ phone: OWN1, type: "text", text: "السلام عليكم ابي اطلب" }), true, "staff: swallowed, no greeting, no sales");
  assert.equal(await w.team.inbound({ phone: OWN1, type: "image", text: "[صورة]" }), true);
  assert.equal(w.calls.length, 0);
  for (const t of ["تنبيهات", "جدّد التنبيهات", "✅ جدّد التنبيهات", "Renew alerts", "ALERTS"]) assert.equal(T.staffCommand({ text: t }), "renew", t);
  assert.equal(T.staffCommand({ text: "أي حاجة", interactiveId: "team:renew" }), "renew");
  assert.deepEqual(["حالة", "مساعدة", "ملخص", "اوامر", "status", "ابي اطلب", "حالة طلبي"].map((t) => T.staffCommand({ text: t })), ["status", "help", "digest", "help", "status", null, null]);
  // the template's button arrives as type «button» with its text ⇒ renew
  assert.equal(await w.team.inbound({ phone: CASH1, type: "button", interactiveId: "جدّد التنبيهات", text: "جدّد التنبيهات" }), true);
  assert.equal(w.calls.length, 1); assert.equal(w.calls[0].body.to, wa966(CASH1)); assert.equal(w.calls[0].body.type, "text");
  await w.team.inbound({ phone: MGR, type: "text", text: "حالة" });
  assert.match(bodyOf(w.calls[1]), /^👤 خالد — مدير\nبيوصلك: كل التحويلات لموظف، حاجات غريبة\nالتنبيهات المجانية شغّالة لحد \d\d:\d\d بكرة\.$/);
  await w.team.inbound({ phone: CASH1, type: "text", text: "مساعدة" });
  assert.match(bodyOf(w.calls[2]), /^أوامر الفريق/);
  await w.team.inbound({ phone: CASH1, type: "text", text: "ملخص" });
  assert.equal(bodyOf(w.calls[3]), "الملخص للمدير والملاك بس.");
  await w.team.inbound({ phone: OWN2, type: "text", text: "ملخص" });
  assert.match(bodyOf(w.calls[4]), /^🗒 ملخص واتساب — آخر ٢٤ ساعة/); assert.equal(w.calls[4].body.to, wa966(OWN2));
  assert.ok(w.calls.every((c) => MEMBERS.some((m) => wa966(m.phone.slice(1)) === c.body.to)), "every message went to a team member");
  // staffAsTesters: a team phone that is also a test phone keeps testing the bot — but its tap and commands still work
  const t = world({ waTeam: { members: MEMBERS, staffAsTesters: true }, settings: { waBot: { testPhones: [`0${OWN1}`] } } }); allOpen(t);
  assert.equal(await t.team.inbound({ phone: OWN1, type: "text", text: "ابي اطلب" }), false);
  assert.equal(await t.team.inbound({ phone: OWN1, type: "text", text: "تنبيهات" }), true);
  assert.equal(await t.team.inbound({ phone: OWN2, type: "text", text: "ابي اطلب" }), true, "not a test phone ⇒ still swallowed");
}));

test("non-customer detection is conservative: a clear job request or supplier pitch only", () => {
  for (const t of ["السلام عليكم، ابحث عن عمل عندكم كاشير", "مرفق سيرتي الذاتية للتقديم", "هل يوجد وظائف شاغرة لديكم؟", "I am looking for a job as a cook"]) assert.equal(T.nonCustomerKind(t), "job_seeker", t);
  for (const t of ["نحن شركة توريد لحوم ونقدم لكم أسعار خاصة", "معكم مؤسسة الفحم الذهبي للتوريد", "مرحبا نقدم لكم عروض اسعار للمطاعم", "We are a supplier of packaging for restaurants"]) assert.equal(T.nonCustomerKind(t), "supplier", t);
  for (const t of ["عندكم توصيل؟", "ابي وجبة عمل لعشرة اشخاص", "كم سعر الكفتة", "وظيفة", "عندكم عروض؟", "ابي عرض سعر", "شركة", "", "مين المورد حقكم"]) assert.equal(T.nonCustomerKind(t), null, t);
});

/* ══ ٦) المسارات ══════════════════════════════════════════════════════════ */
test("routes: the status shows each member's window (open until … / closed since …); full phones for the owner only; the portal gets no phone at all", withEnv(OPEN, async () => {
  const w = world({ approved: ["fc_staff_alerts_renew"] });
  w.wrote(CASH1, 2); w.wrote(MGR, 30);
  const r = (await w.call("GET", "/api/cms/wabot/team")).body;
  assert.equal(r.ok, true); assert.equal(r.owner, true); assert.equal(r.fallbackDirectory, false);
  const [m1, , m3, m4] = r.members;
  assert.deepEqual([m1.phone, m1.last4, m1.role, m1.window.open, m1.window.until, m1.window.minutesLeft, m1.keeper.next, m1.keeper.why], [`0${CASH1}`, "0001", "cashier", true, "2026-10-14T10:00:00.000Z", 22 * 60, "none", "not_due"]);
  assert.deepEqual([m3.window.open, m3.window.closedSince, m3.keeper.next], [false, "2026-10-13T06:00:00.000Z", "closed"]);
  assert.deepEqual([m4.window.open, m4.window.lastInAt, m4.window.closedSince, m4.keeper.why], [false, null, null, "never_wrote"]);
  assert.deepEqual(r.templates, { fc_staff_alerts_renew: { approved: true, source: "meta" }, fc_staff_team_notice: { approved: false, source: null }, fc_staff_wa_handoff: { approved: false, source: null } });
  assert.deepEqual([r.odd.cap, r.odd.sentLastHour], [12, 0]); assert.equal(r.schema.oddKinds.length, 13); assert.equal(r.config.members, undefined);
  w.setOwner(false);
  const r2 = (await w.call("GET", "/api/cms/wabot/team")).body;
  assert.ok(r2.members.every((m) => m.phone === undefined && /^\d{4}$/.test(m.last4)));
  assert.equal((await w.call("PUT", "/api/cms/wabot/team", { enabled: false })).status, 403);
  assert.equal((await w.call("POST", "/api/cms/wabot/team/test", { phone: `0${CASH1}` })).status, 403);
  const p = (await w.call("GET", "/api/portal/wa/team-status")).body;
  assert.equal(p.ok, true); assert.equal(p.members.length, 5);
  assert.deepEqual(Object.keys(p.members[0]).sort(), ["last4", "name", "role", "roleAr", "window"]);
  assert.ok(!JSON.stringify(p).includes(CASH1));
  w.setPortalUser({ name: "شيف", role: "kitchen" });
  assert.equal((await w.call("GET", "/api/portal/wa/team-status")).status, 403);
  assert.equal(w.calls.length + w.sms.length, 0, "reading the status sends nothing");
}));

test("routes: the owner saves the directory and switches; the test message only goes to a member of the directory", withEnv(OPEN, async () => {
  const w = world({ waTeam: null, settings: { waBot: { alertPhones: [`0${CASH1}`], testPhones: [] } } });
  assert.equal((await w.call("GET", "/api/cms/wabot/team")).body.fallbackDirectory, true);
  const bad = await w.call("PUT", "/api/cms/wabot/team", { members: [{ phone: "0512", role: "owner" }] });
  assert.equal(bad.status, 400); assert.equal(w.db.settings.waTeam, undefined);
  const ok = await w.call("PUT", "/api/cms/wabot/team", { members: MEMBERS, odd: { perHour: 8 } });
  assert.equal(ok.body.ok, true); assert.equal(ok.body.members.length, 5); assert.equal(ok.body.config.odd.perHour, 8);
  assert.deepEqual(w.db.settings.waTeam.members.map((m) => m.role), ["cashier", "cashier", "manager", "owner", "owner"]);
  assert.equal((await w.call("PUT", "/api/cms/wabot/team", { keeper: { quietTo: "09:00" } })).body.config.keeper.quietTo, "09:00");
  assert.equal(w.db.settings.waTeam.members.length, 5, "a partial save keeps the rest");
  assert.equal((await w.call("POST", "/api/cms/wabot/team/test", { phone: `0${CUST}` })).status, 400);
  assert.equal(w.calls.length, 0);
  w.wrote(OWN1, 1);
  assert.deepEqual((await w.call("POST", "/api/cms/wabot/team/test", { phone: `0${OWN1}` })).body, { ok: true, via: "wa_free", error: null });
  assert.equal(w.calls[0].body.to, wa966(OWN1));
}));

/* ══ ST2 — السلّم وأزرار المحادثة بيتسلّموا لـwaflow؛ والأزرار الإضافية والقايمة في الرسالة الحرة ═══════ */
test("ST2: with the ladder on, a handover is waflow's to route; ladder off ⇒ the ST1 routing; chat buttons and a pending note go to waflow before the commands", withEnv(OPEN, async () => {
  const seen = { handover: [], inbound: [] };
  const flow = { onHandover: async (x) => { seen.handover.push(x); return { sent: 2, wa: 2, sms: 0, failed: 0, to: 2 }; }, staffInbound: async (ev, m) => { seen.inbound.push([ev.interactiveId || ev.text, m.role]); return /^flow:/.test(String(ev.interactiveId || "")); } };
  const w = world({ flow }); allOpen(w);
  assert.deepEqual(await w.team.handover({ phone: CUST, reason: "asked_human", reasonAr: "طلب موظف", sms: "x" }), { sent: 2, wa: 2, sms: 0, failed: 0, to: 2 });
  assert.deepEqual(seen.handover.map((x) => [x.phone, x.reason, x.stage, x.cfg.ladder.enabled]), [[CUST, "asked_human", "new", true]]); assert.equal(w.calls.length, 0);
  const off = world({ flow, waTeam: { members: MEMBERS, ladder: { enabled: false } } }); allOpen(off);
  await off.team.handover({ phone: CUST, reason: "asked_human", reasonAr: "طلب موظف", sms: "x" });
  assert.equal(seen.handover.length, 1); assert.deepEqual(off.to(), [CASH1, CASH2, MGR].map(wa966));
  assert.equal(await w.team.inbound({ phone: CASH1, type: "interactive", interactiveId: "flow:take:7", text: "استلم المحادثة" }), true);
  assert.equal(await w.team.inbound({ phone: CASH1, type: "text", text: "تنبيهات" }), true);
  assert.deepEqual(seen.inbound, [["flow:take:7", "cashier"], ["تنبيهات", "cashier"]]);
  assert.equal(w.calls.length, 1, "the command still ran after waflow passed on it");
  assert.equal(await w.team.inbound({ phone: CUST, type: "interactive", interactiveId: "flow:take:7" }), false, "a customer can not press a staff button");
}));

test("ST2 free-form payload: extra buttons come before the renew button (3 at most); an outcome list is a list message; a refused interactive falls back to text", withEnv(OPEN, async () => {
  const w = world(); allOpen(w);
  const cfg = T.teamConfig(w.db.settings), m = cfg.members[0];
  await w.team.sendToStaff(cfg, m, { topic: "handover", body: "x", buttons: [{ id: "flow:take:1", title: T.ACTIONS.take }] });
  assert.deepEqual(w.calls[0].body.interactive.action.buttons.map((b) => b.reply.title), ["استلم المحادثة", "✅ جدّد التنبيهات"]);
  await w.team.sendToStaff(cfg, m, { topic: "flow", body: "x", button: false, buttons: [{ id: "a", title: T.ACTIONS.done }, { id: "b", title: T.ACTIONS.transfer }, { id: "c", title: T.ACTIONS.release }] });
  assert.deepEqual(w.calls[1].body.interactive.action.buttons.map((b) => b.reply.title), ["خلصت — اقفل", "حوّل للمدير", "رجّعها للبوت"]);
  await w.team.sendToStaff(cfg, m, { topic: "flow", body: "اختار", button: false, list: { button: "نتيجة المحادثة", rows: T.OUTCOMES.map((o) => ({ id: `flow:out:1:${o.id}`, title: o.label })) } });
  assert.deepEqual([w.calls[2].body.interactive.type, w.calls[2].body.interactive.action.button, w.calls[2].body.interactive.action.sections[0].rows.map((r) => r.title)], ["list", "نتيجة المحادثة", T.OUTCOMES.map((o) => o.label)]);
  const bad = world({ graphFail: (b) => b.type === "interactive" }); allOpen(bad);
  assert.deepEqual(await bad.team.sendToStaff(T.teamConfig(bad.db.settings), m, { topic: "flow", body: "نص", button: false, buttons: [{ id: "a", title: "x" }] }), { ok: true, via: "wa_free" });
  assert.deepEqual(bad.calls.map((c) => c.body.type), ["interactive", "text"]);
}));
