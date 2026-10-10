/* 🛍 سلات جاهزة للإعلانات — القواعد الصافية + المسارات (بول وهمي، أوفلاين).
   node --test cartpresets.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

// cms.register/carts.register بيشغّلوا مؤقّتات — unref عشان العملية تقفل (زي offerpages.test.mjs)
const realSI = globalThis.setInterval, realST = globalThis.setTimeout;
globalThis.setInterval = (...a) => { const t = realSI(...a); t?.unref?.(); return t; };
globalThis.setTimeout = (...a) => { const t = realST(...a); t?.unref?.(); return t; };
process.env.CART_RECOVERY_MINUTES = "0"; // من غير مؤقّت الاسترداد جوّه الاختبار
const { register: registerCarts } = await import("./carts.js");
const {
  cleanPresetItems, presetBody, presetLandingUrl, presetRestorePayload, newPresetCode, PRESET_CODE_RE,
} = await import("./cartpresets.js");
const { sectionOf } = await import("./cms.js");

/* ── قواعد صافية ─────────────────────────────────────────────────────── */

test("الكود المولّد دايماً بشكل /c/ اللي المتجر بيقبله", () => {
  for (let i = 0; i < 50; i++) assert.match(newPresetCode(), PRESET_CODE_RE);
});

test("الأصناف: معرّف نصي، كمية ١–٩٩، المكرر بيتجمع، والزبالة بتترمي", () => {
  assert.deepEqual(cleanPresetItems([
    { id: 12, q: 2 }, { id: "12", qty: 1 }, { id: "", q: 3 }, null, "x", { id: "40", q: 0 }, { id: "41", q: 500 },
    { id: "50", q: 1, n: "  برجر  لحم ", p: "24.5" },
  ]), [{ id: "12", q: 3 }, { id: "40", q: 1 }, { id: "41", q: 99 }, { id: "50", q: 1, n: "برجر لحم", p: 24.5 }]);
  assert.deepEqual(cleanPresetItems("nope"), []);
  assert.equal(cleanPresetItems(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }))).length, 60);
});

test("جسم الحفظ: اسم لازم، الكود/الكوبون/السلَج بقواعدهم، والنصوص بتتقص", () => {
  assert.equal(presetBody(null).error, "bad_body");
  assert.equal(presetBody({ name: "  " }).error, "name_required");
  assert.equal(presetBody({ name: "x", code: "AB" }).error, "bad_code");
  assert.equal(presetBody({ name: "x", code: "has-dash1" }).error, "bad_code");
  assert.equal(presetBody({ name: "x", coupon: "FIRST 10%" }).error, "bad_coupon");
  assert.equal(presetBody({ name: "x", link_slug: "-bad-" }).error, "bad_link_slug");
  const { value: v } = presetBody({
    name: "عشا البيت", code: "Dinner89", title: "ت".repeat(200), coupon: " first ", link_slug: "FC-Dinner",
    utm_source: "meta", utm_campaign: "oct-dinner", items: [{ id: 7, q: 2 }], subtotal: "89.004", active: false,
  });
  assert.equal(v.code, "dinner89");
  assert.equal(v.coupon, "FIRST");
  assert.equal(v.link_slug, "fc-dinner");
  assert.equal(Array.from(v.title).length, 80);
  assert.equal(v.subtotal, 89);
  assert.equal(v.active, false);
  assert.equal(v.utm_medium, null);
  assert.equal(presetBody({ name: "x" }).value.code, null, "كود فاضي = السيرفر يولّد");
});

test("رابط الهبوط: cart أولاً، والكوبون/UTM/fc_link بس لو متحددين", () => {
  assert.equal(presetLandingUrl({ code: "dinner89" }), "/?cart=dinner89");
  const u = new URL("https://x" + presetLandingUrl({
    code: "dinner89", coupon: "FIRST", utm_source: "meta", utm_medium: "paid", utm_campaign: "oct dinner",
    utm_content: "reel-1", link_slug: "fc-dinner" }));
  assert.equal(u.pathname, "/");
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    cart: "dinner89", c: "FIRST", utm_source: "meta", utm_medium: "paid", utm_campaign: "oct dinner",
    utm_content: "reel-1", fc_link: "fc-dinner" });
  // لازم يعدّي فحص البروكسي: يبدأ بـ"/" ومش "//"
  assert.ok(presetLandingUrl({ code: "abcdef" }).startsWith("/?"));
});

test("رد الاسترداد للسلة الجاهزة: نفس شكل رد السلة المتروكة + preset/title", () => {
  const p = presetRestorePayload({ items: [{ id: "7", q: 2 }], cart_raw: {}, title: "عشا البيت جاهز في سلتك", title_en: null });
  assert.deepEqual(p, { ok: true, items: [{ id: "7", q: 2 }], raw: null, option: "delivery", preset: true,
    title: "عشا البيت جاهز في سلتك", title_en: "", subtotal: 0, ordered: false });
  const raw = { "b:box:x": { qty: 1, bundle: { slug: "box" } } };
  assert.deepEqual(presetRestorePayload({ items: [], cart_raw: raw }).raw, raw);
});

test("مسارات اللوحة في قسم «النمو» زي باقي السلات", () => {
  assert.equal(sectionOf("/api/carts/presets"), "growth");
  assert.equal(sectionOf("/api/carts/presets/3"), "growth");
  assert.equal(sectionOf("/api/carts/presets/capture"), "growth");
});

/* ── المسارات ────────────────────────────────────────────────────────── */

/* داتابيز وهمية بجدولين: cart_presets و cart_recovery (+ shop_carts للالتقاط) */
function makeApp({ admin = true, recovery = [], carts = [], orders = [], links = [], menuIds = null } = {}) {
  const db = { presets: [], recovery: recovery.map((r) => ({ open_count: 0, ...r })), seq: 0 };
  const pool = {
    async query(sql, p = []) {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s.startsWith("CREATE TABLE") || s.includes("CREATE TABLE IF NOT EXISTS shop_carts")) return { rows: [], rowCount: 0 };
      // ── cart_recovery
      if (s.startsWith("UPDATE cart_recovery SET open_count")) {
        const f = db.recovery.find((x) => x.code === p[0] && !x.expired);
        if (!f) return { rows: [], rowCount: 0 };
        f.open_count++;
        return { rows: [{ phone_norm: f.phone_norm, step1_channel: "sms", step2_at: null }], rowCount: 1 };
      }
      if (s.startsWith("SELECT items, cart_raw, option, subtotal, order_no FROM cart_recovery")) {
        const f = db.recovery.find((x) => x.code === p[0] && !x.expired);
        return { rows: f ? [f] : [], rowCount: f ? 1 : 0 };
      }
      if (s.startsWith("SELECT 1 FROM cart_recovery WHERE code")) {
        const n = db.recovery.filter((x) => x.code === p[0]).length;
        return { rows: n ? [{}] : [], rowCount: n };
      }
      if (s.includes("FROM shop_orders WHERE phone_norm=$1")) return { rows: [{ paid: 0, coupon: 1 }], rowCount: 1 };
      // 5/10 coupon rules (couponrules.js): FIRST row + «used once» / «prior delivery» lookups — a first-time customer
      if (s.includes("FROM shop_coupons WHERE upper(code)='FIRST'")) return { rows: [{ code: "FIRST", percent: 0, active: true, expires_at: null, free_delivery: true }], rowCount: 1 };
      if (s.includes("FROM shop_orders") && (s.includes("WHERE coupon=$1 AND phone_norm=$2") || s.includes("so.option='delivery'"))) return { rows: [], rowCount: 0 };
      // ── cart_presets
      if (s.startsWith("UPDATE cart_presets SET opens")) {
        const f = db.presets.find((x) => x.code === p[0] && x.active);
        if (!f) return { rows: [], rowCount: 0 };
        f.opens++;
        return { rows: [f], rowCount: 1 };
      }
      if (s.startsWith("SELECT items, cart_raw, title, title_en, subtotal FROM cart_presets")) {
        const f = db.presets.find((x) => x.code === p[0] && x.active);
        return { rows: f ? [f] : [], rowCount: f ? 1 : 0 };
      }
      if (s.startsWith("SELECT 1 FROM cart_presets WHERE code") || s.startsWith("SELECT id FROM cart_presets WHERE code")) {
        const f = db.presets.filter((x) => x.code === p[0]);
        return { rows: f, rowCount: f.length };
      }
      if (s.startsWith("SELECT * FROM cart_presets WHERE id")) {
        const f = db.presets.filter((x) => x.id === p[0]);
        return { rows: f, rowCount: f.length };
      }
      if (s.startsWith("SELECT * FROM cart_presets ORDER BY")) return { rows: [...db.presets], rowCount: db.presets.length };
      if (s.startsWith("INSERT INTO cart_presets")) {
        if (db.presets.some((x) => x.code === p[0])) throw new Error("duplicate key value violates unique constraint");
        const row = { id: ++db.seq, code: p[0], name: p[1], title: p[2], title_en: p[3], items: JSON.parse(p[4]),
          cart_raw: p[5] ? JSON.parse(p[5]) : null, subtotal: p[6], coupon: p[7], utm_source: p[8], utm_medium: p[9],
          utm_campaign: p[10], utm_content: p[11], link_slug: p[12], active: p[13], created_by: p[14], opens: 0 };
        db.presets.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (s.startsWith("UPDATE cart_presets SET active=$2")) {
        const f = db.presets.find((x) => x.id === p[0]);
        if (f) f.active = p[1];
        return { rows: f ? [f] : [], rowCount: f ? 1 : 0 };
      }
      if (s.startsWith("UPDATE cart_presets SET code=$2")) {
        const f = db.presets.find((x) => x.id === p[0]);
        Object.assign(f, { code: p[1], name: p[2], title: p[3], title_en: p[4], items: JSON.parse(p[5]),
          cart_raw: p[6] ? (p[7] ? JSON.parse(p[7]) : null) : f.cart_raw, subtotal: p[8], coupon: p[9], utm_source: p[10],
          utm_medium: p[11], utm_campaign: p[12], utm_content: p[13], link_slug: p[14], active: p[15] });
        return { rows: [f], rowCount: 1 };
      }
      if (s.startsWith("DELETE FROM cart_presets")) {
        const n = db.presets.length;
        db.presets = db.presets.filter((x) => x.id !== p[0]);
        return { rows: [], rowCount: n - db.presets.length };
      }
      // ── اللي حواليهم
      if (s.includes("FROM cms_links WHERE target_type='cart'")) return { rows: links, rowCount: links.length };
      if (s.includes("FROM shop_orders WHERE attribution->>'fc_link' = ANY")) {
        const rows = orders.filter((o) => p[0].includes(o.slug));
        return { rows, rowCount: rows.length };
      }
      if (s.includes("FROM shop_coupons ORDER BY code")) {
        return { rows: [{ code: "FIRST", min_total: "60", free_delivery: true, percent: 0, active: true, expires_at: null }], rowCount: 1 };
      }
      if (s.includes("FROM shop_carts WHERE device_id=$1")) {
        const f = carts.filter((x) => x.device_id === p[0]);
        return { rows: f, rowCount: f.length };
      }
      if (s.includes("FROM shop_carts WHERE phone_norm=$1")) {
        const f = carts.filter((x) => x.phone_norm === p[0]).sort((a, b) => Number(!!b.cart_raw) - Number(!!a.cart_raw));
        return { rows: f.slice(0, 1), rowCount: Math.min(1, f.length) };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const app = new Hono();
  const ctx = {
    pool,
    requireAdmin: async (c) => (admin ? null : c.json({ error: "Unauthorized" }, 401)),
    getSettingsData: async () => ({}),
    jb: (v) => JSON.stringify(v),
    normPhone: (v) => String(v || "").replace(/\D/g, "").replace(/^(966|0)/, ""),
  };
  registerCarts(app, ctx, { presetMenuIds: menuIds ? async () => new Set(menuIds) : async () => null });
  const call = async (method, path, body) => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { app, db, call };
}

test("إنشاء سلة ← /c/<code> بيفتحها: open بيعدّ ويبني الرابط، وGET بيرجّع الأصناف", async () => {
  const { call, db } = makeApp();
  const c = await call("POST", "/api/carts/presets", {
    name: "عشا البيت", code: "dinner89", title: "عشا البيت جاهز في سلتك", coupon: "first",
    utm_source: "meta", utm_medium: "paid", utm_campaign: "oct-dinner", link_slug: "fc-dinner",
    items: [{ id: 7, q: 2 }, { id: 9, q: 1 }], subtotal: 89 });
  assert.equal(c.status, 200);
  assert.equal(c.body.url, "https://freshcuts.sa/c/dinner89");
  assert.equal(c.body.preset.code, "dinner89");

  for (let i = 0; i < 2; i++) {
    const o = await call("POST", "/api/carts/restore/dinner89/open", { s: "" });
    assert.equal(o.status, 200);
    assert.equal(o.body.url, "/?cart=dinner89&c=FIRST&utm_source=meta&utm_medium=paid&utm_campaign=oct-dinner&fc_link=fc-dinner");
  }
  assert.equal(db.presets[0].opens, 2, "مفيش one-shot: كل فتحة بتتعد والرابط بيفضل شغّال");

  const g = await call("GET", "/api/carts/restore/dinner89");
  assert.equal(g.status, 200);
  assert.deepEqual(g.body, { ok: true, items: [{ id: "7", q: 2 }, { id: "9", q: 1 }], raw: null, option: "delivery",
    preset: true, title: "عشا البيت جاهز في سلتك", title_en: "", subtotal: 89, ordered: false });
});

test("سلة موقوفة أو كود مجهول = نفس رد الكود المجهول بالظبط", async () => {
  const { call } = makeApp();
  const c = await call("POST", "/api/carts/presets", { name: "x", code: "paused01", items: [{ id: 1 }] });
  await call("PUT", `/api/carts/presets/${c.body.preset.id}`, { active: false });
  const unknownOpen = await call("POST", "/api/carts/restore/nosuch01/open", {});
  const pausedOpen = await call("POST", "/api/carts/restore/paused01/open", {});
  assert.deepEqual([pausedOpen.status, pausedOpen.body], [unknownOpen.status, unknownOpen.body]);
  assert.deepEqual([unknownOpen.status, unknownOpen.body], [404, { ok: false }]);
  const unknownGet = await call("GET", "/api/carts/restore/nosuch01");
  const pausedGet = await call("GET", "/api/carts/restore/paused01");
  assert.deepEqual([pausedGet.status, pausedGet.body], [unknownGet.status, unknownGet.body]);
  assert.deepEqual([unknownGet.status, unknownGet.body], [404, { ok: false, error: "expired" }]);
  // كود بشكل غلط لسه 404 قبل أي استعلام
  assert.equal((await call("GET", "/api/carts/restore/BAD!")).status, 404);
});

test("رابط الاسترداد القديم ماتغيّرش: cart_recovery بيكسب، وبنفس شكل الرد", async () => {
  const { call, db } = makeApp({ recovery: [{ code: "abcd1234", phone_norm: "512345678", items: [{ id: "3", q: 1 }],
    cart_raw: null, option: "pickup", subtotal: "45", order_no: null }] });
  const o = await call("POST", "/api/carts/restore/abcd1234/open", { s: "push" });
  assert.equal(o.status, 200);
  const q = new URL("https://x" + o.body.url).searchParams;
  assert.equal(q.get("cart"), "abcd1234");
  assert.equal(q.get("utm_source"), "push");
  assert.equal(q.get("utm_campaign"), "cart_recovery");
  assert.equal(q.get("fc_link"), "cart-recovery");
  assert.equal(q.get("c"), "FIRST");
  assert.equal(db.recovery[0].open_count, 1);
  const g = await call("GET", "/api/carts/restore/abcd1234");
  assert.deepEqual(g.body, { ok: true, items: [{ id: "3", q: 1 }], raw: null, option: "pickup", subtotal: 45, ordered: false });
  assert.equal("preset" in g.body, false);
});

test("الكود مايتصادمش: مع سلة جاهزة تانية أو مع أي رابط استرداد (حتى المنتهي)", async () => {
  const { call } = makeApp({ recovery: [{ code: "oldflow1", phone_norm: "512345678", expired: true }] });
  assert.equal((await call("POST", "/api/carts/presets", { name: "a", code: "oldflow1", items: [{ id: 1 }] })).status, 409);
  const a = await call("POST", "/api/carts/presets", { name: "a", code: "mycode01", items: [{ id: 1 }] });
  assert.equal(a.status, 200);
  const dup = await call("POST", "/api/carts/presets", { name: "b", code: "mycode01", items: [{ id: 1 }] });
  assert.deepEqual([dup.status, dup.body.error], [409, "code_taken"]);
  // من غير كود: السيرفر بيولّد واحد صالح
  const gen = await call("POST", "/api/carts/presets", { name: "c", items: [{ id: 1 }] });
  assert.match(gen.body.preset.code, PRESET_CODE_RE);
  // تعديل بنفس الكود مسموح، وبكود سلة تانية مرفوض
  const same = await call("PUT", `/api/carts/presets/${a.body.preset.id}`, { name: "a2", code: "mycode01", items: [{ id: 1 }] });
  assert.equal(same.status, 200);
  const clash = await call("PUT", `/api/carts/presets/${gen.body.preset.id}`, { name: "c", code: "mycode01", items: [{ id: 1 }] });
  assert.equal(clash.status, 409);
});

test("التحقق: سلة فاضية مرفوضة، والأصناف اللي مش في المنيو تحذير مش منع", async () => {
  const { call } = makeApp({ menuIds: ["7", "9"] });
  assert.equal((await call("POST", "/api/carts/presets", { name: "x", items: [] })).body.error, "empty_cart");
  assert.equal((await call("POST", "/api/carts/presets", { name: "", items: [{ id: 7 }] })).body.error, "name_required");
  const r = await call("POST", "/api/carts/presets", { name: "x", items: [{ id: 7 }, { id: 999 }, { id: "b:box:1" }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.unknownIds, ["999"], "معرّفات الباقات (مش أرقام) مابتتفحصش على المنيو");
});

test("اللقطة الخام: بتتحفظ وبترجع زي ما هي، والتعديل من غير cart_raw مابيمسحهاش", async () => {
  const { call } = makeApp();
  const raw = { "b:nd96-box:x": { qty: 1, bundle: { slug: "nd96-box" }, lines: [{ id: 5 }] }, "12": { item: { id: 12 }, qty: 2, note: "بدون بصل" } };
  const c = await call("POST", "/api/carts/presets", { name: "بوكس", code: "boxcart1", items: [], cart_raw: raw });
  assert.equal(c.status, 200, "لقطة خام من غير items كفاية");
  assert.deepEqual((await call("GET", "/api/carts/restore/boxcart1")).body.raw, raw);
  const id = c.body.preset.id;
  await call("PUT", `/api/carts/presets/${id}`, { name: "بوكس ٢", items: [] });
  assert.deepEqual((await call("GET", "/api/carts/restore/boxcart1")).body.raw, raw);
  // مسح اللقطة صراحةً من غير أصناف = سلة فاضية
  assert.equal((await call("PUT", `/api/carts/presets/${id}`, { name: "بوكس", items: [], cart_raw: null })).body.error, "empty_cart");
  const sw = await call("PUT", `/api/carts/presets/${id}`, { name: "بوكس", items: [{ id: 12, q: 2 }], cart_raw: null });
  assert.equal(sw.status, 200);
  assert.equal((await call("GET", "/api/carts/restore/boxcart1")).body.raw, null);
  // لقطة أكبر من ٤٠KB مرفوضة (نفس سقف لقطة المتجر)
  const big = {}; for (let i = 0; i < 60; i++) big["k" + i] = { pad: "x".repeat(1000) };
  assert.equal((await call("POST", "/api/carts/presets", { name: "big", items: [], cart_raw: big })).body.error, "cart_raw_too_big");
});

test("القايمة: الرابط، الفتحات، الطلبات المنسوبة بالسلَج، وحد الكوبون من الداتابيز", async () => {
  const { call } = makeApp({
    links: [{ slug: "ad-dinner", target_id: "dinner89", active: true, clicks: 12 }],
    orders: [{ slug: "fc-dinner", n: 3, revenue: 300.4 }, { slug: "ad-dinner", n: 2, revenue: 150 }, { slug: "other", n: 9, revenue: 900 }],
  });
  await call("POST", "/api/carts/presets", { name: "عشا", code: "dinner89", link_slug: "fc-dinner", items: [{ id: 7 }] });
  await call("POST", "/api/carts/presets", { name: "من غير سلَج", code: "noslug01", items: [{ id: 7 }] });
  await call("POST", "/api/carts/restore/dinner89/open", {});
  const l = await call("GET", "/api/carts/presets");
  assert.equal(l.status, 200);
  const a = l.body.presets.find((x) => x.code === "dinner89");
  assert.equal(a.url, "https://freshcuts.sa/c/dinner89");
  assert.equal(a.opens, 1);
  assert.equal(a.orders, 5);
  assert.equal(a.revenue, 450);
  assert.deepEqual(a.links, [{ slug: "ad-dinner", active: true, clicks: 12 }]);
  const b = l.body.presets.find((x) => x.code === "noslug01");
  assert.equal(b.orders, null, "من غير سلَج مانقدرش ننسب — null مش صفر");
  assert.deepEqual(l.body.coupons, [{ code: "FIRST", minTotal: 60, freeDelivery: true, percent: 0, active: true }]);
});

test("الالتقاط من سلة محفوظة: بالجوال (بأي صيغة) أو بالجهاز، واللقطة الخام الأول", async () => {
  const raw = { "b:box:1": { qty: 1, bundle: { slug: "box" } } };
  const { call } = makeApp({ carts: [
    { device_id: "devaaaa11", phone_norm: "512345678", items: [{ id: "3", n: "برجر", q: 1, p: 20 }], cart_raw: null, subtotal: "20", item_count: 1, option: "delivery", stage: "cart", updated_at: "2026-10-10T10:00:00Z" },
    { device_id: "devbbbb22", phone_norm: "512345678", items: [{ id: "b:box:1", n: "بوكس", q: 1, p: 96 }], cart_raw: raw, subtotal: "96", item_count: 1, option: "delivery", stage: "checkout", updated_at: "2026-10-09T10:00:00Z" },
  ] });
  const p = await call("POST", "/api/carts/presets/capture", { phone: "0512345678" });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.cart.cart_raw, raw);
  assert.equal(p.body.cart.hasRaw, true);
  assert.equal(p.body.cart.subtotal, 96);
  assert.deepEqual(p.body.cart.items, [{ id: "b:box:1", q: 1, n: "بوكس", p: 96 }]);
  const d = await call("POST", "/api/carts/presets/capture", { device: "devaaaa11" });
  assert.equal(d.body.cart.hasRaw, false);
  assert.deepEqual(d.body.cart.items, [{ id: "3", q: 1, n: "برجر", p: 20 }]);
  assert.equal((await call("POST", "/api/carts/presets/capture", { phone: "123" })).body.error, "bad_phone");
  assert.equal((await call("POST", "/api/carts/presets/capture", { device: "x" })).body.error, "bad_device");
  assert.equal((await call("POST", "/api/carts/presets/capture", { phone: "0599999999" })).status, 404);
});

test("مسارات اللوحة كلها ورا requireAdmin، والعامّين مفتوحين", async () => {
  const { call } = makeApp({ admin: false });
  for (const [m, p] of [["GET", "/api/carts/presets"], ["POST", "/api/carts/presets"], ["PUT", "/api/carts/presets/1"],
    ["DELETE", "/api/carts/presets/1"], ["POST", "/api/carts/presets/capture"]]) {
    assert.equal((await call(m, p, m === "GET" ? undefined : {})).status, 401, `${m} ${p}`);
  }
  assert.equal((await call("GET", "/api/carts/restore/nosuch01")).status, 404);
});

test("الحذف بيشيل السلة والرابط بيرجع 404", async () => {
  const { call } = makeApp();
  const c = await call("POST", "/api/carts/presets", { name: "x", code: "delme001", items: [{ id: 1 }] });
  assert.deepEqual((await call("DELETE", `/api/carts/presets/${c.body.preset.id}`)).body, { ok: true, deleted: 1 });
  assert.equal((await call("POST", "/api/carts/restore/delme001/open", {})).status, 404);
});

/* ── رابط حملة /l/<slug> هدفه سلة جاهزة (cms.js) ─────────────────────── */
const cms = await import("./cms.js");

function makeLinksApp({ link, preset }) {
  const state = { opens: 0, saved: null };
  const pool = {
    async query(sql, p = []) {
      const s = sql.replace(/\s+/g, " ").trim();
      if (/^UPDATE cms_links SET clicks/i.test(s) || /^SELECT \* FROM cms_links WHERE slug=\$1 AND active/i.test(s)) {
        return { rows: link && p[0] === link.slug ? [link] : [], rowCount: 1 };
      }
      if (/^UPDATE cart_presets SET opens/i.test(s) || /^SELECT code, coupon FROM cart_presets/i.test(s)) {
        const hit = preset && preset.active !== false && p[0] === preset.code;
        if (hit && /^UPDATE/i.test(s)) state.opens++;
        return { rows: hit ? [preset] : [], rowCount: hit ? 1 : 0 };
      }
      if (/^INSERT INTO cms_links/i.test(s)) {
        state.saved = { target_type: p[2], target_id: p[3] };
        return { rows: [{ id: 1, slug: p[0], target_type: p[2], target_id: p[3] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const app = new Hono();
  cms.register(app, {
    pool, jb: (x) => JSON.stringify(x), DEFAULT_DELIVERY_APPS: [], todayISO: () => "2026-10-10",
    getSettingsData: async () => ({}), setCmsHooks: () => {}, requireAdmin: async () => null,
  }, { notify: () => null });
  const call = async (method, path, body) => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { call, state };
}

test("رابط حملة هدفه سلة: بيهبط على ?cart=<code> بـUTM الرابط وfc_link بتاعه، وبيعدّ فتحة", async () => {
  const link = { slug: "ad-dinner", target_type: "cart", target_id: "dinner89", utm_source: "meta", utm_medium: "paid",
    utm_campaign: "oct-dinner", coupon: null };
  const { call, state } = makeLinksApp({ link, preset: { code: "dinner89", coupon: "FIRST" } });
  const r = await call("POST", "/api/cms/links/resolve/ad-dinner", { ua: "Mozilla/5.0 (iPhone)", ip: "51.36.9.9" });
  assert.equal(r.status, 200);
  assert.ok(r.body.url.startsWith("/?"));
  const q = new URL("https://x" + r.body.url).searchParams;
  assert.equal(q.get("cart"), "dinner89");
  assert.equal(q.get("c"), "FIRST", "كوبون السلة لما الرابط مالوش كوبون");
  assert.equal(q.get("utm_source"), "meta");
  assert.equal(q.get("utm_campaign"), "oct-dinner");
  assert.equal(q.get("fc_link"), "ad-dinner", "الإسناد بسلَج الرابط — الحارس والتقارير زي ما هم");
  assert.equal(state.opens, 1);
});

test("رابط حملة هدفه سلة: كوبون الرابط بيكسب، والسلة الموقوفة = الرئيسية بالـUTM (الإعلان مايقعش)", async () => {
  const link = { slug: "ad-dinner2", target_type: "cart", target_id: "dinner89", utm_source: "snapchat", utm_medium: "paid",
    utm_campaign: null, coupon: "WELCOME" };
  const a = makeLinksApp({ link, preset: { code: "dinner89", coupon: "FIRST" } });
  const qa = new URL("https://x" + (await a.call("POST", "/api/cms/links/resolve/ad-dinner2", { ip: "51.36.9.10" })).body.url).searchParams;
  assert.equal(qa.get("c"), "WELCOME");
  assert.equal(qa.get("cart"), "dinner89");
  const b = makeLinksApp({ link, preset: { code: "dinner89", coupon: "FIRST", active: false } });
  const rb = await b.call("POST", "/api/cms/links/resolve/ad-dinner2", { ip: "51.36.9.11" });
  assert.equal(rb.status, 200);
  const qb = new URL("https://x" + rb.body.url).searchParams;
  assert.equal(qb.get("cart"), null);
  assert.equal(qb.get("fc_link"), "ad-dinner2");
  assert.equal(qb.get("c"), "WELCOME");
});

test("حفظ رابط حملة بهدف «cart»: النوع بيتقبل والكود بيتحفظ lowercase", async () => {
  const { call, state } = makeLinksApp({});
  const r = await call("POST", "/api/cms/links", { slug: "ad-dinner", label: "x", target_type: "cart", target_id: "Dinner89", utm_source: "meta" });
  assert.equal(r.status, 200);
  assert.deepEqual(state.saved, { target_type: "cart", target_id: "dinner89" });
});
