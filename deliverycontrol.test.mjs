/* node --test deliverycontrol.test.mjs
   لوحة التوصيل والمندوبين — التحقق، الافتراضيات، الدمج، والمفاتيح الخطيرة. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_FIELDS, FIELD_BY_PATH, GROUPS,
  getAt, setAt, normSaudiMobile, coerceField, validatePatch,
  dangerousChanges, effectiveOf, effectiveSettings, sourceOf,
  describeFields, applyPatch, auditLine,
} from "./deliverycontrol.js";

const spec = (p) => FIELD_BY_PATH[p];
const noEnv = () => "";

/* ── المواصفة نفسها ─────────────────────────────────────────────────────── */

test("كل حقل: مسار فريد، مجموعة موجودة، عنوان، ونوع معروف", () => {
  const seen = new Set();
  const groups = new Set(GROUPS.map((g) => g.id));
  const types = new Set(["int", "num", "bool", "enum", "text", "url", "phone", "phones"]);
  for (const f of ALL_FIELDS) {
    assert.ok(!seen.has(f.path), `مسار مكرر: ${f.path}`);
    seen.add(f.path);
    assert.ok(groups.has(f.group), `مجموعة غلط: ${f.path}`);
    assert.ok(f.label && f.label.length > 2, f.path);
    assert.ok(types.has(f.type), `${f.path}: ${f.type}`);
    if (f.type === "enum") assert.ok((f.options || []).length >= 2, f.path);
    if (f.type === "int" || f.type === "num") {
      assert.ok(f.min != null && f.max != null, `${f.path} من غير حدود`);
      assert.ok(f.min < f.max, f.path);
    }
  }
});

test("كل حقل تحت delivery أو shop بس — مفيش مفتاح بيتكتب بره", () => {
  for (const f of ALL_FIELDS) {
    assert.ok(/^(delivery|shop)\./.test(f.path), f.path);
  }
});

test("المفاتيح اللي عمر سمّاها موجودة كلها", () => {
  for (const p of [
    "delivery.provider", "delivery.dispatchMode", "delivery.dispatchDelayMin",
    "shop.autoDispatch", "delivery.courierSla.farGuard.fromKm", "delivery.courierSla.deliverGraceMin",
    "delivery.leajlakContract.flatExVat", "delivery.leajlakContract.perKmExVat",
    "delivery.leajlakContract.includedKm", "delivery.leajlakContract.vatPct",
    "delivery.leajlakContract.kmTolerance", "delivery.leajlakContract.cancelFeeExVat",
    "delivery.alertPhones", "delivery.newOrderPhones", "delivery.pickupAddress",
    "delivery.districtCouriers.enabled",
  ]) assert.ok(spec(p), `ناقص: ${p}`);
});

/* ── العنونة ────────────────────────────────────────────────────────────── */

test("getAt/setAt بيوصلوا للمفاتيح المتداخلة من غير ما يدوسوا على إخواتها", () => {
  const s = { delivery: { provider: "leajlak", courierSla: { assignMin: 2 } } };
  assert.equal(getAt(s, "delivery.courierSla.assignMin"), 2);
  assert.equal(getAt(s, "delivery.nope.deep"), undefined);
  setAt(s, "delivery.courierSla.farGuard.fromKm", 12);
  assert.equal(s.delivery.courierSla.assignMin, 2);
  assert.equal(s.delivery.provider, "leajlak");
  assert.equal(s.delivery.courierSla.farGuard.fromKm, 12);
});

test("setAt بيستبدل أي حاجة مش كائن في النص بدل ما يقع", () => {
  const s = { delivery: "مش كائن" };
  setAt(s, "delivery.provider", "cervo");
  assert.deepEqual(s.delivery, { provider: "cervo" });
});

/* ── الأرقام ────────────────────────────────────────────────────────────── */

test("الجوال السعودي: الأشكال المقبولة بترجع ٠٥xxxxxxxx", () => {
  for (const [inp, out] of [
    ["0544775082", "0544775082"],
    ["544775082", "0544775082"],
    ["+966544775082", "0544775082"],
    ["00966544775082", "0544775082"],
    ["966 54 477 5082", "0544775082"],
    ["054-477-5082", "0544775082"],
  ]) assert.equal(normSaudiMobile(inp), out, inp);
  for (const bad of ["", "0444775082", "05447750", "05447750821", "abc", null, undefined])
    assert.equal(normSaudiMobile(bad), null, String(bad));
});

test("قايمة أرقام: بتترتب وتتشال المكرر، وأي رقم غلط بيرفض القايمة كلها", () => {
  const ok = coerceField(spec("delivery.alertPhones"), "0544775082\n0506338246\n0544775082");
  assert.deepEqual(ok, { ok: true, value: ["0544775082", "0506338246"] });
  const bad = coerceField(spec("delivery.alertPhones"), "0544775082, 0111111111");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /0111111111/);
  // مصفوفة برضه مقبولة
  assert.deepEqual(coerceField(spec("delivery.newOrderPhones"), ["  0506338246 "]).value, ["0506338246"]);
  // فاضية = مسموح (يعني «وقّف الرسايل دي»)
  assert.deepEqual(coerceField(spec("delivery.alertPhones"), "").value, []);
});

/* ── التحقق من الأرقام والحدود ──────────────────────────────────────────── */

test("رقم بره المدى بيترفض — مابيتقصّش على الحد بالسكات", () => {
  const f = spec("delivery.dispatchDelayMin"); // 0..90
  assert.equal(coerceField(f, 15).value, 15);
  assert.equal(coerceField(f, 0).value, 0);
  assert.equal(coerceField(f, 90).value, 90);
  assert.equal(coerceField(f, 91).ok, false);
  assert.equal(coerceField(f, -1).ok, false);
  assert.equal(coerceField(f, "مش رقم").ok, false);
  assert.equal(coerceField(f, "").ok, false);
  assert.equal(coerceField(f, null).ok, false);
});

test("int بيتقرّب، num بيحافظ على الكسر", () => {
  assert.equal(coerceField(spec("delivery.dispatchDelayMin"), "15.6").value, 16);
  assert.equal(coerceField(spec("delivery.courierSla.farGuard.fromKm"), "10.5").value, 10.5);
  assert.equal(coerceField(spec("delivery.leajlakContract.perKmExVat"), "2.30").value, 2.3);
});

test("enum: الخيار الغلط بيترفض وبيقول المسموح", () => {
  assert.equal(coerceField(spec("delivery.provider"), "leajlak").value, "leajlak");
  const bad = coerceField(spec("delivery.provider"), "uber");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /leajlak/);
  assert.equal(coerceField(spec("delivery.dispatchMode"), "AUTO").ok, false, "الحساسية للحروف مقصودة");
});

test("bool بياخد صح/غلط بس (والنص بتاعهم)", () => {
  const f = spec("shop.autoDispatch");
  assert.equal(coerceField(f, true).value, true);
  assert.equal(coerceField(f, "false").value, false);
  assert.equal(coerceField(f, 1).ok, false);
  assert.equal(coerceField(f, "ايوه").ok, false);
});

test("رابط: فاضي مسموح، وأي حاجة مش http بترفض", () => {
  const f = spec("delivery.manualDashboardUrl");
  assert.equal(coerceField(f, "").value, "");
  assert.equal(coerceField(f, "https://dash.leajlak.com/orders").ok, true);
  assert.equal(coerceField(f, "javascript:alert(1)").ok, false);
  assert.equal(coerceField(f, "dash.leajlak.com").ok, false);
});

test("نص: بيتقصّ من الطرفين وبيترفض لو أطول من الحد", () => {
  const f = spec("delivery.pickupAddress"); // max 200
  assert.equal(coerceField(f, "  فريش كاتس — جدة  ").value, "فريش كاتس — جدة");
  assert.equal(coerceField(f, "ا".repeat(201)).ok, false);
});

/* ── الحزمة كلها أو ولا حاجة ────────────────────────────────────────────── */

test("validatePatch: حقل واحد غلط بيوقّف الحزمة كلها", () => {
  const r = validatePatch({ "delivery.dispatchDelayMin": 20, "delivery.provider": "uber" });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].path, "delivery.provider");
});

test("validatePatch: مسار مش في اللوحة بيترفض (مش بيتكتب في الإعدادات)", () => {
  const r = validatePatch({ "delivery.__hack": 1 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].error, /مش موجود/);
});

test("validatePatch: حزمة فاضية = خطأ مش نجاح صامت", () => {
  assert.equal(validatePatch({}).ok, false);
  assert.equal(validatePatch(null).ok, false);
  assert.equal(validatePatch("مش كائن").ok, false);
});

/* ── القيمة الفعّالة والمصدر ────────────────────────────────────────────── */

test("الإعدادات الفاضية = افتراضيات الكود، والمصدر «افتراضي»", () => {
  const s = {};
  assert.equal(effectiveOf("delivery.dispatchMode", s, noEnv), "manual", "الفشل بيميل ناحية ما نبعتش");
  assert.equal(effectiveOf("delivery.dispatchDelayMin", s, noEnv), 15);
  assert.equal(effectiveOf("shop.autoDispatch", s, noEnv), true);
  assert.equal(effectiveOf("delivery.courierSla.farGuard.fromKm", s, noEnv), 10);
  assert.equal(effectiveOf("delivery.leajlakContract.flatExVat", s, noEnv), 17);
  assert.equal(effectiveOf("delivery.districtCouriers.enabled", s, noEnv), false, "التوصيل بالحي يفضل مقفول");
  assert.equal(effectiveOf("delivery.courierRouting.enabled", s, noEnv), false);
  assert.equal(sourceOf("delivery.dispatchDelayMin", s, noEnv).kind, "default");
});

test("المخزون بيغلب الافتراضي، والمصدر بيبقى «من اللوحة»", () => {
  const s = { delivery: { dispatchMode: "auto", dispatchDelayMin: 8, courierSla: { farGuard: { fromKm: 10.5 } } } };
  assert.equal(effectiveOf("delivery.dispatchMode", s, noEnv), "auto");
  assert.equal(effectiveOf("delivery.dispatchDelayMin", s, noEnv), 8);
  assert.equal(effectiveOf("delivery.courierSla.farGuard.fromKm", s, noEnv), 10.5);
  assert.equal(sourceOf("delivery.dispatchMode", s, noEnv).kind, "settings");
});

test("القفل اليدوي في متغيّرات البيئة بيغلب اللوحة وبيتعلّم locked", () => {
  const env = (k) => (k === "DELIVERY_FORCE_MANUAL" ? "1" : "");
  const s = { delivery: { dispatchMode: "auto" } };
  assert.equal(effectiveOf("delivery.dispatchMode", s, env), "manual");
  const src = sourceOf("delivery.dispatchMode", s, env);
  assert.equal(src.kind, "env");
  assert.equal(src.locked, true);
  assert.equal(src.note, "DELIVERY_FORCE_MANUAL");
});

test("COURIER_PROVIDER احتياطي بس — اللوحة لو مكتوبة بتكسب", () => {
  const env = (k) => (k === "COURIER_PROVIDER" ? "cervo" : "");
  assert.equal(effectiveOf("delivery.provider", {}, env), "cervo");
  assert.equal(sourceOf("delivery.provider", {}, env).kind, "env");
  const s = { delivery: { provider: "leajlak" } };
  assert.equal(effectiveOf("delivery.provider", s, env), "leajlak");
  assert.equal(sourceOf("delivery.provider", s, env).kind, "settings");
});

test("الرقم البايظ في الإعدادات بيرجع للافتراضي بدل ما يعدّي", () => {
  const s = { delivery: { dispatchDelayMin: "خمستاشر", courierSla: { assignMin: 9999 } } };
  assert.equal(effectiveOf("delivery.dispatchDelayMin", s, noEnv), 15);
  assert.equal(effectiveOf("delivery.courierSla.assignMin", s, noEnv), 2);
});

test("effectiveSettings بيلمّ كل المجموعات مرة واحدة", () => {
  const e = effectiveSettings({ delivery: { alertPhones: ["0544775082"] } }, noEnv);
  assert.equal(e.dispatch.mode, "manual");
  assert.equal(e.leajlakContract.includedKm, 10);
  assert.equal(e.sla.posFailMinutes, 5);
  assert.deepEqual(e.alertPhones, ["0544775082"]);
  assert.equal(e.district.enabled, false);
});

test("describeFields بيدّي لكل حقل مخزون + فعّال + مصدر", () => {
  const rows = describeFields({ delivery: { provider: "leajlak" } }, noEnv);
  assert.equal(rows.length, ALL_FIELDS.length);
  const p = rows.find((r) => r.path === "delivery.provider");
  assert.equal(p.stored, "leajlak");
  assert.equal(p.effective, "leajlak");
  assert.equal(p.danger, "any");
  const d = rows.find((r) => r.path === "delivery.dispatchDelayMin");
  assert.equal(d.stored, null, "مش مكتوب");
  assert.equal(d.effective, 15, "بس الكود بيستعمل ١٥");
});

/* ── المفاتيح الخطيرة ───────────────────────────────────────────────────── */

test("تبديل الشركة خطير، وإعادة حفظ نفس القيمة لأ", () => {
  const s = { delivery: { provider: "leajlak" } };
  assert.equal(dangerousChanges({ "delivery.provider": "cervo" }, s).length, 1);
  assert.equal(dangerousChanges({ "delivery.provider": "leajlak" }, s).length, 0);
});

test("إقفال الإرسال الآلي خطير، وفتحه لأ (danger:off)", () => {
  const s = {};
  assert.equal(dangerousChanges({ "shop.autoDispatch": false }, s).length, 1);
  assert.equal(dangerousChanges({ "shop.autoDispatch": true }, s).length, 0, "افتراضياً شغّال أصلاً");
  assert.equal(dangerousChanges({ "shop.autoDispatch": true }, { shop: { autoDispatch: false } }).length, 0);
});

test("فتح التوصيل بالحي والتوجيه بالمسافة خطير، وإقفالهم لأ (danger:on)", () => {
  assert.equal(dangerousChanges({ "delivery.districtCouriers.enabled": true }, {}).length, 1);
  assert.equal(dangerousChanges({ "delivery.districtCouriers.enabled": false }, {}).length, 0);
  assert.equal(dangerousChanges({ "delivery.courierRouting.enabled": true }, {}).length, 1);
});

test("أي تغيير في بوابة الإرسال خطير في الاتجاهين", () => {
  assert.equal(dangerousChanges({ "delivery.dispatchMode": "auto" }, {}).length, 1);
  assert.equal(dangerousChanges({ "delivery.dispatchMode": "manual" }, { delivery: { dispatchMode: "auto" } }).length, 1);
  assert.equal(dangerousChanges({ "delivery.dispatchMode": "manual" }, {}).length, 0, "هو أصلاً يدوي");
});

test("المفاتيح العادية مش بتطلب تأكيد", () => {
  assert.deepEqual(dangerousChanges({
    "delivery.dispatchDelayMin": 20,
    "delivery.alertPhones": ["0544775082"],
    "delivery.leajlakContract.flatExVat": 18,
  }, {}), []);
});

test("كل تحذير خطر بيقول للمستخدم إيه اللي هيحصل", () => {
  for (const d of dangerousChanges({
    "delivery.provider": "cervo", "delivery.dispatchMode": "auto",
    "shop.autoDispatch": false, "delivery.districtCouriers.enabled": true,
  }, {})) {
    assert.ok(d.warn && d.warn.length > 20, d.path);
    assert.ok(d.label, d.path);
    assert.ok("from" in d && "to" in d, d.path);
  }
});

/* ── الدمج ──────────────────────────────────────────────────────────────── */

test("applyPatch مابيلمسش مفاتيح تانية في الإعدادات", () => {
  const before = {
    cms: { dailyTarget: 200 },
    shop: { otpDevMode: true, autoDispatch: true },
    delivery: { provider: "leajlak", ljShopId: "15882", alertPhones: ["0544775082"],
                leajlakContract: { flatExVat: 17, perKmExVat: 2 } },
  };
  const snapshot = JSON.parse(JSON.stringify(before));
  const { next, delivery, shop } = applyPatch(before, {
    "delivery.leajlakContract.perKmExVat": 2.5,
    "shop.autoDispatch": false,
  });
  assert.deepEqual(before, snapshot, "الأصل مايتغيّرش (نسخة)");
  assert.equal(next.cms.dailyTarget, 200);
  assert.equal(delivery.provider, "leajlak");
  assert.equal(delivery.ljShopId, "15882");
  assert.deepEqual(delivery.alertPhones, ["0544775082"]);
  assert.equal(delivery.leajlakContract.flatExVat, 17, "أخوه في نفس العقد فضل مكانه");
  assert.equal(delivery.leajlakContract.perKmExVat, 2.5);
  assert.equal(shop.otpDevMode, true);
  assert.equal(shop.autoDispatch, false);
});

test("applyPatch بيعمل delivery/shop لو مش موجودين", () => {
  const { delivery, shop } = applyPatch({}, { "delivery.provider": "cervo", "shop.autoDispatch": false });
  assert.equal(delivery.provider, "cervo");
  assert.equal(shop.autoDispatch, false);
});

test("الحفظ بيخلّي القيمة الفعّالة تساوي اللي اتكتب", () => {
  const v = validatePatch({ "delivery.dispatchMode": "auto", "delivery.dispatchDelayMin": "12" });
  assert.equal(v.ok, true);
  const { next } = applyPatch({}, v.values);
  assert.equal(effectiveOf("delivery.dispatchMode", next, noEnv), "auto");
  assert.equal(effectiveOf("delivery.dispatchDelayMin", next, noEnv), 12);
});

/* ── سجل النشاط ─────────────────────────────────────────────────────────── */

test("سطر السجل بيقول من إيه لإيه، وبيعلّم الخطير", () => {
  const line = auditLine({ "delivery.provider": "cervo", "delivery.dispatchDelayMin": 20 },
    { delivery: { provider: "leajlak", dispatchDelayMin: 15 } });
  assert.match(line, /⚠️/);
  assert.match(line, /leajlak/);
  assert.match(line, /cervo/);
  assert.match(line, /15/);
  assert.match(line, /20/);
  assert.ok(line.length <= 500);
});

test("سطر السجل بيقرا الصح والغلط والقوايم", () => {
  const line = auditLine({ "shop.autoDispatch": false, "delivery.alertPhones": [] },
    { shop: { autoDispatch: true }, delivery: { alertPhones: ["0544775082"] } });
  assert.match(line, /شغّال → مقفول/);
  assert.match(line, /0544775082 → —/);
});

test("سطر السجل مابيزيدش عن حد العمود مهما كانت الحزمة", () => {
  const big = {};
  for (const f of ALL_FIELDS) if (f.type === "int" || f.type === "num") big[f.path] = f.min;
  assert.ok(auditLine(big, {}).length <= 500);
});

/* ── المسارات: requireAdmin جوّه الـhandler (مش middleware) ──────────────────
   استعمال requireAdmin كـmiddleware في الكودبيز ده بيطلّع 500 «Context is not
   finalized» — ولمستخدم مصرّح له بس، يعني بيعدّي من أي اختبار سطحي. الاختبار
   ده بيمسك الحالة دي: لو الرفض ما رجعش زي ما هو، بيقع هنا. */
function fakeApp() {
  const routes = {};
  const on = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  return { app: { get: on("GET"), put: on("PUT"), post: on("POST"), delete: on("DELETE") }, routes };
}
function fakeCtx({ settings = {}, requireAdmin = async () => null, onQuery } = {}) {
  const queries = [];
  return {
    queries,
    ctx: {
      pool: { query: async (sql, params) => { queries.push({ sql, params }); return onQuery ? onQuery(sql, params) : { rows: [] }; } },
      getSettingsData: async () => settings,
      requireAdmin,
      jb: (v) => JSON.stringify(v),
      log: { log() {} },
      auditNote: async () => {},
    },
  };
}
const fakeC = (body) => ({
  req: { json: async () => body, method: "PUT", path: "/api/delivery/control", header: () => "" },
  json: (payload, status = 200) => ({ payload, status }),
  set() {}, get() { return null; },
});

const { register } = await import("./deliverycontrol.js");

test("المسارات: الرفض من requireAdmin بيرجع زي ما هو (مش 500)", async () => {
  const denied = { payload: { error: "forbidden" }, status: 403 };
  const { app, routes } = fakeApp();
  const { ctx } = fakeCtx({ requireAdmin: async () => denied });
  register(app, ctx);
  assert.ok(routes["GET /api/delivery/control"], "GET مش متسجّل");
  assert.ok(routes["PUT /api/delivery/control"], "PUT مش متسجّل");
  assert.equal(await routes["GET /api/delivery/control"](fakeC({})), denied);
  assert.equal(await routes["PUT /api/delivery/control"](fakeC({ patch: {} })), denied);
});

test("GET بيرجع كل الحقول + متغيّرات البيئة + مرآة سياسة الرسوم", async () => {
  const { app, routes } = fakeApp();
  const { ctx } = fakeCtx({
    settings: { delivery: { provider: "leajlak" } },
    onQuery: async () => ({ rows: [{ id: 3, name: "الأساسية", config: { baseKm: 3, baseFee: 10, maxKm: 10.9 } }] }),
  });
  register(app, ctx);
  const r = await routes["GET /api/delivery/control"](fakeC({}));
  assert.equal(r.payload.ok, true);
  assert.equal(r.payload.fields.length, ALL_FIELDS.length);
  assert.equal(r.payload.zonePolicy.maxKm, 10.9);
  assert.equal(r.payload.zonePolicy.name, "الأساسية");
  assert.ok(r.payload.env && r.payload.env.keys);
  assert.ok(r.payload.groups.length === GROUPS.length);
});

test("PUT: خانة غلط ⇒ 400 ومفيش أي كتابة على قاعدة البيانات", async () => {
  const { app, routes } = fakeApp();
  const f = fakeCtx({});
  register(app, f.ctx);
  const r = await routes["PUT /api/delivery/control"](fakeC({ patch: { "delivery.dispatchDelayMin": 500 } }));
  assert.equal(r.status, 400);
  assert.equal(r.payload.error, "invalid");
  assert.equal(f.queries.filter((q) => /UPDATE settings/i.test(q.sql)).length, 0, "ما ينفعش يكتب وهو رافض");
});

test("PUT: مفتاح خطير من غير تأكيد ⇒ 409 ومفيش كتابة", async () => {
  const { app, routes } = fakeApp();
  const f = fakeCtx({ settings: { delivery: { provider: "leajlak" } } });
  register(app, f.ctx);
  const r = await routes["PUT /api/delivery/control"](fakeC({ patch: { "delivery.provider": "cervo" } }));
  assert.equal(r.status, 409);
  assert.equal(r.payload.error, "confirm_required");
  assert.equal(r.payload.needConfirm[0].path, "delivery.provider");
  assert.equal(f.queries.filter((q) => /UPDATE settings/i.test(q.sql)).length, 0);
});

test("PUT: مع التأكيد ⇒ بيكتب delivery و shop بس (jsonb_set)", async () => {
  const { app, routes } = fakeApp();
  const f = fakeCtx({ settings: { cms: { dailyTarget: 200 }, delivery: { provider: "leajlak", ljShopId: "15882" } } });
  register(app, f.ctx);
  const r = await routes["PUT /api/delivery/control"](
    fakeC({ patch: { "delivery.provider": "cervo" }, confirm: ["delivery.provider"] }));
  assert.equal(r.payload.ok, true);
  const w = f.queries.find((q) => /UPDATE settings/i.test(q.sql));
  assert.ok(w, "لازم يكتب");
  assert.match(w.sql, /jsonb_set/);
  assert.match(w.sql, /\{delivery\}/);
  assert.match(w.sql, /\{shop\}/);
  assert.doesNotMatch(w.sql, /data=\$1::jsonb WHERE/i, "ممنوع نكتب البلوب كامل");
  const delivery = JSON.parse(w.params[0]);
  assert.equal(delivery.provider, "cervo");
  assert.equal(delivery.ljShopId, "15882", "باقي مفاتيح التوصيل ما اتلمستش");
  assert.match(r.payload.note, /⚠️/);
});

test("PUT: حزمة عادية بتعدي من غير تأكيد", async () => {
  const { app, routes } = fakeApp();
  const f = fakeCtx({});
  register(app, f.ctx);
  const r = await routes["PUT /api/delivery/control"](
    fakeC({ patch: { "delivery.dispatchDelayMin": 20, "delivery.alertPhones": ["0544775082"] } }));
  assert.equal(r.payload.ok, true);
  assert.deepEqual(r.payload.danger, []);
  const delivery = JSON.parse(f.queries.find((q) => /UPDATE settings/i.test(q.sql)).params[0]);
  assert.equal(delivery.dispatchDelayMin, 20);
  assert.deepEqual(delivery.alertPhones, ["0544775082"]);
});

test("PUT: جسم من غير patch بيتقبل كـpatch مباشر", async () => {
  const { app, routes } = fakeApp();
  const f = fakeCtx({});
  register(app, f.ctx);
  const r = await routes["PUT /api/delivery/control"](fakeC({ "delivery.dispatchDelayMin": 7 }));
  assert.equal(r.payload.ok, true);
});

test("حارس المشوار البعيد: enabled بيتشتق من mode (مفتاحين في الكود، واحد في اللوحة)", () => {
  const off = applyPatch({ delivery: { courierSla: { farGuard: { enabled: true, fromKm: 10.5 } } } },
    { "delivery.courierSla.farGuard.mode": "off" });
  assert.equal(off.delivery.courierSla.farGuard.enabled, false);
  assert.equal(off.delivery.courierSla.farGuard.fromKm, 10.5, "المسافة ما اتلمستش");
  const on = applyPatch({ delivery: { courierSla: { farGuard: { enabled: false } } } },
    { "delivery.courierSla.farGuard.mode": "suggest" });
  assert.equal(on.delivery.courierSla.farGuard.enabled, true, "«تنبيه بس» لازم يفتحه فعلاً");
  // تعديل المسافة لوحدها مابيلمسش enabled
  const km = applyPatch({ delivery: { courierSla: { farGuard: { enabled: false, mode: "suggest" } } } },
    { "delivery.courierSla.farGuard.fromKm": 12 });
  assert.equal(km.delivery.courierSla.farGuard.enabled, false);
});
