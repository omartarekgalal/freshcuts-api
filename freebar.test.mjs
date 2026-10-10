/* 🛵 شريط التوصيل المجاني — الإعدادات والمسارات (أوفلاين).
   node --test freebar.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  FREEBAR_DEFAULTS, FREEBAR_TEXT_KEYS, FREEBAR_TEXT_MAX, freeBarCfg, freeBarStored, mergeFreeBar, freeBarErrors,
  cleanBarText, register, TRUST_TEXT_KEYS, TRUST_BANNED_WORDS, bannedWording, normWording, trustWordingError,
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
      gapAr: "باقي {x} ر.س وتحصل على التوصيل مجاناً", gapEn: "{x} SAR away from free delivery",
      tierAr: "أضف {x} ر.س وينخفض التوصيل إلى {fee} ر.س", tierEn: "Add {x} SAR and delivery drops to {fee} SAR",
      doneAr: "🎉 التوصيل مجاني", doneEn: "🎉 Free delivery unlocked",
      firstAr: "أول طلب توصيل — من {min} ر.س", firstEn: "First delivery order — from {min} SAR",
      addAr: "أضف", addEn: "Add",
    },
    trust: {
      enabled: true,
      menuAr: "نفس سعر المطعم… بدون أي زيادة", menuEn: "Same price as in the restaurant — no markup",
      checkoutAr: "الأسعار هنا هي نفس أسعار المطعم", checkoutEn: "Prices here are the same as in the restaurant",
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
  assert.deepEqual(freeBarStored(b), { enabled: false, autoFirst: true, maxGap: 40, suggest: true, texts: { doneEn: "Free!" }, trust: { enabled: true } });
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
  assert.deepEqual(state.data.freeBar, { enabled: false, autoFirst: true, maxGap: 300, suggest: true, texts: { gapAr: "باقي {x} ر.س" }, trust: { enabled: true } });
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

/* ── 🤝 سطر الثقة (freeBar.trust) ── */
const TRUST_DEF = FREEBAR_DEFAULTS.trust;

test("trust: كامل دايماً بالافتراضي، ونفس تنضيف النصوص (سطر واحد، ≤ ٨٠، من غير < >، الفاضي = الافتراضي)", () => {
  assert.deepEqual(TRUST_TEXT_KEYS, ["menuAr", "menuEn", "checkoutAr", "checkoutEn"]);
  for (const raw of [undefined, null, "x", [], {}]) assert.deepEqual(freeBarCfg({ freeBar: { trust: raw } }).trust, TRUST_DEF);
  const t = freeBarCfg({ freeBar: { trust: {
    enabled: "no", menuAr: "  نفس السعر\nبالظبط  ", menuEn: "y".repeat(200), checkoutAr: "", checkoutEn: "<i>Same</i>", extra: "يترمي" } } }).trust;
  assert.equal(t.enabled, true, "enabled لازم boolean حقيقي");
  assert.equal(t.menuAr, "نفس السعر بالظبط");
  assert.equal(t.menuEn.length, 80);
  assert.equal(t.checkoutAr, TRUST_DEF.checkoutAr);
  assert.equal(t.checkoutEn, "i Same /i");
  assert.deepEqual(Object.keys(t), ["enabled", ...TRUST_TEXT_KEYS]);
  assert.equal(freeBarCfg({ freeBar: { trust: { enabled: false } } }).trust.enabled, false);
  for (const k of TRUST_TEXT_KEYS) assert.ok(Array.from(TRUST_DEF[k]).length <= FREEBAR_TEXT_MAX);
});

test("trust: الدمج جزئي، والمخزّن = المفتاح + النصوص المختلفة عن الافتراضي بس", () => {
  const saved = { maxGap: 40, texts: { gapAr: "باقي {x}" }, trust: { enabled: false, menuAr: "نفس سعر الفرع" } };
  const a = mergeFreeBar(saved, { trust: { checkoutEn: "Same prices as dine-in" } });
  assert.equal(a.trust.enabled, false, "المفتاح المحفوظ فضل");
  assert.equal(a.trust.menuAr, "نفس سعر الفرع");
  assert.equal(a.trust.checkoutEn, "Same prices as dine-in");
  assert.equal(a.maxGap, 40);
  assert.equal(a.texts.gapAr, "باقي {x}");
  assert.deepEqual(freeBarStored(a).trust, { enabled: false, menuAr: "نفس سعر الفرع", checkoutEn: "Same prices as dine-in" });
  // جسم من غير trust (لوحة قديمة) مابيلمسوش
  assert.deepEqual(mergeFreeBar(saved, { suggest: false }).trust, { ...TRUST_DEF, enabled: false, menuAr: "نفس سعر الفرع" });
  // نص فاضي = رجوع للافتراضي
  const b = mergeFreeBar(saved, { trust: { enabled: true, menuAr: "" } });
  assert.deepEqual(b.trust, TRUST_DEF);
  assert.deepEqual(freeBarStored(b).trust, { enabled: true });
  assert.deepEqual(freeBarCfg({ freeBar: freeBarStored(a) }), a, "اللي اتخزّن بيتقري زي ما هو");
  // مخزّن قديم من غير trust خالص
  assert.deepEqual(freeBarStored(freeBarCfg({ freeBar: { enabled: false } })).trust, { enabled: true });
});

test("trust: جسم غلط بيترفض", () => {
  assert.deepEqual(freeBarErrors({ trust: "x" }), ["trust must be an object"]);
  assert.deepEqual(freeBarErrors({ trust: [] }), ["trust must be an object"]);
  assert.deepEqual(freeBarErrors({ trust: { enabled: 1 } }), ["trust.enabled must be boolean"]);
  assert.deepEqual(freeBarErrors({ trust: { enabled: false, menuAr: "" } }), []);
});

test("حارس الصياغة: النصوص الافتراضية (كلها) سليمة", () => {
  for (const k of TRUST_TEXT_KEYS) assert.equal(bannedWording(TRUST_DEF[k]), null, k);
  for (const v of Object.values(FREEBAR_DEFAULTS.texts)) assert.equal(bannedWording(v), null, v);
  assert.equal(TRUST_BANNED_WORDS.length, 22);
});

test("حارس الصياغة: «أرخص»/«تطبيق»/أسماء التطبيقات بتتمسك بعد التطبيع", () => {
  // همزات، تشكيل، تطويل
  assert.equal(bannedWording("أرخص من أي مكان"), "أرخص");
  assert.equal(bannedWording("إرخص سعر"), "أرخص");
  assert.equal(bannedWording("أَرْخَص سعر"), "أرخص");
  assert.equal(bannedWording("ارخـــص سعر"), "أرخص");
  assert.equal(bannedWording("أرخص من التطبيقات"), "أرخص", "أول كلمة في ترتيب القايمة");
  assert.equal(bannedWording("أحسن من التطبيقات"), "تطبيق");
  assert.equal(bannedWording("زي كيتا"), "كيتا");
  assert.equal(bannedWording("هنقرستيشن"), "هنقرستيشن");
  assert.equal(bannedWording("هنجرستيشن"), "هنجرستيشن");
  assert.equal(bannedWording("طلبك جاهز"), "جاهز");
  assert.equal(bannedWording("نينجا"), "نينجا");
  assert.equal(bannedWording("مرسول"), "مرسول");
  assert.equal(bannedWording("زي طلبات"), "طلبات");
  // إنجليزي: حالة الحروف والمسافات
  assert.equal(bannedWording("CHEAPER than anywhere"), "cheaper");
  assert.equal(bannedWording("The Cheapest"), "cheapest");
  assert.equal(bannedWording("Same as Keeta"), "keeta");
  assert.equal(bannedWording("HungerStation price"), "hungerstation");
  assert.equal(bannedWording("Hunger   Station price"), "hunger station");
  assert.equal(bannedWording("Jahez"), "jahez");
  assert.equal(bannedWording("NINJA"), "ninja");
  assert.equal(bannedWording("Mrsool"), "mrsool");
  assert.equal(bannedWording("Talabat"), "talabat");
  assert.equal(bannedWording("Same as the app"), "app");
  assert.equal(bannedWording("App prices are higher"), "app", "بداية النص زي ما قبلها مسافة");
  assert.equal(bannedWording("Lower than delivery-apps"), "apps");
  // سليم
  assert.equal(bannedWording("Happy to serve the same price"), null, "«app» جوّه كلمة مش ممنوعة");
  assert.equal(bannedWording("نفس سعر الفرع بالظبط"), null);
  assert.equal(bannedWording(""), null);
  assert.equal(bannedWording(null), null);
  assert.equal(normWording("أإآ ة ى  X"), "ااا ه ي x");
});

test("trustWordingError: بيفحص نصوص trust بس، وبيرجّع الحقل والكلمة", () => {
  assert.equal(trustWordingError({}), null);
  assert.equal(trustWordingError({ trust: "x" }), null);
  assert.equal(trustWordingError({ trust: { enabled: false, menuAr: "" } }), null);
  assert.deepEqual(trustWordingError({ trust: { menuAr: "سليم", checkoutEn: "Cheaper than Keeta" } }), { field: "checkoutEn", word: "cheaper" });
  // نصوص الشريط نفسها مش تحت الحارس (العقد القديم زي ما هو)
  assert.equal(trustWordingError({ texts: { gapAr: "أرخص" } }), null);
  // سطر جديد بين كلمتين مايعدّيش
  assert.deepEqual(trustWordingError({ trust: { menuEn: "hunger\nstation" } }), { field: "menuEn", word: "hunger station" });
});

test("PUT trust: جزئي، بيتخزّن جوّه settings.freeBar، وGET بيرجّعه كامل مع الافتراضي", async () => {
  const { call, state } = makeApp({ data: { freeBar: { maxGap: 45, texts: { gapAr: "باقي {x} ر.س" } } } });
  const g0 = await call("GET", "/api/delivery/free-bar");
  assert.deepEqual(g0.body.config.trust, TRUST_DEF);
  assert.deepEqual(g0.body.defaults.trust, TRUST_DEF);
  const r = await call("PUT", "/api/delivery/free-bar", { trust: { enabled: false, checkoutAr: "  نفس أسعار الفرع  " } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.config.trust, { ...TRUST_DEF, enabled: false, checkoutAr: "نفس أسعار الفرع" });
  assert.equal(r.body.config.maxGap, 45, "باقي الإعدادات زي ما هي");
  assert.deepEqual(state.data.freeBar, { enabled: true, autoFirst: true, maxGap: 45, suggest: true,
    texts: { gapAr: "باقي {x} ر.س" }, trust: { enabled: false, checkoutAr: "نفس أسعار الفرع" } });
  // لوحة قديمة (من غير trust) مابتمسحوش
  const old = await call("PUT", "/api/delivery/free-bar", { enabled: true, autoFirst: true, suggest: true, maxGap: 45, texts: {} });
  assert.deepEqual(old.body.config.trust, { ...TRUST_DEF, enabled: false, checkoutAr: "نفس أسعار الفرع" });
  // رجوع للافتراضي
  const back = await call("PUT", "/api/delivery/free-bar", { trust: { enabled: true, checkoutAr: "" } });
  assert.deepEqual(back.body.config.trust, TRUST_DEF);
  assert.deepEqual(state.data.freeBar.trust, { enabled: true });
});

test("PUT trust: صياغة ممنوعة = 400 banned_wording بالحقل والكلمة، ومفيش كتابة", async () => {
  const { call, state } = makeApp();
  const r = await call("PUT", "/api/delivery/free-bar", { maxGap: 30, trust: { menuAr: "أرخص من التطبيقات" } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { ok: false, error: "banned_wording", field: "menuAr", word: "أرخص" });
  const e = await call("PUT", "/api/delivery/free-bar", { trust: { menuAr: "نفس السعر", checkoutEn: "Same as on Talabat" } });
  assert.deepEqual(e.body, { ok: false, error: "banned_wording", field: "checkoutEn", word: "talabat" });
  assert.equal((await call("PUT", "/api/delivery/free-bar", { trust: { enabled: "x" } })).body.error, "trust.enabled must be boolean");
  assert.equal(state.writes.length, 0);
  // الافتراضيات نفسها بتعدّي لو اتبعتت صريحة
  const ok = await call("PUT", "/api/delivery/free-bar", { trust: { ...TRUST_DEF } });
  assert.equal(ok.status, 200);
  assert.deepEqual(state.data.freeBar.trust, { enabled: true });
});
