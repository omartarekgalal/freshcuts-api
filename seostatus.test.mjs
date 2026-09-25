// node --test seostatus.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isItemPath, sitemapStats, ldHasAggregateRating, mergeStatus } from "./seostatus.js";
import { sectionOf } from "./cms.js";

test("صفحة صنف مقابل صفحة قسم — عربي وإنجليزي", () => {
  assert.equal(isItemPath("https://freshcuts.sa/menu/pizza/margherita-12"), true);
  assert.equal(isItemPath("https://freshcuts.sa/en/menu/pizza/margherita-12"), true);
  assert.equal(isItemPath("https://freshcuts.sa/menu/pizza"), false);
  assert.equal(isItemPath("https://freshcuts.sa/en/menu/pizza"), false);
  assert.equal(isItemPath("https://freshcuts.sa/menu"), false);
  assert.equal(isItemPath("https://freshcuts.sa/"), false);
});

test("عدّ الـsitemap: قسم مايتحسبش صنف (الغلطة اللي وقعت فيها في الـgrep)", () => {
  const xml = ["/", "/en/", "/menu", "/menu/pizza", "/en/menu/pizza", "/menu/pizza/tuna-9", "/en/menu/pizza/tuna-9"]
    .map((p) => `<url><loc>https://freshcuts.sa${p}</loc></url>`).join("");
  assert.deepEqual(sitemapStats(xml), { urls: 7, itemPages: 2 });
});

test("aggregateRating في JSON-LD بس — النص الظاهر مايتحسبش", () => {
  const visible = `<a id="gRateBadge">⭐ 4.9 · aggregateRating في نص عادي</a>`;
  const ld = `<script type="application/ld+json">{"@type":"Restaurant","aggregateRating":{"ratingValue":"4.9"}}</script>`;
  const clean = `<script type="application/ld+json">{"@type":"Restaurant","name":"x"}</script>`;
  assert.equal(ldHasAggregateRating(visible + clean), false);
  assert.equal(ldHasAggregateRating(visible + ld), true);
});

test("الدمج: المفاتيح بتتبدّل، null بيشيل، updatedAt من السيرفر بس", () => {
  const cur = { gsc: { clicks: 182 }, done: [1], notes: "x" };
  const out = mergeStatus(cur, { gsc: { clicks: 200 }, notes: null, updatedAt: "مزوّر" }, "2026-09-26T00:00:00Z");
  assert.deepEqual(out, { gsc: { clicks: 200 }, done: [1], updatedAt: "2026-09-26T00:00:00Z" });
});

test("الصلاحيات: SEO تحت النمو، والواتساب وحاجبين الإعلانات تحت العملاء", () => {
  assert.equal(sectionOf("/api/cms/growth/seo"), "growth");
  assert.equal(sectionOf("/api/cms/outreach"), "customers");
  assert.equal(sectionOf("/api/cms/outreach/template"), "customers");
  assert.equal(sectionOf("/api/sms/blocked"), "customers");
  assert.equal(sectionOf("/api/sms/blocked/import"), "customers");
  // ويب هوك تقنيات مش لوحة — مايتأثرش (بيتحمي بالعبارة السرية)
  assert.equal(sectionOf("/api/sms/dlr"), "settings");
});
