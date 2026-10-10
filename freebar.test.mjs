/* 🛵 شريط التوصيل المجاني — الإعدادات والمسارات (أوفلاين).
   node --test freebar.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  FREEBAR_DEFAULTS, FREEBAR_TEXT_KEYS, FREEBAR_TEXT_MAX, freeBarCfg, freeBarStored, mergeFreeBar, freeBarErrors,
  cleanBarText, register,
} from "./freebar.js";
import { SERVER_OWNED_PATHS, mergeForPut } from "./settings-guard.js";
import { sectionOf } from "./cms.js";

test("من غير إعدادات: الافتراضي كامل (٤ مفاتيح + ١٠ نصوص)", () => {
  for (const s of [undefined, null, {}, { freeBar: null }, { freeBar: "x" }, { freeBar: [] }]) {
    assert.deepEqual(freeBarCfg(s), FREEBAR_DEFAULTS);
  }
  assert.equal(FREEBAR_TEXT_KEYS.length, 10);
  assert.deepEqual(FREEBAR_DEFAULTS, {
    enabled: true, autoFirst: true, maxGap: 60, suggest: true,
    texts: {
      gapAr: "فاضل {x} ر.س وتاخد التوصيل مجاناً", gapEn: "{x} SAR away from free delivery",
      tierAr: "زوّد {x} ر.س والتوصيل ينزل لـ{fee} ر.س", tierEn: "Add {x} SAR and delivery drops to {fee} SAR",
      doneAr: "🎉 التوصيل مجاني", doneEn: "🎉 Free delivery unlocked",
      firstAr: "أول طلب توصيل — من {min} ر.س", firstEn: "First delivery order — from {min} SAR",
      addAr: "ضيف", addEn: "Add",
    },
  });
  for (const v of Object.values(FREEBAR_DEFAULTS.texts)) assert.ok(Array.from(v).length <= FREEBAR_TEXT_MAX);
});

test("الأرقام بتتقص ٠–٣٠٠، والمفاتيح لازم boolean حقيقي", () => {
  assert.equal(freeBarCfg({ freeBar: { maxGap: 999 } }).maxGap, 300);
  assert.equal(freeBarCfg({ freeBar: { maxGap: -5 } }).maxGap, 0);
  assert.equal(freeBarCfg({ freeBar: { maxGap: 0 } }).maxGap, 0, "صفر قيمة صالحة مش «فاضي»");
  assert.equal(freeBarCfg({ freeBar: { maxGap: "45.6" } }).maxGap, 46);
  assert.equal(freeBarCfg({ freeBar: { maxGap: "abc" } }).maxGap, 60);
  assert.equal(freeBarCfg({ freeBar: { maxGap: null } }).maxGap, 60);
  const c = freeBarCfg({ freeBar: { enabled: false, autoFirst: "no", suggest: 0 } });
  assert.equal(c.enabled, false);
  assert.equal(c.autoFirst, true);
  assert.equal(c.suggest, true);
});

test("النصوص: ≤ ٨٠ حرف، سطر واحد، من غير < >، والفاضي بيرجع الافتراضي", () => {
  const c = freeBarCfg({ freeBar: { texts: {
    gapAr: "  باقي {x} ريال\nوالتوصيل علينا  ", gapEn: "x".repeat(200), doneAr: "", tierAr: 42,
    addAr: "<b>ضيف</b>", unknownKey: "يترمي" } } });
  assert.equal(c.texts.gapAr, "باقي {x} ريال والتوصيل علينا");
  assert.equal(c.texts.gapEn.length, 80);
  assert.equal(c.texts.doneAr, FREEBAR_DEFAULTS.texts.doneAr);
  assert.equal(c.texts.tierAr, FREEBAR_DEFAULTS.texts.tierAr);
  assert.equal(c.texts.addAr, "b ضيف /b");
  assert.equal("unknownKey" in c.texts, false);
  assert.deepEqual(Object.keys(c.texts), FREEBAR_TEXT_KEYS);
  // الإيموجي بيتعد حرف واحد ومابيتقطعش من النص
  assert.equal(cleanBarText("🎉".repeat(100)), "🎉".repeat(80));
});

test("الدمج جزئي: مفتاح واحد مابيرجّعش الباقي للافتراضي، ونص فاضي = رجوع للافتراضي", () => {
  const saved = { enabled: false, maxGap: 40, texts: { gapAr: "باقي {x}" } };
  const a = mergeFreeBar(saved, { suggest: false });
  assert.equal(a.enabled, false);
  assert.equal(a.maxGap, 40);
  assert.equal(a.suggest, false);
  assert.equal(a.texts.gapAr, "باقي {x}");
  const b = mergeFreeBar(saved, { texts: { gapAr: "", doneEn: "Free!" } });
  assert.equal(b.texts.gapAr, FREEBAR_DEFAULTS.texts.gapAr);
  assert.equal(b.texts.doneEn, "Free!");
  // المخزّن: النصوص المختلفة عن الافتراضي بس
  assert.deepEqual(freeBarStored(b), { enabled: false, autoFirst: true, maxGap: 40, suggest: true, texts: { doneEn: "Free!" } });
  assert.deepEqual(freeBarCfg({ freeBar: freeBarStored(b) }), b, "اللي اتخزّن بيتقري زي ما هو");
});

test("الجسم الغلط بيترفض بدل ما يتصلّح بالسكات", () => {
  assert.deepEqual(freeBarErrors(null), ["bad body"]);
  assert.deepEqual(freeBarErrors([]), ["bad body"]);
  assert.deepEqual(freeBarErrors({ enabled: "yes" }), ["enabled must be boolean"]);
  assert.deepEqual(freeBarErrors({ maxGap: "abc" }), ["maxGap must be a number"]);
  assert.deepEqual(freeBarErrors({ texts: "x" }), ["texts must be an object"]);
  assert.deepEqual(freeBarErrors({ enabled: true, maxGap: 30, texts: {} }), []);
});

test("settings.freeBar ملك السيرفر: الـPUT الكامل للإعدادات مابيدوسش عليه", () => {
  assert.ok(SERVER_OWNED_PATHS.includes("freeBar"));
  const cur = { freeBar: { enabled: false, maxGap: 40 }, shop: { allowCash: false } };
  const merged = mergeForPut(cur, { shop: { allowCash: true }, freeBar: { enabled: true } });
  assert.deepEqual(merged.freeBar, { enabled: false, maxGap: 40 });
  assert.equal(merged.shop.allowCash, true);
  assert.equal("freeBar" in mergeForPut({}, { freeBar: { enabled: false } }), false);
});

test("مسار اللوحة في قسم «التوصيل»", () => {
  assert.equal(sectionOf("/api/delivery/free-bar"), "delivery");
});

function makeApp({ admin = true, data = {} } = {}) {
  const state = { data: JSON.parse(JSON.stringify(data)), writes: [] };
  const pool = {
    async query(sql, p = []) {
      if (sql.includes("UPDATE settings SET data = jsonb_set") && sql.includes("'{freeBar}'")) {
        state.data.freeBar = JSON.parse(p[0]);
        state.writes.push(state.data.freeBar);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM shop_coupons")) return { rows: [{ min_total: "60", free_delivery: true, active: true, expires_at: null }], rowCount: 1 };
      if (sql.includes("FROM dl_policies")) return { rows: [{ config: { feeByTotal: [{ over: 150, fee: 0 }, { over: 80, fee: 9 }, { over: null, fee: 3 }] } }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const app = new Hono();
  register(app, {
    pool, jb: (v) => JSON.stringify(v), getSettingsData: async () => state.data,
    requireAdmin: async (c) => (admin ? null : c.json({ error: "Unauthorized" }, 401)),
  });
  const call = async (method, path, body) => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { call, state };
}

test("GET: الإعدادات + الافتراضي + الحدود الحقيقية للمعاينة (FIRST وسلّم الرسوم مرتّب)", async () => {
  const { call } = makeApp({ data: { freeBar: { maxGap: 45 } } });
  const r = await call("GET", "/api/delivery/free-bar");
  assert.equal(r.status, 200);
  assert.equal(r.body.config.maxGap, 45);
  assert.deepEqual(r.body.defaults, FREEBAR_DEFAULTS);
  assert.equal(r.body.textMax, 80);
  assert.deepEqual(r.body.first, { minTotal: 60, freeDelivery: true, active: true });
  assert.deepEqual(r.body.ladder, [{ over: 80, fee: 9 }, { over: 150, fee: 0 }]);
});

test("PUT: دمج جزئي، قصّ، وتخزين في settings.freeBar بس", async () => {
  const { call, state } = makeApp({ data: { freeBar: { enabled: false }, other: 1 } });
  const r = await call("PUT", "/api/delivery/free-bar", { maxGap: 500, texts: { gapAr: "باقي {x} ر.س" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.config.maxGap, 300);
  assert.equal(r.body.config.enabled, false, "المحفوظ قبل كده فضل");
  assert.equal(r.body.config.texts.gapAr, "باقي {x} ر.س");
  assert.deepEqual(state.data.freeBar, { enabled: false, autoFirst: true, maxGap: 300, suggest: true, texts: { gapAr: "باقي {x} ر.س" } });
  assert.equal(state.data.other, 1);
  // رجوع نص للافتراضي
  const back = await call("PUT", "/api/delivery/free-bar", { texts: { gapAr: "" } });
  assert.equal(back.body.config.texts.gapAr, FREEBAR_DEFAULTS.texts.gapAr);
  assert.deepEqual(state.data.freeBar.texts, {});
});

test("PUT: جسم غلط = 400 ومفيش كتابة، ومن غير صلاحية = 401", async () => {
  const { call, state } = makeApp();
  assert.equal((await call("PUT", "/api/delivery/free-bar", { enabled: "yes" })).status, 400);
  assert.equal((await call("PUT", "/api/delivery/free-bar", "not json")).status, 400);
  assert.equal(state.writes.length, 0);
  const locked = makeApp({ admin: false });
  assert.equal((await locked.call("GET", "/api/delivery/free-bar")).status, 401);
  assert.equal((await locked.call("PUT", "/api/delivery/free-bar", {})).status, 401);
});
