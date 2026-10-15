import test from "node:test";
import assert from "node:assert/strict";
import { jwtExpMs, pickToken, renewDue, sessionHealth } from "./portalsessions.js";

const mkJwt = (expSec) => {
  const body = Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url");
  return `h.${body}.s`;
};
const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);   // ثابت
const inH = (h) => Math.floor((NOW + h * 3600_000) / 1000);

test("jwtExpMs reads exp in ms, null otherwise", () => {
  assert.equal(jwtExpMs(mkJwt(2_000_000_000)), 2_000_000_000_000);
  assert.equal(jwtExpMs("not-a-jwt"), null);
  assert.equal(jwtExpMs(""), null);
});

test("pickToken prefers the longest-lived still-valid token", () => {
  const soon = mkJwt(inH(1)), far = mkJwt(inH(50)), dead = mkJwt(inH(-5));
  assert.equal(pickToken([soon, far, dead], NOW).token, far);
  // كلهم ميتين ⇒ يرجّع الأطول (عشان رسالة الخطأ تكون على الأحدث)
  const d1 = mkJwt(inH(-10)), d2 = mkJwt(inH(-2));
  assert.equal(pickToken([d1, d2], NOW).token, d2);
  assert.equal(pickToken([], NOW), null);
  assert.equal(pickToken([null, "", undefined], NOW), null);
});

test("renewDue: true when near expiry", () => {
  assert.equal(renewDue({ expMs: NOW + 30 * 60_000, now: NOW, leadMin: 90 }), true);   // فاضل ٣٠ د < ٩٠
  assert.equal(renewDue({ expMs: NOW + 5 * 3600_000, now: NOW, leadMin: 90 }), false);  // فاضل ٥ ساعات
});

test("renewDue: maxAge resets even for a long-lived token", () => {
  const exp = NOW + 6 * 24 * 3600_000;    // ٦ أيام قدام (refresh نينجا)
  // اتجدّد من ٣ ساعات، السقف ٤٨ ساعة ⇒ مش مستحق
  assert.equal(renewDue({ expMs: exp, lastRefreshAt: new Date(NOW - 3 * 3600_000).toISOString(), now: NOW, leadMin: 360, maxAgeMin: 48 * 60 }), false);
  // اتجدّد من ٥٠ ساعة ⇒ مستحق (قبل ما الـ٧ أيام يخلصوا)
  assert.equal(renewDue({ expMs: exp, lastRefreshAt: new Date(NOW - 50 * 3600_000).toISOString(), now: NOW, leadMin: 360, maxAgeMin: 48 * 60 }), true);
  // مفيش تاريخ تجديد ⇒ مستحق
  assert.equal(renewDue({ expMs: exp, lastRefreshAt: null, now: NOW, leadMin: 360, maxAgeMin: 48 * 60 }), true);
});

test("sessionHealth: no session => bad + needsReconnect", () => {
  const h = sessionHealth("ninja", { hasSession: false }, NOW);
  assert.equal(h.tone, "bad");
  assert.equal(h.needsReconnect, true);
});

test("sessionHealth: dead refresh => needs reconnect (the Ninja 6/8 case)", () => {
  const h = sessionHealth("ninja", { hasSession: true, jwt: mkJwt(inH(-1800)), refresh: mkJwt(inH(-1673)) }, NOW);
  assert.equal(h.tone, "bad");
  assert.equal(h.state, "needs_reconnect");
  assert.equal(h.needsReconnect, true);
});

test("sessionHealth: refresh rejected by last error => reconnect", () => {
  const h = sessionHealth("ninja", { hasSession: true, jwt: mkJwt(inH(5)), refresh: mkJwt(inH(100)), lastError: "refresh HTTP 401" }, NOW);
  assert.equal(h.needsReconnect, true);
  assert.equal(h.tone, "bad");
});

test("sessionHealth: refresh soon => warn, not reconnect", () => {
  const h = sessionHealth("ninja", { hasSession: true, jwt: mkJwt(inH(5)), refresh: mkJwt(inH(10)) }, NOW);
  assert.equal(h.tone, "warn");
  assert.equal(h.state, "refresh_soon");
  assert.equal(h.needsReconnect, false);
});

test("sessionHealth: healthy => good", () => {
  const h = sessionHealth("hungerstation", { hasSession: true, accessExp: NOW + 3 * 3600_000, refresh: mkJwt(inH(200)) }, NOW);
  assert.equal(h.tone, "good");
  assert.equal(h.needsReconnect, false);
  assert.ok(h.accessLeftMin > 150 && h.accessLeftMin <= 180);
});

test("sessionHealth: HS opaque refresh (not a JWT) with live access => good", () => {
  // توكن تجديد هنقرستيشن مش JWT (٤٠ حرف) ⇒ refreshExp = null، مانعتبرهاش ميتة
  const h = sessionHealth("hungerstation", { hasSession: true, accessExp: NOW + 2 * 3600_000, refresh: "x".repeat(40) }, NOW);
  assert.equal(h.tone, "good");
  assert.equal(h.needsReconnect, false);
});
