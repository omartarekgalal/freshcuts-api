/* ═══════════════════════════════════════════════════════════════════════════
   🛡 حماية صف الإعدادات — المرحلة ٠ (٢٩/٩)
     ١) PUT الكامل من نسخة قديمة مابيرجّعش تعديلات السيرفر (خلص/مهلة/فرملة…)
     ٢) rev: مطابق ⇒ يتحفظ، قديم ⇒ 409 ومفيش كتابة، من غير rev ⇒ زي الأول
     ٣) GET لغير المالك من غير أسرار، وGET متقصقص + PUT كامل مابيمسحش سر
     ٤) POST /api/settings/patch: allowlist + مالك بس + jsonb_set + سجل

     node --test settings-guard.test.mjs
═══════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  register, mergeForPut, settingsRev, redactForViewer, validatePatch, deepSetStatement, setAt, getAt,
} from "./settings-guard.js";

const clone = (v) => JSON.parse(JSON.stringify(v));

/* داتابيز مزيّفة لصف واحد: بتفهم SELECT/UPDATE الكامل وjsonb_set الموجّه
   (آخر بارامترين = مسار الورقة والقيمة، والآباء الناقصين بيبقوا {}). */
function fakePool(initial) {
  const db = { data: clone(initial), writes: [], sql: [] };
  const query = async (sql, p = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    db.sql.push(s);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s)) return { rows: [] };
    if (/^SELECT data FROM settings WHERE id=1/.test(s)) return { rows: [{ data: clone(db.data) }] };
    if (/^UPDATE settings SET data=\$1::jsonb/.test(s)) { db.data = JSON.parse(p[0]); db.writes.push("full"); return { rowCount: 1, rows: [] }; }
    if (/^UPDATE settings SET data = jsonb_set/.test(s)) {
      setAt(db.data, p.at(-2), JSON.parse(p.at(-1)));
      db.writes.push(p.at(-2).join("."));
      return { rowCount: 1, rows: [] };
    }
    throw new Error("unexpected sql: " + s);
  };
  return { db, query, connect: async () => ({ query, release() {} }) };
}

/* توكنات الاختبار: admin = المالك، cmsops = مستخدم فريق مش مالك وعنده
   صلاحية الكتابة، amb = سفير (قراية بس). */
function makeApp(initial) {
  const pool = fakePool(initial);
  const notes = [];
  const tok = (c) => (c.req.header("Authorization") || "").replace(/^Bearer /, "");
  const app = new Hono();
  register(app, {
    pool,
    isOwner: (c) => tok(c) === "admin",
    requireAdmin: async (c) => (["admin", "cmsops"].includes(tok(c)) ? null : c.json({ error: "Unauthorized" }, 401)),
    requireAmbassadorOrAdmin: async (c) => (["admin", "amb"].includes(tok(c)) ? null : c.json({ error: "Unauthorized" }, 401)),
    auditNote: async (_c, s) => { notes.push(s); },
  });
  const call = async (method, path, token, body) => {
    const r = await app.request(path, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { pool, db: pool.db, notes, call };
}

/* صف شبه الحقيقي: مفاتيح الشاشات + مفاتيح السيرفر + الأسرار. */
const LIVE = () => ({
  storefront: { texts: { title: "فريش كاتس" } },
  hours: { enabled: true },
  cashierPin: "4321",
  shop: { posPaymentMethod: "Order", checkout2Default: true, modifiers: { a: 1 } },
  catalog: { hiddenIds: ["98"], dineInIds: ["121"], soldOut: {}, pausedOffers: {} },
  delivery: { provider: "leajlak", alertPhones: ["0500000001"], courierRouting: { enabled: false } },
  cms: { dailyTarget: 200, campaigns: { smsEnabled: false } },
  staffAlerts: { mute: [] },
  googlePlace: { rating: 4.8 },
  webPushKeys: { publicKey: "PUB", privateKey: "PRIV-SECRET" },
  portal: { staff: [{ id: "s1", name: "كاشير", role: "cashier", pinHash: "s1$abc" }] },
  waSender: { enabled: true, agentHash: "HASH-SECRET" },
  seoStatus: { at: "2026-09-28" },
  jobs: { "fc-adsentry": { enabled: true, label: "حارس الإعلانات" }, morningBudgets: { enabled: true, until: "2026-09-30", budgets: [] } },
  adsGuard: { floor: 500, ratio: 0.15, hardCap: 3000, keepBest: 3, smsPhones: ["966500000000"], spendExclude: { "2026-09-27": 1130 } },
});

/* اللي بيعمله البورتال والسيرفر وقت ما الشاشة مفتوحة (كتّاب jsonb_set). */
function serverWritesMeanwhile(db) {
  setAt(db.data, "catalog.soldOut.108", { at: "t", by: "كاشير" });
  setAt(db.data, "catalog.pausedOffers.box", { at: "t" });
  setAt(db.data, "catalog.hiddenIds", ["98", "77"]);
  setAt(db.data, "delivery.dispatchDelayTemp", { min: 30, until: "t" });
  setAt(db.data, "delivery.cervoTrial", { enabled: true });
  setAt(db.data, "cms.campaigns.brake", { on: true, reason: "opt-out 5%" });
  setAt(db.data, "staffAlerts.mute", ["courier"]);
  setAt(db.data, "googlePlace.rating", 4.9);
  setAt(db.data, "tsDiscountSync", { lastRefreshAt: "t" });
  setAt(db.data, "seoStatus.at", "2026-09-29");
  setAt(db.data, "waSender.agentHash", "HASH-NEW");
  setAt(db.data, "jobs.fc-pacer", { enabled: false });
  setAt(db.data, "adsGuard.spendExclude.2026-09-29", 200);
  setAt(db.data, "portal.staff", [...db.data.portal.staff, { id: "s2", name: "مدير", role: "manager", pinHash: "s1$def" }]);
}

test("١) PUT كامل من نسخة قديمة (من غير rev): مفاتيح السيرفر بتفضل، وتعديل الشاشة بيتحفظ", async () => {
  const { db, call } = makeApp(LIVE());
  const stale = (await call("GET", "/api/settings", "admin")).body; // الشاشة فتحت
  serverWritesMeanwhile(db);                                          // البورتال/السيرفر كتبوا
  const before = clone(db.data);
  stale.storefront.texts.title = "عنوان جديد";                        // الشاشة عدّلت
  stale.cashierPin = "9999";
  const r = await call("PUT", "/api/settings", "admin", stale);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(db.data.storefront.texts.title, "عنوان جديد");
  assert.equal(db.data.cashierPin, "9999");
  for (const p of ["catalog.soldOut", "catalog.pausedOffers", "catalog.hiddenIds", "delivery.dispatchDelayTemp",
    "delivery.cervoTrial", "cms.campaigns.brake", "staffAlerts", "googlePlace", "webPushKeys", "portal.staff",
    "tsDiscountSync", "seoStatus", "waSender.agentHash", "jobs", "adsGuard.spendExclude"]) {
    assert.deepEqual(getAt(db.data, p), getAt(before, p), `${p} رجع زي ما كان`);
  }
  assert.ok(db.sql.some((s) => /FOR UPDATE/.test(s)), "القراية والكتابة جوّه transaction والصف متقفل");
});

test("١) مفتاح سيرفر اتمسح من السيرفر (فتح صنف خلصان) مايرجعش من النسخة القديمة", async () => {
  const init = LIVE();
  init.catalog.soldOut = { 108: { at: "t" } };
  const { db, call } = makeApp(init);
  const stale = (await call("GET", "/api/settings", "admin")).body;
  delete db.data.catalog.soldOut["108"]; // البورتال فتح الصنف
  delete db.data.delivery.dispatchDelayTemp;
  await call("PUT", "/api/settings", "admin", stale);
  assert.deepEqual(db.data.catalog.soldOut, {});
  assert.equal("dispatchDelayTemp" in db.data.delivery, false);
});

test("٢) rev: مطابق ⇒ يتحفظ (والمسار المشترك hiddenIds يتقبل)، قديم ⇒ 409 ومفيش كتابة", async () => {
  const { db, call } = makeApp(LIVE());
  const g = (await call("GET", "/api/settings?withRev=1", "admin")).body;
  assert.ok(g.rev && g.settings && g.owner === true);

  // كتابات السيرفر في مفاتيحه مابتغيّرش الـrev (مفيش 409 على الفاضي)
  setAt(db.data, "catalog.soldOut.5", { at: "t" });
  setAt(db.data, "googlePlace.rating", 5);
  const next = clone(g.settings);
  next.catalog.hiddenIds = ["98", "99"];
  next.hours.enabled = false;
  const ok = await call("PUT", `/api/settings?rev=${g.rev}`, "admin", next);
  assert.equal(ok.status, 200);
  assert.deepEqual(db.data.catalog.hiddenIds, ["98", "99"], "rev مطابق ⇒ الشاشة تملك hiddenIds");
  assert.equal(db.data.hours.enabled, false);
  assert.ok(db.data.catalog.soldOut["5"], "خلص اتكتب بعد الفتح فضل");
  assert.equal(ok.body.rev, settingsRev(db.data), "الرد بيرجّع الـrev الجديد");

  // نفس الـrev القديم تاني (حد تاني حفظ في النص) ⇒ 409
  const writes = db.writes.length;
  const stale = await call("PUT", `/api/settings?rev=${g.rev}`, "admin", { ...next, hours: { enabled: true } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "stale");
  assert.equal(stale.body.rev, ok.body.rev);
  assert.equal(db.writes.length, writes, "مفيش أي كتابة");
  assert.equal(db.data.hours.enabled, false);

  // الـrev في الهيدر كمان
  const viaHeader = await (async () => {
    const r = await call("GET", "/api/settings?withRev=1", "admin");
    return r.body.rev;
  })();
  assert.equal(viaHeader, ok.body.rev);
});

test("٢) من غير rev: hiddenIds بتفضل من الداتابيز (fc-unhide/المنتجات)، وباقي الشاشة بيتحفظ", async () => {
  const { db, call } = makeApp(LIVE());
  const s = (await call("GET", "/api/settings", "admin")).body;
  setAt(db.data, "catalog.hiddenIds", []); // fc-unhide رجّع الأصناف
  s.storefront.texts.title = "x";
  await call("PUT", "/api/settings", "admin", s);
  assert.deepEqual(db.data.catalog.hiddenIds, []);
  assert.equal(db.data.storefront.texts.title, "x");
});

test("٣) GET لغير المالك من غير أسرار ولا أرقام موظفين، والمالك بياخد كله", async () => {
  const { call } = makeApp(LIVE());
  const amb = (await call("GET", "/api/settings", "amb")).body;
  assert.equal(amb.webPushKeys.privateKey, undefined);
  assert.equal(amb.webPushKeys.publicKey, "PUB", "المفتاح العام مش سر");
  assert.equal(amb.portal.staff[0].pinHash, undefined);
  assert.equal(amb.portal.staff[0].name, "كاشير");
  assert.equal(amb.waSender.agentHash, undefined);
  assert.equal(amb.cashierPin, undefined);
  assert.equal(amb.delivery.alertPhones, undefined);
  assert.equal(amb.adsGuard.smsPhones, undefined);
  assert.equal(amb.storefront.texts.title, "فريش كاتس");
  const own = (await call("GET", "/api/settings", "admin")).body;
  assert.equal(own.webPushKeys.privateKey, "PRIV-SECRET");
  assert.equal(own.portal.staff[0].pinHash, "s1$abc");
  assert.equal((await call("GET", "/api/settings", "nobody")).status, 401);
});

test("٣) GET متقصقص وبعده PUT كامل: مفيش سر ولا رقم بيتمسح", async () => {
  const { db, call } = makeApp(LIVE());
  const before = clone(db.data);
  const stripped = (await call("GET", "/api/settings", "amb")).body;
  stripped.storefront.texts.title = "من نسخة متقصقصة";
  const r = await call("PUT", "/api/settings", "cmsops", stripped); // مستخدم فريق مش مالك
  assert.equal(r.status, 200);
  assert.equal(db.data.webPushKeys.privateKey, "PRIV-SECRET");
  assert.equal(db.data.portal.staff[0].pinHash, "s1$abc");
  assert.equal(db.data.waSender.agentHash, "HASH-SECRET");
  assert.equal(db.data.cashierPin, "4321", "cashierPin (مش مفتاح سيرفر) رجع لأنه سر");
  assert.deepEqual(db.data.adsGuard, before.adsGuard);
  assert.equal(db.data.storefront.texts.title, "من نسخة متقصقصة");
  // السفير مايقدرش يكتب أصلاً
  assert.equal((await call("PUT", "/api/settings", "amb", stripped)).status, 401);
});

test("mergeForPut/redactForViewer: وحدات صافية", () => {
  const cur = LIVE();
  const out = mergeForPut(cur, { hours: { enabled: false } });
  assert.deepEqual(out.webPushKeys, cur.webPushKeys);
  assert.deepEqual(out.cms, cur.cms);
  assert.equal(out.hours.enabled, false);
  assert.equal(out.storefront, undefined, "مفاتيح الشاشة اللي مابعتتهاش بتتمسح زي الأول (PUT كامل)");
  const red = redactForViewer(cur);
  assert.equal(JSON.stringify(red).includes("SECRET"), false);
  assert.equal(JSON.stringify(red).includes("0500000001"), false);
  assert.equal(settingsRev(cur), settingsRev({ ...cur, googlePlace: { rating: 1 }, jobs: {} }), "مفاتيح السيرفر برّه الـrev");
  assert.notEqual(settingsRev(cur), settingsRev({ ...cur, hours: { enabled: false } }));
});

test("٤) PATCH: للمالك بس، allowlist، وأرضية الإعلانات والمهام بتتكتب بـjsonb_set", async () => {
  const { db, notes, call } = makeApp(LIVE());
  const body = { changes: [
    { path: "adsGuard.floor", value: 800 },
    { path: "adsGuard.ratio", value: 0.2 },
    { path: "adsGuard.hardCap", value: 2500 },
    { path: "adsGuard.keepBest", value: 2 },
    { path: "jobs.fc-adsentry.enabled", value: false },
    { path: "jobs.morningBudgets.until", value: "2026-10-05" },
    { path: "jobs.morningBudgets.budgets", value: [{ id: "google/24262865184", name: "جوجل سيرش", daily: "180" }] },
  ] };
  assert.equal((await call("POST", "/api/settings/patch", "cmsops", body)).status, 403, "مستخدم فريق مش مالك ⇒ 403");
  assert.equal((await call("POST", "/api/settings/patch", "amb", body)).status, 403);
  assert.equal(db.writes.length, 0);

  const r = await call("POST", "/api/settings/patch", "admin", body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(db.data.adsGuard, { ...LIVE().adsGuard, floor: 800, ratio: 0.2, hardCap: 2500, keepBest: 2 },
    "smsPhones وspendExclude وباقي المفاتيح فضلت");
  assert.equal(db.data.jobs["fc-adsentry"].enabled, false);
  assert.equal(db.data.jobs["fc-adsentry"].label, "حارس الإعلانات");
  assert.equal(db.data.jobs.morningBudgets.until, "2026-10-05");
  assert.deepEqual(db.data.jobs.morningBudgets.budgets, [{ id: "google/24262865184", name: "جوجل سيرش", daily: 180 }]);
  assert.ok(db.writes.every((w) => w !== "full"), "ممنوع PUT كامل");
  assert.equal(db.writes.length, 7, "كتابة لكل مسار");
  assert.match(notes[0], /adsGuard\.floor: 500 → 800/);
  assert.ok(db.sql.includes("BEGIN") && db.sql.includes("COMMIT"));

  // تاريخ فاضي = من غير نهاية
  await call("POST", "/api/settings/patch", "admin", { changes: [{ path: "jobs.morningBudgets.until", value: "" }] });
  assert.equal(db.data.jobs.morningBudgets.until, null);
});

test("٤) PATCH: رفض المسارات والقيم الغلط من غير أي كتابة", async () => {
  const { db, call } = makeApp(LIVE());
  const bad = async (changes) => {
    const r = await call("POST", "/api/settings/patch", "admin", { changes });
    assert.equal(r.status, 400, JSON.stringify(changes));
    return r.body.errors;
  };
  await bad([{ path: "webPushKeys.privateKey", value: "x" }]);
  await bad([{ path: "adsGuard.smsPhones", value: [] }]);
  await bad([{ path: "cashierPin", value: "1" }]);
  await bad([{ path: "adsGuard.ratio", value: 15 }]); // لازم كسر مش نسبة مئوية
  await bad([{ path: "adsGuard.floor", value: "abc" }]);
  await bad([{ path: "adsGuard.floor", value: 4000 }]); // أكبر من السقف الحالي 3000
  await bad([{ path: "jobs.fc-ghost.enabled", value: true }]); // مهمة مش موجودة
  await bad([{ path: "jobs.fc-adsentry.enabled", value: "yes" }]);
  await bad([{ path: "jobs.fc-adsentry.until", value: "30/9" }]);
  await bad([{ path: "jobs.morningBudgets.budgets", value: [{ id: "evil; rm", daily: 5 }] }]);
  await bad([{ path: "jobs.morningBudgets.budgets", value: [{ id: "meta/1", daily: 99999 }] }]);
  await bad([]);
  assert.equal(db.writes.length, 0);
  // الأرضية والسقف مع بعض في نفس الطلب مسموح
  const r = await call("POST", "/api/settings/patch", "admin",
    { changes: [{ path: "adsGuard.hardCap", value: 5000 }, { path: "adsGuard.floor", value: 4000 }] });
  assert.equal(r.status, 200);
});

test("deepSetStatement: بيعمل الآباء الناقصين وبيحط القيمة كـjsonb", () => {
  const st = deepSetStatement("jobs.morningBudgets.until", "2026-10-01");
  assert.deepEqual(st.params.slice(0, 3), [["jobs"], ["jobs", "morningBudgets"], ["jobs", "morningBudgets", "until"]]);
  assert.equal(st.params[3], JSON.stringify("2026-10-01"));
  assert.match(st.sql, /^UPDATE settings SET data = jsonb_set\(/);
  assert.match(st.sql, /jsonb_typeof\(data #> \$1::text\[\]\) = 'object'/);
  assert.match(st.sql, /\$3::text\[\], \$4::jsonb, true\)/);
  const v = validatePatch([{ path: "jobs.x.enabled", value: true }], { jobs: { x: [] } });
  assert.equal(v.ok, false, "المهمة لازم تكون كائن موجود");
});
