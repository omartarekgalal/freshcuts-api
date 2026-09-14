/* إرسال SMS (تقنيات): إعادة المحاولة على أعطال الشبكة بس — 14 سبتمبر 2026 DNS
   الحاوية فشل (EAI_AGAIN) وعميل ماوصلوش رمز الدخول.
     node --test sms-retry.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { sendSms, smsRetryable } from "./accounts.js";

process.env.TAQNYAT_API_KEY = process.env.TAQNYAT_API_KEY || "test-key";
process.env.TAQNYAT_SENDER = process.env.TAQNYAT_SENDER || "FreshCut";

const netErr = (code) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
const okResp = () => ({ ok: true, status: 201, json: async () => ({ statusCode: 201, messageId: 1 }) });
const realFetch = globalThis.fetch;
const silence = () => { const e = console.error; console.error = () => {}; return () => { console.error = e; }; };

test("أعطال DNS/الاتصال قابلة للإعادة، والمهلة لأ", () => {
  assert.equal(smsRetryable(netErr("EAI_AGAIN")), true);
  assert.equal(smsRetryable(netErr("ENOTFOUND")), true);
  assert.equal(smsRetryable(netErr("UND_ERR_CONNECT_TIMEOUT")), true);
  assert.equal(smsRetryable(Object.assign(new Error("aborted"), { name: "AbortError" })), false);
  assert.equal(smsRetryable(new Error("boom")), false);
});

test("DNS فشل مرتين وبعدين نجح ⇒ الرسالة بتخرج (٣ نداءات)", async () => {
  let calls = 0; const restore = silence();
  globalThis.fetch = async () => { calls++; if (calls < 3) throw netErr("EAI_AGAIN"); return okResp(); };
  try {
    const r = await sendSms({ phoneNorm: "512345678", body: "x" }, { backoffMs: 1 });
    assert.equal(calls, 3);
    assert.equal(r.statusCode, 201);
  } finally { globalThis.fetch = realFetch; restore(); }
});

test("DNS فاشل على طول ⇒ بيرمي بعد ٣ محاولات بس", async () => {
  let calls = 0; const restore = silence();
  globalThis.fetch = async () => { calls++; throw netErr("EAI_AGAIN"); };
  try {
    await assert.rejects(sendSms({ phoneNorm: "512345678", body: "x" }, { backoffMs: 1 }));
    assert.equal(calls, 3);
  } finally { globalThis.fetch = realFetch; restore(); }
});

test("مهلة الرد ⇒ مفيش إعادة (عشان مانبعتش رمزين)", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
  try {
    await assert.rejects(sendSms({ phoneNorm: "512345678", body: "x" }, { backoffMs: 1 }));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("رفض تقنيات (4xx) ⇒ خطأ صريح من غير إعادة", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 401, json: async () => ({ statusCode: 401, message: "bad key" }) }; };
  try {
    await assert.rejects(sendSms({ phoneNorm: "512345678", body: "x" }, { backoffMs: 1 }), /Taqnyat: bad key/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = realFetch; }
});
