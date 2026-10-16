import test from "node:test";
import assert from "node:assert/strict";
import { jwtExpMs, pickToken, renewDue, sessionHealth, portalAlertText, fitWords, isRejection, alertDue, sweepConfig,
  validatePortalSettings, reviveState, register } from "./portalsessions.js";
import { smsInfo, fitOneSms, makeStaffNotifier } from "./staffalerts.js";

const mkJwt = (expSec) => {
  const body = Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url");
  return `h.${body}.s`;
};
const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);   // ثابت
const inH = (h) => Math.floor((NOW + h * 3600_000) / 1000);

test("jwtExpMs reads exp in ms, null otherwise", () => {
  assert.equal(jwtExpMs(mkJwt(2_000_000_000)), 2_000_000_000_000);
  assert.equal(jwtExpMs("not-a-jwt"), null);
  assert.equal(jwtExpMs(""), null);
});

test("pickToken prefers the longest-lived still-valid token", () => {
  const soon = mkJwt(inH(1)), far = mkJwt(inH(50)), dead = mkJwt(inH(-5));
  assert.equal(pickToken([soon, far, dead], NOW).token, far);
  // كلهم ميتين ⇒ يرجّع الأطول (عشان رسالة الخطأ تكون على الأحدث)
  const d1 = mkJwt(inH(-10)), d2 = mkJwt(inH(-2));
  assert.equal(pickToken([d1, d2], NOW).token, d2);
  assert.equal(pickToken([], NOW), null);
  assert.equal(pickToken([null, "", undefined], NOW), null);
});

test("renewDue: true when near expiry", () => {
  assert.equal(renewDue({ expMs: NOW + 30 * 60_000, now: NOW, leadMin: 90 }), true);   // فاضل ٣٠ د < ٩٠
  assert.equal(renewDue({ expMs: NOW + 5 * 3600_000, now: NOW, leadMin: 90 }), false);  // فاضل ٥ ساعات
});

test("renewDue: maxAge resets even for a long-lived token", () => {
  const exp = NOW + 6 * 24 * 3600_000;    // ٦ أيام قدام (refresh نينجا)
  // اتجدّد من ٣ ساعات، السقف ٤٨ ساعة ⇒ مش مستحق
  assert.equal(renewDue({ expMs: exp, lastRefreshAt: new Date(NOW - 3 * 3600_000).toISOString(), now: NOW, leadMin: 360, maxAgeMin: 48 * 60 }), false);
  // اتجدّد من ٥٠ ساعة ⇒ مستحق (قبل ما الـ٧ أيام يخلصوا)
  assert.equal(renewDue({ expMs: exp, lastRefreshAt: new Date(NOW - 50 * 3600_000).toISOString(), now: NOW, leadMin: 360, maxAgeMin: 48 * 60 }), true);
  // مفيش تاريخ تجديد ⇒ مستحق
  assert.equal(renewDue({ expMs: exp, lastRefreshAt: null, now: NOW, leadMin: 360, maxAgeMin: 48 * 60 }), true);
});

test("sessionHealth: no session => bad + needsReconnect", () => {
  const h = sessionHealth("ninja", { hasSession: false }, NOW);
  assert.equal(h.tone, "bad");
  assert.equal(h.needsReconnect, true);
});

test("sessionHealth: dead refresh => needs reconnect (the Ninja 6/8 case)", () => {
  const h = sessionHealth("ninja", { hasSession: true, jwt: mkJwt(inH(-1800)), refresh: mkJwt(inH(-1673)) }, NOW);
  assert.equal(h.tone, "bad");
  assert.equal(h.state, "needs_reconnect");
  assert.equal(h.needsReconnect, true);
});

test("sessionHealth: refresh rejected by last error => reconnect", () => {
  const h = sessionHealth("ninja", { hasSession: true, jwt: mkJwt(inH(5)), refresh: mkJwt(inH(100)), lastError: "refresh HTTP 401" }, NOW);
  assert.equal(h.needsReconnect, true);
  assert.equal(h.tone, "bad");
});

test("sessionHealth: refresh soon => warn, not reconnect", () => {
  const h = sessionHealth("ninja", { hasSession: true, jwt: mkJwt(inH(5)), refresh: mkJwt(inH(10)) }, NOW);
  assert.equal(h.tone, "warn");
  assert.equal(h.state, "refresh_soon");
  assert.equal(h.needsReconnect, false);
});

test("sessionHealth: healthy => good", () => {
  const h = sessionHealth("hungerstation", { hasSession: true, accessExp: NOW + 3 * 3600_000, refresh: mkJwt(inH(200)) }, NOW);
  assert.equal(h.tone, "good");
  assert.equal(h.needsReconnect, false);
  assert.ok(h.accessLeftMin > 150 && h.accessLeftMin <= 180);
});

test("sessionHealth: HS opaque refresh (not a JWT) with live access => good", () => {
  // توكن تجديد هنقرستيشن مش JWT (٤٠ حرف) ⇒ refreshExp = null، مانعتبرهاش ميتة
  const h = sessionHealth("hungerstation", { hasSession: true, accessExp: NOW + 2 * 3600_000, refresh: "x".repeat(40) }, NOW);
  assert.equal(h.tone, "good");
  assert.equal(h.needsReconnect, false);
});

/* ── مراجعة ١٦/١٠: التنبيه بلغة «رسايل الإدارة» + رسالة واحدة من غير قص كلمة ── */
test("portalAlertText: every platform × kind × language is ONE sms and never cut", () => {
  for (const p of ["hungerstation", "ninja"]) {
    for (const kind of ["down", "soon"]) {
      for (const hrs of [1, 9, 23, 72, 168]) {
        const en = portalAlertText(p, kind, "en", hrs);
        assert.equal(smsInfo(en).encoding, "GSM-7", en);
        assert.equal(smsInfo(en).segments, 1, en);
        assert.match(en, /Portal sessions\.$/, `english cut: ${en}`);
        const ar = portalAlertText(p, kind, "ar", hrs);
        assert.equal(smsInfo(ar).segments, 1, ar);
        assert.match(ar, /^فريش كاتس/);
        assert.match(ar, /اربطها من اللوحة$/, `arabic cut: ${ar}`);
        // الحارس الأخير في staffalerts مايلمسهاش
        assert.equal(fitOneSms(en), en);
        assert.equal(fitOneSms(ar), ar);
      }
    }
  }
  assert.match(portalAlertText("ninja", "soon", "ar", 9.6), /نينجا هتخلص خلال 10 ساعة/);
  assert.match(portalAlertText("hungerstation", "down", "en"), /HungerStation portal session stopped/);
});

test("fitWords drops whole words, never half a word", () => {
  const long = "فريش كاتس " + "كلمة طويلة جدا ".repeat(10);
  const t = fitWords(long);
  assert.equal(smsInfo(t).segments, 1);
  assert.ok(long.replace(/\s+/g, " ").trim().startsWith(t));
  assert.ok(/(كلمة|طويلة|جدا)$/.test(t), t);
});

test("staff notifier sends the portal text in the dashboard language (en default, ar when set)", async () => {
  const sent = [];
  const sendSms = async ({ body }) => { sent.push(body); return { ok: true }; };
  const en = makeStaffNotifier({ getSettingsData: async () => ({ delivery: { alertPhones: "0500000001" } }), sendSms });
  await en.critical((lang) => portalAlertText("ninja", "down", lang), "t");
  assert.match(sent[0], /^Fresh Cuts ALERT: Ninja/);
  const ar = makeStaffNotifier({ getSettingsData: async () => ({ delivery: { alertPhones: "0500000001", staffSmsLanguage: "ar" } }), sendSms });
  await ar.critical((lang) => portalAlertText("ninja", "down", lang), "t");
  assert.equal(sent[1], "فريش كاتس عاجل: جلسة نينجا وقفت - اربطها من اللوحة");
});

test("isRejection: a network blip on HS (URL has 'token-refresh') is NOT a rejection", () => {
  assert.equal(isRejection("تعذر تجديد دخول بوابة هنقرستيشن: https://bff-api.eu.prd.portal.restaurant/auth/v4/token-refresh → fetch failed"), false);
  assert.equal(isRejection("https://x/auth/v4/token-refresh → HTTP 401 {\"error\":\"invalid_token\"}"), true);
  assert.equal(isRejection("refresh HTTP 401"), true);
  assert.equal(isRejection("صلاحية التجديد انتهت"), true);
  assert.equal(isRejection("HTTP 502 bad gateway"), false);
});

test("sessionHealth: one transient error = warn; 3 in a row = needs reconnect", () => {
  const ok = { hasSession: true, accessExp: NOW + 3 * 3600_000, refresh: "x".repeat(40) };
  const one = sessionHealth("hungerstation", { ...ok, lastError: "fetch failed", failCount: 1 }, NOW);
  assert.equal(one.tone, "warn");
  assert.equal(one.needsReconnect, false);
  const three = sessionHealth("hungerstation", { ...ok, lastError: "fetch failed", failCount: 3 }, NOW);
  assert.equal(three.state, "needs_reconnect");
  assert.equal(three.needsReconnect, true);
});

test("sessionHealth: expired access with a live refresh = warn (will renew), not green", () => {
  const h = sessionHealth("hungerstation", { hasSession: true, accessExp: NOW - 10 * 60_000, refresh: "x".repeat(40) }, NOW);
  assert.equal(h.tone, "warn");
  assert.equal(h.state, "access_expired");
});

test("alertDue: throttled per kind, escalation from soon to down is immediate, off switch works", () => {
  const cfg = sweepConfig({});
  const down = { state: "needs_reconnect", refreshLeftMin: -5 };
  const soon = { state: "refresh_soon", refreshLeftMin: 600 };
  assert.deepEqual(alertDue(down, { alerts: {} }, cfg, NOW), { kind: "down", hoursLeft: -5 / 60 });
  assert.equal(alertDue(down, { alerts: { down: NOW - 3600_000 } }, cfg, NOW), null);          // من ساعة ⇒ مكتوم (١٢ ساعة)
  assert.ok(alertDue(down, { alerts: { down: NOW - 13 * 3600_000 } }, cfg, NOW));               // من ١٣ ساعة ⇒ تاني
  assert.equal(alertDue(soon, { alerts: {} }, cfg, NOW).kind, "soon");
  assert.equal(alertDue(down, { alerts: { soon: NOW - 60_000 } }, cfg, NOW).kind, "down");      // تصعيد
  assert.equal(alertDue({ state: "ok" }, { alerts: {} }, cfg, NOW), null);
  assert.equal(alertDue(down, { alerts: {} }, sweepConfig({ portals: { alertsEnabled: false } }), NOW), null);
});

test("sweepConfig clamps + validatePortalSettings rejects junk", () => {
  const c = sweepConfig({ portals: { renewSweepMin: 1, hsLeadMin: 999, ninjaMaxAgeHours: 500, alertRepeatHours: "x" } });
  assert.equal(c.sweepMin, 5);
  assert.equal(c.hsLeadMin, 200);
  assert.equal(c.ninjaMaxAgeHours, 120);
  assert.equal(c.alertRepeatHours, 12);
  assert.deepEqual(validatePortalSettings({ renewSweepMin: 30, alertsEnabled: false }), { ok: true, values: { renewSweepMin: 30, alertsEnabled: false } });
  assert.equal(validatePortalSettings({ renewSweepMin: 2 }).ok, false);
  assert.equal(validatePortalSettings({ hack: 1 }).ok, false);
  assert.equal(validatePortalSettings({ alertsEnabled: "yes" }).ok, false);
  assert.equal(validatePortalSettings({}).ok, false);
  assert.equal(validatePortalSettings([]).ok, false);
});

test("reviveState keeps only sane fields", () => {
  const s = reviveState({ lastError: "x", failCount: "4", alerts: { down: "123", bad: "nope" }, junk: 1 });
  assert.deepEqual(s, { lastError: "x", lastRefreshAt: null, lastTickAt: null, failCount: 4, alerts: { down: 123 } });
  assert.deepEqual(reviveState(null).alerts, {});
});

/* ── الحالة والكتم بيعيشوا بعد restart الـAPI (كانت بتتصفّر) ── */
function fakePool() {
  const rows = new Map();
  return {
    rows,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, " ").trim();
      if (/^CREATE TABLE/i.test(s)) return { rows: [] };
      if (/^SELECT meta FROM portal_sessions WHERE platform=\$1/i.test(s)) return { rows: rows.has(params[0]) ? [{ meta: JSON.parse(JSON.stringify(rows.get(params[0]).meta)) }] : [] };
      if (/^INSERT INTO portal_sessions\(platform, meta/i.test(s)) { rows.set(params[0], { meta: JSON.parse(params[1]) }); return { rows: [] }; }
      if (/FROM portal_sessions WHERE platform='ninja'/i.test(s)) return { rows: [] };
      throw new Error(`unexpected sql: ${s.slice(0, 80)}`);
    },
  };
}
function fakeApp() { const routes = {}; const reg = (m) => (p, h) => { routes[`${m} ${p}`] = h; }; return { routes, get: reg("GET"), post: reg("POST") }; }
const quietLog = { log() {}, error() {} };

test("restart keeps the tile + the alert throttle (no repeat SMS after every deploy)", async () => {
  const pool = fakePool();
  const alerts = [];
  const hsMem = { userId: "1", refreshToken: "r".repeat(40), deviceToken: "d", access: null, accessExp: null };
  const deps = () => ({
    autoStart: false, log: quietLog,
    hsPortal: () => ({ load: async () => hsMem, accessToken: async () => { throw new Error("https://x/auth/v4/token-refresh → HTTP 401 invalid_token"); } }),
    ninja: () => null,
    alert: async (p, kind) => { alerts.push(`${p}:${kind}`); },
  });
  const ctx = { pool, requireAdmin: async () => null, isOwner: async () => true, getSettingsData: async () => ({}) };
  const a = register(fakeApp(), ctx, deps());
  await a.sweepOnce();
  assert.deepEqual(alerts, ["hungerstation:down"]);
  const s1 = await a.statusPayload();
  const hs1 = s1.sessions.find((x) => x.platform === "hungerstation");
  assert.equal(hs1.state, "needs_reconnect");
  assert.ok(hs1.lastAlertAt);
  // «restart»: موديول جديد على نفس الداتابيز
  const b = register(fakeApp(), ctx, deps());
  const s2 = await b.statusPayload();
  const hs2 = s2.sessions.find((x) => x.platform === "hungerstation");
  assert.equal(hs2.state, "needs_reconnect", "the tile must not reset to green after a restart");
  assert.equal(hs2.failCount, 1);
  await b.sweepOnce();
  assert.deepEqual(alerts, ["hungerstation:down"], "no second SMS inside the repeat window after a restart");
});

test("settings route: owner only, validated, merged into settings.portals", async () => {
  const pool = fakePool();
  const seen = [];
  const q = pool.query.bind(pool);
  pool.query = async (sql, params) => { if (/^UPDATE settings/i.test(sql.trim())) { seen.push(params[0]); return { rows: [] }; } return q(sql, params); };
  const app = fakeApp();
  let owner = false;
  const ctx = { pool, requireAdmin: async () => null, isOwner: async () => owner, getSettingsData: async () => ({}) };
  register(app, ctx, { autoStart: false, log: quietLog });
  const h = app.routes["POST /api/portals/settings"];
  const mkC = (body) => ({ req: { json: async () => body }, json: (o, st = 200) => ({ o, st }) });
  assert.equal((await h(mkC({ renewSweepMin: 20 }))).st, 403);
  owner = true;
  assert.equal((await h(mkC({ renewSweepMin: 1 }))).st, 400);
  const r = await h(mkC({ renewSweepMin: 20, alertsEnabled: false }));
  assert.equal(r.st, 200);
  assert.deepEqual(JSON.parse(seen[0]), { renewSweepMin: 20, alertsEnabled: false });
});

test("the alert ref (index.js: portal-<platform>-<kind>) is its own type in «الفريق والتنبيهات» (can be muted, counted)", async () => {
  const { ALERT_TYPES, typeOfRef } = await import("./staffcontrol.js");
  const t = ALERT_TYPES.find((x) => x.id === "portal_session");
  assert.ok(t, "portal_session in the catalogue");
  for (const p of ["hungerstation", "ninja"]) for (const kind of ["down", "soon"]) {
    const r = typeOfRef(`portal-${p}-${kind}`);
    assert.equal(r.type, "portal_session");
    assert.ok(t.codes[r.code], `code ${r.code} has an Arabic label`);
  }
});

test("renewal switched off from the dashboard: no platform calls, alerts still go out", async () => {
  const pool = fakePool();
  let calls = 0;
  const alerts = [];
  const ctx = { pool, requireAdmin: async () => null, isOwner: async () => true, getSettingsData: async () => ({ portals: { renewEnabled: false } }) };
  const m = register(fakeApp(), ctx, {
    autoStart: false, log: quietLog,
    hsPortal: () => ({ load: async () => null, accessToken: async () => { calls++; return "x"; } }),
    ninja: () => ({ sessionInfo: async () => ({ hasSession: true, jwt: mkJwt(Math.floor(Date.now() / 1000) - 3600), refresh: mkJwt(Math.floor(Date.now() / 1000) - 60), jwtExp: Date.now() - 3600_000, refreshExp: Date.now() - 60_000 }),
      refreshNow: async () => { calls++; return { error: "x" }; } }),
    alert: async (p, kind) => { alerts.push(`${p}:${kind}`); },
  });
  await m.sweepOnce();
  assert.equal(calls, 0);
  assert.deepEqual(alerts, ["ninja:down"]);
});
