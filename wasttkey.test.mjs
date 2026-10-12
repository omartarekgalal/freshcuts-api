/* 🔑 مفتاح تحويل الصوت لنص — node --test wasttkey.test.mjs
   مزوّد وهمي وقاعدة في الذاكرة. مفيش أي مفتاح حقيقي ولا نداء شبكة. */
import test from "node:test";
import assert from "node:assert/strict";
import { makeStt, transcribeDirect, keyShapeOk, scrubProviderText, sttProvider, STT_PROVIDERS, STT_MESSAGES } from "./wasttkey.js";
import { encryptSecret, decryptSecret, readSecret, activeSecretName, knownFingerprints, keyFingerprint } from "./ttconnect.js";
import { STT_SAMPLE, sttSampleBuffer } from "./wasttsample.js";

const KEY = "sk-proj-TESTONLYnotARealKey0123456789abcdWXYZ";
const GROQ = "gsk_TESTONLYnotARealKey0123456789abcdQRST";
const withSecrets = (vals, fn) => async () => {
  const saved = { SECRETS_KEY: process.env.SECRETS_KEY, ADMIN_TOKEN: process.env.ADMIN_TOKEN };
  delete process.env.SECRETS_KEY; delete process.env.ADMIN_TOKEN; Object.assign(process.env, vals);
  try { await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
function fakePool() {
  const db = { row: null, sql: [] };
  return { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim(); db.sql.push([s, p]);
    if (/^CREATE TABLE IF NOT EXISTS wa_stt_key/i.test(s)) return { rows: [] };
    if (/^SELECT provider, key_enc, last4, saved_at, saved_by, test FROM wa_stt_key/i.test(s)) return { rows: db.row ? [{ ...db.row }] : [] };
    if (/^INSERT INTO wa_stt_key/i.test(s)) { db.row = { provider: p[0], key_enc: p[1], last4: p[2], saved_at: "2026-10-20T10:00:00.000Z", saved_by: p[3], test: null }; return { rows: [{ provider: p[0] }] }; }
    if (/^UPDATE wa_stt_key SET test=/i.test(s)) { if (db.row) db.row.test = JSON.parse(p[0]); return { rows: [] }; }
    if (/^DELETE FROM wa_stt_key/i.test(s)) { db.row = null; return { rows: [] }; }
    throw new Error("unexpected SQL: " + s.slice(0, 80));
  } };
}
const A = (o = {}) => ({ sttProvider: "openai", sttModel: "gpt-4o-transcribe", sttSarPerMin: 0.0225, voiceEnabled: false, ...o });
/* مزوّد وهمي: بيسجّل الطلبات وبيرد زي ما نقول له */
function provider(answer) {
  const calls = [];
  const fetch = async (url, o) => { calls.push({ url: String(url), headers: o.headers, form: o.body }); const a = typeof answer === "function" ? answer(url, o) : answer;
    return { ok: a.status === 200, status: a.status, json: async () => a.body, text: async () => (typeof a.body === "string" ? a.body : JSON.stringify(a.body)) }; };
  return { calls, fetch };
}
const HEARD = { status: 200, body: { text: "السَّلامُ عليكم ورحمة الله." } };
const clock = (start = Date.parse("2026-10-20T10:00:00Z")) => { let t = start; return { now: () => new Date(t), add: (s) => { t += s * 1000; } }; };
const quiet = { error() {} };

test("the server secret: a value encrypted under ADMIN_TOKEN still reads after SECRETS_KEY is added; new values go under SECRETS_KEY; a wrong secret reads nothing", withSecrets({ ADMIN_TOKEN: "admin-token-old" }, async () => {
  assert.equal(activeSecretName(), "ADMIN_TOKEN");
  const old = encryptSecret("tiktok-token-value");
  const fpOld = keyFingerprint();
  assert.deepEqual(readSecret(old), { plain: "tiktok-token-value", under: "ADMIN_TOKEN" });
  process.env.SECRETS_KEY = "a-new-dedicated-secret";                       // the coordinator adds it later
  assert.equal(activeSecretName(), "SECRETS_KEY");
  assert.equal(decryptSecret(old), "tiktok-token-value", "the old value is still readable");
  assert.deepEqual(readSecret(old), { plain: "tiktok-token-value", under: "ADMIN_TOKEN" });
  assert.ok(knownFingerprints().includes(fpOld), "its stored fingerprint is still a known one, so nothing is reported as «the key changed»");
  const fresh = encryptSecret("new-value");
  assert.deepEqual(readSecret(fresh), { plain: "new-value", under: "SECRETS_KEY" });
  // ADMIN_TOKEN rotated afterwards: values under SECRETS_KEY survive, values still under the old ADMIN_TOKEN do not
  process.env.ADMIN_TOKEN = "admin-token-rotated";
  assert.equal(decryptSecret(fresh), "new-value"); assert.deepEqual(readSecret(old), { plain: null, under: null });
  // an explicit secret keeps the old strict behaviour
  assert.equal(decryptSecret(old, "admin-token-old"), "tiktok-token-value"); assert.equal(decryptSecret(old, "nope"), null);
  delete process.env.SECRETS_KEY; delete process.env.ADMIN_TOKEN;
  assert.equal(activeSecretName(), null); assert.equal(decryptSecret(old), null); assert.throws(() => encryptSecret("x"));
}));

test("providers and key shape: three providers with their hosts; a key must look like that provider's key", () => {
  assert.deepEqual(STT_PROVIDERS.map((p) => [p.id, new URL(p.url).host, p.defaultModel, p.keyPrefix]), [["openai", "api.openai.com", "gpt-4o-transcribe", "sk-"], ["groq", "api.groq.com", "whisper-large-v3", "gsk_"], ["elevenlabs", "api.elevenlabs.io", "scribe_v1", "sk_"]]);
  for (const p of STT_PROVIDERS) { assert.ok(p.url.startsWith("https://")); assert.ok(p.models.includes(p.defaultModel)); assert.ok(p.sarPerMin > 0 && p.sarPerMin < 1); }
  assert.equal(keyShapeOk("openai", KEY), true); assert.equal(keyShapeOk("groq", GROQ), true); assert.equal(keyShapeOk("elevenlabs", "sk_" + "a".repeat(40)), true);
  for (const [p, k] of [["openai", GROQ], ["groq", KEY], ["elevenlabs", KEY], ["openai", "sk_" + "a".repeat(40)], ["openai", "sk-short"], ["openai", "sk-" + "a".repeat(400)], ["openai", "sk-has space" + "a".repeat(30)], ["openai", "sk-line\nbreak" + "a".repeat(30)], ["openai", ""], ["openai", null], ["azure", KEY], ["openai", "sk-" + "ع".repeat(30)]]) assert.equal(keyShapeOk(p, k), false, `${p} ${String(k).slice(0, 12)}`);
  assert.equal(sttProvider("nope"), null);
  assert.equal(scrubProviderText(`Incorrect API key provided: ${KEY}. Find it at…`, KEY).includes("TESTONLY"), false);
  assert.equal(scrubProviderText("Invalid key sk-abc****************WXYZ or gsk_1234abcd"), "Invalid key [key] or [key]");
  assert.equal(scrubProviderText("Authorization: Bearer abc.def.ghi rejected"), "Authorization: Bearer [key] rejected");
  assert.ok(scrubProviderText("x".repeat(500)).length <= 160);
});

test("the direct call: each provider's own URL, header and field names; the key goes only into the header; every failure has a code", async () => {
  const p = provider(HEARD);
  const r = await transcribeDirect({ provider: "openai", key: KEY, model: "gpt-4o-transcribe", buf: sttSampleBuffer(), mime: "audio/wav", fetch: p.fetch });
  assert.deepEqual([r.ok, r.text, r.host], [true, "السَّلامُ عليكم ورحمة الله.", "api.openai.com"]);
  assert.equal(p.calls[0].url, "https://api.openai.com/v1/audio/transcriptions"); assert.deepEqual(p.calls[0].headers, { authorization: `Bearer ${KEY}` });
  assert.equal(p.calls[0].form.get("model"), "gpt-4o-transcribe"); assert.equal(p.calls[0].form.get("file").name, "voice.wav"); assert.equal(p.calls[0].form.get("file").size, STT_SAMPLE.bytes);
  const g = provider(HEARD); await transcribeDirect({ provider: "groq", key: GROQ, model: "whisper-large-v3", buf: sttSampleBuffer(), mime: "audio/ogg; codecs=opus", fetch: g.fetch });
  assert.equal(g.calls[0].url, "https://api.groq.com/openai/v1/audio/transcriptions"); assert.equal(g.calls[0].headers.authorization, `Bearer ${GROQ}`); assert.equal(g.calls[0].form.get("file").name, "voice.ogg");
  const e = provider(HEARD); const el = "sk_" + "b".repeat(40); await transcribeDirect({ provider: "elevenlabs", key: el, model: "scribe_v1", buf: sttSampleBuffer(), mime: "audio/wav", fetch: e.fetch });
  assert.equal(e.calls[0].url, "https://api.elevenlabs.io/v1/speech-to-text"); assert.deepEqual(e.calls[0].headers, { "xi-api-key": el }); assert.equal(e.calls[0].form.get("model_id"), "scribe_v1"); assert.equal(e.calls[0].form.get("model"), null);
  for (const c of [p, g, e]) assert.ok(![...c.calls[0].form.entries()].some(([, v]) => typeof v === "string" && /TESTONLY|bbbbbbbb/.test(v)), "the key is never a form field");
  const fail = async (status, body) => transcribeDirect({ provider: "openai", key: KEY, model: "m", buf: sttSampleBuffer(), mime: "audio/wav", fetch: provider({ status, body }).fetch });
  assert.deepEqual([(await fail(401, { error: { message: `Incorrect API key provided: ${KEY}` } })).reason, (await fail(403, {})).reason, (await fail(404, { error: { message: "The model `x` does not exist" } })).reason, (await fail(429, {})).reason, (await fail(402, {})).reason, (await fail(400, "bad")).reason, (await fail(503, "")).reason],
    ["unauthorized", "forbidden", "model_not_found", "quota", "quota", "bad_request", "provider_down"]);
  const bad = await fail(401, { error: { message: `Incorrect API key provided: ${KEY}` } });
  assert.ok(!JSON.stringify(bad).includes("TESTONLY"), "the provider echoing the key back does not put it in our answer");
  assert.equal((await fail(404, { error: { message: "The model `x` does not exist" } })).detail, "The model `x` does not exist");
  assert.equal((await fail(200, { text: "  " })).reason, "empty_transcript");
  assert.equal((await transcribeDirect({ provider: "openai", key: KEY, model: "m", buf: sttSampleBuffer(), mime: "audio/wav", fetch: async () => { throw new Error("ENOTFOUND"); } })).reason, "network");
  assert.equal((await transcribeDirect({ provider: "openai", key: KEY, model: "m", buf: sttSampleBuffer(), mime: "audio/wav", timeoutMs: 1000, fetch: (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" })))) })).reason, "timeout");
  assert.equal((await transcribeDirect({ provider: "openai", key: KEY, model: "m", buf: sttSampleBuffer(), mime: "video/mp4", fetch: p.fetch })).reason, "type");
});

test("save / status / delete: the key is stored encrypted, comes back as last4 only, and a new key clears the old test", withSecrets({ ADMIN_TOKEN: "admin-token-x" }, async () => {
  const pool = fakePool(), p = provider(HEARD), ck = clock();
  const stt = makeStt({ pool, fetch: p.fetch, now: ck.now, log: quiet, proxy: async () => ({ ok: false, reason: "http_400", ms: 3 }) });
  let s = await stt.status(A());
  assert.deepEqual([s.key, s.route, s.test, s.canEnable, s.reason, s.secretStore], [{ saved: false }, "proxy", null, false, "no_key", "ADMIN_TOKEN"]);
  assert.deepEqual(s.providers.map((x) => Object.keys(x).sort()), Array(3).fill(["defaultModel", "id", "keyPrefix", "keyUrl", "label", "models", "sarPerMin"]), "no URL internals, nothing secret");
  assert.deepEqual(s.testCost, { seconds: STT_SAMPLE.seconds, sar: 0.0009 });
  for (const [body, err] of [[{ provider: "azure", key: KEY }, "bad_provider"], [{ provider: "openai", key: "sk-short" }, "bad_key"], [{ provider: "groq", key: KEY }, "bad_key"], [{ provider: "openai", key: 12345 }, "bad_key"]]) { const r = await stt.saveKey(body); assert.deepEqual([r.ok, r.error, r.status], [false, err, 400]); assert.ok(r.message); }
  assert.equal(pool.db.row, null);
  const r = await stt.saveKey({ provider: "openai", key: `  ${KEY}  `, who: "omar" });
  assert.deepEqual(r, { ok: true, last4: "WXYZ", provider: "openai" });
  assert.match(pool.db.row.key_enc, /^v1:/); assert.ok(!JSON.stringify(pool.db.row).includes("TESTONLY"), "nothing readable is stored");
  assert.ok(!JSON.stringify(pool.db.sql).includes("TESTONLY"), "the key is in no SQL parameter in the clear");
  assert.equal(decryptSecret(pool.db.row.key_enc), KEY);
  s = await stt.status(A());
  assert.deepEqual(s.key, { saved: true, provider: "openai", last4: "WXYZ", savedAt: "2026-10-20T10:00:00.000Z", savedBy: "omar", readable: true, under: "ADMIN_TOKEN", matchesProvider: true });
  assert.deepEqual([s.route, s.canEnable, s.reason], ["direct", false, "not_tested"]); assert.ok(!JSON.stringify(s).includes("TESTONLY"));
  // the chosen provider differs from the saved key's provider
  s = await stt.status(A({ sttProvider: "groq", sttModel: "whisper-large-v3" }));
  assert.deepEqual([s.key.matchesProvider, s.route, s.reason], [false, "none", "key_other_provider"]);
  // test passes → can enable; a NEW key (even the same provider) clears it
  const t = await stt.test(A()); assert.equal(t.ok, true); assert.equal((await stt.status(A())).canEnable, true);
  await stt.saveKey({ provider: "openai", key: KEY.replace("WXYZ", "9999"), who: "omar" });
  s = await stt.status(A()); assert.deepEqual([s.test, s.canEnable, s.reason, s.key.last4], [null, false, "not_tested", "9999"]);
  // the server secret changed and the old one is gone ⇒ unreadable, said plainly
  process.env.ADMIN_TOKEN = "rotated";
  s = await stt.status(A()); assert.deepEqual([s.key.readable, s.key.under, s.route, s.reason], [false, null, "none", "key_unreadable"]);
  assert.equal((await stt.transcribe({ acfg: A(), buf: sttSampleBuffer(), mime: "audio/wav" })).reason, "key_unreadable");
  process.env.ADMIN_TOKEN = "admin-token-x";
  assert.deepEqual(await stt.deleteKey(), { ok: true }); assert.equal(pool.db.row, null); assert.deepEqual(await stt.deleteKey(), { ok: true });
  // no server secret at all ⇒ refuse to store
  delete process.env.ADMIN_TOKEN;
  assert.deepEqual([(await stt.saveKey({ provider: "openai", key: KEY })).error, (await stt.saveKey({ provider: "openai", key: KEY })).status], ["no_server_secret", 503]);
}));

test("the test button: the bundled sample to the chosen provider; pass = it heard «سلام»; the result gates the switch for exactly this provider + model + key; cooldown", withSecrets({ SECRETS_KEY: "dedicated", ADMIN_TOKEN: "admin" }, async () => {
  const pool = fakePool(), ck = clock(); let answer = HEARD;
  const p = provider(() => answer);
  const stt = makeStt({ pool, fetch: p.fetch, now: ck.now, log: quiet, proxy: async () => ({ ok: false, reason: "http_404", ms: 4, provider: "stt:llm.o2m8.me" }) });
  // no key: the model provider is tried, it has no such model ⇒ no_key, and nothing unlocks
  let t = await stt.test(A());
  assert.deepEqual([t.ok, t.route, t.error, t.canEnable, t.costSar], [false, "proxy", "no_key", false, 0]); assert.equal(t.message, STT_MESSAGES.no_key);
  await stt.saveKey({ provider: "openai", key: KEY, who: "omar" });
  assert.equal((await stt.status(A())).key.under, "SECRETS_KEY");
  t = await stt.test(A()); assert.deepEqual([t.status, t.error], [429, "cooldown"]); assert.equal(p.calls.length, 0, "the cooldown stops the call itself");
  ck.add(11);
  t = await stt.test(A());
  assert.deepEqual([t.ok, t.route, t.provider, t.model, t.heard, t.error, t.costSar, t.canEnable, t.reason], [true, "direct", "openai", "gpt-4o-transcribe", "السَّلامُ عليكم ورحمة الله.", null, 0.000938, true, null]);
  assert.equal(p.calls.length, 1); assert.equal(p.calls[0].form.get("file").size, STT_SAMPLE.bytes); assert.equal(p.calls[0].form.get("file").type, "audio/wav");
  let s = await stt.status(A());
  assert.deepEqual([s.test.ok, s.test.current, s.test.heard, s.canEnable], [true, true, "السَّلامُ عليكم ورحمة الله.", true]); assert.equal("sig" in s.test, false);
  assert.deepEqual(await stt.canEnable(A()), { ok: true, reason: null, message: null });
  // the model or the provider changes ⇒ the test is stale
  assert.deepEqual([(await stt.canEnable(A({ sttModel: "whisper-1" }))).reason, (await stt.status(A({ sttModel: "whisper-1" }))).test.current], ["test_stale", false]);
  assert.equal((await stt.canEnable(A({ sttProvider: "groq" }))).reason, "key_other_provider");
  // failures, each in words, each locking the switch again
  for (const [ans, code, extra] of [[{ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } }, "unauthorized", /\[key\]/], [{ status: 404, body: { error: { message: "model not found" } } }, "model_not_found", /model not found/],
    [{ status: 429, body: {} }, "quota", null], [{ status: 500, body: "" }, "provider_down", null], [{ status: 200, body: { text: "hello world" } }, "wrong_text", null], [{ status: 200, body: { text: "" } }, "wrong_text", null]]) {
    ck.add(11); answer = ans; t = await stt.test(A());
    assert.deepEqual([t.ok, t.error, t.canEnable, t.reason], [false, code, false, "test_failed"], code); assert.ok(t.message.startsWith(STT_MESSAGES[code]));
    if (extra) assert.match(t.message, extra); assert.ok(!JSON.stringify(t).includes("TESTONLY"));
  }
  assert.equal(t.heard, null); assert.equal(t.costSar, 0);
  // and back to passing
  ck.add(11); answer = HEARD; t = await stt.test(A()); assert.equal(t.canEnable, true);
  // the voice path uses the same key and host
  const v = await stt.transcribe({ acfg: A(), buf: sttSampleBuffer(), mime: "audio/wav" });
  assert.deepEqual([v.ok, v.route, v.provider], [true, "direct", "stt:api.openai.com"]); assert.ok(!JSON.stringify(v).includes("TESTONLY"));
}));

test("the bundled sample is a real small wav", () => {
  const b = sttSampleBuffer();
  assert.equal(b.length, STT_SAMPLE.bytes); assert.equal(b.toString("latin1", 0, 4), "RIFF"); assert.equal(b.toString("latin1", 8, 12), "WAVE");
  assert.equal(b.readUInt32LE(24), STT_SAMPLE.rate); assert.equal(b.readUInt16LE(22), 1); assert.equal(b.readUInt16LE(34), 16);
  assert.ok(STT_SAMPLE.seconds >= 1.5 && STT_SAMPLE.seconds <= 4 && b.length < 150_000);
  assert.equal(Math.round(((b.length - 44) / 2 / STT_SAMPLE.rate) * 100) / 100, STT_SAMPLE.seconds);
});
