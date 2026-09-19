import test from "node:test";
import assert from "node:assert/strict";
import {
  encryptSecret, decryptSecret, keyFingerprint, buildAuthUrl, newState, isOurState, pickAdvertiser,
  exchangeCode, checkScopes, ttMktToken, ttMktTokenSource, ttAdvertiserId, _setCacheForTest,
} from "./ttconnect.js";

test("AES-GCM round trip; wrong key or tampering → null, never throws", () => {
  const blob = encryptSecret("s3cr3t-app-secret-value", "key-A");
  assert.match(blob, /^v1:/);
  assert.ok(!blob.includes("s3cr3t"));
  assert.equal(decryptSecret(blob, "key-A"), "s3cr3t-app-secret-value");
  assert.equal(decryptSecret(blob, "key-B"), null);
  const parts = blob.split(":"); parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA");
  assert.equal(decryptSecret(parts.join(":"), "key-A"), null);
  assert.equal(decryptSecret("garbage", "key-A"), null);
  assert.notEqual(encryptSecret("x", "k"), encryptSecret("x", "k")); // random IV
  assert.equal(keyFingerprint("k").length, 12);
  assert.notEqual(keyFingerprint("k"), keyFingerprint("k2"));
});

test("state: prefixed, random, strict check", () => {
  const s = newState();
  assert.ok(isOurState(s));
  assert.notEqual(s, newState());
  assert.equal(isOurState("fctt_abc"), false);
  assert.equal(isOurState("xyz_" + "a".repeat(32)), false);
  assert.equal(isOurState(s + "<script>"), false);
});

test("auth url is TikTok's advertiser portal with encoded redirect", () => {
  const u = new URL(buildAuthUrl({ appId: "7673553737050898452", state: "fctt_" + "a".repeat(32), redirectUri: "https://freshcuts.sa/" }));
  assert.equal(u.origin + u.pathname, "https://business-api.tiktok.com/portal/auth");
  assert.equal(u.searchParams.get("app_id"), "7673553737050898452");
  assert.equal(u.searchParams.get("redirect_uri"), "https://freshcuts.sa/");
});

test("advertiser pick prefers env when authorised", () => {
  assert.deepEqual(pickAdvertiser(["1", "2"], "2"), { id: "2", envMatches: true });
  assert.deepEqual(pickAdvertiser(["1", "2"], "9"), { id: "1", envMatches: false });
  assert.deepEqual(pickAdvertiser(["1"], ""), { id: "1", envMatches: null });
});

const fakeFetch = (routes) => async (url, opts) => {
  for (const [re, body] of routes) if (re.test(url)) return { status: 200, json: async () => (typeof body === "function" ? body(url, opts) : body) };
  return { status: 404, json: async () => null };
};

test("exchangeCode posts app_id/secret/auth_code and parses advertisers", async () => {
  let sent = null;
  const f = fakeFetch([[/oauth2\/access_token/, (u, o) => { sent = JSON.parse(o.body); return { code: 0, data: { access_token: "tok123", advertiser_ids: [111], scope: [4, 5] } }; }]]);
  const r = await exchangeCode({ appId: "A", secret: "S", authCode: "C" }, f);
  assert.deepEqual(sent, { app_id: "A", secret: "S", auth_code: "C" });
  assert.deepEqual(r, { ok: true, accessToken: "tok123", advertiserIds: ["111"], scope: [4, 5] });
  const bad = await exchangeCode({ appId: "A", secret: "S", authCode: "C" }, fakeFetch([[/oauth2/, { code: 40104, message: "auth_code expired" }]]));
  assert.equal(bad.ok, false); assert.match(bad.error, /40104/);
});

test("checkScopes reports each capability separately", async () => {
  const f = fakeFetch([
    [/advertiser\/info/, { code: 0, data: { list: [{ name: "FC", status: "STATUS_ENABLE" }] } }],
    [/campaign\/get/, { code: 0, data: { list: [] } }],
    [/report\/integrated/, { code: 0, data: { list: [] } }],
    [/pixel\/list/, { code: 0, data: { pixels: [{}, {}] } }],
    [/custom_audience/, { code: 40001, message: "No permission" }],
  ]);
  const r = await checkScopes("t", "111", f);
  assert.equal(r.advertiser.ok, true); assert.equal(r.advertiser.name, "FC");
  assert.equal(r.pixels.count, 2);
  assert.deepEqual(r.audiences, { ok: false, code: 40001, message: "No permission" });
});

test("token precedence: DB → marketing env → events env; events token never overridden elsewhere", () => {
  const save = { ...process.env };
  process.env.TIKTOK_MARKETING_TOKEN = ""; process.env.TIKTOK_ACCESS_TOKEN = "ev"; process.env.TIKTOK_ADVERTISER_ID = "";
  _setCacheForTest({ token: "", advertiserId: "" });
  assert.equal(ttMktToken(), "ev"); assert.match(ttMktTokenSource(), /events/);
  process.env.TIKTOK_MARKETING_TOKEN = "mk";
  assert.equal(ttMktToken(), "mk");
  _setCacheForTest({ token: "db", advertiserId: "777" });
  assert.equal(ttMktToken(), "db"); assert.equal(ttMktTokenSource(), "db");
  assert.equal(ttAdvertiserId(), "777");
  process.env.TIKTOK_ADVERTISER_ID = "555";
  assert.equal(ttAdvertiserId(), "555");
  _setCacheForTest({ token: "", advertiserId: "" });
  process.env = save;
});
