/* ════════════════════════════════════════════════════════════════════════════
   SX1 (١٥/١٠) — قايمتين أرقام بسبب لكل رقم: «موظفين / فريق» و«مستثنين من الإعلانات بس» + الترحيل + الفحص اليومي.
   الحادثة: عميل في قايمة «مايوصلوش حملات» (excludePhones) كان بيتعامل «موظف» والبوت ساكت عليه.
     node --test phonelists.test.mjs
   كل الأرقام هنا وهمية (5000000xx / 5680000xx) — مفيش بيانات عملاء حقيقية.
═════════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as P from "./phonelists.js";
import * as R from "./smsrules.js";
import { staffFromSettings } from "./uploadgate.js";
import { dailyText } from "./wateam.js";

const MIG = "2026-10-15T00:00:00Z";
const TEAM = { members: [{ phone: "0500000001", name: "مدير", role: "manager" }, { phone: "0500000002", name: "مالك ١", role: "owner" }, { phone: "0500000003", name: "مالك ٢", role: "owner" }, { phone: "0500000004", name: "كاشير", role: "cashier" }, { phone: "0500000009", role: "cashier", active: false }] };
const sorted = (s) => [...s].sort();

test("SX1 sets: team vs no-marketing vs bot-silent — the campaign-only list never silences the bot", () => {
  const s = { delivery: { alertPhones: ["0500000002"], newOrderPhones: "0500000005" }, waTeam: TEAM,
    cms: { campaigns: { excludePhones: ["0500000077"] }, phoneLists: { migratedAt: MIG, staffPhones: [{ phone: "0500000010", reason: "employee" }], reviewPhones: [{ phone: "0500000011", reason: "ambassador" }], noAdsPhones: [{ phone: "0500000012", reason: "ads_request" }] } } };
  assert.deepEqual(sorted(P.teamPhones(s)), ["500000001", "500000002", "500000003", "500000004", "500000005", "500000010", "500000011"], "alert + team (active) + staff + review; not noAds; legacy ignored after migration");
  assert.deepEqual(sorted(P.noMarketingPhones(s)), ["500000001", "500000002", "500000003", "500000004", "500000005", "500000010", "500000011", "500000012"]);
  assert.deepEqual([...P.silentMap(s).entries()].sort(), [["500000010", "staff_list"], ["500000011", "staff_review"]], "only the staff list (and pending review) — never noAds, never the old list");
  // smsrules: the campaign exclusion keeps its name (all marketing callers), the «not a customer» set is separate
  assert.deepEqual(sorted(R.staffPhoneSet(s)), sorted(P.noMarketingPhones(s)));
  assert.equal(R.teamPhoneSet(s).has("500000012"), false, "a customer who asked for no ads is still a customer");
  assert.equal(R.staffPhoneSet(s).has("500000012"), true, "…but gets no marketing");
  // ad platforms: both lists stay out
  const up = staffFromSettings(s);
  for (const p of ["500000010", "500000011", "500000012"]) assert.ok(up.has(p), p);
  assert.equal(up.has("500000077"), false, "the frozen old list is not read after the migration");
  // before the migration ran (first boot) the old list behaves exactly like before
  const pre = { cms: { campaigns: { excludePhones: ["+966 50 000 0077"] } } };
  assert.ok(P.teamPhones(pre).has("500000077")); assert.equal(P.silentMap(pre).get("500000077"), "staff_list"); assert.ok(staffFromSettings(pre).has("500000077"));
  // whereIs
  assert.equal(P.whereIs(s, "0500000012").list, "noAds"); assert.equal(P.whereIs(s, "0500000004").list, "team"); assert.equal(P.whereIs(s, "0500000005").list, "alert"); assert.equal(P.whereIs(s, "0599999999").list, null);
});

test("SX1 migration plan: team members stay staff by role, numbers with paid web orders or chats go to the owner's review queue, the rest stay staff with their real reason", () => {
  const legacy = ["0500000001", "0500000002", "0500000003", "0568000014", "0568000015", "0568000016", "0568000017", "bad"];
  const team = P.teamMembers({ waTeam: TEAM });
  const ambassadors = new Set(["500000001", "500000002", "500000003", "568000014", "568000015", "568000016"]);
  const evidence = new Map([["568000014", { web: 2, chats: 3, intent: 1, pos: 5 }], ["568000015", { web: 0, chats: 1, intent: 0 }], ["568000016", { web: 0, chats: 0, intent: 0, pos: 9 }]]);
  const plan = P.planMigration({ legacy, team, ambassadors, evidence, now: new Date(MIG) });
  const by = (l) => Object.fromEntries(l.map((e) => [e.phone, e]));
  const st = by(plan.staff), rv = by(plan.review);
  assert.deepEqual(Object.keys(st).sort(), ["500000001", "500000002", "500000003", "568000016", "568000017"]);
  assert.deepEqual(Object.keys(rv).sort(), ["568000014", "568000015"], "web orders or chats ⇒ review, never silently moved");
  assert.deepEqual([st["500000001"].reason, st["500000002"].reason, st["500000003"].reason], ["employee", "owner", "owner"]);
  assert.equal(st["568000016"].reason, "ambassador", "POS orders alone do not count — the old list was about campaigns");
  assert.equal(st["568000017"].reason, "legacy", "unknown reason is said as unknown, not invented");
  assert.equal(rv["568000014"].suggest, "noAds"); assert.deepEqual([rv["568000014"].evidence.web, rv["568000014"].evidence.chats], [2, 3]);
  for (const e of [...plan.staff, ...plan.review]) { assert.equal(e.source, "migration"); assert.equal(e.added_at, new Date(MIG).toISOString()); assert.ok(e.added_by); }
  // the evidence could not be read ⇒ every non-team number goes to review (the owner decides)
  const blind = P.planMigration({ legacy, team, ambassadors, evidence: null, now: new Date(MIG) });
  assert.deepEqual(blind.staff.map((e) => e.phone).sort(), ["500000001", "500000002", "500000003"]);
  assert.equal(blind.review.length, 4);
});

test("SX1 edits: a reason is required, «asked for no ads» can only be campaign-only, team members cannot be campaign-only, one list per number", () => {
  const settings = { waTeam: TEAM };
  const cur = { migratedAt: MIG, staffPhones: [{ phone: "568000016", reason: "ambassador" }], reviewPhones: [{ phone: "568000014", reason: "ambassador", name: "محمد" }] };
  const o = { who: "عمر", now: new Date("2026-10-16T09:00:00Z"), settings };
  assert.equal(P.addEntry(cur, { list: "staff", phone: "0568000020" }, o).error, "reason_required");
  assert.match(P.addEntry(cur, { list: "staff", phone: "0568000020" }, o).message, /السبب/);
  assert.equal(P.addEntry(cur, { list: "staff", phone: "0568000020", reason: "ads_request" }, o).error, "reason_wrong_list", "the 15/10 mistake cannot be made again");
  assert.equal(P.addEntry(cur, { list: "noAds", phone: "0500000004", reason: "family" }, o).error, "team_member");
  assert.equal(P.addEntry(cur, { list: "x", phone: "0568000020", reason: "employee" }, o).error, "bad_list");
  assert.equal(P.addEntry(cur, { list: "staff", phone: "123", reason: "employee" }, o).error, "bad_phone");
  assert.equal(P.addEntry(cur, { list: "staff", phone: "0568000020", reason: "legacy" }, o).error, "bad_reason", "legacy is for the migration only");
  const a = P.addEntry(cur, { list: "staff", phone: "0568000020", name: " سعيد ", reason: "employee" }, o);
  assert.ok(a.ok); assert.deepEqual(a.change, { action: "add", phone: "568000020", from: null, to: "staff", reason: "employee", note: null });
  assert.deepEqual(a.next.staffPhones.at(-1), { phone: "568000020", name: "سعيد", reason: "employee", note: "", added_by: "عمر", added_at: "2026-10-16T09:00:00.000Z", source: "dashboard" });
  // moving staff → noAds: out of staff, into noAds, logged as a move
  const m = P.addEntry(a.next, { list: "noAds", phone: "0568000016", reason: "ads_request" }, o);
  assert.equal(m.change.action, "move"); assert.equal(m.change.from, "staff");
  assert.equal(m.next.staffPhones.some((r) => P.normPhone(r) === "568000016"), false); assert.ok(m.next.noAdsPhones.some((r) => P.normPhone(r) === "568000016"));
  // review decisions
  const d1 = P.decideEntry(cur, { phone: "0568000014", to: "noAds" }, o);
  assert.ok(d1.ok); assert.equal(d1.change.action, "decide"); assert.equal(d1.change.from, "review"); assert.equal(d1.entry.reason, "ads_request"); assert.equal(d1.entry.name, "محمد");
  assert.equal(P.listsOf({ cms: { phoneLists: d1.next } }).review.length, 0);
  const d2 = P.decideEntry(cur, { phone: "0568000014", to: "none" }, o);
  assert.ok(d2.ok); assert.equal(d2.change.action, "decide"); assert.equal(P.teamPhones({ cms: { phoneLists: d2.next } }).has("568000014"), false, "a regular customer again");
  const d3 = P.decideEntry(cur, { phone: "0568000014", to: "staff", reason: "employee" }, o);
  assert.ok(d3.ok); assert.equal(P.silentMap({ cms: { phoneLists: d3.next } }).get("568000014"), "staff_list");
  assert.equal(P.decideEntry(cur, { phone: "0568000016", to: "none" }, o).error, "not_in_review");
  // remove + flag-ok + settings
  assert.equal(P.removeEntry(cur, "0568000099").error, "not_listed");
  assert.equal(P.removeEntry(cur, "0568000016").change.action, "remove");
  const ok = P.flagOk(cur, "0568000016", { now: new Date("2026-10-17T08:00:00Z") });
  assert.equal(ok.next.staffPhones[0].ok_at, "2026-10-17T08:00:00.000Z"); assert.equal(P.flagOk(cur, "0568000014").error, "not_staff");
  assert.deepEqual(P.settingsFromBody({}, { staffSilent: { enabled: false, afterMin: 7 }, check: { at: "12:15" } }).next, { staffSilent: { enabled: false, afterMin: 7 }, check: { at: "12:15" } });
  assert.equal(P.settingsFromBody({}, { staffSilent: { afterMin: 0 } }).ok, false);
  assert.deepEqual(P.cfgOf({}), { staffSilent: { enabled: true, afterMin: 5 }, check: { enabled: true, at: "11:30" } });
});

test("SX1 daily check: staff-listed numbers acting like customers after they were added (or after the last «ok») — team and test numbers never flagged", () => {
  const s = { waTeam: TEAM, cms: { phoneLists: { migratedAt: MIG, staffPhones: [
    { phone: "568000016", reason: "ambassador", added_at: MIG }, { phone: "568000017", reason: "employee", added_at: MIG, ok_at: "2026-10-16T00:00:00Z" },
    { phone: "500000002", reason: "owner", added_at: MIG }, { phone: "568000018", reason: "test", added_at: MIG }, { phone: "568000019", reason: "employee", added_at: MIG }] } } };
  assert.equal(P.sinceOf({ added_at: MIG, ok_at: "2026-10-16T00:00:00Z" }), "2026-10-16T00:00:00.000Z");
  const ev = new Map([["568000016", { web: 1, intent: 0 }], ["568000017", { web: 0, intent: 2 }], ["500000002", { web: 3, intent: 3 }], ["568000018", { web: 5, intent: 0 }], ["568000019", { web: 0, intent: 0, chats: 4 }]]);
  const f = P.flagsOf(s, ev);
  assert.deepEqual(f.map((x) => x.phone), ["568000016", "568000017"]);
  assert.match(f[0].why, /طلب موقع مدفوع/); assert.match(f[1].why, /نية عميل/);
});

/* ── المسارات + الترحيل على قاعدة مزيّفة ── */
function harness({ settings, evidence = new Map(), ambassadors = [], owner = true } = {}) {
  const db = { settings: JSON.parse(JSON.stringify(settings)), log: [], checks: new Map(), staffSync: [], migrateWrites: 0 };
  const evRows = (pns, sinces) => pns.map((pn, i) => { const e = evidence.get(pn) || {}; return { pn, web: e.web || 0, web_at: null, chats: e.chats || 0, chat_at: null, intent: e.intent || 0, pos: e.pos ?? null, name: e.name || "", since: sinces[i] }; });
  const setLists = (v) => { db.settings.cms = { ...(db.settings.cms || {}), phoneLists: JSON.parse(v) }; };
  const handle = (sql, p = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE/i.test(s) || /^BEGIN|^COMMIT|^ROLLBACK/i.test(s)) return { rows: [], rowCount: 0 };
    if (/^\/\*pl:evidence\*\//.test(s)) return { rows: evRows(p[0], p[1]) };
    if (/^SELECT phone_norm, name FROM ambassadors/i.test(s)) return { rows: ambassadors };
    if (/^SELECT data FROM settings WHERE id=1 FOR UPDATE/i.test(s)) return { rows: [{ data: JSON.parse(JSON.stringify(db.settings)) }] };
    if (/^UPDATE settings SET data = jsonb_set.*'\{cms,phoneLists\}'.*migratedAt\}'\) IS NULL/i.test(s)) {
      if (db.settings.cms && db.settings.cms.phoneLists && db.settings.cms.phoneLists.migratedAt) return { rows: [], rowCount: 0 };
      db.migrateWrites++; setLists(p[0]); return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE settings SET data = jsonb_set.*'\{cms,phoneLists\}'/i.test(s)) { setLists(p[0]); return { rows: [], rowCount: 1 }; }
    if (/^INSERT INTO cms_phone_list_log/i.test(s)) { const lit = /VALUES \(\$1,'migrate',\$2,'legacy','(\w+)',\$3,\$4\)/.exec(s);
      db.log.push(lit ? { who: p[0], action: "migrate", phone_norm: p[1], from_list: "legacy", to_list: lit[1], reason: p[2], note: p[3] } : { who: p[0], action: p[1], phone_norm: p[2], from_list: p[3], to_list: p[4], reason: p[5], note: p[6] }); return { rows: [] }; }
    if (/^SELECT at, who, action, phone_norm/i.test(s)) return { rows: [...db.log].reverse().map((r) => ({ at: new Date(MIG), ...r })) };
    if (/^UPDATE cms_contacts SET is_staff/i.test(s)) { db.staffSync.push([...p[0]].sort()); return { rows: [] }; }
    if (/^INSERT INTO cms_phone_list_checks/i.test(s)) { db.checks.set(p[0], { day: p[0], ran_at: p[1], trigger: p[2], flagged: p[3], rows: JSON.parse(p[4]) }); return { rows: [] }; }
    if (/^SELECT day, ran_at, trigger, flagged, rows FROM cms_phone_list_checks/i.test(s)) return { rows: [...db.checks.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 1) };
    if (/^SELECT 1 FROM cms_phone_list_checks WHERE day/i.test(s)) return { rows: db.checks.has(p[0]) ? [{}] : [] };
    throw new Error(`unexpected SQL: ${s.slice(0, 120)}`);
  };
  const pool = { query: async (sql, p) => handle(sql, p), connect: async () => ({ query: async (sql, p) => handle(sql, p), release: () => {} }) };
  const routes = {};
  const app = { get: (pth, h) => { routes[`GET ${pth}`] = h; }, post: (pth, h) => { routes[`POST ${pth}`] = h; }, put: (pth, h) => { routes[`PUT ${pth}`] = h; } };
  let isOwner = owner, now = new Date("2026-10-16T09:00:00Z");
  const api = P.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), isOwner: () => isOwner },
    { autostart: false, now: () => now, whoami: async () => ({ name: "عمر" }), log: { error: () => {}, log: () => {} } });
  const call = async (method, path, json = {}) => { const r = await routes[`${method} ${path}`]({ req: { json: async () => json }, json: (body, status = 200) => ({ body, status }) }); return r; };
  return { db, api, call, setOwner: (v) => { isOwner = v; }, setNow: (v) => { now = new Date(v); } };
}

test("SX1 migration runs once: lists written with reasons + who/when, every move logged, customers-file staff flags synced; a second boot does nothing", async () => {
  const settings = { waTeam: TEAM, delivery: { alertPhones: ["0500000002"] }, cms: { campaigns: { excludePhones: ["0500000001", "0500000002", "0568000014", "0568000016"], smsEnabled: true } } };
  const h = harness({ settings, evidence: new Map([["568000014", { web: 1, chats: 2 }]]), ambassadors: [{ phone_norm: "568000014", name: "محمد" }, { phone_norm: "568000016", name: "سيف" }] });
  const r = await h.api.migrate({ now: new Date(MIG) });
  assert.deepEqual(r, { migrated: 4, staff: 3, review: 1 });
  const L = P.listsOf(h.db.settings);
  assert.equal(L.migrated, true); assert.equal(h.db.settings.cms.phoneLists.migratedFrom, 4);
  assert.deepEqual(L.staff.map((e) => [e.phone, e.reason]).sort(), [["500000001", "employee"], ["500000002", "owner"], ["568000016", "ambassador"]]);
  assert.deepEqual(L.review.map((e) => [e.phone, e.name]), [["568000014", "محمد"]]);
  assert.deepEqual(h.db.settings.cms.campaigns.excludePhones.length, 4, "the old list is left as it was (only the previous version reads it)");
  assert.equal(h.db.log.length, 4); assert.ok(h.db.log.every((x) => x.action === "migrate"));
  assert.equal(h.db.log.find((x) => x.phone_norm === "568000014").to_list, "review");
  assert.ok(h.db.staffSync.length >= 1);
  assert.deepEqual(await h.api.migrate(), { skipped: "already" });
  assert.equal(h.db.migrateWrites, 1);
});

test("SX1 routes: owner only for edits, reason required, campaign-only number is not staff in the customers file, the log says who and why", async () => {
  const settings = { waTeam: TEAM, cms: { phoneLists: { migratedAt: MIG, staffPhones: [{ phone: "568000016", reason: "ambassador", added_at: MIG, added_by: "ترحيل تلقائي (SX1)" }], reviewPhones: [{ phone: "568000014", reason: "ambassador", added_at: MIG }] } } };
  const h = harness({ settings, evidence: new Map([["568000016", { web: 1, intent: 2 }]]), owner: false });
  const v0 = (await h.call("GET", "/api/cms/phone-lists")).body;
  assert.equal(v0.ok, true); assert.equal(v0.owner, false); assert.equal(v0.lists.staff[0].phone, "056•••16", "masked for anyone but the owner");
  assert.equal((await h.call("POST", "/api/cms/phone-lists/entry", { list: "noAds", phone: "0568000020", reason: "ads_request" })).status, 403);
  h.setOwner(true);
  const v = (await h.call("GET", "/api/cms/phone-lists")).body;
  assert.equal(v.lists.staff[0].phone, "0568000016"); assert.equal(v.lists.staff[0].reasonAr, "سفير (برنامج الدعوات)"); assert.equal(v.lists.staff[0].evidence.web, 1);
  assert.deepEqual(v.implicit.map((x) => [x.last4, x.source]), [["0001", "team"], ["0002", "team"], ["0003", "team"], ["0004", "team"]], "team members shown with why, read-only");
  assert.ok(v.lists_ar.staff.effects.length >= 4 && v.lists_ar.noAds.effects.some((t) => /البوت والمساعد بيردّوا/.test(t)));
  const miss = await h.call("POST", "/api/cms/phone-lists/entry", { list: "staff", phone: "0568000020" });
  assert.equal(miss.status, 400); assert.equal(miss.body.error, "reason_required");
  const add = await h.call("POST", "/api/cms/phone-lists/entry", { list: "noAds", phone: "0568000020", name: "عميل", reason: "ads_request" });
  assert.equal(add.status, 200); assert.equal(add.body.change.action, "add");
  assert.equal(add.body.lists.noAds[0].added_by, "عمر");
  assert.equal(h.db.staffSync.at(-1).includes("568000020"), false, "campaign-only ⇒ not «staff» in the customers file");
  const dec = await h.call("POST", "/api/cms/phone-lists/decide", { phone: "0568000014", to: "noAds" });
  assert.equal(dec.status, 200); assert.equal(dec.body.lists.review.length, 0);
  assert.deepEqual(h.db.log.slice(-2).map((x) => [x.action, x.phone_norm, x.from_list, x.to_list, x.who]), [["add", "568000020", null, "noAds", "عمر"], ["decide", "568000014", "review", "noAds", "عمر"]]);
  assert.equal((await h.call("PUT", "/api/cms/phone-lists/settings", { staffSilent: { afterMin: 99 } })).status, 400);
  assert.equal((await h.call("PUT", "/api/cms/phone-lists/settings", { staffSilent: { afterMin: 8 } })).body.cfg.staffSilent.afterMin, 8);
  // the daily check: counted once a day, «ok» hides it until there is new evidence
  const chk = (await h.call("POST", "/api/cms/phone-lists/check")).body;
  assert.equal(chk.check.flagged, 1); assert.equal(chk.check.rows[0].phone, "0568000016");
  assert.equal((await h.call("GET", "/api/cms/phone-lists/flags")).body.flagged, 1);
  assert.equal(await h.api.tick(), null, "already checked this business day");
  h.setNow("2026-10-16T09:05:00Z");
  await h.call("POST", "/api/cms/phone-lists/flag-ok", { phone: "0568000016" });
  assert.equal((await h.call("GET", "/api/cms/phone-lists/flags")).body.flagged, 0);
  assert.deepEqual(await h.api.flagCount(), { flagged: 0, review: 0 });
});

test("SX1 owners' daily summary: one counted line, nothing when there is nothing", () => {
  const t = dailyText({ handovers: 2, staffFlags: 2, staffReview: 1 });
  assert.match(t, /أرقام في قايمة الموظفين بتتصرف زي عملاء: 2/); assert.match(t, /مستنية قرارك/);
  assert.doesNotMatch(dailyText({ handovers: 2 }), /قايمة الموظفين|مستنية قرارك/);
});
