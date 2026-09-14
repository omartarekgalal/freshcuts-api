/* DNS احتياطي — 14 سبتمبر 2026: DNS الحاوية فشل (EAI_AGAIN) على تقنيات وتاب سينس ولاجلك.
     node --test dns-fallback.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { makeLookup } from "./dns-fallback.js";

const fail = (code) => (host, opts, cb) => cb(Object.assign(new Error(code), { code }));
const okLookup = (host, opts, cb) => (opts.all ? cb(null, [{ address: "10.0.0.1", family: 4 }]) : cb(null, "10.0.0.1", 4));
const resolver = (addrs, err = null) => {
  const calls = { n: 0 };
  return { calls, resolve4: (h, cb) => { calls.n++; cb(err, addrs); }, resolve6: (h, cb) => { calls.n++; cb(err, addrs); } };
};
const run = (lookup, host, opts = {}) => new Promise((r) => lookup(host, opts, (...a) => r(a)));

test("الاستعلام العادي نجح ⇒ الاحتياطي مايتلمسش", async () => {
  const rv = resolver(["1.2.3.4"]);
  const [err, addr] = await run(makeLookup(okLookup, rv, { log: null }), "api.taqnyat.sa");
  assert.equal(err, null); assert.equal(addr, "10.0.0.1"); assert.equal(rv.calls.n, 0);
});

test("EAI_AGAIN ⇒ بيرجع عنوان من Cloudflare/Google", async () => {
  const rv = resolver(["62.204.48.59"]);
  const [err, addr, fam] = await run(makeLookup(fail("EAI_AGAIN"), rv, { log: null }), "api.taqnyat.sa");
  assert.equal(err, null); assert.equal(addr, "62.204.48.59"); assert.equal(fam, 4); assert.equal(rv.calls.n, 1);
});

test("options.all (اللي fetch بيستخدمه) ⇒ مصفوفة عناوين", async () => {
  const rv = resolver(["1.1.1.1", "1.0.0.1"]);
  const [err, list] = await run(makeLookup(fail("EAI_AGAIN"), rv, { log: null }), "app.leajlak.com", { all: true });
  assert.equal(err, null);
  assert.deepEqual(list, [{ address: "1.1.1.1", family: 4 }, { address: "1.0.0.1", family: 4 }]);
});

test("اسم خدمة داخلية (من غير نقطة) ⇒ الخطأ الأصلي من غير احتياطي", async () => {
  const rv = resolver(["9.9.9.9"]);
  const [err] = await run(makeLookup(fail("ENOTFOUND"), rv, { log: null }), "shared-postgres");
  assert.equal(err.code, "ENOTFOUND"); assert.equal(rv.calls.n, 0);
});

test("الاحتياطي كمان فشل ⇒ الخطأ الأصلي زي ما هو", async () => {
  const rv = resolver(null, Object.assign(new Error("x"), { code: "ETIMEOUT" }));
  const [err] = await run(makeLookup(fail("EAI_AGAIN"), rv, { log: null }), "api.myfatoorah.com");
  assert.equal(err.code, "EAI_AGAIN");
});

test("أخطاء مش مؤقتة ماتروحش للاحتياطي", async () => {
  const rv = resolver(["9.9.9.9"]);
  const [err] = await run(makeLookup(fail("EINVAL"), rv, { log: null }), "api.taqnyat.sa");
  assert.equal(err.code, "EINVAL"); assert.equal(rv.calls.n, 0);
});
