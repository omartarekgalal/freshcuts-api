// SU1 (16/10): SMS segment «عملاء مايوصلهمش واتساب» (wa_unreachable) — owner decision 15/10: «WhatsApp beats SMS — SMS only where
// WhatsApp can't reach». Segment SQL shape, settings (dashboard-editable), and every usual campaign exclusion through the real
// cms.js routes on a fake DB. Synthetic phones only (50000xxxx). Nothing is sent.
// Run: node --test su1-wa-unreachable.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
// cms.register starts timers — unref them so the process can exit (same as g2-address-first.test.mjs)
const realSI = globalThis.setInterval, realST = globalThis.setTimeout;
globalThis.setInterval = (...a) => { const t = realSI(...a); t?.unref?.(); return t; };
globalThis.setTimeout = (...a) => { const t = realST(...a); t?.unref?.(); return t; };
const cms = await import("./cms.js");
const R = await import("./smsrules.js");
const cmsSrc = readFileSync(new URL("./cms.js", import.meta.url), "utf8");
const flat = (s) => String(s).replace(/\s+/g, " ").trim();

/* ── fixtures: 9 customers, all synthetic ── */
const P = {
  ok1: "500000101",       // direct (hall) customer, Cloud 131026 → in, reaches the audience
  ok2: "500000102",       // direct, Cloud 130472 → in, reaches the audience
  inv: "500000103",       // direct, only in wa_invalid_numbers → in, reaches the audience
  staff: "500000104",     // in the segment, but an alert phone (staffPhoneSet)
  opted: "500000105",     // in the segment, opted out
  adblk: "500000106",     // in the segment, FreshCut-AD blocked at the operator
  gap: "500000107",       // in the segment, got a marketing SMS 1 day ago (recent tier needs 3)
  online: "500000108",    // in the segment, ordered on the site in the last 3 days
  apps: "500000109",      // in the segment, all orders from a delivery app (no direct relationship)
  reach: "500000110",     // ordinary customer whose WhatsApp works → NOT in the segment
  notCust: "500000111",   // returned by the SQL but not a customer at all → not counted
};
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const posRow = (pn, { orders = 2, app = 0, last = 10 } = {}) => ({ pn, orders, spend: 150, last_day: daysAgo(last), name: "عميل تجربة", app_orders: app });
const POS = [P.ok1, P.ok2, P.inv, P.staff, P.opted, P.adblk, P.gap, P.online, P.reach].map((pn) => posRow(pn)).concat([posRow(P.apps, { orders: 2, app: 2 })]);
const AT = new Date(Date.now() - 20 * 3600_000).toISOString();      // Thursday's wave, ~20 h ago
const WAU = [
  { pn: P.ok1, at: AT, code: 131026, job_id: 24, src: "wa_cloud" },
  { pn: P.ok2, at: AT, code: 130472, job_id: 27, src: "wa_cloud" },
  { pn: P.inv, at: AT, code: null, job_id: 8, src: "wa_invalid" },
  ...[P.staff, P.opted, P.adblk, P.gap, P.online, P.apps, P.notCust].map((pn) => ({ pn, at: AT, code: 131026, job_id: 25, src: "wa_cloud" })),
];

function harness({ settings = {}, wau = WAU } = {}) {
  const st = { sql: [], waParams: [], saved: [] };
  let S = JSON.parse(JSON.stringify(settings));
  const pool = {
    async query(sql, p = []) {
      const s = flat(sql);
      st.sql.push(s);
      if (s.includes("FROM wa_invalid_numbers") && s.includes("WITH att AS")) { st.waParams.push(p); return { rows: wau.map((x) => ({ ...x })) }; }
      if (s.startsWith("WITH x AS (") && s.includes("FROM ts_orders o")) return { rows: POS.map((x) => ({ ...x })) };
      if (/^SELECT phone_norm AS pn, count\(\*\)::int AS n/.test(s)) return { rows: [] };
      if (/^SELECT phone_norm, optout_code, opted_out_at FROM cms_contacts/.test(s))
        return { rows: p[0].map((pn) => ({ phone_norm: pn, optout_code: `c${pn.slice(-4)}`, opted_out_at: pn === P.opted ? new Date().toISOString() : null })) };
      if (/^WITH m AS \( SELECT phone_norm, created_at AS at FROM cms_campaign_sends/.test(s))
        return { rows: p[0].includes(P.gap) ? [{ phone_norm: P.gap, days: 1, in7: 1, in30: 1 }] : [] };
      if (/^SELECT DISTINCT phone_norm FROM shop_orders WHERE .*INTERVAL '3 days'/.test(s))
        return { rows: p[0].includes(P.online) ? [{ phone_norm: P.online }] : [] };
      if (/count\(DISTINCT phone_norm\)::int n FROM push_subs/.test(s)) return { rows: [{ n: 0 }] };
      if (/^UPDATE settings SET data = jsonb_set\( CASE WHEN data \? 'cms'/.test(s)) {
        const v = JSON.parse(p[0]); st.saved.push(v); S = { ...S, cms: { ...(S.cms || {}), campaigns: v } }; return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const app = new Hono();
  const api = cms.register(app, { pool, jb: (x) => JSON.stringify(x), DEFAULT_DELIVERY_APPS: [], todayISO: () => daysAgo(0),
    getSettingsData: async () => S, setCmsHooks: () => {}, requireAdmin: async () => null },
  { notify: () => null, warm: false, smsBlock: () => ({ blockedSet: async (pns) => new Set(pns.filter((x) => x === P.adblk)) }) });
  const call = async (method, path, body) => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { call, st, api };
}
const BASE = { delivery: { alertPhones: [`0${P.staff}`] }, cms: { campaigns: { smsEnabled: true } } };

/* ═══ 1) the SQL ═══ */
test("SQL shape: latest Cloud campaign attempt per phone within N days, failed with a listed code — OR wa_invalid_numbers — and no WhatsApp delivered since", () => {
  const q = flat(R.WA_UNREACHABLE_SQL);
  // (a) the latest Cloud attempt per phone, inside the window ($1 days)
  assert.match(q, /SELECT DISTINCT ON \(q\.phone_norm\)/);
  assert.match(q, /FROM wa_send_queue q WHERE q\.channel = 'wa_cloud' AND q\.status IN \('sent', 'failed', 'sending'\)/, "attempts only: sent / failed / in flight — never pending, skipped or holdout");
  assert.match(q, /COALESCE\(q\.tried_at, q\.sent_at, q\.claimed_at\) > NOW\(\) - \(\$1::int \* INTERVAL '1 day'\)/);
  assert.match(q, /ORDER BY q\.phone_norm, COALESCE\(q\.tried_at, q\.sent_at, q\.claimed_at\) DESC, q\.id DESC \)/, "the newest attempt wins");
  assert.match(q, /COALESCE\(q\.error_code, q\.first_error_code\) AS code/);
  // …and only if THAT attempt failed with one of the codes ($2)
  assert.match(q, /FROM att WHERE status = 'failed' AND code = ANY\(\$2::int\[\]\)/);
  // (b) not on WhatsApp at all — no day limit
  assert.match(q, /UNION ALL SELECT phone_norm, at, NULL::int, job_id, 'wa_invalid'::text FROM wa_invalid_numbers \)/);
  assert.doesNotMatch(q.split("FROM wa_invalid_numbers")[1].split(")")[0], /INTERVAL/);
  // no WhatsApp delivered after the failure — any outbound message (campaign, order update, reply) or a campaign row with delivered/read
  assert.match(q, /NOT EXISTS \(SELECT 1 FROM wa_messages m WHERE m\.phone_norm = c\.pn AND m\.direction = 'out' AND m\.status IN \('delivered', 'read'\) AND m\.created_at > c\.at\)/);
  assert.match(q, /NOT EXISTS \(SELECT 1 FROM wa_send_queue d WHERE d\.phone_norm = c\.pn AND COALESCE\(d\.delivered_at, d\.read_at\) > c\.at\)/);
  assert.match(q, /WHERE c\.pn ~ '\^5\[0-9\]\{8\}\$'/);
  // one row per phone; the Cloud reason (with its code) is preferred over the bare invalid mark
  assert.match(q, /SELECT DISTINCT ON \(c\.pn\) c\.pn, c\.at, c\.code, c\.job_id, c\.src FROM cand c/);
  assert.match(q, /ORDER BY c\.pn, \(c\.code IS NOT NULL\) DESC, c\.at DESC$/);
  // read-only: no write keyword anywhere
  assert.doesNotMatch(q, /\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
  // the two placeholders, nothing interpolated
  assert.deepEqual([...new Set(q.match(/\$\d/g))].sort(), ["$1", "$2"]);
});

test("settings: defaults 7 days + 131026/130472; range 1–60; codes only from the list; an explicit empty list is kept", () => {
  assert.deepEqual(R.waUnreachableOf({}), { days: 7, codes: [131026, 130472] });
  assert.deepEqual(R.waUnreachableOf(undefined), { days: 7, codes: [131026, 130472] });
  assert.deepEqual(R.waUnreachableOf({ waUnreachableDays: 14 }).days, 14);
  for (const bad of [0, 61, -3, "x", null, 2.0e9]) assert.equal(R.waUnreachableOf({ waUnreachableDays: bad }).days, 7, String(bad));
  assert.equal(R.waUnreachableOf({ waUnreachableDays: "3" }).days, 3);
  assert.deepEqual(R.waUnreachableOf({ waUnreachableCodes: [131049, "131026", 999, 131026] }).codes, [131026, 131049], "known codes only, deduped, in list order");
  assert.deepEqual(R.waUnreachableOf({ waUnreachableCodes: [] }).codes, [], "owner unticked all: only «not on WhatsApp» numbers");
  assert.deepEqual(R.waUnreachableOf({ waUnreachableCodes: ["x", 5] }).codes, [131026, 130472], "garbage ⇒ default");
  assert.deepEqual(R.waUnreachableOf({ waUnreachableCodes: "131026" }).codes, [131026, 130472], "not a list ⇒ default");
  assert.deepEqual(R.WA_UNREACHABLE_CODE_OPTIONS.map((o) => o.code), [131026, 130472, 131049]);
  assert.ok(R.WA_UNREACHABLE_CODE_OPTIONS.every((o) => o.label && o.label.includes(String(o.code))));
});

test("segment object: id, Arabic label, smsOnly, no allowApps (apps-only rule stays on), hint follows the setting", () => {
  let cfg = R.waUnreachableOf({});
  const seg = R.waUnreachableSegment(() => cfg);
  assert.equal(seg.id, "wa_unreachable");
  assert.equal(seg.label, "عملاء مايوصلهمش واتساب");
  assert.equal(seg.smsOnly, true);
  assert.equal(seg.allowApps, undefined);
  assert.match(seg.hint, /خلال 7 يوم/); assert.match(seg.hint, /131026 \/ 130472/);
  cfg = R.waUnreachableOf({ waUnreachableDays: 3, waUnreachableCodes: [131026] });
  assert.match(seg.hint, /خلال 3 يوم/); assert.doesNotMatch(seg.hint, /130472/);
  assert.equal(seg.test({ waUnreachable: { code: 131026 } }), true);
  assert.equal(seg.test({ waUnreachable: null }), false);
  assert.equal(seg.test({}), false);
  assert.equal(R.waUnreachableSegment(() => { throw new Error("x"); }).hint.includes("خلال 7 يوم"), true, "a broken cfg getter falls back to defaults");
});

/* ═══ 2) through the real cms.js routes ═══ */
test("GET /api/cms/segments: the segment is listed with its label from the API; count = customers the SQL returned (non-customers not counted)", async () => {
  const h = harness({ settings: BASE });
  const r = await h.call("GET", "/api/cms/segments");
  assert.equal(r.status, 200);
  const s = r.body.segments.find((x) => x.id === "wa_unreachable");
  assert.ok(s, "listed");
  assert.equal(s.label, "عملاء مايوصلهمش واتساب");
  assert.equal(s.icon, "📵");
  assert.equal(s.smsOnly, true);
  assert.equal(s.allowApps, undefined);
  assert.equal(s.count, 9, "all fixtures except the reachable one and the non-customer");
  assert.deepEqual(h.st.waParams[0], [7, [131026, 130472]], "default window + codes go to the SQL as parameters");
  // the other segments are not affected
  assert.ok(r.body.segments.find((x) => x.id === "never_online"));
});

test("reach (SMS): every usual campaign exclusion still applies — staff, opt-out, FreshCut-AD block, gap, online order ≤3 days, apps-only", async () => {
  const h = harness({ settings: BASE });
  const r = await h.call("GET", "/api/cms/segments/wa_unreachable/reach?channel=sms");
  assert.equal(r.status, 200);
  assert.equal(r.body.segmentSize, 9);
  assert.equal(r.body.audience, 3, "ok1 + ok2 + inv");
  const ex = r.body.excluded;
  assert.equal(ex.staff, 1); assert.equal(ex.opted_out, 1); assert.equal(ex.ad_blocked, 1);
  assert.equal(ex.gap, 1); assert.equal(ex.recent_online_order, 1); assert.equal(ex.apps_only, 1);
  for (const k of Object.keys(ex)) assert.ok(r.body.excludeLabels[k], `label for ${k}`);
});

test("reach: a temporary SMS pause on the segment (settings.cms.smsPause) also applies", async () => {
  const until = new Date(Date.now() + 3 * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const h = harness({ settings: { ...BASE, cms: { ...BASE.cms, smsPause: [{ segments: ["wa_unreachable"], until }] } } });
  const r = await h.call("GET", "/api/cms/segments/wa_unreachable/reach?channel=sms");
  assert.equal(r.body.audience, 0);
  assert.ok(r.body.excluded.sms_paused >= 3);
});

test("members: each one carries why (code / source / failure time); the reachable customer is not there", async () => {
  const h = harness({ settings: BASE });
  const r = await h.call("GET", "/api/cms/segments/wa_unreachable?limit=50");
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 9);
  const by = Object.fromEntries(r.body.members.map((m) => [m.phone, m]));
  assert.deepEqual({ code: by[P.ok1].waUnreachable.code, src: by[P.ok1].waUnreachable.src, jobId: by[P.ok1].waUnreachable.jobId }, { code: 131026, src: "wa_cloud", jobId: 24 });
  assert.equal(by[P.ok2].waUnreachable.code, 130472);
  assert.deepEqual({ code: by[P.inv].waUnreachable.code, src: by[P.inv].waUnreachable.src }, { code: null, src: "wa_invalid" });
  assert.equal(by[P.reach], undefined);
  assert.equal(by[P.notCust], undefined);
});

test("WhatsApp campaigns never see it: not in segmentList, and segmentPhones returns an empty list (not null, which falls back to another audience)", async () => {
  const h = harness({ settings: BASE });
  assert.equal(h.api.segmentList().some((s) => s.id === "wa_unreachable"), false);
  assert.ok(h.api.segmentList().some((s) => s.id === "never_online"), "other segments still offered");
  assert.deepEqual(await h.api.segmentPhones("wa_unreachable"), []);
  assert.ok((await h.api.segmentPhones("never_online")).length > 0);
});

test("dashboard settings: GET /api/cms/campaigns exposes the knobs + options; PUT /api/cms/campaign-settings saves them (validated) and the next count uses them", async () => {
  const h = harness({ settings: BASE });
  let r = await h.call("GET", "/api/cms/campaigns");
  assert.equal(r.status, 200);
  const w = r.body.waUnreachable;
  assert.equal(w.segment, "wa_unreachable");
  assert.equal(w.days, 7); assert.deepEqual(w.codes, [131026, 130472]);
  assert.deepEqual(w.defaults, { days: 7, codes: [131026, 130472] });
  assert.deepEqual(w.daysRange, [1, 60]);
  assert.deepEqual(w.options.map((o) => o.code), [131026, 130472, 131049]);
  await h.call("GET", "/api/cms/segments");      // warm the 5-min cache with the old setting
  r = await h.call("PUT", "/api/cms/campaign-settings", { smsEnabled: true, dailySmsCap: 1000, waUnreachableDays: 3, waUnreachableCodes: [131026, 999] });
  assert.equal(r.status, 200);
  assert.equal(h.st.saved.at(-1).waUnreachableDays, 3);
  assert.deepEqual(h.st.saved.at(-1).waUnreachableCodes, [131026]);
  assert.equal(h.st.saved.at(-1).smsEnabled, true, "the rest of the campaign settings is kept");
  await h.call("GET", "/api/cms/segments");
  assert.deepEqual(h.st.waParams.at(-1), [3, [131026]], "cache dropped: the new window/codes are used right away");
  r = await h.call("GET", "/api/cms/campaigns");
  assert.deepEqual([r.body.waUnreachable.days, r.body.waUnreachable.codes], [3, [131026]]);
  // out of range ⇒ default, like the gap knobs
  await h.call("PUT", "/api/cms/campaign-settings", { smsEnabled: true, dailySmsCap: 1000, waUnreachableDays: 500 });
  assert.equal(h.st.saved.at(-1).waUnreachableDays, 7);
  // a save without the keys leaves them alone
  await h.call("PUT", "/api/cms/campaign-settings", { smsEnabled: true, dailySmsCap: 1000, minGapDays: 3 });
  assert.deepEqual(h.st.saved.at(-1).waUnreachableCodes, [131026]);
});

test("a database without the WhatsApp tables (42P01) ⇒ empty segment, the rest of the segments still load", async () => {
  // the WA SQL throws "relation does not exist"
  const app = new Hono();
  const pool = { async query(sql) {
    const s = flat(sql);
    if (s.includes("FROM wa_invalid_numbers") && s.includes("WITH att AS")) { const e = new Error("relation \"wa_send_queue\" does not exist"); e.code = "42P01"; throw e; }
    if (s.startsWith("WITH x AS (") && s.includes("FROM ts_orders o")) return { rows: POS.map((x) => ({ ...x })) };
    return { rows: [], rowCount: 0 };
  } };
  cms.register(app, { pool, jb: (x) => JSON.stringify(x), DEFAULT_DELIVERY_APPS: [], todayISO: () => daysAgo(0),
    getSettingsData: async () => BASE, setCmsHooks: () => {}, requireAdmin: async () => null }, { notify: () => null, warm: false });
  const r = await (await app.request("/api/cms/segments")).json();
  assert.equal(r.segments.find((x) => x.id === "wa_unreachable").count, 0);
  assert.ok(r.segments.find((x) => x.id === "never_online").count > 0);
});

/* ═══ 3) source guards ═══ */
test("cms.js wiring: the SQL is fed from the campaign settings, the segment sits in SEGMENTS, and the SMS audience path is the shared one", () => {
  assert.ok(cmsSrc.includes("waUnreachCfg = smsRules.waUnreachableOf(((s || {}).cms || {}).campaigns);"));
  assert.ok(cmsSrc.includes("pool.query(smsRules.WA_UNREACHABLE_SQL, [waUnreachCfg.days, waUnreachCfg.codes])"));
  assert.ok(cmsSrc.includes("smsRules.waUnreachableSegment(() => waUnreachCfg),"));
  assert.ok(cmsSrc.includes("const segmentList = () => SEGMENTS.filter((s) => !s.smsOnly).map(pub);"));
  // audienceFor still decides apps-only from the segment flag (the new segment has none ⇒ the rule applies)
  assert.ok(cmsSrc.includes("allowApps: s.allowApps === true, adBlocked });"));
});
