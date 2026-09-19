import test from "node:test";
import assert from "node:assert/strict";
import { classify, adKeyOf, campaignMatches, rangeOf, ratios } from "./mkhub.js";

test("classify: paid meta, organic bio, sms, sticker, whatsapp, in-app ad-name only", () => {
  assert.equal(classify({ utm_source: "meta", utm_medium: "paid", channel: "meta_ads" }).family, "meta");
  assert.equal(classify({ utm_source: "instagram", utm_medium: "bio", channel: "meta_ads" }).family, "organic");
  assert.equal(classify({ utm_source: "sms", utm_medium: "crm", channel: "sms" }).family, "sms");
  assert.equal(classify({ utm_source: "sticker", utm_medium: "print", channel: "campaign_link" }).family, "offline");
  assert.equal(classify({ utm_source: "whatsapp", utm_medium: "message", utm_content: "96-wa-kilo" }).family, "whatsapp");
  assert.equal(classify({ channel: "facebook", utm_term: "FC96-ATC-KILO-A-R1-proof" }).family, "meta");
  assert.equal(classify({ channel: "facebook" }).family, "organic");
  assert.equal(classify({ utm_source: "snapchat", utm_medium: "paid", channel: "snap_ads" }).family, "snapchat");
  assert.equal(classify({ channel: "snap_ads" }).family, "snapchat");
  assert.equal(classify({ channel: "google" }).family, "google");
  assert.equal(classify({ utm_source: "tiktok", utm_medium: "bio", channel: "campaign_link" }).family, "organic");
  assert.equal(classify({ channel: "direct" }).family, "direct");
  assert.equal(classify({ attrib_source: "offline" }).family, "offline");
});

test("adKeyOf prefers Meta ad name, skips Snap BGID and numeric ids", () => {
  assert.equal(adKeyOf({ utm_term: "FC96-ATC-KILO-A-R1-proof", utm_content: "96-m3-kilo-a" }), "ad:FC96-ATC-KILO-A-R1-proof");
  assert.equal(adKeyOf({ utm_term: "BGID_10", utm_content: "96-snap-kilo" }), "content:96-snap-kilo");
  assert.equal(adKeyOf({ utm_term: "120249864867050593", utm_content: "120249868356980593" }), null);
});

test("campaignMatches: name, prefix, dated suffix, id", () => {
  assert.ok(campaignMatches("fc96-sales-pur", { id: "1", name: "FC96-SALES-PUR" }));
  assert.ok(campaignMatches("fc-96-store", { id: "1", name: "FC-96-STORE-2026-09" }));
  assert.ok(campaignMatches("id:123", { id: "123", name: "x" }));
  assert.ok(!campaignMatches("fc-rt-web-96", { id: "1", name: "FC96-SALES-PUR" }));
});

test("rangeOf uses the 04:00 business-day roll", () => {
  const at = new Date("2026-09-19T00:30:00Z"); // 03:30 Riyadh → still 18/9
  assert.deepEqual(rangeOf({ range: "today" }, at), { from: "2026-09-18", to: "2026-09-18", label: "today" });
  assert.equal(rangeOf({ range: "7d" }, at).from, "2026-09-12");
});

test("ratios never divide by zero", () => {
  const r = ratios({ spend: 100, ours: { sessions: 0, adds: 0, orders: 0, revenue: 0, newCustomers: 0 } });
  assert.equal(r.cpa, null); assert.equal(r.roas, 0);
  assert.equal(ratios({ spend: null, ours: { sessions: 10, orders: 2, revenue: 200, adds: 3, newCustomers: 1 } }).cpa, null);
});

test("classify: auto-tagged click ids without utm", () => {
  assert.equal(classify({ channel: "google", click_ids: ["gclid"] }).family, "google");
  assert.equal(classify({ channel: "google", click_ids: ["gclid"] }).paid, true);
  assert.equal(classify({ channel: "tiktok", click_ids: ["ttclid"] }).family, "tiktok");
  assert.equal(classify({ click_ids: { ScCid: "x" } }).family, "snapchat");
});
