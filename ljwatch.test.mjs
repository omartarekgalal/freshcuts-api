/* LJ2a — مراقب حساب لاجلك (ljwatch.js). fetch مزيّف + داتابيز مزيّفة؛ مفيش نداء حقيقي لأي حد.
     node --test ljwatch.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classify, probe, nextState, ljWatchCfg, smsText, waText, ljHealthOf, controlLine, register,
  SEED, REOPEN_COOLDOWN_MS, MAX_ALERT_ATTEMPTS, riyadhHM,
} from "./ljwatch.js";
import { smsInfo } from "./staffalerts.js";

const SUSP = { message: "Client is not active or may be suspended. If you think this is an error, please contact Leajlak for further details." };

/* ── fetch مزيّف: كل نداء بيتسجّل (الطريقة + الرابط) عشان نتأكد إنه GET /shops بس ── */
function fakeFetch(script) {
  const calls = [];
  let i = 0;
  const f = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, auth: Boolean(opts.headers && opts.headers.Authorization) });
    const step = typeof script === "function" ? script(i) : script[Math.min(i, script.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    const text = typeof step.body === "string" ? step.body : JSON.stringify(step.body ?? {});
    return { status: step.status, text: async () => text };
  };
  f.calls = calls;
  return f;
}
const OK = { status: 200, body: { data: [{ id: 7, name: "Fresh Cuts" }] } };
const SUSPENDED = { status: 401, body: SUSP };
const NETERR = Object.assign(new Error("fetch failed"), { name: "TypeError" });

/* ── داتابيز مزيّفة لجدول lj_watch_state + كل استعلام بيتسجّل ── */
function fakePool({ failAll = false } = {}) {
  const row = { data: null, ver: 0 };
  const sqls = [];
  return {
    row, sqls,
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      sqls.push(s);
      if (failAll) throw new Error("db down");
      if (/^CREATE TABLE IF NOT EXISTS lj_watch_state/i.test(s)) return { rows: [], rowCount: 0 };
      if (/^INSERT INTO lj_watch_state/i.test(s)) {
        if (row.data) return { rows: [], rowCount: 0 };
        row.data = JSON.parse(p[0]); row.ver = /VALUES \(1, \$1::jsonb, 1/.test(s) ? 1 : 0;
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      if (/^SELECT data, ver::text AS ver FROM lj_watch_state/i.test(s)) return { rows: row.data ? [{ data: JSON.parse(JSON.stringify(row.data)), ver: String(row.ver) }] : [] };
      if (/^UPDATE lj_watch_state SET data=\$1::jsonb, ver=ver\+1/i.test(s)) {
        if (String(row.ver) !== String(p[1])) return { rows: [], rowCount: 0 };
        row.data = JSON.parse(p[0]); row.ver++;
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      if (/^UPDATE lj_watch_state SET data = data \|\| \$1::jsonb/i.test(s)) { row.data = { ...row.data, ...JSON.parse(p[0]) }; return { rows: [], rowCount: 1 }; }
      throw new Error("unexpected SQL: " + s.slice(0, 80));
    },
  };
}
function fakeApp() {
  const routes = {};
  return { routes, get: (p, h) => { routes[`GET ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } };
}
const SETTINGS = (over = {}) => ({
  shop: { autoDispatch: false },
  delivery: { alertPhones: ["0551115082", "0552228246"], ...(over.delivery || {}) },
  waTeam: { members: [{ role: "owner", phone: "0551115082" }, { role: "owner", phone: "0553336075" }] },
  ...over.top,
});
function setup({ script, settings = SETTINGS(), smsFail = false, waResult = { ok: false, skipped: "window_closed" }, pool = fakePool(), t0 = Date.parse("2026-10-16T17:00:00Z") } = {}) {
  process.env.LEAJLAK_TOKEN = "test-token-not-real";
  const clock = { t: t0 };
  const sms = [], waSent = [], logs = [];
  const fetch = fakeFetch(script);
  const app = fakeApp();
  const api = register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => settings }, {
    fetch, now: () => clock.t, schedule: false, log: (...a) => logs.push(a.join(" ")), info: (...a) => logs.push(a.join(" ")),
    sendSms: async (m) => { sms.push(m); if (smsFail) throw new Error("taqnyat down"); return { ok: true }; },
    wa: { sendFreeform: async (m) => { waSent.push(m); return waResult; } },
  });
  const later = (min) => { clock.t += min * 60_000; };
  return { api, app, pool, fetch, sms, waSent, logs, clock, later };
}

/* ═══ التصنيف ═══ */
test("200 + JSON ⇒ شغّال", () => {
  const r = classify({ status: 200, body: { data: [] } });
  assert.equal(r.state, "up"); assert.equal(r.label, "شغّال"); assert.equal(r.httpStatus, 200);
});
test("401 برسالة الإيقاف ⇒ «موقوف من لاجلك»", () => {
  const r = classify({ status: 401, body: SUSP });
  assert.equal(r.state, "suspended"); assert.equal(r.label, "موقوف من لاجلك"); assert.equal(r.httpStatus, 401);
  assert.match(r.message, /suspended/);
});
test("خطأ شبكة/مهلة/401 تاني/5xx/200 مش JSON ⇒ «مش عارفين» بالكود", () => {
  assert.deepEqual([classify({ error: "fetch failed" }).state, classify({ error: "fetch failed" }).label, classify({ error: "fetch failed" }).httpStatus],
    ["unknown", "مش عارفين (خطأ شبكة)", null]);
  assert.match(classify({ error: "timeout" }).label, /مارديتش/);
  const un = classify({ status: 401, body: { message: "Unauthenticated." } });
  assert.equal(un.state, "unknown"); assert.equal(un.httpStatus, 401); assert.match(un.label, /HTTP 401/);
  const e5 = classify({ status: 502, text: "<html>bad gateway</html>" });
  assert.equal(e5.state, "unknown"); assert.match(e5.label, /HTTP 502/);
  assert.equal(classify({ status: 200, body: null, text: "<html>" }).state, "unknown");
  assert.match(classify({ error: "no_token" }).label, /LEAJLAK_TOKEN/);
});

/* ═══ السؤال نفسه: GET /shops بس ═══ */
test("probe: GET على /shops بالتوكن — ومفيش توكن ⇒ مفيش نداء خالص", async () => {
  const f = fakeFetch([OK]);
  const r = await probe({ fetchImpl: f, base: "https://app.leajlak.com/api/partner", token: "x" });
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls, [{ url: "https://app.leajlak.com/api/partner/shops", method: "GET", auth: true }]);
  const g = fakeFetch([OK]);
  assert.deepEqual(await probe({ fetchImpl: g, token: "" }), { error: "no_token" });
  assert.equal(g.calls.length, 0);
  const n = await probe({ fetchImpl: fakeFetch([NETERR]), token: "x" });
  assert.equal(n.error, "fetch failed");
});
test("probe: لاجلك مارديتش ⇒ timeout (مايعلّقش)", async () => {
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const r = await probe({ fetchImpl: hang, token: "x", timeoutMs: 20 });
  assert.equal(r.error, "timeout");
});
test("الملف كله مافيهوش POST/PUT/DELETE/PATCH ناحية لاجلك (الطريقة الوحيدة GET)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./ljwatch.js", import.meta.url), "utf8");
  const methods = [...src.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)], ["GET"]);
  assert.doesNotMatch(src, /UPDATE settings|jsonb_set\([^)]*'\{shop|autoDispatch\s*[:=]\s*true/);
});

/* ═══ الانتقال (صافي) ═══ */
test("nextState: since بيتغيّر مع تغيّر الحالة بس، وunknown مابيلمسش آخر حالة معروفة", () => {
  const t = Date.parse("2026-10-16T17:00:00Z");
  const a = nextState({ ...SEED }, classify({ status: 401, body: SUSP }), t).next;
  assert.equal(a.state, "suspended"); assert.equal(a.since, new Date(t).toISOString());
  const b = nextState(a, classify({ status: 401, body: SUSP }), t + 600_000).next;
  assert.equal(b.since, a.since, "نفس الحالة ⇒ since ثابت");
  assert.equal(b.lastCheck, new Date(t + 600_000).toISOString());
  assert.equal(b.log.length, 0, "مفيش تغيير ⇒ مفيش سطر سجل");
  const c = nextState(b, classify({ error: "fetch failed" }), t + 1_200_000);
  assert.equal(c.next.state, "unknown"); assert.equal(c.next.lastKnown, "suspended"); assert.equal(c.alert, false);
  assert.equal(c.next.log[0].from, "suspended"); assert.equal(c.next.log[0].to, "unknown");
  const d = nextState(c.next, classify({ status: 200, body: {} }), t + 1_800_000);
  assert.equal(d.reopened, true); assert.equal(d.alert, true, "موقوف ⇒ خطأ شبكة ⇒ شغّال = رجع");
});
test("nextState: «رجع» تاني جوّه ٦ ساعات ⇒ مفيش تنبيه (cooldown)", () => {
  const t = Date.parse("2026-10-16T17:00:00Z");
  const prev = { state: "suspended", lastKnown: "suspended", lastAlertAt: new Date(t - 3600_000).toISOString() };
  const r = nextState(prev, classify({ status: 200, body: {} }), t);
  assert.equal(r.reopened, true); assert.equal(r.coolingDown, true); assert.equal(r.alert, false);
  const r2 = nextState(prev, classify({ status: 200, body: {} }), t - 3600_000 + REOPEN_COOLDOWN_MS + 1);
  assert.equal(r2.alert, true);
});

/* ═══ النصوص ═══ */
test("SMS عربي ورسالة واحدة (≤ ٧٠ حرف UCS-2) + الطلب الآلي", () => {
  const t = Date.parse("2026-10-16T16:40:00Z");
  const s = smsText(t, false);
  assert.match(s, /لاجلك رجع شغال 19:40/); assert.match(s, /لسه مقفول/);
  assert.equal(smsInfo(s).segments, 1); assert.equal(smsInfo(smsText(t, true)).segments, 1);
  assert.equal(riyadhHM(Date.parse("2026-10-16T21:05:00Z")), "00:05");
  assert.match(waText(t, { knownSince: "2026-10-16T16:00:00Z" }, false), /كان موقوف من 16\/10 19:00/);
});

/* ═══ التشغيل كامل: الزرع ⇒ موقوف ⇒ رجع ⇒ مفيش عاصفة ═══ */
test("الدورة: موقوف (مفيش تنبيه) ⇒ شغّال (SMS واحدة للمالك + واتساب حر) ⇒ شغّال تاني (مفيش حاجة)", async () => {
  const { api, fetch, sms, waSent, pool, later, logs } = setup({ script: [SUSPENDED, OK, OK, OK] });
  let r = await api.check();
  assert.equal(r.state, "suspended"); assert.equal(r.alerted, false); assert.equal(sms.length, 0);
  assert.equal(pool.row.data.lastKnown, "suspended");
  later(10);
  r = await api.check();
  assert.equal(r.state, "up"); assert.equal(r.alerted, true); assert.equal(r.changed, true);
  assert.equal(sms.length, 1, "رقم واحد = المالك اللي في دليل الفريق وفي أرقام الإنذارات");
  assert.equal(sms[0].phoneNorm, "551115082"); assert.equal(sms[0].kind, "staff");
  assert.match(sms[0].body, /لاجلك رجع شغال/);
  assert.equal(waSent.length, 1); assert.equal(waSent[0].payload.type, "text", "رسالة حرة بس — مفيش قالب");
  assert.equal(pool.row.data.lastAlert.sms, 1);
  assert.deepEqual(pool.row.data.lastAlert.waSkipped, ["window_closed"], "النافذة مقفولة ⇒ الواتساب ماطلعش");
  assert.ok(logs.some((l) => /موقوف من لاجلك ⇒ شغّال/.test(l)), "التغيير اتسجّل في اللوج");
  for (let k = 0; k < 2; k++) { later(10); r = await api.check(); assert.equal(r.alerted, false); }
  assert.equal(sms.length, 1, "مفيش عاصفة");
  assert.ok(fetch.calls.every((c) => c.method === "GET" && /\/shops$/.test(c.url)));
  assert.equal(fetch.calls.length, 4);
  assert.ok(!pool.sqls.some((s) => /settings/i.test(s)), "مفيش ولا استعلام على settings — الطلب الآلي مايتلمسش");
});
test("الرقص: موقوف ⇒ شغّال ⇒ موقوف ⇒ شغّال جوّه ساعة ⇒ تنبيه واحد بس", async () => {
  const { api, sms } = setup({ script: [SUSPENDED, OK, SUSPENDED, OK, SUSPENDED, OK] });
  for (let k = 0; k < 6; k++) await api.check();
  assert.equal(sms.length, 1);
});
test("خطأ شبكة في النص: موقوف ⇒ شبكة ⇒ شغّال ⇒ تنبيه واحد؛ والشبكة لوحدها مابتنبّهش", async () => {
  const { api, sms, pool, later } = setup({ script: [SUSPENDED, NETERR, NETERR, OK] });
  await api.check(); later(10);
  let r = await api.check();
  assert.equal(r.state, "unknown"); assert.equal(pool.row.data.label, "مش عارفين (خطأ شبكة)"); assert.equal(pool.row.data.httpStatus, null);
  later(10); await api.check();
  assert.equal(sms.length, 0);
  later(10); r = await api.check();
  assert.equal(r.alerted, true); assert.equal(sms.length, 1);
});
test("أول فحص بعد النشر لقاه شغّال (الزرع = موقوف) ⇒ تنبيه «رجع» واحد", async () => {
  const { api, sms } = setup({ script: [OK, OK] });
  await api.check(); await api.check();
  assert.equal(sms.length, 1);
});
test("المراقبة مقفولة ⇒ مفيش نداء للاجلك خالص؛ وفحص يدوي وهي مقفولة مابيبعتش تنبيه", async () => {
  const { api, fetch, sms } = setup({ script: [OK], settings: SETTINGS({ delivery: { ljWatch: { enabled: false } } }) });
  const r = await api.check();
  assert.equal(r.skipped, "disabled"); assert.equal(fetch.calls.length, 0);
  const m = await api.check({ reason: "manual", force: true });
  assert.equal(m.state, "up"); assert.equal(m.alerted, false); assert.equal(sms.length, 0);
});
test("الإرسال وقع لكل الأرقام ⇒ إعادة مع الفحص الجاي، ٣ محاولات بالكتير", async () => {
  const { api, sms, pool } = setup({ script: [OK], smsFail: true, waResult: { ok: false, skipped: "window_closed" } });
  for (let k = 0; k < 6; k++) await api.check();
  assert.equal(sms.length, MAX_ALERT_ATTEMPTS, "٣ محاولات وبس");
  assert.equal(pool.row.data.alertPending, MAX_ALERT_ATTEMPTS);
});
test("مفيش أرقام ⇒ مفيش إرسال ولا إعادة، والسبب متسجّل", async () => {
  const { api, sms, pool } = setup({ script: [OK], settings: { shop: { autoDispatch: false }, delivery: {} } });
  await api.check(); await api.check();
  assert.equal(sms.length, 0); assert.equal(pool.row.data.lastAlert.skipped, "no_phones");
});
test("حاويتين وقت النشر: الحجز بـver ⇒ واحدة بس اللي بتبعت", async () => {
  const pool = fakePool();
  const a = setup({ script: [OK], pool });
  const b = setup({ script: [OK], pool });
  await a.api.readState();
  /* الاتنين قروا نفس النسخة قبل ما حد يكتب */
  const [ra, rb] = await Promise.all([a.api.check(), b.api.check()]);
  assert.equal(a.sms.length + b.sms.length, 1);
  assert.ok([ra.skipped, rb.skipped].includes("claimed_elsewhere"));
});
test("الداتابيز واقعة وقت التشغيل ⇒ مفيش crash: register مابيرميش، check بيرجّع ok:false، والمسار 200", async () => {
  const { api, app } = setup({ script: [OK], pool: fakePool({ failAll: true }) });
  const r = await api.check();
  assert.equal(r.ok, false);
  const res = await app.routes["GET /api/delivery/leajlak/account"]({ json: (p, s = 200) => ({ p, s }) });
  assert.equal(res.s, 200); assert.equal(res.p.ok, false);
});
test("المسارات: الحالة + الكارت؛ «افحص دلوقتي» مرة كل ٣٠ ثانية", async () => {
  const { app, later, fetch } = setup({ script: [SUSPENDED, OK] });
  const c = { json: (p, s = 200) => ({ p, s }) };
  let r = await app.routes["POST /api/delivery/leajlak/account/check"](c);
  assert.equal(r.p.state.state, "suspended"); assert.equal(r.p.health.status, "bad");
  r = await app.routes["POST /api/delivery/leajlak/account/check"](c);
  assert.equal(r.p.error, "too_soon"); assert.equal(fetch.calls.length, 1);
  later(1);
  r = await app.routes["GET /api/delivery/leajlak/account"](c);
  assert.equal(r.p.ok, true); assert.equal(r.p.recipients.phones[0], "***5082"); assert.equal(r.p.autoDispatch, false);
  assert.match(r.p.health.line, /موقوف من لاجلك/);
});

/* ═══ الكارت + الإعدادات ═══ */
test("ljHealthOf: موقوف=أحمر، شغّال=أخضر، مش عارفين=أصفر، مقفول/مافيش فحص=رمادي، متأخر=أصفر", () => {
  const t = Date.parse("2026-10-16T17:00:00Z");
  const iso = (m) => new Date(t - m * 60_000).toISOString();
  const v = (state, extra = {}) => ({ cfg: { enabled: true, everyMin: 10 }, autoDispatch: false, state: { state, since: iso(30), lastCheck: iso(2), httpStatus: state === "up" ? 200 : 401, lastKnown: state === "unknown" ? "suspended" : state, label: state === "unknown" ? "مش عارفين (خطأ شبكة)" : null, ...extra } });
  assert.equal(ljHealthOf(v("suspended"), t).status, "bad");
  assert.match(ljHealthOf(v("suspended"), t).fix, /مندوب خارجي/);
  assert.equal(ljHealthOf(v("up"), t).status, "good");
  assert.match(ljHealthOf(v("up"), t).fix, /قرارك/);
  assert.equal(ljHealthOf(v("unknown"), t).status, "warn");
  assert.equal(ljHealthOf(v("up", { lastCheck: iso(60) }), t).status, "warn");
  assert.equal(ljHealthOf({ cfg: { enabled: false, everyMin: 10 }, state: {} }, t).status, "unknown");
  assert.equal(ljHealthOf({ cfg: { enabled: true, everyMin: 10 }, state: { lastKnown: "suspended" } }, t).status, "unknown");
  assert.match(controlLine(v("suspended"), t), /^🔴 الحالة دلوقتي: موقوف من لاجلك/);
});
test("ljWatchCfg: الافتراضي شغّال كل ١٠ د، والمدى ٥–١٢٠", () => {
  assert.deepEqual(ljWatchCfg({}), { enabled: true, everyMin: 10 });
  assert.deepEqual(ljWatchCfg({ delivery: { ljWatch: { enabled: false, everyMin: 2 } } }), { enabled: false, everyMin: 5 });
  assert.equal(ljWatchCfg({ delivery: { ljWatch: { everyMin: 999 } } }).everyMin, 120);
  assert.equal(ljWatchCfg({ delivery: { ljWatch: { everyMin: "x" } } }).everyMin, 10);
});
test("«التوصيل والمندوبين»: حقلين المراقبة في المواصفة + سطر الحالة فوق المفتاح + leajlakAccount", async () => {
  const dc = await import("./deliverycontrol.js");
  const paths = dc.ALL_FIELDS.map((f) => f.path);
  assert.ok(paths.includes("delivery.ljWatch.enabled") && paths.includes("delivery.ljWatch.everyMin"));
  assert.equal(dc.effectiveOf("delivery.ljWatch.enabled", {}), true);
  assert.equal(dc.effectiveOf("delivery.ljWatch.everyMin", {}), 10);
  assert.equal(dc.validatePatch({ "delivery.ljWatch.everyMin": 3 }).ok, false, "أقل من ٥ مرفوض");
  assert.equal(dc.validatePatch({ "delivery.ljWatch.everyMin": 15, "delivery.ljWatch.enabled": false }).ok, true);
  const routes = {};
  const app = { get: (p, h) => { routes[`GET ${p}`] = h; }, put: (p, h) => { routes[`PUT ${p}`] = h; } };
  const view = { cfg: { enabled: true, everyMin: 10 }, autoDispatch: false, state: { state: "suspended", since: new Date().toISOString(), lastCheck: new Date().toISOString(), httpStatus: 401, lastKnown: "suspended" } };
  dc.register(app, { pool: { query: async () => ({ rows: [] }) }, getSettingsData: async () => ({}), requireAdmin: async () => null }, { ljWatch: () => ({ view: async () => view }) });
  const r = await routes["GET /api/delivery/control"]({ json: (payload, status = 200) => ({ payload, status }) });
  assert.equal(r.payload.leajlakAccount.state.state, "suspended");
  const f = r.payload.fields.find((x) => x.path === "delivery.ljWatch.enabled");
  assert.match(f.hint, /^🔴 الحالة دلوقتي: موقوف من لاجلك/);
  /* المراقب مش متسجّل/وقع ⇒ الشاشة شغّالة عادي */
  const routes2 = {};
  dc.register({ get: (p, h) => { routes2[`GET ${p}`] = h; }, put() {} }, { pool: { query: async () => ({ rows: [] }) }, getSettingsData: async () => ({}), requireAdmin: async () => null },
    { ljWatch: () => ({ view: async () => { throw new Error("boom"); } }) });
  const r2 = await routes2["GET /api/delivery/control"]({ json: (payload, status = 200) => ({ payload, status }) });
  assert.equal(r2.payload.ok, true); assert.equal(r2.payload.leajlakAccount, null);
});
test("بوابة رسايل الإدارة: «lj-watch reopened» نوع خاص lj_watch (مش «other») ويتقفل من اللوحة لو المالك عايز", async () => {
  const sc = await import("./staffcontrol.js");
  assert.deepEqual(sc.typeOfRef("lj-watch reopened"), { type: "lj_watch", code: null });
  assert.ok(sc.ALERT_TYPES.some((t) => t.id === "lj_watch"));
  assert.equal(sc.allowStaff({}, "lj-watch reopened", "551115082"), true);
  assert.equal(sc.allowStaff({ staffAlerts: { types: { lj_watch: { enabled: false } } } }, "lj-watch reopened", "551115082"), false);
});
