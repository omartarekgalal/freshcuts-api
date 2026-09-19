import test from "node:test";
import assert from "node:assert/strict";
import { alertDecision } from "./adconnect.js";
const now = Date.parse("2026-09-19T12:00:00Z");
test("alert only after two failures, not when unconfigured, max once/24h, and on near expiry", () => {
  assert.equal(alertDecision({ ok: true }, { platform: "meta", ok: false, configured: true, reason: "x" }, now), null);
  assert.match(alertDecision({ ok: false }, { platform: "meta", ok: false, configured: true, reason: "x" }, now), /Meta connection failing/);
  assert.equal(alertDecision({ ok: false }, { platform: "tiktok", ok: false, configured: false }, now), null);
  assert.equal(alertDecision({ ok: false, alerted_at: "2026-09-19T08:00:00Z" }, { platform: "meta", ok: false, configured: true }, now), null);
  assert.match(alertDecision(null, { platform: "meta", ok: true, configured: true, token: { expiresAt: "2026-09-22T00:00:00Z" } }, now), /expires/);
});
