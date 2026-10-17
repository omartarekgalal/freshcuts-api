/* node --test portalservice.test.mjs — PS1: «الخدمة» في بوابة المدير (شركة التوصيل / الإرسال الآلي / المهلة / تسليم المندوب / حساب لاجلك) */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { serviceView, managerPatch, managerAuditLine, register, MANAGER_FIELDS, HANDOFF_PATH } from "./portalservice.js";

const noEnv = () => "";
const SETTINGS = { delivery: { provider: "leajlak", dispatchMode: "auto", dispatchDelayMin: 1, autoDispatchReason: "لاجلك موقوفة", autoDispatchBy: "أبو فهد" }, shop: { autoDispatch: false }, waBot: { courierJob: { enabled: true } } };

test("serviceView: الفعّال من نفس دوال الإعداد + الخيارات بالعربي + الأزرار + سبب الإيقاف", () => {
  const v = serviceView(SETTINGS, { env: noEnv, canEdit: true });
  assert.equal(v.canEdit, true);
  assert.equal(v.provider.effective, "leajlak"); assert.equal(v.provider.label, "لأجلك");
  assert.deepEqual(v.provider.options.map((o) => o.v), ["leajlak", "cervo", "flyingarrow"]);
  assert.equal(v.provider.source.kind, "settings");
  assert.equal(v.dispatchMode.effective, "auto"); assert.equal(v.dispatchMode.lock, null);
  assert.equal(v.autoDispatch.effective, false); assert.equal(v.autoDispatch.reason, "لاجلك موقوفة"); assert.equal(v.autoDispatch.changedBy, "أبو فهد");
  assert.equal(v.prepDelay.base, 1); assert.equal(v.prepDelay.temp, null);
  assert.equal(v.handoff.mode, "buttons"); assert.equal(v.handoff.buttons, true);
  assert.equal(v.leajlak, null);
  assert.deepEqual(v.notes, []);
});

test("serviceView: الافتراضيات + قفل البيئة اليدوي بيظهر في notes وفي dispatchMode.lock", () => {
  const env = (k) => (k === "DELIVERY_FORCE_MANUAL" ? "1" : "");
  const v = serviceView({}, { env, canEdit: false });
  assert.equal(v.provider.effective, "flyingarrow"); assert.equal(v.provider.source.kind, "default");
  assert.equal(v.autoDispatch.effective, true);
  assert.equal(v.prepDelay.base, 15);
  assert.equal(v.handoff.mode, "buttons");          // الافتراضي شغّال (CW1a)
  assert.equal(v.dispatchMode.effective, "manual"); assert.equal(v.dispatchMode.lock.forced, true);
  assert.match(v.notes[0], /DELIVERY_FORCE_MANUAL/);
  const v2 = serviceView({ delivery: { dispatchMode: "manual" } }, { env: noEnv });
  assert.match(v2.notes[0], /يدوي» من اللوحة/);
});

test("serviceView: حالة لاجلك من مراقب LJ2a", () => {
  const lj = { cfg: { enabled: true, everyMin: 10 }, state: { state: "suspended", label: "موقوف من لاجلك", since: "2026-10-16T17:46:00Z", lastCheck: "2026-10-16T18:00:00Z", httpStatus: 401 }, health: { status: "bad", line: "🔴 موقوف", fix: "استعمل المندوب الخارجي" } };
  const v = serviceView(SETTINGS, { env: noEnv, lj });
  assert.equal(v.leajlak.state, "suspended"); assert.equal(v.leajlak.httpStatus, 401); assert.equal(v.leajlak.line, "🔴 موقوف"); assert.equal(v.leajlak.everyMin, 10);
});

test("managerPatch: الحقول الخمسة بس، بنفس تحقق deliverycontrol", () => {
  assert.deepEqual(Object.keys(MANAGER_FIELDS), ["provider", "autoDispatch", "dispatchDelayMin"]);
  let p = managerPatch({ patch: { provider: "cervo", autoDispatch: false, dispatchDelayMin: 10, handoffButtons: false } });
  assert.equal(p.ok, true);
  assert.deepEqual(p.values, { "delivery.provider": "cervo", "shop.autoDispatch": false, "delivery.dispatchDelayMin": 10 });
  assert.deepEqual(p.extra, { [HANDOFF_PATH]: false });
  p = managerPatch({ provider: "jahez" });
  assert.equal(p.ok, false); assert.match(p.errors[0].error, /الخيارات المسموحة/);
  p = managerPatch({ dispatchDelayMin: 120 });
  assert.equal(p.ok, false); assert.match(p.errors[0].error, /أكبر قيمة 90/);
  p = managerPatch({ "delivery.alertPhones": ["0501234567"] });
  assert.equal(p.ok, false); assert.match(p.errors[0].error, /مش من صلاحيات المدير/);
  p = managerPatch({ handoffButtons: "yes" });
  assert.equal(p.ok, false);
  p = managerPatch({});
  assert.equal(p.ok, false); assert.match(p.errors[0].error, /مفيش أي حقل/);
});

test("managerAuditLine: مين غيّر إيه من إيه لإيه + الأزرار + السبب", () => {
  const line = managerAuditLine({ values: { "shop.autoDispatch": false }, extra: { [HANDOFF_PATH]: false }, settings: { shop: { autoDispatch: true }, waBot: { courierJob: { enabled: true } } }, reason: "لاجلك واقفة", who: "أبو فهد" });
  assert.match(line, /^🛵 الخدمة \(بوابة المدير · أبو فهد\)/);
  assert.match(line, /⚠️ طلب مندوب تلقائي للطلبات الأونلاين: شغّال → مقفول/);
  assert.match(line, /تسليم المندوب الخارجي: أزرار واتساب → رابط بس/);
  assert.match(line, /السبب: لاجلك واقفة$/);
});

/* ── المسارات: Hono حقيقي + بوابة وهمية + قاعدة وهمية ─────────────────────── */
function build({ settings = SETTINGS, role = "manager", lj = null } = {}) {
  const db = { settings: JSON.parse(JSON.stringify(settings)), writes: [], cmsAudit: [], portalAudit: [], tx: [] };
  const setAt = (obj, path, v) => { const ks = path.split("."); let cur = obj; for (const k of ks.slice(0, -1)) { if (!cur[k] || typeof cur[k] !== "object") cur[k] = {}; cur = cur[k]; } cur[ks.at(-1)] = v; };
  const client = {
    query: async (sql, vals = []) => {
      const s = String(sql); db.tx.push(s);
      if (/jsonb_set|UPDATE settings/i.test(s)) { db.writes.push({ sql: s, vals }); return { rows: [], rowCount: 1 }; }
      return { rows: [{ data: db.settings }], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    query: async (sql, vals = []) => {
      const s = String(sql);
      if (/INSERT INTO cms_audit/.test(s)) { db.cmsAudit.push(vals); return { rows: [], rowCount: 1 }; }
      if (/INSERT INTO portal_audit/.test(s)) { db.portalAudit.push(vals); return { rows: [], rowCount: 1 }; }
      return { rows: [{ data: db.settings }], rowCount: 1 };
    },
  };
  const user = role === "none" ? null : { id: "s1", name: role === "manager" ? "أبو فهد" : "منى", role };
  const portal = {
    requirePortal: async (c, need) => {
      if (!user) return { res: c.json({ ok: false, error: "unauthorized" }, 401) };
      if (need === "manager" && user.role !== "manager") return { res: c.json({ ok: false, error: "forbidden", message: "الإجراء ده للمدير بس" }, 403) };
      return { user };
    },
    audit: (u, action, orderNo, ok, detail) => db.portalAudit.push({ name: u.name, action, detail }),
  };
  const app = new Hono();
  register(app, { pool, getSettingsData: async () => db.settings, log: { error() {}, log() {} } }, { portal: () => portal, ljWatch: () => lj });
  const call = (method, path, body) => app.request(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { app, db, call, setAt };
}

test("GET: الكاشير يقرا (canEdit=false)، المدير canEdit=true، ومن غير جلسة 401", async () => {
  let { call } = build({ role: "cashier" });
  let r = await call("GET", "/api/portal/delivery-service"); let j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.ok, true); assert.equal(j.canEdit, false); assert.equal(j.provider.label, "لأجلك");
  ({ call } = build({ role: "manager" }));
  j = await (await call("GET", "/api/portal/delivery-service")).json();
  assert.equal(j.canEdit, true);
  ({ call } = build({ role: "none" }));
  assert.equal((await call("GET", "/api/portal/delivery-service")).status, 401);
});

test("PUT: الكاشير 403؛ المدير: حقل غلط 400، خطير من غير confirm 409، إيقاف من غير سبب 400", async () => {
  let { call } = build({ role: "cashier" });
  assert.equal((await call("PUT", "/api/portal/delivery-service", { patch: { dispatchDelayMin: 5 } })).status, 403);
  ({ call } = build({ role: "manager", settings: { ...SETTINGS, shop: { autoDispatch: true } } }));
  let r = await call("PUT", "/api/portal/delivery-service", { patch: { provider: "jahez" } });
  assert.equal(r.status, 400); assert.match((await r.json()).message, /الخيارات المسموحة/);
  r = await call("PUT", "/api/portal/delivery-service", { patch: { provider: "cervo" } });
  assert.equal(r.status, 409); let j = await r.json(); assert.equal(j.error, "confirm_required"); assert.equal(j.needConfirm[0].path, "delivery.provider");
  r = await call("PUT", "/api/portal/delivery-service", { patch: { autoDispatch: false }, confirm: true });
  assert.equal(r.status, 400); assert.equal((await r.json()).error, "reason_required");
});

test("PUT: المدير بيغيّر — الكتابة بـjsonb_set على المسارات بس، السبب والاسم بيتسجّلوا، وسطر في cms_audit وportal_audit", async () => {
  const { call, db } = build({ role: "manager", settings: { ...SETTINGS, shop: { autoDispatch: true } } });
  const r = await call("PUT", "/api/portal/delivery-service", { patch: { autoDispatch: false, dispatchDelayMin: 10, handoffButtons: false }, confirm: true, reason: "لاجلك واقفة النهارده" });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.ok, true);
  assert.deepEqual(j.changed, ["shop.autoDispatch", "delivery.dispatchDelayMin", HANDOFF_PATH, "delivery.autoDispatchReason", "delivery.autoDispatchBy", "delivery.autoDispatchAt"]);
  assert.match(j.note, /أبو فهد/); assert.match(j.note, /⚠️ طلب مندوب تلقائي/); assert.match(j.note, /السبب: لاجلك واقفة النهارده/);
  // كتابة موجّهة (settings-guard.applyPathChanges): FOR UPDATE + jsonb_set لكل مسار، من غير UPDATE settings SET data = $1 كامل
  assert.ok(db.tx.some((s) => /FOR UPDATE/.test(s)));
  assert.equal(db.writes.length, 6);
  assert.ok(db.writes.every((w) => /jsonb_set/i.test(w.sql)));
  assert.ok(!db.writes.some((w) => /SET data\s*=\s*\$1\s*WHERE/i.test(w.sql)));
  // السجلّين
  assert.equal(db.cmsAudit.length, 1);
  assert.equal(db.cmsAudit[0][1], "أبو فهد"); assert.equal(db.cmsAudit[0][2], "portal:manager"); assert.equal(db.cmsAudit[0][5], "delivery"); assert.match(db.cmsAudit[0][6], /السبب/);
  const pa = db.portalAudit.find((x) => x.action === "delivery_service_change");
  assert.equal(pa.name, "أبو فهد"); assert.equal(pa.detail.reason, "لاجلك واقفة النهارده"); assert.deepEqual(pa.detail.danger, ["shop.autoDispatch"]);
});

test("PUT: تبديل الشركة بتأكيد بيكتب delivery.provider بس (المهلة المؤقتة ومفاتيح تانية مابتتلمسش)", async () => {
  const { call, db } = build({ role: "manager" });
  const r = await call("PUT", "/api/portal/delivery-service", { patch: { provider: "flyingarrow" }, confirm: true });
  assert.equal(r.status, 200);
  assert.equal(db.writes.length, 1);
  assert.deepEqual(db.writes[0].vals.slice(0, 1).map(String).length, 1);
  assert.ok(!db.writes.some((w) => /dispatchDelayTemp|courierSla|alertPhones/.test(JSON.stringify(w))));
});

test("leajlak-check: المدير بس، مرة كل ٣٠ ثانية، ومن غير مراقب 503", async () => {
  let checks = 0;
  const lj = { view: async () => ({ ok: true, cfg: { enabled: true, everyMin: 10 }, state: { state: "up", label: "شغّال", since: "2026-10-16T18:16:00Z", lastCheck: new Date().toISOString(), httpStatus: 200 } }), check: async ({ reason, force }) => { checks++; assert.equal(force, true); assert.match(reason, /^portal:/); return { ok: true, state: "up" }; } };
  let { call, db } = build({ role: "manager", lj });
  let r = await call("POST", "/api/portal/delivery-service/leajlak-check");
  let j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(checks, 1); assert.equal(j.leajlak.state, "up"); assert.equal(j.leajlak.label, "شغّال");
  assert.ok(db.portalAudit.some((x) => x.action === "leajlak_check"));
  r = await call("POST", "/api/portal/delivery-service/leajlak-check");
  assert.equal(r.status, 429); assert.equal(checks, 1);
  ({ call } = build({ role: "cashier", lj }));
  assert.equal((await call("POST", "/api/portal/delivery-service/leajlak-check")).status, 403);
  // GET بيرجّع حالة لاجلك كمان
  ({ call } = build({ role: "cashier", lj }));
  j = await (await call("GET", "/api/portal/delivery-service")).json();
  assert.equal(j.leajlak.state, "up"); assert.ok(j.leajlak.line);
});
