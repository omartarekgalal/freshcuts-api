/* كود اختبار تيك توك للويب — node --test funnel-tiktok-testcode.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { withTikTokTestCode } from "./funnel.js";

test("no code → body unchanged (production)", () => {
  const b = { event_source: "web", data: [] };
  assert.equal(withTikTokTestCode(b, ""), b);
});
test("code → test_event_code added, rest kept", () => {
  const b = withTikTokTestCode({ event_source: "web", event_source_id: "PX", data: [{ event: "Pageview" }] }, "TEST123");
  assert.equal(b.test_event_code, "TEST123");
  assert.equal(b.event_source_id, "PX");
  assert.equal(b.data[0].event, "Pageview");
});
test("reads TIKTOK_WEB_TEST_EVENT_CODE, ignores the offline TIKTOK_TEST_EVENT_CODE", () => {
  process.env.TIKTOK_TEST_EVENT_CODE = "OFFLINE";
  delete process.env.TIKTOK_WEB_TEST_EVENT_CODE;
  assert.equal(withTikTokTestCode({ a: 1 }).test_event_code, undefined);
  process.env.TIKTOK_WEB_TEST_EVENT_CODE = " WEB9 ";
  assert.equal(withTikTokTestCode({ a: 1 }).test_event_code, "WEB9");
  delete process.env.TIKTOK_WEB_TEST_EVENT_CODE; delete process.env.TIKTOK_TEST_EVENT_CODE;
});
