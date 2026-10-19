/* 💸 UT1 (عمر ١٩/١٠: «نستفيد من الرسايل الخدمية … بدل التسويقية لانها بنص السعر … وهي فعلا مش تسويقية») — node --test ut1-utility-first.test.mjs
   whatsapp.js + wateam.js + wacloud.js الحقيقيين فوق قاعدة وهمية وfetch بيسجّل كل نداء (مفيش شبكة ولا رسالة حقيقية). بيثبت:
     ١) البدايل الخدمية الخمسة في الكتالوج: صالحة لميتا، UTILITY، باللغتين، مرجع للحدث، من غير زر رد سريع ولا كلام ترويجي، وفي دفعة تقديم.
     ٢) الحارس بيقرا فئة ميتا **الحيّة** (لكل لغة) قبل الجدول الاحتياطي: قالب خدمي ميتا بتحاسبه تسويق ⇒ meta_marketing — للفريق وللعملاء، بمفاتيح المالك.
     ٣) sendToStaff: القالب المحسوب تسويق بيتخطّى للقالب الخدمي اللي بعده ثم SMS — عمره ما بيتبعت.
     ٤) كل استخدام قديم لـfc_staff_team_notice راح لقالب خدمي فيه مرجع (التحويل / الغريب / الملخص / البوابة / التجربة / رسالة المالك / التجديد).
     ٥) مفاتيح اللوحة: «كل إعدادات البوت» فيها مجموعة «الخدمي أولاً»، والحفظ بيتراجع، ومسار التدقيق GET بس. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const W = await import("./whatsapp.js");
const C = await import("./watemplates.js");
const T = await import("./wateam.js");
const WC = await import("./wacloud.js");
const BOT = await import("./wabotrun.js");
const U = await import("./wautility-cfg.js");
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
const OPEN = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1", WHATSAPP_WABA_ID: "WABA1", WHATSAPP_ENABLED: "1" };
const H = 3600_000;
const CASH = "561000001", MGR = "506000003", OWN = "544000004", SOC = "544000006", CUST = "512345678";
const MEMBERS = [{ phone: `0${CASH}`, name: "منى", role: "cashier" }, { phone: `0${MGR}`, name: "خالد", role: "manager" }, { phone: `0${OWN}`, name: "عمر", role: "owner" },
  { phone: `0${SOC}`, name: "مسؤول السوشيال", role: "social" }];
const NOON = "2026-10-19T12:00:00Z";      // ١٥:٠٠ الرياض
const UT1 = ["fc_staff_portal_offline", "fc_staff_chat_review", "fc_staff_inbox_summary", "fc_staff_task_notice", "fc_staff_alerts_paused"];
/* قايمة ميتا زي قراءة ١٩/١٠ (بس القوالب اللي بتهمنا) */
const META_19 = [
  ...["ar", "en"].map((language) => ({ name: "fc_staff_team_notice", language, status: "APPROVED", category: "MARKETING" })),
  ...["ar", "en"].map((language) => ({ name: "fc_staff_alerts_renew", language, status: "APPROVED", category: "MARKETING" })),
  { name: "fc_staff_checkout_watchdog", language: "ar", status: "APPROVED", category: "MARKETING" },
  { name: "fc_staff_checkout_watchdog", language: "en", status: "APPROVED", category: "UTILITY" },
  ...["ar", "en"].map((language) => ({ name: "fc_staff_wa_handoff", language, status: "APPROVED", category: "UTILITY" })),
  { name: "fc_review_stars", language: "ar", status: "APPROVED", category: "MARKETING" },
  { name: "fc_order_received", language: "ar", status: "APPROVED", category: "UTILITY" },
  ...UT1.flatMap((name) => ["ar", "en"].map((language) => ({ name, language, status: "APPROVED", category: "UTILITY" }))),
];

function world({ at = NOON, members = MEMBERS, settings = {}, approved = [], metaList = null, lastIn = {}, used = [] } = {}) {
  let nowMs = Date.parse(at);
  const clock = { now: () => new Date(nowMs), advance: (min) => { nowMs += min * 60_000; } };
  const db = { settings: { waMaster: { enabled: true }, notifications: { whatsappEnabled: true }, delivery: { alertPhones: [], staffSmsLanguage: "en" }, waBot: { testPhones: [] }, waTeam: { members }, ...settings },
    lastIn: { ...lastIn }, events: approved.map((name) => ({ name, event: "APPROVED" })), log: [], out: [], odd: [], oddSeq: 0, state: {} };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) { const li = db.lastIn[p[0]]; return { rows: li && nowMs - Date.parse(li) < 24 * H ? [{}] : [] }; }
    if (/^SELECT max\(created_at\) AS at FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: [{ at: db.lastIn[p[0]] || null }] };
    if (/^SELECT event FROM wa_template_events WHERE name=\$1/i.test(s)) return { rows: db.events.filter((e) => e.name === p[0]).slice(-1).map((e) => ({ event: e.event })) };
    if (/^INSERT INTO wa_messages/i.test(s)) { db.out.push({ template: p[2], status: p[6] }); return { rows: [], rowCount: 1 }; }
    if (/^INSERT INTO wa_team_log/i.test(s)) { db.log.push({ phone_norm: p[0], role: p[1], topic: p[2], kind: p[3], via: p[4], ok: p[5], error: p[6] }); return { rows: [], rowCount: 1 }; }
    if (/^SELECT 1 FROM wa_team_odd WHERE kind=\$1/i.test(s)) return { rows: [] };
    if (/^INSERT INTO wa_team_odd/i.test(s)) { const id = ++db.oddSeq; db.odd.push({ id, status: "pending" }); return { rows: [{ id }], rowCount: 1 }; }
    if (/^SELECT count\(\*\)::int AS n FROM wa_team_odd WHERE status='sent'/i.test(s)) return { rows: [{ n: 0 }] };
    if (/^SELECT template, count\(\*\) FILTER/i.test(s)) return { rows: used };
    if (/^SELECT count\(DISTINCT \(ref4, kind/i.test(s)) return { rows: [{ n: 2, u: 1, sms: 0 }] };
    if (/^SELECT kind, count\(\*\)::int AS n FROM wa_team_odd WHERE at > \$1 GROUP BY 1/i.test(s)) return { rows: [{ kind: "complaint", n: 3 }] };
    return { rows: [], rowCount: 0 };
  } };
  const calls = [], reads = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (/message_templates/.test(u)) { reads.push(u); return metaList ? { ok: true, status: 200, json: async () => ({ data: metaList }) } : { ok: false, status: 500, json: async () => ({ error: { message: "meta down", code: 2 } }) }; }
    if ((init.method || "GET") === "GET") return { ok: true, status: 200, json: async () => ({}) };
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.U${calls.length}` }] }) };
  };
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
  const ctx = { pool, requireAdmin: async () => null, isOwner: async () => true, auditNote: async () => {}, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: JSON.stringify,
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(app, ctx, { fetch, sendSms: async () => ({ ok: true }) });
  if (metaList !== undefined && metaList !== false) WC.register(app, ctx, { wa, fetch, sessionUser: async () => ({ name: "عمر", role: "owner" }) });
  const sms = [];
  const team = T.register(app, ctx, { wa, sendSms: async (x) => { sms.push(x); return { ok: true }; }, now: clock.now, noTimer: true, log: { error() {}, log() {} } });
  const call = (method, path, json = {}, query = {}) => routes[`${method} ${path}`]({ req: { json: async () => json, query: (k) => query[k], param: () => undefined, header: () => undefined }, json: (body, status = 200) => ({ body, status }) });
  return { db, clock, calls, reads, sms, wa, team, call };
}
const tplCalls = (w) => w.calls.filter((c) => c.body && c.body.type === "template");
const params = (c) => (c.body.template.components.find((x) => x.type === "body") || { parameters: [] }).parameters.map((q) => q.text);

/* ══ ١) الكتالوج ═══════════════════════════════════════════════════════════ */
test("catalog: five utility replacements, Arabic + English, valid for Meta, an event reference in every one, a link button only, no promo words, queued for submission", () => {
  const promo = /(^|[\s،.])(خصم|كود|كوبون|عرض|العرض|عروض|مجاني|مجانا|اشترك|اطلب)|٪|%|discount|coupon|offer|promo|free|subscribe|order now/i;
  for (const n of UT1) {
    const pair = C.TEMPLATES.filter((t) => t.name === n);
    assert.deepEqual(pair.map((t) => t.language).sort(), ["ar", "en"], n);
    for (const t of pair) {
      assert.deepEqual(C.validateTemplate(t), [], `${n}:${t.language}`);
      assert.equal(t.category, "UTILITY"); assert.equal(t.meta.group, "staff"); assert.equal(t.meta.audience, "staff");
      const body = C.bodyOf(t);
      assert.ok((body.match(/\{\{\d\}\}/g) || []).length >= 2, `${n}: at least two references (who / when)`);
      assert.ok(!promo.test(body), `${n}:${t.language} promotional wording: ${body}`);
      assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(body), `${n}: no emoji in a staff utility body`);
      const btns = C.buttonsOf(t);
      assert.ok(btns.length >= 1 && btns.every((b) => b.type === "URL"), `${n}: URL button only — no quick reply (fc_staff_alerts_renew / team_notice had one and went MARKETING)`);
      assert.ok(btns.every((b) => !/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(b.text)));
      if (t.language === "ar") assert.ok(/[؀-ۿ]/.test(body)); else assert.ok(!/[؀-ۿ]/.test(body));
    }
    assert.ok(C.SUBMIT_BATCHES.some((b) => b.includes(n)), `${n} in SUBMIT_BATCHES`);
    assert.ok(!(n in C.HOLD), `${n} is not held`);
    assert.ok(!Object.keys(C.META_CATEGORY).some((k) => k.startsWith(`${n}:`)));
  }
  assert.deepEqual(C.SUBMIT_BATCHES.at(-1), UT1, "one batch, portal offline first");
  // the old marketing-billed pair is kept (an approved template is never deleted) and still marked as marketing in the fallback table
  for (const k of ["fc_staff_team_notice:ar", "fc_staff_team_notice:en", "fc_staff_alerts_renew:ar", "fc_staff_alerts_renew:en"]) assert.equal(C.META_CATEGORY[k], "MARKETING", k);
});

test("binding: every replacement binds from the data its sender passes — nothing missing, no newline in a value", () => {
  const data = {
    fc_staff_portal_offline: T.portalTplData({ startAt: "2026-10-19T18:05:00Z" }, null, new Date(NOON)),
    fc_staff_chat_review: { chat: { ref4: "5678", reason: T.ODD_KINDS.secret } },
    fc_staff_inbox_summary: T.inboxData({ at: NOON, handovers: 0, alerts: 3 }),
    fc_staff_task_notice: { task: { role: C.STAFF_ROLE_TPL.ar.social, at: "15:00" } },
    fc_staff_alerts_paused: { member: { role: C.STAFF_ROLE_TPL.ar.cashier }, paused: { at: "20:15" } },
  };
  assert.deepEqual(data.fc_staff_portal_offline, { portal: { name: "الكاشير", since: "21:05" } });
  assert.deepEqual(data.fc_staff_inbox_summary, { inbox: { at: "15:00", handovers: "0", alerts: "3" } }, "zero is a real value, not a missing one");
  for (const n of UT1) for (const lang of ["ar", "en"]) {
    const b = C.bindTemplate(C.findTemplate(n, lang), data[n]);
    assert.deepEqual(b.missing, [], `${n}:${lang}`);
    assert.ok(b.body.every((v) => v && !/\n/.test(v)));
  }
  // a portal episode with no closure start falls back to the episode, then to now
  assert.equal(T.portalTplData({}, { since: "2026-10-19T17:00:00Z" }, new Date(NOON)).portal.since, "20:00");
  assert.equal(T.portalTplData(null, null, new Date(NOON)).portal.since, "15:00");
});

/* ══ ٢) الحارس: فئة ميتا الحيّة ═══════════════════════════════════════════ */
test("guard (live read): a staff utility template Meta bills as MARKETING is refused as meta_marketing — per language; the live list beats the fallback table both ways", withEnv(OPEN, async () => {
  const live = world({ metaList: META_19.map((r) => (r.name === "fc_staff_wa_handoff" && r.language === "ar" ? { ...r, category: "MARKETING" } : r.name === "fc_staff_team_notice" && r.language === "ar" ? { ...r, category: "UTILITY" } : r)) });
  const g = (template, lang) => live.wa.guardSend({ phoneNorm: OWN, kind: "template", template, staff: true, lang });
  assert.deepEqual(await g("fc_staff_wa_handoff", "ar"), { ok: false, reason: "meta_marketing" }, "re-classed today, not in the table ⇒ the live read catches it");
  assert.equal((await g("fc_staff_wa_handoff", "en")).ok, true, "the English one is still UTILITY");
  assert.equal((await g("fc_staff_team_notice", "ar")).ok, true, "Meta gave it back (live) ⇒ the stale table does not block it");
  assert.deepEqual(await g("fc_staff_team_notice", "en"), { ok: false, reason: "meta_marketing" });
  assert.deepEqual(await g("fc_staff_checkout_watchdog", "ar"), { ok: false, reason: "meta_marketing" });
  assert.equal((await g("fc_staff_checkout_watchdog", "en")).ok, true);
  assert.equal((await g("fc_staff_portal_offline", "ar")).ok, true);
  assert.equal(await live.wa.metaCategoryOf("fc_staff_wa_handoff", "ar"), "MARKETING");
  assert.equal(await live.wa.metaCategoryOf("fc_staff_wa_handoff", "en"), "UTILITY");
  assert.ok(live.reads.length >= 1 && live.reads.length <= 2, "one cached read of the template list, not one per send");
  assert.equal(live.calls.length, 0, "the guard never sends");
  // Meta unreadable ⇒ the table (19/10) decides
  const down = world({ metaList: null });
  assert.deepEqual(await down.wa.guardSend({ phoneNorm: OWN, kind: "template", template: "fc_staff_team_notice", staff: true, lang: "ar" }), { ok: false, reason: "meta_marketing" });
  assert.equal((await down.wa.guardSend({ phoneNorm: OWN, kind: "template", template: "fc_staff_wa_handoff", staff: true, lang: "ar" })).ok, true);
  assert.equal(await down.wa.metaCategoryOf("fc_staff_daily_summary", "ar"), null, "Meta gave daily_summary:ar back to UTILITY — out of the table");
}));

test("guard (owner switches): utilityFirst.staff off ⇒ the marketing-billed staff template goes again (owner's choice); customers: service template refused, the stars exception stays as today until the owner closes it", withEnv(OPEN, async () => {
  const off = world({ metaList: META_19, settings: { waBot: { testPhones: [], utilityFirst: { staff: false } } } });
  assert.equal((await off.wa.guardSend({ phoneNorm: OWN, kind: "template", template: "fc_staff_team_notice", staff: true, lang: "ar" })).ok, true);
  // customers: a service template Meta bills as marketing (fc_order_received made MARKETING here) ⇒ refused before consent
  const meta = META_19.map((r) => (r.name === "fc_order_received" ? { ...r, category: "MARKETING" } : r));
  const w = world({ metaList: meta });
  const cust = (template, x = w) => x.wa.guardSend({ phoneNorm: CUST, kind: "template", template, orderNo: "W1", lang: "ar" });
  assert.deepEqual(await cust("fc_order_received"), { ok: false, reason: "meta_marketing" });
  // fc_review_stars: MARKETING at Meta since 16/10 — the default exception keeps today's behaviour (the refusal, if any, is about consent, not price)
  assert.notEqual((await cust("fc_review_stars")).reason, "meta_marketing");
  const closed = world({ metaList: meta, settings: { waBot: { testPhones: [], utilityFirst: { reviewStarsAsMarketing: false } } } });
  assert.deepEqual(await cust("fc_review_stars", closed), { ok: false, reason: "meta_marketing" });
  const noCust = world({ metaList: meta, settings: { waBot: { testPhones: [], utilityFirst: { customers: false } } } });
  assert.notEqual((await cust("fc_order_received", noCust)).reason, "meta_marketing");
  // a template that is MARKETING by our own catalog is not «re-classed» — the marketing rules handle it as before
  assert.notEqual((await cust("fc_cart_1h")).reason, "meta_marketing");
  assert.equal(w.calls.length + closed.calls.length + noCust.calls.length, 0);
  // pure verdict
  assert.equal(U.utilityFirstVerdict({ cfg: {}, audience: "staff", template: "x", billedMarketing: false }), null);
  assert.equal(U.utilityFirstVerdict({ cfg: {}, audience: "staff", template: "x", billedMarketing: true }), "meta_marketing");
  assert.equal(U.utilityFirstVerdict({ cfg: {}, audience: "customer", template: "fc_review_stars", billedMarketing: true }), null);
}));

/* ══ ٣) sendToStaff: البديل الخدمي ثم SMS ═════════════════════════════════ */
test("sendToStaff: an approved but marketing-billed template is skipped for the next utility one; none left ⇒ SMS (or nothing) — never the marketing one", withEnv(OPEN, async () => {
  const w = world({ metaList: META_19, approved: ["fc_staff_team_notice", "fc_staff_chat_review"] });
  const cfg = T.teamConfig(w.db.settings), own = cfg.members.find((m) => m.role === "owner");
  const r = await w.team.sendToStaff(cfg, own, { topic: "odd", kind: "secret", body: "👀", sms: "sms",
    templates: [{ name: "fc_staff_team_notice", data: { notice: { text: "x" } } }, { name: "fc_staff_chat_review", data: { chat: { ref4: "5678", reason: "شكوى" } } }] });
  assert.deepEqual([r.ok, r.via], [true, "wa_template"]);
  assert.deepEqual(tplCalls(w).map((c) => c.body.template.name), ["fc_staff_chat_review"]);
  // only the marketing one approved ⇒ SMS, with the reason in the log
  const x = world({ metaList: META_19, approved: ["fc_staff_team_notice"] });
  const cx = T.teamConfig(x.db.settings);
  const r2 = await x.team.sendToStaff(cx, cx.members.find((m) => m.role === "owner"), { topic: "odd", kind: "secret", body: "👀", sms: "Fresh Cuts WhatsApp: complaint",
    templates: [{ name: "fc_staff_chat_review", data: { chat: { ref4: "5678", reason: "شكوى" } } }, { name: "fc_staff_team_notice", data: { notice: { text: "x" } } }] });
  assert.deepEqual([r2.ok, r2.via], [true, "sms"]);
  assert.equal(x.calls.length, 0, "no paid call to Meta");
  assert.equal(x.db.log.at(-1).error, "fallback after template:meta_marketing");
  // no SMS text ⇒ nothing, honestly logged
  const r3 = await x.team.sendToStaff(cx, cx.members.find((m) => m.role === "owner"), { topic: "digest", kind: "daily", body: "🗒", sms: null, templates: [{ name: "fc_staff_team_notice", data: { notice: { text: "x" } } }] });
  assert.deepEqual([r3.ok, r3.via, r3.error], [false, "none", "template:meta_marketing"]);
}));

/* ══ ٤) كل استخدام قديم راح لقالب خدمي ═══════════════════════════════════ */
test("every former fc_staff_team_notice use now carries a utility template first: handover, odd (with and without a customer), daily digest, test button, owner direct message, keeper", withEnv(OPEN, async () => {
  const w = world({ metaList: META_19, approved: ["fc_staff_team_notice", "fc_staff_alerts_renew", "fc_staff_wa_handoff", ...UT1], settings: { waTeam: { members: MEMBERS, outsideWindow: "template" } } });
  // handover (urgent ⇒ cashier, manager, owner) ⇒ fc_staff_wa_handoff
  await w.team.handover({ phone: CUST, reason: "complaint", reasonAr: "شكوى", urgent: true, orderNo: "W1790000000001", sms: "x" });
  assert.deepEqual(tplCalls(w).map((c) => [c.body.template.name, ...params(c)]), [MGR, CASH, OWN].map(() => ["fc_staff_wa_handoff", "شكوى", "عميل …5678 طلب W1790000000001"]).slice(0, 3));
  // odd with a customer ⇒ fc_staff_chat_review · odd with no customer ⇒ fc_staff_inbox_summary (1 alert)
  let n = w.calls.length;
  assert.equal(await w.team.odd({ kind: "payment_problem", phone: CUST }), "sent");
  assert.ok(w.calls.slice(n).every((c) => c.body.template.name === "fc_staff_chat_review" && params(c).join("|") === "5678|مشكلة دفع / موقع"));
  n = w.calls.length;
  assert.equal(await w.team.odd({ kind: "budget_cap", detail: "السقف اليومي" }), "sent");
  assert.ok(w.calls.slice(n).every((c) => c.body.template.name === "fc_staff_inbox_summary" && params(c).join("|") === "15:00|0|1"));
  // test button ⇒ the real 24 h numbers
  n = w.calls.length;
  const t = await w.call("POST", "/api/cms/wabot/team/test", { phone: `0${OWN}` });
  assert.deepEqual([t.body.ok, t.body.via], [true, "wa_template"]);
  assert.deepEqual([w.calls[n].body.template.name, ...params(w.calls[n])], ["fc_staff_inbox_summary", "15:00", "2", "3"]);
  // owner direct message ⇒ fc_staff_task_notice (role + time, never the text)
  n = w.calls.length;
  const d = await w.call("POST", "/api/cms/wabot/team/send", { phone: `0${SOC}`, text: "ارفع فيديو المشاوي" });
  assert.deepEqual([d.body.via, d.body.full], ["wa_template", false]);
  assert.deepEqual([w.calls[n].body.template.name, ...params(w.calls[n])], ["fc_staff_task_notice", "السوشيال ميديا", "15:00"]);
  assert.ok(!JSON.stringify(w.calls[n].body).includes("المشاوي"));
  // nothing went out as fc_staff_team_notice / fc_staff_alerts_renew
  assert.ok(tplCalls(w).every((c) => !["fc_staff_team_notice", "fc_staff_alerts_renew"].includes(c.body.template.name)));
  assert.equal(w.sms.length, 0);
}));

test("source check: waflow (escalation ladder + «حوّل لك محادثة») and wateam (portal offline cashier/manager, digest, keeper) name a utility template before any marketing-billed one", () => {
  const flow = fs.readFileSync(new URL("./waflow.js", import.meta.url), "utf8");
  assert.ok(!/name: "fc_staff_team_notice"/.test(flow), "waflow no longer sends fc_staff_team_notice");
  assert.equal((flow.match(/name: "fc_staff_wa_handoff"/g) || []).length, 2);
  assert.match(flow, /reasonText: clip\(`تحويل من \$\{by\}`, 60\)/);
  const team = fs.readFileSync(new URL("./wateam.js", import.meta.url), "utf8");
  for (const line of team.split("\n").filter((l) => /templates: \[/.test(l) && /TPL_NOTICE|TPL_RENEW/.test(l))) {
    const first = /templates: \[(?:\{ name: (TPL_[A-Z]+)|(oddTpl))/.exec(line);      // oddTpl = TPL_CHAT أو TPL_INBOX
    assert.ok(first && !["TPL_NOTICE", "TPL_RENEW"].includes(first[1]), `marketing-billed template first: ${line.trim().slice(0, 120)}`);
  }
  assert.match(team, /\{ name: TPL_PORTAL, data: portalTplData\(clo\(\), e, now\) \}/);
  assert.match(team, /\{ name: TPL_PORTAL, data: portalTplData\(x, e, now\) \}/);
  assert.match(team, /\{ name: TPL_PAUSED, data: \{ member: \{ role: roleTpl\(m\.role\) \}, paused: \{ at: riyadhHHMM\(closedAt\) \} \} \}, \{ name: TPL_RENEW, data: \{\} \}/);
});

/* ══ ٥) اللوحة ═════════════════════════════════════════════════════════════ */
test("dashboard: «كل إعدادات البوت» shows the «الخدمي أولاً» group (three switches, Arabic labels, defaults on); saving is validated", () => {
  const def = BOT.botConfig({});
  assert.deepEqual(def.utilityFirst, { staff: true, customers: true, reviewStarsAsMarketing: true });
  const rows = BOT.schemaFor(def).filter((x) => x.group === "utilityFirst");
  assert.deepEqual(rows.map((x) => [x.key, x.type, x.default]), [["utilityFirst.staff", "boolean", true], ["utilityFirst.customers", "boolean", true], ["utilityFirst.reviewStarsAsMarketing", "boolean", true]]);
  assert.ok(rows.every((x) => /[؀-ۿ]/.test(x.ar) && /[؀-ۿ]/.test(x.help) && /[؀-ۿ]/.test(x.groupAr)));
  assert.deepEqual(BOT.botConfig({ waBot: { utilityFirst: { staff: false, junk: 1 } } }).utilityFirst, { staff: false, customers: true, reviewStarsAsMarketing: true });
  assert.deepEqual(U.utilityFirstFromBody({ reviewStarsAsMarketing: false }, { staff: true }), { ok: true, value: { staff: true, reviewStarsAsMarketing: false } });
  assert.equal(U.utilityFirstFromBody({ staff: "no" }).ok, false);
  assert.equal(U.utilityFirstFromBody({ nonsense: true }).ok, false);
  assert.equal(U.utilityFirstFromBody(null).ok, false);
});

test("GET /api/cms/wa-cloud/utility-audit: lists every template whose Meta category differs from ours, with 30-day sends, 131049 blocks and the extra SAR — read only", withEnv(OPEN, async () => {
  const used = [{ template: "fc_review_stars", sent: 67, billed_mk: 63, billed_ut: 0, blocked_131049: 7 }, { template: "fc_staff_team_notice", sent: 8, billed_mk: 8, billed_ut: 0, blocked_131049: 57 },
    { template: "fc_staff_alerts_renew", sent: 2, billed_mk: 2, billed_ut: 0, blocked_131049: 0 }];
  const w = world({ metaList: META_19, used });
  const r = (await w.call("GET", "/api/cms/wa-cloud/utility-audit")).body;
  assert.equal(r.ok, true); assert.equal(r.liveRead, true);
  assert.deepEqual(r.config, { staff: true, customers: true, reviewStarsAsMarketing: true });
  assert.deepEqual(r.rows.map((x) => `${x.name}:${x.language}:${x.meta}`).sort(),
    ["fc_review_stars:ar:MARKETING", "fc_staff_alerts_renew:ar:MARKETING", "fc_staff_alerts_renew:en:MARKETING", "fc_staff_checkout_watchdog:ar:MARKETING", "fc_staff_team_notice:ar:MARKETING", "fc_staff_team_notice:en:MARKETING"]);
  const stars = r.rows.find((x) => x.name === "fc_review_stars");
  assert.deepEqual([stars.sent30, stars.billedMarketing30, stars.blocked131049_30, stars.exception, stars.source], [67, 63, 7, "reviewStarsAsMarketing", "live"]);
  assert.equal(stars.extraSar30, Math.round(63 * (0.2159 - 0.0401) * 100) / 100);
  const tn = r.rows.filter((x) => x.name === "fc_staff_team_notice");
  assert.equal(tn.filter((x) => x.sent30 > 0).length, 1, "counted once per name, not once per language");
  assert.equal(r.extraSar30, Math.round(r.rows.reduce((a, x) => a + x.extraSar30, 0) * 100) / 100);
  assert.ok(Math.abs(r.extraSar30 - (63 + 8 + 2) * (0.2159 - 0.0401)) < 0.02);
  assert.equal(w.calls.length, 0, "GET only — nothing sent");
}));
