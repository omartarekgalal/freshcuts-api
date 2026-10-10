// Meta paid vs organic is read from the link's own tags, never from the in-app browser or a bare fbclid (10/10).
// Run: node --test metatouch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { metaTouch, metaOrganicName, isAdTerm, isPaidMedium } from "./metatouch.js";
import { classifyChannel } from "./journey.js";
import { classifySource } from "./checkout-meta.js";
import { adSourceOf } from "./adsreport.js";
import { classify } from "./mkhub.js";

// the two real orders of 10/10 (W1791628084711, W1791631320838) — page posts opened in the Facebook in-app browser
const POST = { utm_source: "facebook", utm_medium: "post", utm_campaign: "nd96_organic", utm_content: "96-fb-c07" };
const POST_ORDER = { utm: POST, click: { fbc: "fb.1.1791627525000.IwZX", fbp: "fb.1.1791627525003.5490" }, fc_link: "96-fb-c07" };
const POST_SESSION = { ...POST, link_slug: "96-fb-c07", click_ids: ["fbclid"], in_app: "facebook", referrer_host: "facebook.com" };
// a real ad click of the same day
const AD = { utm_source: "meta", utm_medium: "paid", utm_campaign: "oct-first", utm_term: "120251213773280593" };
const AD_ORDER = { utm: AD, click: { fbclid: "x" }, fc_link: "m-offer-1" };
const AD_SESSION = { ...AD, link_slug: "m-offer-1", click_ids: ["fbclid"], in_app: "facebook" };

test("the rule: the medium decides; fbclid alone decides nothing", () => {
  assert.equal(metaTouch({ ...AD, fbclid: true }), "paid");
  assert.equal(metaTouch({ ...AD, fbclid: false }), "paid", "an ad without fbclid is still an ad");
  assert.equal(metaTouch({ ...POST, link: "96-fb-c07", fbclid: true }), "organic");
  for (const med of ["post", "story", "bio", "cta", "organic", "reel"]) assert.equal(metaTouch({ utm_source: "instagram", utm_medium: med, fbclid: true }), "organic", med);
  for (const med of ["paid", "cpc", "paid_social", "ads", "sponsored"]) assert.equal(metaTouch({ utm_source: "fb", utm_medium: med }), "paid", med);
  assert.equal(metaTouch({ fbclid: true }), "organic", "a bare fbclid (shared link, page post without tags)");
  assert.equal(metaTouch({ utm_source: "facebook", fbclid: true }), "organic");
  assert.equal(metaTouch({ utm_source: "facebook", utm_campaign: "oct26-organic" }), "organic");
  assert.equal(metaTouch({ utm_source: "meta" }), "paid", "utm_source=meta is only ever written on ad links");
  assert.equal(metaTouch({ utm_source: "meta", utm_campaign: "nd96_organic" }), "organic");
});

test("the rule: ad tags rescue a click whose utm was wiped by the in-app browser", () => {
  assert.equal(metaTouch({ utm_term: "FC96-ATC-KILO-A", fbclid: true }), "paid");
  assert.equal(metaTouch({ utm_term: "120250904108500593", fbclid: true }), "paid");
  assert.equal(metaTouch({ link: "96-m3-kilo-a" }), "paid");
  assert.equal(metaTouch({ link: "96-meta-r1-box", fbclid: true }), "paid");
  assert.equal(isAdTerm("{{ad.name}}"), true);
  assert.equal(isAdTerm("BGID_123"), false, "Snap's macro is not a Meta ad tag");
  assert.equal(isAdTerm("12345"), false);
  // an explicit organic medium still wins over a stale ad term kept in the browser's storage
  assert.equal(metaTouch({ utm_source: "instagram", utm_medium: "bio", utm_term: "FC96-ATC-KILO-A", fbclid: true }), "organic");
});

test("the rule: not a Meta visit at all", () => {
  assert.equal(metaTouch({}), null);
  assert.equal(metaTouch({ utm_source: "sms", utm_medium: "crm", fbclid: true }), null, "another explicit source wins over an old fbclid");
  assert.equal(metaTouch({ utm_source: "google", utm_medium: "cpc" }), null);
  assert.equal(metaTouch({ utm_medium: "paid" }), null);
  assert.equal(isPaidMedium("gbp_post"), false);
  assert.equal(metaOrganicName({ utm_source: "ig" }), "instagram");
  assert.equal(metaOrganicName({ utm_source: "facebook" }), "facebook");
  assert.equal(metaOrganicName({ in_app: "instagram" }), "instagram");
  assert.equal(metaOrganicName({}), "facebook");
});

test("session channel: a page post in the Facebook in-app browser is «فيسبوك (مجاني)», an ad is «إعلانات ميتا»", () => {
  assert.equal(classifyChannel(POST_SESSION), "facebook");
  assert.equal(classifyChannel({ ...POST_SESSION, utm_content: "96-fb-who", link_slug: "96-fb-who" }), "facebook");
  assert.equal(classifyChannel({ utm_source: "facebook", utm_medium: "cta", utm_campaign: "nd96_organic", link_slug: "96-fb-cta", click_ids: ["fbclid"] }), "facebook");
  assert.equal(classifyChannel({ utm_source: "instagram", utm_medium: "bio", utm_campaign: "nd96_organic", link_slug: "96-ig-bio", click_ids: ["fbclid"], in_app: "instagram" }), "instagram");
  assert.equal(classifyChannel({ utm_source: "instagram", utm_medium: "story", link_slug: "96-ig-c01" }), "instagram", "same channel with or without fbclid");
  assert.equal(classifyChannel(AD_SESSION), "meta_ads");
  assert.equal(classifyChannel({ ...AD_SESSION, click_ids: [] }), "meta_ads");
  assert.equal(classifyChannel({ utm_source: "ig", utm_medium: "paid", utm_campaign: "120250901236620593", click_ids: ["fbclid"] }), "meta_ads");
  assert.equal(classifyChannel({ utm_source: "meta", utm_medium: "paid_social", utm_campaign: "fc-prospect-lal" }), "meta_ads");
  assert.equal(classifyChannel({ click_ids: ["fbclid"], utm_term: "FC96-ATC-KILO-A", in_app: "facebook" }), "meta_ads", "utm wiped, ad tag kept");
  assert.equal(classifyChannel({ click_ids: ["fbclid"], in_app: "facebook" }), "facebook");
  // other channels are untouched
  assert.equal(classifyChannel({ utm_source: "snapchat", utm_medium: "story", link_slug: "96-sn-c01" }), "campaign_link");
  assert.equal(classifyChannel({ utm_source: "sms", utm_medium: "crm", click_ids: ["fbclid"] }), "sms");
  assert.equal(classifyChannel({ utm_source: "google", utm_medium: "paid", link_slug: "g-brand-1" }), "google_ads");
  assert.equal(classifyChannel({ utm_source: "other", utm_medium: "link", link_slug: "box-burger-duo" }), "campaign_link");
});

test("order source (attrib_source): «meta» means a paid ad only", () => {
  assert.equal(classifySource(POST_ORDER), "facebook");
  assert.equal(classifySource(POST_ORDER, POST_SESSION), "facebook");
  assert.equal(classifySource({ utm: { utm_source: "instagram", utm_medium: "bio", utm_campaign: "nd96_organic" }, click: { fbclid: "z" } }), "instagram");
  assert.equal(classifySource(AD_ORDER), "meta");
  assert.equal(classifySource({ utm: { utm_source: "fb", utm_medium: "paid" } }), "meta");
  // nothing from the browser: the server-side session decides, by the same rule
  assert.equal(classifySource({}, POST_SESSION), "facebook");
  assert.equal(classifySource({}, AD_SESSION), "meta");
  assert.equal(classifySource({}, { channel: "meta_ads" }), "meta");
  assert.equal(classifySource({ utm: { utm_source: "sms" }, click: { fbclid: "old" } }), "sms");
});

test("ads report: the two page-post orders are not «from a Meta ad»; the ad order is", () => {
  assert.equal(adSourceOf(POST_ORDER, "meta"), null, "even while the stored attrib_source still says meta (before the backfill)");
  assert.equal(adSourceOf(POST_ORDER, "facebook"), null);
  assert.equal(adSourceOf({ utm: { ...POST, utm_content: "96-fb-who" }, click: { fbc: "fb.1.x" } }, "meta"), null);
  assert.equal(adSourceOf(AD_ORDER, "meta"), "meta");
  assert.equal(adSourceOf({ utm: { utm_source: "ig", utm_medium: "paid" }, click: { fbclid: "x" } }), "meta");
  assert.equal(adSourceOf({ click: { fbclid: "x" }, utm: { utm_term: "FC96-ATC-KILO-A" } }), "meta", "utm wiped, ad tag kept");
  assert.equal(adSourceOf({ click: { fbclid: "x" } }), null, "a bare fbclid is not an ad");
  assert.equal(adSourceOf({ fc_link: "96-m3-box-b" }), "meta");
  assert.equal(adSourceOf({ click: { ScCid: "s" } }), "snapchat", "Snapchat is untouched");
  // 10/10 as the dashboard showed it: 3 orders / 488 SAR before, 1 / 142 after
  const day = [[POST_ORDER, 150], [{ ...POST_ORDER, utm: { ...POST, utm_content: "96-fb-who" }, fc_link: "96-fb-who" }, 196], [AD_ORDER, 142]];
  const meta = day.filter(([o]) => adSourceOf(o, "meta") === "meta");
  assert.equal(meta.length, 1);
  assert.equal(meta.reduce((s, [, t]) => s + t, 0), 142);
});

test("marketing hub: an old session row that still says meta_ads does not make a page post paid", () => {
  assert.deepEqual(classify({ ...POST, channel: "meta_ads" }), { family: "organic", paid: false, platform: "meta" });
  assert.deepEqual(classify({ utm_source: "facebook", utm_medium: "cta", utm_campaign: "nd96_organic", channel: "meta_ads" }), { family: "organic", paid: false, platform: "meta" });
  assert.equal(classify({ ...AD, channel: "meta_ads" }).paid, true);
  assert.equal(classify({ ...AD, channel: "meta_ads" }).family, "meta");
});
