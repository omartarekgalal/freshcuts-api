import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvSession, jwtExpMs, readRefreshReply, fingerprint } from "./hs_portal.js";

test("env session needs userId + refreshToken + deviceToken", () => {
  assert.equal(parseEnvSession(""), null);
  assert.equal(parseEnvSession("{bad"), null);
  assert.equal(parseEnvSession(JSON.stringify({ userId: "u", refreshToken: "r" })), null);
  assert.deepEqual(parseEnvSession(JSON.stringify({ userId: "u", refreshToken: "r", deviceToken: "d", deviceUuid: "x" })),
    { userId: "u", refreshToken: "r", deviceToken: "d", deviceUuid: "x" });
});

test("refresh reply in both shapes the portal handles", () => {
  assert.deepEqual(readRefreshReply({ access_token: "a", refresh_token: "b" }), { access: "a", refresh: "b" });
  assert.deepEqual(readRefreshReply({ keymaker: { access_token: "a", refresh_token: "b" } }), { access: "a", refresh: "b" });
  assert.equal(readRefreshReply({ error: "x" }), null);
});

test("jwt exp", () => {
  const p = Buffer.from(JSON.stringify({ exp: 2000000000 })).toString("base64url");
  assert.equal(jwtExpMs(`x.${p}.y`), 2000000000000);
  assert.equal(jwtExpMs("nope"), null);
  assert.equal(fingerprint("a").length, 16);
});
