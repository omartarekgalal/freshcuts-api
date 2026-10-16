/* WH1 (١٦/١٠) — مراقب صحة واتساب: الإعدادات، الأرقام، الصرف، المشاكل، خطة التنبيه، والتشغيل على داتابيز مزيّفة.
   node --test wahealth.test.mjs   (أرقام وهمية بس) */
import test from "node:test";
import assert from "node:assert/strict";
const H = await import("./wahealth.js");
const { smsInfo } = await import("./staffalerts.js");
const { healthErrorsOf } = await import("./wacloud.js");
const { SERVER_OWNED_PATHS, redactForViewer } = await import("./settings-guard.js");
const { Hono } = await import("hono");

const NOW = Date.parse("2026-10-16T03:00:00Z");      // ٠٦:٠٠ الرياض
const P1 = "500000001", P2 = "500000002", P3 = "500000003";

test("healthCfg: الافتراضي + الحدود + الأرقام + العلامة", () => {
  const d = H.healthCfg({});
  assert.equal(d.enabled, true); assert.equal(d.sms, true); assert.equal(d.everyMin, 15); assert.equal(d.monthBudgetSar, 0);
  assert.equal(d.warnPct, 80); assert.equal(d.repeatHours, 6); assert.equal(d.marker, "‼️ واتساب فريش كاتس:"); assert.deepEqual(d.phones, []);
  const c = H.healthCfg({ waHealth: { everyMin: 1, warnPct: 150, monthBudgetSar: "5000", phones: ["0500000001", "966500000002", "bad", "0500000001"], marker: "   ", prepaidSince: "2026-13-01", enabled: false } });
  assert.equal(c.everyMin, 5); assert.equal(c.warnPct, 99); assert.equal(c.monthBudgetSar, 5000);
  assert.deepEqual(c.phones, [P1, P2]); assert.equal(c.marker, H.MARKER_DEFAULT); assert.equal(c.prepaidSince, ""); assert.equal(c.enabled, false);
  assert.ok(SERVER_OWNED_PATHS.includes("waHealth"), "الحفظ العام للإعدادات مايمسحش إعدادات المراقب");
  assert.equal(redactForViewer({ waHealth: { phones: [P1], warnPct: 80 } }).waHealth.phones, undefined, "أرقام التنبيه مابتظهرش لغير المالك");
});

test("recipientsOf: المكتوب ⇒ المالك اللي في الإنذارات ⇒ المالكين ⇒ الإنذارات", () => {
  const team = { waTeam: { members: [{ phone: P1, role: "owner" }, { phone: P2, role: "owner" }, { phone: P3, role: "manager" }] } };
  assert.deepEqual(H.recipientsOf({ ...team, delivery: { alertPhones: [P1, P3] } }), { phones: [P1], source: "owner_alert" });
  assert.deepEqual(H.recipientsOf({ ...team, delivery: { alertPhones: [P3] } }), { phones: [P1, P2], source: "team_owners" });
  assert.deepEqual(H.recipientsOf({ delivery: { alertPhones: `0${P3}` } }), { phones: [P3], source: "alert_phones" });
  assert.deepEqual(H.recipientsOf({ ...team, waHealth: { phones: [`0${P3}`] } }), { phones: [P3], source: "custom" });
  assert.deepEqual(H.recipientsOf({}), { phones: [], source: "none" });
});

const DAY = 86400;
const pt = (dayIso, cat, cost, volume) => ({ start: Date.parse(`${dayIso}T00:00:00Z`) / 1000, end: Date.parse(`${dayIso}T00:00:00Z`) / 1000 + DAY, cost, volume, pricing_category: cat });
const RAW = { data: [{ data_points: [
  pt("2026-10-14", "MARKETING", 200, 900), pt("2026-10-14", "UTILITY", 0.5, 12),
  pt("2026-10-15", "MARKETING", 258.2, 1196), pt("2026-10-15", "UTILITY", 0.56, 14), pt("2026-10-15", "SERVICE", 0, 40),
  pt("2026-10-16", "MARKETING", 10, 50),
  pt("2026-09-30", "MARKETING", 999, 1),
] }] };

test("parsePricing + spendView: النهارده والشهر والمتوسط والتوقّع والرصيد المشحون", () => {
  const { days } = H.parsePricing(RAW);
  assert.deepEqual(days.map((d) => d.day), ["2026-09-30", "2026-10-14", "2026-10-15", "2026-10-16"]);
  assert.equal(days[2].cost, 258.76); assert.equal(days[2].volume, 1250); assert.equal(days[2].byCat.MARKETING.cost, 258.2);
  const sp = H.spendView(days, { now: NOW, prepaidSince: "2026-10-15" });
  assert.equal(sp.today, 10); assert.equal(sp.month, 469.26, "سبتمبر مش داخل في الشهر");
  assert.equal(sp.avgDays, 2); assert.equal(sp.avgDaily, 229.63, "متوسط الأيام الكاملة (١٤ و١٥) — النهارده مش داخل");
  assert.equal(sp.monthEnd, "2026-10-31");
  assert.ok(sp.projected > sp.month && Math.abs(sp.projected - (sp.month + sp.avgDaily * sp.daysLeft)) < 5);
  assert.equal(sp.spentSincePrepaid, 268.76);
  assert.equal(sp.byCat.MARKETING.volume, 2146);
  /* الشكل التاني (الـedge) نفس النتيجة */
  assert.deepEqual(H.parsePricing({ data: RAW.data }).days, days);
  assert.deepEqual(H.parsePricing(null).days, []);
});

test("spendIssues: ٨٠٪ تحذير، عدّى = خطير، المعدّل هيعدّي = تحذير قبلها، رصيد قليل/خلص، من غير ميزانية = info", () => {
  const sp = { month: 820, avgDaily: 50, projected: 1600, spentSincePrepaid: 300, today: 20 };
  const k = (arr) => arr.map((i) => `${i.key}:${i.level}`);
  assert.deepEqual(k(H.spendIssues(sp, H.healthCfg({ waHealth: { monthBudgetSar: 1000 } }), { now: NOW })), ["budget_warn:warn"]);
  assert.deepEqual(k(H.spendIssues({ ...sp, month: 1000 }, H.healthCfg({ waHealth: { monthBudgetSar: 1000 } }), { now: NOW })), ["budget_over:crit"]);
  const pace = H.spendIssues({ ...sp, month: 500 }, H.healthCfg({ waHealth: { monthBudgetSar: 1000 } }), { now: NOW });
  assert.deepEqual(k(pace), ["budget_pace:warn"]);
  assert.match(pace[0].title, /2026-10-26/, "(1000-500)/50 = ١٠ أيام من ١٦/١٠");
  assert.deepEqual(k(H.spendIssues({ ...sp, month: 100, projected: 900 }, H.healthCfg({ waHealth: { monthBudgetSar: 1000 } }), { now: NOW })), [], "تحت الحد والتوقّع تحت الميزانية");
  assert.deepEqual(k(H.spendIssues(sp, H.healthCfg({}), { now: NOW })), ["no_budget:info"]);
  assert.deepEqual(k(H.spendIssues(sp, H.healthCfg({ waHealth: { prepaidSar: 400, prepaidSince: "2026-10-10" } }), { now: NOW })), ["no_budget:info", "prepaid_low:warn"], "فاضل ١٠٠ = يومين < ٣");
  assert.deepEqual(k(H.spendIssues(sp, H.healthCfg({ waHealth: { prepaidSar: 300, prepaidSince: "2026-10-10" } }), { now: NOW })), ["no_budget:info", "prepaid_out:crit"]);
  assert.deepEqual(k(H.spendIssues(sp, H.healthCfg({ waHealth: { prepaidSar: 2000, prepaidSince: "2026-10-10" } }), { now: NOW })), ["no_budget:info"]);
  assert.deepEqual(k(H.spendIssues(null, H.healthCfg({}), { pricingOk: false })), ["spend_unread:info"]);
});

test("phoneIssues: حالة ١٦/١٠ (LIMITED بسبب الاسم) + الجودة + الحد + القراية الفاشلة", () => {
  const live = { ok: true, health: "LIMITED", quality: "GREEN", status: "CONNECTED", tier: "TIER_250", nameStatus: "PENDING_REVIEW", portfolio: { ok: true, limit: "TIER_2K" },
    healthErrors: [{ entity: "PHONE_NUMBER", code: 141006, text: "message limit will increase after the display name is approved", fix: null }] };
  const a = H.phoneIssues(live, { tier: "TIER_250", portfolio: "TIER_2K" });
  assert.deepEqual(a.map((i) => `${i.key}:${i.level}`), ["health_limited:warn", "name_pending:warn"]);
  assert.match(a[0].title, /الاسم المعروض/);
  assert.match(a[0].detail, /display name/);
  const b = H.phoneIssues({ ...live, health: "AVAILABLE", nameStatus: "APPROVED", quality: "YELLOW", tier: "TIER_50" }, { tier: "TIER_250" });
  assert.deepEqual(b.map((i) => `${i.key}:${i.level}`), ["quality_yellow:warn", "tier_drop:crit"]);
  const c = H.phoneIssues({ ...live, health: "BLOCKED", quality: "RED", nameStatus: "DECLINED", status: "RESTRICTED", portfolio: { ok: true, limit: "TIER_250" } }, { portfolio: "TIER_2K" });
  assert.deepEqual(c.map((i) => i.key).sort(), ["health_blocked", "name_rejected", "phone_status", "portfolio_drop", "quality_red"]);
  assert.ok(c.every((i) => i.level === "crit"));
  assert.deepEqual(H.phoneIssues({ ok: false, error: "no_token" }).map((i) => i.key), ["read_failed"]);
  assert.deepEqual(H.phoneIssues({ ...live, health: "AVAILABLE", nameStatus: "APPROVED" }, {}), [], "كله تمام ⇒ مفيش مشاكل");
});

test("errorIssues: أول 131042 = خطير، السرعة بعد الحد، قفزة 131049", () => {
  const cfg = H.healthCfg({});
  const a = H.errorIssues([{ code: 131042, n: 1 }, { code: 130429, n: 5 }], { marketing: 10, capped: 0 }, cfg);
  assert.deepEqual(a.map((i) => `${i.key}:${i.level}`), ["pay_error:crit"]);
  assert.match(a[0].todo, /الدفع/);
  const b = H.errorIssues([{ code: 130429, n: 15 }, { code: 131056, n: 6 }, { code: 131045, n: 2 }, { code: 133010, n: 1 }], { marketing: 200, capped: 60 }, cfg);
  assert.deepEqual(b.map((i) => `${i.key}:${i.level}`), ["not_registered:crit", "rate_limit:warn", "cap_spike:warn"]);
  assert.equal(b[0].n, 3, "الكودين بتوع «مش متسجّل» مشكلة واحدة");
  assert.deepEqual(H.errorIssues([], { marketing: 20, capped: 15 }, cfg), [], "أقل من ٣٠ رسالة تسويق ⇒ مش قفزة");
  assert.deepEqual(H.errorIssues([{ code: 131026, n: 50 }], null, cfg), [], "رقم مش على واتساب مش مشكلة في الحساب");
});

test("eventIssues: حدث حساب = خطير، DOWNGRADE = نزول حد", () => {
  assert.deepEqual(H.eventIssues([{ kind: "account", event: "ACCOUNT_RESTRICTION" }, { kind: "phone", event: "DOWNGRADE", tier: "TIER_50" }]).map((i) => i.key), ["account_event", "tier_drop"]);
  assert.deepEqual(H.eventIssues([{ kind: "phone", event: "UPGRADE" }, { kind: "account", event: "VERIFIED_ACCOUNT" }]), []);
});

test("alertPlan: جديد ⇒ يتبعت، نفسه ⇒ لأ، تصعيد ⇒ يتبعت، تكرار بعد الساعات، التحذير ٢٤ ساعة، رجع تمام، info لأ", () => {
  const cfg = H.healthCfg({});
  const crit = { key: "pay_error", level: "crit" }, warn = { key: "name_pending", level: "warn" }, info = { key: "no_budget", level: "info" };
  const p1 = H.alertPlan([crit, warn, info], {}, cfg, NOW);
  assert.deepEqual(p1.announce.map((i) => i.key), ["pay_error", "name_pending"]);
  assert.deepEqual(Object.keys(p1.next).sort(), ["name_pending", "pay_error"]);
  const p2 = H.alertPlan([crit, warn], p1.next, cfg, NOW + 3600_000);
  assert.deepEqual(p2.announce, []); assert.equal(p2.next.pay_error.at, p1.next.pay_error.at);
  const p3 = H.alertPlan([crit, warn], p1.next, cfg, NOW + 6 * 3600_000 + 1);
  assert.deepEqual(p3.announce.map((i) => i.key), ["pay_error"], "الخطير بيتكرر كل ٦ ساعات، التحذير لأ");
  const p4 = H.alertPlan([crit, warn], p1.next, cfg, NOW + 24 * 3600_000 + 1);
  assert.deepEqual(p4.announce.map((i) => i.key), ["pay_error", "name_pending"]);
  const esc = H.alertPlan([{ key: "name_pending", level: "crit" }], { name_pending: { level: "warn", at: new Date(NOW).toISOString() } }, cfg, NOW + 60_000);
  assert.deepEqual(esc.announce.map((i) => i.key), ["name_pending"]);
  const rec = H.alertPlan([warn], p1.next, cfg, NOW + 60_000);
  assert.deepEqual(rec.recovered, ["pay_error"]);
  assert.deepEqual(H.alertPlan([], p1.next, H.healthCfg({ waHealth: { recovery: false } }), NOW).recovered, []);
});

test("alertText: العلامة الأول، لحد جزئين SMS، رجع تمام", () => {
  const t = H.alertText({ marker: H.MARKER_DEFAULT, announce: [{ key: "pay_error", sms: "الدفع عند ميتا فشل والرسايل مش بتوصل — حدّث الكارت أو زوّد الرصيد" }, { key: "x", sms: "y" }] });
  assert.ok(t.startsWith("‼️ واتساب فريش كاتس: الدفع"), t);
  assert.match(t, /\+1 تانيين/);
  assert.ok(smsInfo(t).segments <= 2, `${smsInfo(t).length}`);
  const long = H.alertText({ announce: [{ sms: "ا".repeat(400) }] });
  assert.ok(smsInfo(long).segments <= 2 && long.endsWith("…"));
  assert.equal(H.alertText({ recovered: ["pay_error", "budget_warn"] }), "‼️ واتساب فريش كاتس: رجع تمام: الدفع، الميزانية");
  assert.equal(H.alertText({}), "");
  assert.ok(H.testText().startsWith(H.MARKER_DEFAULT));
});

test("healthErrorsOf (wacloud): أسباب ميتا من health_status", () => {
  const hs = { can_send_message: "LIMITED", entities: [
    { entity_type: "PHONE_NUMBER", can_send_message: "LIMITED", errors: [{ error_code: 141006, error_description: "Display name pending", possible_solution: "Wait for review" }] },
    { entity_type: "WABA", can_send_message: "AVAILABLE", additional_info: ["Your messaging limit will increase after the display name is approved"] }] };
  assert.deepEqual(healthErrorsOf(hs), [
    { entity: "PHONE_NUMBER", code: 141006, text: "Display name pending", fix: "Wait for review" },
    { entity: "WABA", code: null, text: "Your messaging limit will increase after the display name is approved", fix: null }]);
  assert.deepEqual(healthErrorsOf(null), []);
});

/* ── التشغيل على داتابيز مزيّفة ── */
function fakeDb({ errorsRows = [] } = {}) {
  const st = { data: {}, ver: 0 };
  const db = { st, errorsRows, settings: null, sql: [] };
  db.pool = {
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      db.sql.push(s);
      if (/^CREATE TABLE|^INSERT INTO wa_health_state/.test(s)) return { rows: [], rowCount: 0 };
      if (/^SELECT data, ver::text AS ver/.test(s)) return { rows: [{ data: JSON.parse(JSON.stringify(st.data)), ver: String(st.ver), updated_at: null }] };
      if (/^UPDATE wa_health_state SET data=\$1::jsonb, ver=ver\+1/.test(s)) {
        if (db.stealClaim) { db.stealClaim = false; st.ver++; return { rows: [], rowCount: 0 }; }
        if (String(st.ver) !== String(p[1])) return { rows: [], rowCount: 0 };
        st.data = JSON.parse(p[0]); st.ver++; return { rows: [{ id: 1 }], rowCount: 1 };
      }
      if (/^UPDATE wa_health_state SET data = jsonb_set\(data, '\{log\}'/.test(s)) { st.data.log = JSON.parse(p[0]); return { rows: [], rowCount: 1 }; }
      if (/FROM wa_messages/.test(s)) return { rows: db.errorsRows };
      if (/FROM wa_send_queue WHERE error_code IS NOT NULL/.test(s)) return { rows: [] };
      if (/FROM wa_send_queue/.test(s)) return { rows: [{ marketing: 0, capped: 0 }] };
      if (/FROM wa_quality_events/.test(s)) return { rows: [] };
      if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{waHealth\}'/.test(s)) { db.settings.waHealth = JSON.parse(p[0]); return { rows: [], rowCount: 1 }; }
      throw new Error(`unexpected sql: ${s.slice(0, 80)}`);
    },
  };
  return db;
}
const LIVE_PHONE = { ok: true, health: "AVAILABLE", quality: "GREEN", status: "CONNECTED", tier: "TIER_250", nameStatus: "APPROVED", portfolio: { ok: true, limit: "TIER_2K" }, healthErrors: [] };
function harness({ owner = true, phone = LIVE_PHONE, errorsRows = [], pricingFail = false, settings = null } = {}) {
  const db = fakeDb({ errorsRows });
  db.settings = settings || { waTeam: { members: [{ phone: P1, role: "owner" }] }, delivery: { alertPhones: [P1, P3] }, waHealth: { monthBudgetSar: 10000 } };
  const sms = [];
  const graphCalls = [];
  const cloud = { phoneInfo: async () => db.phone, wabaId: () => "WABA1",
    graphGet: async (path, q) => { graphCalls.push([path, q]); if (pricingFail) throw Object.assign(new Error("(#100) nope"), { code: 100 }); return { pricing_analytics: RAW, id: "WABA1" }; } };
  db.phone = phone;
  const app = new Hono();
  let clock = NOW;
  const api = H.register(app, { pool: db.pool, requireAdmin: async () => null, getSettingsData: async () => db.settings, isOwner: async () => owner },
    { cloud: () => cloud, sendSms: async (m) => { sms.push(m); return { ok: true }; }, now: () => clock, schedule: false, log: () => {} });
  return { db, sms, api, app, graphCalls, tick: (ms) => { clock += ms; } };
}

test("التشغيل: أول 131042 ⇒ SMS واحد للمالك بالعلامة، التكرار ساكت، ولما يروح ⇒ «رجع تمام»", async () => {
  const h = harness({ errorsRows: [{ code: 131042, n: 3, last: new Date(NOW).toISOString() }] });
  const r1 = await h.api.check({ reason: "test" });
  assert.equal(r1.ok, true); assert.deepEqual(r1.alerted, ["pay_error"]);
  assert.equal(h.sms.length, 1); assert.equal(h.sms[0].phoneNorm, P1, "المالك اللي في دليل الفريق وفي الإنذارات بس");
  assert.equal(h.sms[0].kind, "staff");
  assert.ok(h.sms[0].body.startsWith("‼️ واتساب فريش كاتس: الدفع"), h.sms[0].body);
  assert.equal(h.graphCalls[0][0], "WABA1");
  assert.match(h.graphCalls[0][1].fields, /^pricing_analytics\.start\(\d+\)\.end\(\d+\)\.granularity\(DAILY\)\.dimensions\(\["PRICING_CATEGORY"\]\)$/);
  assert.equal(h.db.st.data.last.level, "crit");
  assert.equal(h.db.st.data.last.spend.month, 469.26);
  assert.equal(h.db.st.data.log[0].sent, 1);
  h.tick(15 * 60_000);
  const r2 = await h.api.check({ reason: "test" });
  assert.deepEqual(r2.alerted, []); assert.equal(h.sms.length, 1, "نفس المشكلة مابتتبعتش تاني قبل ٦ ساعات");
  h.db.errorsRows = [];
  h.tick(15 * 60_000);
  const r3 = await h.api.check({ reason: "test" });
  assert.deepEqual(r3.recovered, ["pay_error"]); assert.equal(h.sms.length, 2);
  assert.equal(h.sms[1].body, "‼️ واتساب فريش كاتس: رجع تمام: الدفع");
  h.tick(15 * 60_000);
  await h.api.check({ reason: "test" });
  assert.equal(h.sms.length, 2, "مفيش حاجة جديدة ⇒ مفيش رسالة");
});

test("التشغيل: حاوية تانية حجزت ⇒ مانبعتش؛ SMS مقفول ⇒ يتسجّل من غير إرسال؛ ميتا مش مقروءة ⇒ info", async () => {
  const h = harness({ errorsRows: [{ code: 131031, n: 1 }] });
  h.db.stealClaim = true;
  const r = await h.api.check({});
  assert.equal(r.skipped, "claimed_elsewhere"); assert.equal(h.sms.length, 0);
  const h2 = harness({ errorsRows: [{ code: 131031, n: 1 }], pricingFail: true, settings: { waTeam: { members: [{ phone: P1, role: "owner" }] }, waHealth: { sms: false } } });
  const r2 = await h2.api.check({});
  assert.deepEqual(r2.alerted, ["account_locked"]); assert.equal(h2.sms.length, 0);
  assert.equal(h2.db.st.data.log[0].skipped, "sms_off");
  assert.ok(h2.db.st.data.last.issues.some((i) => i.key === "spend_unread" && i.level === "info"));
  assert.equal(h2.db.st.data.last.spend, null);
});

test("التشغيل: حد الرقم بيتفتكر — النزول في الفحص الجاي = خطير", async () => {
  const h = harness();
  await h.api.check({});
  assert.equal(h.sms.length, 0, "كله تمام");
  assert.equal(h.db.st.data.tier, "TIER_250");
  h.db.phone = { ...LIVE_PHONE, tier: "TIER_50" };
  h.tick(15 * 60_000);
  const r = await h.api.check({});
  assert.deepEqual(r.alerted, ["tier_drop"]); assert.match(h.sms[0].body, /TIER_50/);
});

test("المسارات: GET للأدمن بأرقام مقنّعة لغير المالك، الإعدادات والتجربة للمالك بس", async () => {
  const h = harness({ owner: false });
  await h.api.check({});
  const g = await (await h.app.request("/api/cms/wa-health")).json();
  assert.equal(g.ok, true); assert.equal(g.state.level, "ok"); assert.deepEqual(g.recipients.phones, ["***0001"]);
  assert.equal(g.recipients.source, "owner_alert"); assert.ok(g.recipients.sourceAr);
  const denied = await h.app.request("/api/cms/wa-health/settings", { method: "POST", body: JSON.stringify({ warnPct: 50 }) });
  assert.equal(denied.status, 403);
  assert.equal((await h.app.request("/api/cms/wa-health/test", { method: "POST" })).status, 403);

  const o = harness({ owner: true });
  const bad = await (await o.app.request("/api/cms/wa-health/settings", { method: "POST", body: JSON.stringify({ phones: ["123"] }) })).json();
  assert.equal(bad.ok, false); assert.equal(bad.error, "bad_phone");
  const saved = await (await o.app.request("/api/cms/wa-health/settings", { method: "POST", body: JSON.stringify({ phones: [`0${P2}`], monthBudgetSar: 7000, warnPct: 85, marker: "‼️ تجربة:", junk: 1 }) })).json();
  assert.equal(saved.ok, true); assert.deepEqual(o.db.settings.waHealth.phones, [P2]); assert.equal(o.db.settings.waHealth.monthBudgetSar, 7000);
  assert.equal(o.db.settings.waHealth.junk, undefined);
  assert.equal(saved.recipients.source, "custom"); assert.deepEqual(saved.cfg.phones, [P2], "المالك بيشوف الرقم كامل عشان يعدّله");
  const t = await (await o.app.request("/api/cms/wa-health/test", { method: "POST" })).json();
  assert.equal(t.ok, true); assert.equal(o.sms.length, 1); assert.equal(o.sms[0].phoneNorm, P2); assert.ok(o.sms[0].body.startsWith("‼️ تجربة:"));
  const chk = await (await o.app.request("/api/cms/wa-health/check", { method: "POST" })).json();
  assert.equal(chk.ok, true); assert.equal(chk.state.level, "ok");
});
