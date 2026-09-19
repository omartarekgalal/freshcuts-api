/* ═══════════════════════════════════════════════════════════════════════════
   سلامة الإعدادات (٢٠٢٦-٠٩-١٩) — «كل قيمة ليها مصدر واحد، وكل مستهلك بيقرا منه»

     ١) العروض: عرض جديد بالكامل من اللوحة (سعر/تواريخ/قنوات/نص المتجر/بادج/صور)
        من غير كود، وعروض ٩٦ فضلت زي ما هي بالحرف
     ٢) نافذة الإعلانات من مواعيد المطعم = نفس الأرقام اليدوية القديمة
     ٣) ساعات هدوء SMS: مصدر واحد (settings.cms.campaigns)
     ٤) حالة النظام: الحالات والخلاصة

     node --test settings-integrity.test.mjs
═══════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";

const offers = await import("./offers.js");
const { adsWindow, storeHoursWindow } = await import("./autopilot.js");
const smsRules = await import("./smsrules.js");
const health = await import("./syshealth.js");
const { bundleAvailability } = await import("./bundles.js");

/* داتابيز مزيّفة بتفهم أعمدة offer_registry الجديدة */
function fakePool() {
  const table = new Map();
  const J = (v) => (v == null ? null : typeof v === "string" ? JSON.parse(v) : v);
  return {
    table,
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (/^INSERT INTO offer_registry .*custom, price, catalog_title, extra/i.test(s)) {
        if (table.has(p[0])) { const e = new Error("dup"); e.code = "23505"; throw e; }
        table.set(p[0], { id: p[0], enabled: p[1], from_day: p[2], until_day: p[3], until_provisional: p[4], title: p[5],
          description: p[6], channels: J(p[7]), updated_by: p[8], custom: true, price: p[9], catalog_title: p[10], extra: J(p[11]),
          created_at: new Date().toISOString() });
        return { rows: [], rowCount: 1 };
      }
      if (/^INSERT INTO offer_registry/i.test(s)) {
        if (table.has(p[0])) return { rows: [], rowCount: 0 };
        table.set(p[0], { id: p[0], enabled: p[1], from_day: p[2], until_day: p[3], until_provisional: p[4],
          title: p[5], description: p[6], channels: J(p[7]), custom: false });
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE offer_registry SET extra/i.test(s)) {
        const r = table.get(p[0]); if (!r) return { rowCount: 0, rows: [] };
        if (p[1]) r.extra = J(p[2]);
        if (p[3] != null) r.price = p[3];
        if (p[4] != null) r.catalog_title = p[4];
        return { rowCount: 1, rows: [r] };
      }
      if (/^UPDATE offer_registry/i.test(s)) {
        const r = table.get(p[0]); if (!r) return { rowCount: 0, rows: [] };
        Object.assign(r, { enabled: p[1], from_day: p[2], until_day: p[3], until_provisional: p[4], title: p[5], description: p[6], channels: J(p[7]) });
        return { rowCount: 1, rows: [r] };
      }
      if (/^DELETE FROM offer_registry/i.test(s)) { table.delete(p[0]); return { rowCount: 1, rows: [] }; }
      if (/FROM offer_registry/i.test(s)) return { rows: [...table.values()].map((r) => ({ ...r })) };
      return { rows: [], rowCount: 0 };
    },
  };
}
async function fresh() {
  offers.resetOffersToSeed();
  const pool = fakePool();
  await offers.ensureOffersSchema(pool);
  await offers.loadOffers(pool);
  return pool;
}
const at = (d) => new Date(`${d}T12:00:00Z`);

test("ND96: نص المتجر والصور والبادج بقوا في السجل — بنفس القيم اللي كانت في app.js بالحرف", async () => {
  await fresh();
  const k = offers.publicOffer(offers.offerById("nd96_kilo"), at("2026-09-19"));
  assert.deepEqual(k.copy, { title: "كيلو مشاوي بـ٩٦", line: "كفتة أو طرب أو شيش طاووق أو صدور + طبق أرز مجاناً", cta: "اختار المشوي ←" });
  assert.deepEqual(k.badgeItems, { items: ["91", "94", "114", "111"], variant: "كيلو" });
  assert.deepEqual(k.art, { web: "/static/offers/nd96_kilo-web.jpg?v=4", wide: "/static/offers/nd96_kilo-wide.jpg?v=4" });
  assert.equal(k.bundleSlug, "national96-grill");
  assert.deepEqual(k.includes, ["سلطة وطحينة وخبز مع المشاوي"]);
  const b = offers.publicOffer(offers.offerById("nd96_box"), at("2026-09-19"));
  assert.equal(b.copy.cta, "كوّن البوكس ←");
  assert.equal(b.bundleSlug, "national96-box");
  assert.equal(b.price, 96);
  assert.equal(k.custom, false);
});

test("تعديل نص المتجر لعرض ٩٦ من اللوحة — السعر فضل مقفول، و«وفّر» مرفوضة في النص الجديد كمان", async () => {
  const pool = await fresh();
  const cur = offers.offerById("nd96_kilo").extra;
  const r = await offers.saveOffer(pool, "nd96_kilo", { extra: { ...cur, copy: { ...cur.copy, cta: "اطلب الكيلو ←" } } }, "t");
  assert.equal(r.ok, true, r.message);
  assert.ok(r.changed.includes("extra"));
  assert.equal(offers.offerById("nd96_kilo").copy.cta, "اطلب الكيلو ←");
  assert.equal(offers.offerById("nd96_kilo").price, 96);
  const bad = await offers.saveOffer(pool, "nd96_kilo", { extra: { copy: { title: "وفّر ٢٠٪" } } }, "t");
  assert.equal(bad.error, "savings_claim_forbidden");
  const art = await offers.saveOffer(pool, "nd96_kilo", { extra: { art: { web: "javascript:alert(1)" } } }, "t");
  assert.equal(art.error, "bad_art_url");
  const locked = await offers.saveOffer(pool, "nd96_kilo", { price: 80 }, "t");
  assert.equal(locked.error, "locked_field");
});

test("عرض جديد بالكامل من اللوحة: بيتعمل موقوف، بيتشغّل، بيظهر للمتجر، وسعره قابل للتعديل", async () => {
  const pool = await fresh();
  const bad = await offers.createOffer(pool, { id: "Ramadan 1", title: "x", price: 50, until: "2026-10-30" }, "t");
  assert.equal(bad.error, "bad_id");
  const dup = await offers.createOffer(pool, { id: "nd96_kilo", title: "x", price: 50, until: "2026-10-30" }, "t");
  assert.equal(dup.error, "id_taken");
  const r = await offers.createOffer(pool, {
    id: "family_box", title: "بوكس العيلة", price: 149, from: "2026-10-01", until: "2026-10-31",
    channels: { dineIn: false, takeaway: true, delivery: true },
    extra: { copy: { title: "بوكس العيلة ١٤٩", line: "٤ مشاوي + ٢ أرز", cta: "كوّن البوكس ←" }, gifts: ["بيبسي لتر"],
      badgeItems: { items: ["91", "x"], variant: "كيلو" }, bundleSlug: "family-box" },
    components: ["٤ مشاوي", "٢ أرز"],
  }, "المالك");
  assert.equal(r.ok, true, r.message);
  const o = offers.offerById("family_box");
  assert.equal(o.custom, true);
  assert.equal(o.enabled, false, "العرض الجديد بيبدأ موقوف");
  assert.equal(o.price, 149);
  assert.equal(o.productId, "offer-family_box");
  assert.deepEqual(o.badgeItems.items, ["91"], "الأرقام بس");
  assert.deepEqual(o.components.map((c) => c.label), ["٤ مشاوي", "٢ أرز"]);
  const pub = offers.publicOffer(o, at("2026-10-05"));
  assert.equal(pub.onlineOnly, true);
  assert.equal(pub.status, "disabled");
  // تشغيل + تعديل السعر (المخصّص: السعر مش مقفول)
  const on = await offers.saveOffer(pool, "family_box", { enabled: true, price: 159 }, "t");
  assert.equal(on.ok, true, on.message);
  assert.ok(on.changed.includes("price"));
  assert.equal(offers.offerById("family_box").price, 159);
  assert.equal(offers.publicOffer(offers.offerById("family_box"), at("2026-10-05")).status, "live");
  assert.ok(offers.activeOffers(at("2026-10-05")).some((x) => x.id === "family_box"));
  // الباقة المربوطة بتاخد حالة العرض المخصّص زي ٩٦ بالظبط
  const av = bundleAvailability({ offer_id: "family_box", active: true }, offers.publicOffer(offers.offerById("family_box"), at("2026-10-05")));
  assert.equal(av.orderable, true);
  assert.deepEqual(av.kinds.sort(), ["delivery", "pickup"]);
  // إعادة التحميل من الجدول بتحافظ على كل ده
  await offers.loadOffers(pool);
  assert.equal(offers.offerById("family_box").copy.title, "بوكس العيلة ١٤٩");
  // لسه مابدأش (من ١ أكتوبر) ومالوش صفحة منشورة ⇒ يتمسح
  const del = await offers.deleteOffer(pool, "family_box");
  assert.equal(del.ok, true, del.message);
  assert.equal(offers.offerById("family_box"), null);
  const seedDel = await offers.deleteOffer(pool, "nd96_box");
  assert.equal(seedDel.error, "seed_offer");
});

test("عرض مخصّص: «وفّر» ممنوعة، وتاريخ نهاية إجباري، وتطبيقات التوصيل مقفولة", async () => {
  const pool = await fresh();
  assert.equal((await offers.createOffer(pool, { id: "aa1", title: "خصم الشتاء", price: 50, until: "2026-10-30" }, "t")).error, "savings_claim_forbidden");
  assert.equal((await offers.createOffer(pool, { id: "aa2", title: "بوكس", price: 50 }, "t")).error, "until_required");
  assert.equal((await offers.createOffer(pool, { id: "aa3", title: "بوكس", price: 0, until: "2026-10-30" }, "t")).error, "bad_price");
  assert.equal((await offers.createOffer(pool, { id: "aa4", title: "بوكس", price: 50, until: "2026-10-30",
    channels: { delivery: true, deliveryApps: true } }, "t")).error, "delivery_apps_locked");
});

test("نافذة الإعلانات من مواعيد المطعم = نفس الأرقام اليدوية (١١ → ٢، الخميس/الجمعة ٣) على مدار أسبوعين", () => {
  const hours = { enabled: true, days: Object.fromEntries(["sun", "mon", "tue", "wed", "sat"].map((d) => [d, { open: "12:00", close: "02:00" }])
    .concat([["thu", { open: "12:00", close: "03:00" }], ["fri", { open: "12:00", close: "03:00" }]])) };
  const manual = { adsOpenHour: 11, adsCloseHour: 2, adsLateCloseHour: 3, adsLateNightDows: [4, 5] };
  for (let h = 0; h < 24 * 14; h++) {
    const t = new Date(Date.UTC(2026, 8, 14) + h * 3600e3 + 600e3);
    const a = adsWindow(t, { ...manual, adsFollowStoreHours: false });
    const b = adsWindow(t, { ...manual, storeHours: hours });
    assert.equal(b.source, "store_hours");
    assert.deepEqual([b.open, b.openHour, b.closeHour, b.late], [a.open, a.openHour, a.closeHour, a.late], t.toISOString());
  }
  // تغيير المواعيد في مكان واحد بيحرّك الإعلانات
  const late = { ...hours, days: { ...hours.days, sat: { open: "14:00", close: "01:00" } } };
  assert.deepEqual(storeHoursWindow(late, 6), { closed: false, openHour: 13, closeHour: 1 });
  const closed = { ...hours, days: { ...hours.days, sat: { closed: true } } };
  const sat = adsWindow(new Date("2026-09-19T15:00:00Z"), { storeHours: closed });
  assert.equal(sat.open, false);
  // مفيش مواعيد ⇒ الأرقام اليدوية
  assert.equal(adsWindow(new Date(), manual).source, "manual");
});

test("ساعات هدوء SMS: مصدر واحد — الافتراضي ٢٢→١٢، والإعداد بيغيّرها لكل المستهلكين", () => {
  assert.deepEqual(smsRules.quietOf({}), { start: 22, end: 12 });
  const s = { cms: { campaigns: { quietStart: 23, quietEnd: 11 } } };
  assert.deepEqual(smsRules.quietOf(s), { start: 23, end: 11 });
  assert.equal(smsRules.quietText(smsRules.quietOf(s)), "23:00–11:00");
  const riyadh = (h) => new Date(Date.UTC(2026, 8, 19, (h - 3 + 24) % 24, 5));
  assert.equal(smsRules.inQuietFor({}, riyadh(22)), true);
  assert.equal(smsRules.inQuietFor(s, riyadh(22)), false);
  assert.equal(smsRules.inQuietFor(s, riyadh(11)), false);
  assert.equal(smsRules.inQuietFor(s, riyadh(10)), true);
  assert.deepEqual(smsRules.quietOf({ cms: { campaigns: { quietStart: 99 } } }), { start: 22, end: 12 }, "قيمة غلط ⇒ الافتراضي");
});

test("حالة النظام: الحداثة والخلاصة", () => {
  const ago = (m) => new Date(Date.now() - m * 60000);
  assert.equal(health.freshness(ago(5), { warnMin: 15, badMin: 45 }), "good");
  assert.equal(health.freshness(ago(20), { warnMin: 15, badMin: 45 }), "warn");
  assert.equal(health.freshness(ago(60), { warnMin: 15, badMin: 45 }), "bad");
  assert.equal(health.freshness(ago(60), { warnMin: 15, badMin: 45, open: false }), "good", "المطعم قافل ⇒ السكوت طبيعي");
  assert.equal(health.freshness(null, { warnMin: 1, badMin: 2 }), "unknown");
  const c = (st) => health.comp("x", "core", "X", st, "سطر");
  assert.equal(health.overallOf([c("good"), c("good")]).tone, "good");
  assert.equal(health.overallOf([c("good"), c("unknown")]).tone, "warn");
  const bad = health.overallOf([c("warn"), c("bad")]);
  assert.equal(bad.tone, "bad");
  assert.equal(bad.counts.bad, 1);
  assert.ok(c("good").checkedAt);
});
