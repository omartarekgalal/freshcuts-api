/* «طلب تطبيق توصيل» = source = delivery_app، مش «النوت مش فاضية» — node --test app-source.test.mjs

   الحادثة (١٣/١٠): طلبات متجرنا بتتكتب في order_sources بـsource = 'website' ورقم الطلب في source_note (posnames.js).
   اختبار cms.js كان «النوت مش فاضية» ⇒ ١٦٧ من ١٧١ عميل موقع اتعلّموا «عميل كيتا» و١٠٣ منهم دخلوا شريحتَي كيتا.

   الاختبار هنا:
     • القاعدة نفسها (identity.js) على صفوف زي اللي في الجدول، منها صف طلب موقع؛
     • صفوف بتعدّي من نفس الفلتر وبعدين من نفس تجميع وشرايح smsrules.js ⇒ عميل الموقع بره شرايح كيتا والتطبيقات؛
     • كل مكان في الكود كان بيقرا الشرط القديم بقى بيقرا القاعدة.
   الـSQL نفسه بيتجرّب على Postgres الحقيقي بصفوف حرفية من الشريحة (slices/AP1-…/sqlcheck.mjs) — مفيش Postgres في اختبارات الريبو. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { APP_SOURCE, appSourceSql, appNoteSql, websiteSourceSql, isAppSource } from "./identity.js";
import * as rules from "./smsrules.js";

const rd = (f) => readFileSync(new URL("./" + f, import.meta.url), "utf8");
/* نفس أشكال الصفوف اللي على السيرفر النهارده (القياس: delivery_app/feedus/keeta، website/shop/رقم الطلب، …) */
const ROWS = [
  { order_id: 1, source: "website", source_note: "W1790000000001", filled_by: "shop", phone_norm: "500000001", items: [["مشاوي مشكل (كيلو)", 96]] },   // عميل موقع بس
  { order_id: 2, source: "delivery_app", source_note: "Keeta", filled_by: "feedus", phone_norm: "500000002", items: [["مشاوي مشكل (كيلو)", 120]] },   // عميل كيتا بس
  { order_id: 3, source: "delivery_app", source_note: "keeta", filled_by: "cashier", phone_norm: "500000003", items: [["بيتزا مارجريتا", 30]] },
  { order_id: 4, source: "website", source_note: "W1790000000004", filled_by: "shop", phone_norm: "500000003", items: [["مشاوي مشكل (كيلو)", 300]] }, // نفس عميل كيتا طلب من الموقع
  { order_id: 5, source: "delivery_app", source_note: "HungerStation", filled_by: "feedus", phone_norm: "", items: [] },
  { order_id: 6, source: "delivery_app", source_note: "  ", filled_by: "auto", phone_norm: "500000006", items: [] },
  { order_id: 7, source: "friend", source_note: "", filled_by: "cashier", phone_norm: "500000007", items: [] },
  { order_id: 8, source: "instagram", source_note: "ad 12", filled_by: "cashier", phone_norm: "500000008", items: [] },
];

test("the rule: only a delivery_app row with a note is an app order — a website order's note is its order number", () => {
  assert.equal(APP_SOURCE, "delivery_app");
  assert.deepEqual(ROWS.map(isAppSource), [false, true, true, false, true, false, false, false]);
  assert.equal(isAppSource({ source: "website", source_note: "W1790000000001" }), false, "the row that caused the incident");
  assert.equal(isAppSource({ source: "delivery_app", sourceNote: "Keeta" }), true, "camelCase rows too");
  assert.equal(isAppSource(null), false);
  assert.equal(appSourceSql("s"), "(s.source = 'delivery_app' AND btrim(COALESCE(s.source_note, '')) <> '')");
  assert.equal(appSourceSql("order_sources"), "(order_sources.source = 'delivery_app' AND btrim(COALESCE(order_sources.source_note, '')) <> '')");
  assert.equal(appNoteSql("s"), "(CASE WHEN s.source = 'delivery_app' THEN NULLIF(btrim(s.source_note), '') END)");
  assert.equal(websiteSourceSql("s"), "(s.source = 'website')");
});

/* نفس تجميع cms.js customerRows() على صفوف عدّت من القاعدة، وبعدين اختبارات الشرايح الحقيقية */
function profiles(rows, filter) {
  const priceOf = rules.priceMatcher([]);
  const m = new Map();
  for (const r of rows.filter(filter).filter((x) => /^5[0-9]{8}$/.test(x.phone_norm))) {
    const e = m.get(r.phone_norm) || { orders: 0, apps: new Set(), grill: 0, box: 0, food: {} };
    e.orders += 1; e.apps.add(String(r.source_note).trim());
    for (const [name, amount] of r.items) {
      const val = rules.lineValue({ name, amount, qty: 1 }, priceOf), fam = rules.itemFamily(name);
      if (fam !== "other") e[fam] += val;
      const g = rules.foodGroup(name); if (g) e.food[g] = (e.food[g] || 0) + val;
    }
    m.set(r.phone_norm, e);
  }
  return new Map([...m].map(([pn, e]) => [pn, { keetaOrders: e.orders, keetaLean: rules.leanOf(e.grill, e.box), appSrcOrders: e.orders, appNames: [...e.apps].join(","), appTopFood: rules.topFoodGroup(e.food), onlineDaysSince: 9999 }]));
}
const inSeg = (cust, re) => [...cust].filter(([, c]) => [...rules.KEETA_SEGMENTS, ...rules.APP_FOOD_SEGMENTS].some((s) => re.test(s.id) && s.test(c))).map(([pn]) => pn).sort();

test("segments: a website-only customer is in no Keeta or app segment; a Keeta customer's website order does not change what he «eats on the app»", () => {
  const old = profiles(ROWS, (r) => String(r.source_note || "").trim() !== "");      // the old condition
  const now = profiles(ROWS, isAppSource);
  assert.deepEqual(inSeg(old, /^k_keeta_/), ["500000001", "500000002", "500000003", "500000008"], "the bug: the website buyer (…001) and a cashier note (…008) were «Keeta customers»");
  assert.deepEqual(inSeg(now, /^k_keeta_/), ["500000002", "500000003"]);
  assert.deepEqual(inSeg(now, /^k_app_/), ["500000002", "500000003"]);
  assert.ok(!now.has("500000001") && !now.has("500000008") && !now.has("500000006"));
  // …003 ordered pizza on Keeta and grills on our website: before, the website order made him a «grill» Keeta customer
  assert.equal(old.get("500000003").keetaLean, "grill");
  assert.notEqual(now.get("500000003").keetaLean, "grill");
  assert.equal(now.get("500000003").appNames, "keeta");
  assert.ok([...now.values()].every((c) => !/^W?\d{6,}$/.test(c.appNames)), "no order number is ever an app name");
});

test("cms.js: the three readers (segments query, both app-conversion queries) use the rule, and the old condition is gone from the repo", () => {
  const cms = rd("cms.js");
  assert.ok(cms.includes('import { FIRST_ORDER_CTE, shopPaidSql, maskPhone, appSourceSql } from "./identity.js";'));
  assert.ok(cms.includes("WHERE ${appSourceSql(\"s\")} AND s.phone_norm ~ '${PHONE_RE}' AND ${SALES_ONLY}),"), "customerRows(): the app orders of a phone");
  assert.equal(cms.split("WHERE ${appSourceSql(\"order_sources\")} AND phone_norm ~ '${PHONE_RE}')").length - 1, 2, "app-conversion: population and their website orders");
  const conv = cms.slice(cms.indexOf('app.get("/api/cms/app-conversion"'), cms.indexOf('app.get("/api/cms/app-conversion"') + 1600);
  assert.ok(!/source_note/.test(conv));
  // anywhere in the API: «the note is not empty» must not decide that an order is an app order
  const bad = [];
  for (const f of readdirSync(new URL(".", import.meta.url)).filter((x) => x.endsWith(".js"))) {
    if (f === "identity.js") continue;
    rd(f).split("\n").forEach((line, i) => {
      if (/btrim\(COALESCE\((s\.)?source_note, ''\)\) <> ''/.test(line) && !/source\s*=\s*'delivery_app'/.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("«which app» labels: an order number can no longer become a channel name; our store's POS copy is 'website'", () => {
  for (const f of ["analytics.js", "dayreport.js", "chat.js"]) {
    const s = rd(f), i = s.indexOf("channelSql = (appsParam"), body = s.slice(i, i + 700);
    assert.ok(i > 0, f);
    assert.ok(body.includes('${appNoteSql("s")},') && body.includes('OR ${websiteSourceSql("s")} THEN \'website\''), f);
    assert.ok(!body.includes("NULLIF(s.source_note, '')"), f);
  }
  const n = rd("notifications.js"); const j = n.indexOf("const CHANNEL_SQL");
  assert.ok(n.slice(j, j + 400).includes("CASE WHEN s.source = 'website' THEN 'website' WHEN s.source = 'delivery_app' THEN NULLIF(btrim(s.source_note), '') END"));
  assert.ok(!rd("ai.js").includes("COALESCE(NULLIF(s.source_note,''),'(غير محدد)')"));
  assert.ok(rd("groups.js").includes("COALESCE(CASE WHEN s.source = 'delivery_app' THEN NULLIF(btrim(s.source_note),'') END,'') AS app"), "a website order's discount is not a «platform promo»");
  const ads = rd("ads.js");
  assert.ok(ads.includes('if (row.src === "website") return "website";') && ads.includes('const app = row.src === "delivery_app" ? (row.src_note || "").trim().toLowerCase() : "";'));
});
