/* عقد بيانات الـcheckout (W0-03) — node --test checkout-meta.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { parseCheckoutMeta, fireServerPurchase, MAX_LEN } from "./checkout-meta.js";

const H = { "cf-connecting-ip": "5.6.7.8", "user-agent": "Mozilla/5.0 (iPhone)" };

test("الشكل الكامل: fc_link + utm + click + entry + ip/ua من الهيدر", () => {
  const body = {
    attribution: {
      fc_link: "96-m2-box",
      utm: { utm_source: "meta", utm_medium: "paid", utm_campaign: "nd96" },
      click: { fbc: "fb.1.1726000000000.TEST123", fbp: "fb.1.1.2", scid: "abc" },
      landing_at: "2026-09-16T10:00:00.000Z",
      entry: "offers_page",
    },
    client: "android", app_version: "1.2.3", journey_sid: "j_abc-123",
  };
  const m = parseCheckoutMeta(body, H);
  assert.deepEqual(m.attribution, {
    fc_link: "96-m2-box",
    utm: { utm_source: "meta", utm_medium: "paid", utm_campaign: "nd96" },
    click: { fbc: "fb.1.1726000000000.TEST123", fbp: "fb.1.1.2", scid: "abc" },
    landing_at: "2026-09-16T10:00:00.000Z",
    entry: "offers_page",
    ip: "5.6.7.8",
    ua: "Mozilla/5.0 (iPhone)",
    captured: "checkout",
  });
  assert.equal(m.client, "android");
  assert.equal(m.app_version, "1.2.3");
  assert.equal(m.journey_sid, "j_abc-123");
});

test("مفاتيح مجهولة بتتشال (أعلى وجوّه utm/click)", () => {
  const m = parseCheckoutMeta({
    attribution: {
      fc_link: "x", evil: "1", __proto__x: "y",
      utm: { utm_source: "a", utm_evil: "b" },
      click: { fbclid: "c", password: "d", ScCid: "e" },
    },
  }, H);
  assert.deepEqual(Object.keys(m.attribution).sort(),
    ["captured", "click", "entry", "fc_link", "ip", "landing_at", "ua", "utm"]);
  assert.deepEqual(m.attribution.utm, { utm_source: "a" });
  assert.deepEqual(m.attribution.click, { fbclid: "c", ScCid: "e" });
});

test("القص: كل قيمة ≤ ٣٠٠ حرف", () => {
  const long = "x".repeat(1000);
  const m = parseCheckoutMeta({
    attribution: { fc_link: long, entry: long, utm: { utm_campaign: long }, click: { fbc: long } },
  }, { "user-agent": long, "cf-connecting-ip": "1.1.1.1" });
  assert.equal(MAX_LEN, 300);
  assert.equal(m.attribution.fc_link.length, 300);
  assert.equal(m.attribution.entry.length, 300);
  assert.equal(m.attribution.utm.utm_campaign.length, 300);
  assert.equal(m.attribution.click.fbc.length, 300);
  assert.equal(m.attribution.ua.length, 300);
});

test("ip/ua من الهيدر بس — اللي في الـbody بيتجاهل", () => {
  const body = { attribution: { ip: "9.9.9.9", ua: "forged-ua", fc_link: "a" }, ip: "9.9.9.9", ua: "forged" };
  const withH = parseCheckoutMeta(body, H);
  assert.equal(withH.attribution.ip, "5.6.7.8");
  assert.equal(withH.attribution.ua, "Mozilla/5.0 (iPhone)");
  const noH = parseCheckoutMeta(body, {});
  assert.equal(noH.attribution.ip, null);
  assert.equal(noH.attribution.ua, null);
});

test("الهيدر: دالة (c.req.header) أو Headers أو object بحروف كبيرة، وx-forwarded-for احتياطي", () => {
  const fn = (n) => ({ "cf-connecting-ip": "2.2.2.2", "user-agent": "UA" })[n];
  assert.equal(parseCheckoutMeta({}, fn).attribution.ip, "2.2.2.2");
  const hs = new Headers({ "CF-Connecting-IP": "2001:db8::1", "User-Agent": "UA2" });
  const m = parseCheckoutMeta({}, hs);
  assert.equal(m.attribution.ip, "2001:db8::1");
  assert.equal(m.attribution.ua, "UA2");
  assert.equal(parseCheckoutMeta({}, { "User-Agent": "UA3" }).attribution.ua, "UA3");
  assert.equal(parseCheckoutMeta({}, { "x-forwarded-for": "3.3.3.3, 10.0.0.1" }).attribution.ip, "3.3.3.3");
  assert.equal(parseCheckoutMeta({}, { "cf-connecting-ip": "<script>" }).attribution.ip, null);
});

test("client غير معروف ← web، وapp_version ≤ ٢٠، وjourney_sid لازم يطابق", () => {
  assert.equal(parseCheckoutMeta({ client: "hacker" }, H).client, "web");
  assert.equal(parseCheckoutMeta({}, H).client, "web");
  assert.equal(parseCheckoutMeta({ client: "iOS" }, H).client, "ios");
  for (const c of ["web", "webview", "pwa", "ios", "android"]) assert.equal(parseCheckoutMeta({ client: c }, H).client, c);
  assert.equal(parseCheckoutMeta({ app_version: "1".repeat(50) }, H).app_version.length, 20);
  assert.equal(parseCheckoutMeta({}, H).app_version, null);
  assert.equal(parseCheckoutMeta({ journey_sid: "ABC" }, H).journey_sid, null);
  assert.equal(parseCheckoutMeta({ journey_sid: "a b" }, H).journey_sid, null);
  assert.equal(parseCheckoutMeta({ journey_sid: "a".repeat(65) }, H).journey_sid, null);
  assert.equal(parseCheckoutMeta({ journey_sid: "a".repeat(64) }, H).journey_sid, "a".repeat(64));
});

test("مدخلات بايظة مابتوقعش: body فاضي/مصفوفة/قيم مش نصية/تاريخ غلط", () => {
  const m = parseCheckoutMeta(null, undefined);
  assert.equal(m.attribution.fc_link, null);
  assert.deepEqual(m.attribution.utm, {});
  assert.deepEqual(m.attribution.click, {});
  assert.equal(m.attribution.captured, "checkout");
  const arr = parseCheckoutMeta({ attribution: ["x"] }, H);
  assert.equal(arr.attribution.fc_link, null);
  const odd = parseCheckoutMeta({
    attribution: { fc_link: { a: 1 }, utm: "str", click: { fbc: ["x"], gclid: 12345 }, landing_at: "not a date" },
  }, H);
  assert.equal(odd.attribution.fc_link, null);
  assert.deepEqual(odd.attribution.utm, {});
  assert.deepEqual(odd.attribution.click, { gclid: "12345" });
  assert.equal(odd.attribution.landing_at, null);
});

test("fireServerPurchase: بينده serverPurchase({orderNo}) من غير انتظار", async () => {
  const calls = [];
  fireServerPurchase(() => ({ serverPurchase: async (a) => { calls.push(a); return { ok: true }; } }), "W1");
  assert.deepEqual(calls, [{ orderNo: "W1" }]);
});

test("fireServerPurchase: الفشل (sync/async) أو غياب funnel مابيرميش", async () => {
  const errs = [];
  const log = { error: (m) => errs.push(m) };
  assert.doesNotThrow(() => fireServerPurchase(undefined, "W1", log));
  assert.doesNotThrow(() => fireServerPurchase(() => null, "W1", log));
  assert.doesNotThrow(() => fireServerPurchase(() => { throw new Error("boom"); }, "W2", log));
  assert.doesNotThrow(() => fireServerPurchase(() => ({ serverPurchase: () => { throw new Error("sync"); } }), "W3", log));
  fireServerPurchase(() => ({ serverPurchase: () => Promise.reject(new Error("async")) }), "W4", log);
  await new Promise((r) => setImmediate(r));
  assert.equal(errs.length, 3);
  assert.ok(errs.some((e) => e.includes("W4") && e.includes("async")));
});

test("قيم مش صالحة لـJSONB (NUL / surrogate يتيم / قص في نص إيموجي) بتتنضّف", () => {
  const nul = String.fromCharCode(0);
  const emoji = String.fromCodePoint(0x1F525); // طولها ٢ (زوج surrogate)
  const m = parseCheckoutMeta({
    attribution: {
      fc_link: "a" + nul + "b",
      entry: "x" + String.fromCharCode(0xD83D) + "y",
      utm: { utm_campaign: "c".repeat(299) + emoji },
    },
  }, { "user-agent": "UA" + nul, "cf-connecting-ip": "1.1.1.1" });
  assert.equal(m.attribution.fc_link, "ab");
  assert.equal(m.attribution.entry, "xy");
  assert.equal(m.attribution.utm.utm_campaign, "c".repeat(299));
  assert.equal(m.attribution.ua, "UA");
  // الـJSON الناتج مفيهوش أي escape يرفضه Postgres
  const json = JSON.stringify(m.attribution);
  assert.ok(!/\u0000|\ud[89ab][0-9a-f]{2}(?!\ud[c-f])|\ud[c-f][0-9a-f]{2}/i.test(json), json);
  assert.equal(parseCheckoutMeta({ attribution: { utm: { utm_term: "ok" + emoji } } }, H).attribution.utm.utm_term, "ok" + emoji);
});

/* ── التطبيق (Capacitor) بيتعرّف من اليوزر-إيجنت ───────────────────────────
   من غير ده كل طلبات التطبيق بتتسجّل "web" لأن المتجر لسه مابيبعتش client. */
const APP_H = { "cf-connecting-ip": "5.6.7.8", "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36 FreshCutsApp/android/1.0.0" };
const APP_IOS_H = { "cf-connecting-ip": "5.6.7.8", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) FreshCutsApp/ios/1.0.2" };

test("UA التطبيق بيدّي client/app_version من غير ما المتجر يبعت حاجة", () => {
  const m = parseCheckoutMeta({}, APP_H);
  assert.equal(m.client, "android");
  assert.equal(m.app_version, "1.0.0");
  const i = parseCheckoutMeta({}, APP_IOS_H);
  assert.equal(i.client, "ios");
  assert.equal(i.app_version, "1.0.2");
});

test("الـbody بيكسب الـUA لما يبعت قيمة مسموحة، والقيمة الغلط بترجع للـUA", () => {
  assert.equal(parseCheckoutMeta({ client: "pwa" }, APP_H).client, "pwa");
  // قيمة مش في القايمة ⇒ مانرجعش "web" ونضيّع إن ده تطبيق
  assert.equal(parseCheckoutMeta({ client: "hacker" }, APP_H).client, "android");
  assert.equal(parseCheckoutMeta({ app_version: "9.9.9" }, APP_H).app_version, "9.9.9");
});

test("متصفح عادي يفضل web — مفيش تصنيف بالغلط", () => {
  assert.equal(parseCheckoutMeta({}, H).client, "web");
  assert.equal(parseCheckoutMeta({}, H).app_version, null);
  const fake = { "user-agent": "Mozilla/5.0 FreshCutsApp/desktop/1.0.0" };
  assert.equal(parseCheckoutMeta({}, fake).client, "web");
});
