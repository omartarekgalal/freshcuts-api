/* قرار O6 (PDPL): syncAudiences=false لازم يقفل رفع قوايم الجوال من المجدول
   بتاع audiences.js (كل ٦ ساعات) — مش النداء الليلي بتاع الطيار بس.
     node --test audiences-o6.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";

process.env.AUD_SCHEDULER = "0";          // مفيش مؤقّتات في الاختبار
delete process.env.META_CAPI_TOKEN;       // ولا أي نداء حقيقي على منصة
delete process.env.META_AD_ACCOUNT_ID;
delete process.env.TIKTOK_ACCESS_TOKEN;
delete process.env.SNAP_ACCESS_TOKEN;

const { listsUploadAllowed, register } = await import("./audiences.js");

test("listsUploadAllowed (١٩/٩): الافتراضي مقفول، true صريح بس بيفتح، فشل القراءة مقفول", () => {
  assert.equal(listsUploadAllowed(null), false);
  assert.equal(listsUploadAllowed(undefined), false);
  assert.equal(listsUploadAllowed("true"), true);
  assert.equal(listsUploadAllowed(true), true);
  assert.equal(listsUploadAllowed("false"), false);
  assert.equal(listsUploadAllowed(false), false);
  assert.equal(listsUploadAllowed("FALSE"), false);
  assert.equal(listsUploadAllowed(null, { readFailed: true }), false);
});

function harness(syncAudiences) {
  const seen = [];
  const pool = {
    query: async (sql, params) => {
      const s = String(sql);
      seen.push(s);
      if (/FROM ap_settings/.test(s)) {
        if (syncAudiences === "THROW") throw new Error("db down");
        return { rows: syncAudiences === undefined ? [] : [{ v: String(syncAudiences) }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const noop = () => {};
  const app = { get: noop, post: noop, put: noop, delete: noop, patch: noop, use: noop };
  const ctx = { pool, requireAdmin: async () => null, jb: (x) => JSON.stringify(x) };
  const api = register(app, ctx);
  const uploads = () => seen.filter((q) => /INSERT INTO aud_syncs/.test(q)).length;
  const listsRan = (r) => (r.ran || []).find((x) => x.job === "lists");
  return { api, seen, uploads, listsRan };
}

test("المجدول: syncAudiences=false → lists متخطّية ومفيش syncAll", async () => {
  const h = harness(false);
  const r = await h.api.refresh({ trigger: "cron" });
  const l = h.listsRan(r);
  assert.ok(l, "lists لازم تظهر في ran");
  assert.match(String(l.skipped), /syncAudiences=false/);
  assert.equal(h.uploads(), 0);
  assert.equal(r.lists, undefined);
});

test("المجدول: قراءة الإعدادات فشلت → مقفول (الخصوصية أولى)", async () => {
  const h = harness("THROW");
  const r = await h.api.refresh({ trigger: "cron" });
  assert.match(String(h.listsRan(r)?.skipped), /unreadable/);
  assert.equal(r.lists, undefined);
});

test("المجدول (١٩/٩): من غير إعداد (الافتراضي) → الرفع مقفول", async () => {
  const h = harness(undefined);
  const r = await h.api.refresh({ trigger: "cron" });
  assert.match(String(h.listsRan(r)?.skipped), /syncAudiences/);
  assert.equal(h.uploads(), 0);
});

test("المجدول: syncAudiences=true → syncAll بيتنده", async () => {
  const h = harness(true);
  const r = await h.api.refresh({ trigger: "cron" });
  assert.ok(r.lists, "syncAll اتنده");
});

test("force=lists (أمر يدوي صريح) مابيتقفلش بالإعداد", async () => {
  const h = harness(false);
  const r = await h.api.refresh({ force: "lists", trigger: "manual" });
  assert.ok(r.lists, "الأمر اليدوي بيعدّي");
  // بس syncAll نفسها بتقفل الرفع (البوابة) — مفيش ولا صف aud_syncs
  assert.equal(r.lists.enabled, false);
  assert.equal(h.uploads(), 0);
});
