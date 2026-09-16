/* مفتاح استكمال/تتبع الطلب (W1-02) — node --test resume-key.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { resumeKey, verifyResumeKey, normCreatedAt, KEY_LENGTH } from "./resume-key.js";

const SECRET = "test-secret-not-real";
const ROW = { order_no: "W1726480000000", created_at: new Date("2026-09-16T10:00:00.123Z") };

test("المفتاح ٢٤ حرف وآمن في الرابط", () => {
  const k = resumeKey(ROW, SECRET);
  assert.equal(typeof k, "string");
  assert.equal(k.length, KEY_LENGTH);
  assert.equal(KEY_LENGTH, 24);
  assert.match(k, /^[A-Za-z0-9_-]{24}$/);
});

test("ثابت لنفس الطلب — مهما كان شكل created_at (Date / ISO / نص pg)", () => {
  const a = resumeKey(ROW, SECRET);
  assert.equal(resumeKey(ROW, SECRET), a);
  assert.equal(resumeKey({ orderNo: ROW.order_no, createdAt: "2026-09-16T10:00:00.123Z" }, SECRET), a);
  assert.equal(resumeKey({ order_no: ROW.order_no, created_at: "2026-09-16 13:00:00.123+03" }, SECRET), a);
});

test("مختلف لطلب تاني، ولوقت إنشاء تاني، ولسر تاني", () => {
  const a = resumeKey(ROW, SECRET);
  assert.notEqual(resumeKey({ ...ROW, order_no: "W1726480000001" }, SECRET), a);
  assert.notEqual(resumeKey({ ...ROW, created_at: new Date("2026-09-16T10:00:01.123Z") }, SECRET), a);
  assert.notEqual(resumeKey(ROW, "another-secret"), a);
});

test("HMAC_SHA256(secret, orderNo|created_at) بالظبط", async () => {
  const crypto = await import("node:crypto");
  const expected = crypto.createHmac("sha256", SECRET)
    .update(`${ROW.order_no}|${ROW.created_at.toISOString()}`).digest("base64url").slice(0, 24);
  assert.equal(resumeKey(ROW, SECRET), expected);
});

test("من غير سر أو بيانات ناقصة → null (مابيرميش)", () => {
  assert.equal(resumeKey(ROW, ""), null);
  assert.equal(resumeKey(ROW, undefined), null);
  assert.equal(resumeKey(null, SECRET), null);
  assert.equal(resumeKey({ order_no: "W1" }, SECRET), null);
  assert.equal(resumeKey({ created_at: new Date() }, SECRET), null);
  assert.equal(resumeKey({ order_no: "W1", created_at: "not a date" }, SECRET), null);
});

test("من غير باراميتر السر بيقرا SHOP_RESUME_SECRET", () => {
  const prev = process.env.SHOP_RESUME_SECRET;
  try {
    delete process.env.SHOP_RESUME_SECRET;
    assert.equal(resumeKey(ROW), null);
    process.env.SHOP_RESUME_SECRET = SECRET;
    assert.equal(resumeKey(ROW), resumeKey(ROW, SECRET));
  } finally {
    if (prev === undefined) delete process.env.SHOP_RESUME_SECRET; else process.env.SHOP_RESUME_SECRET = prev;
  }
});

test("verifyResumeKey: الصح بس اللي بيعدّي", () => {
  const k = resumeKey(ROW, SECRET);
  assert.equal(verifyResumeKey(ROW, k, SECRET), true);
  assert.equal(verifyResumeKey({ ...ROW, order_no: "W9" }, k, SECRET), false);
  assert.equal(verifyResumeKey(ROW, k.slice(0, 23) + (k[23] === "A" ? "B" : "A"), SECRET), false);
  assert.equal(verifyResumeKey(ROW, k.slice(0, 10), SECRET), false);
  assert.equal(verifyResumeKey(ROW, null, SECRET), false);
  assert.equal(verifyResumeKey(ROW, k, ""), false);
});

test("normCreatedAt", () => {
  assert.equal(normCreatedAt(null), null);
  assert.equal(normCreatedAt(""), null);
  assert.equal(normCreatedAt("x"), null);
  assert.equal(normCreatedAt(0), "1970-01-01T00:00:00.000Z");
  assert.equal(normCreatedAt("2026-09-16T10:00:00Z"), "2026-09-16T10:00:00.000Z");
});
