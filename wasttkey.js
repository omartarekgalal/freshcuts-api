/* ═══════════════════════════════════════════════════════════════════════════
   wasttkey.js — مفتاح تحويل الصوت لنص: يتحفظ من اللوحة، يتجرّب، وبعدها مفتاح «المساعد يسمع» يتفتح (VM2، ١٢/١٠)

   العقد: docs/designs-2026-10/qa-1010/slices/VM2-api-assist-stt-key/README.md
   - المفتاح بيتخزّن متشفّر (AES-256-GCM بسر السيرفر — نفس encryptSecret بتاعة ttconnect.js) في wa_stt_key (صف واحد).
   - مابيرجعش في أي رد (آخر ٤ حروف بس)، ومابيتكتبش في أي سجل، وبيتبعت لمزوّده هو بس على HTTPS.
   - «المساعد يسمع» مابيتفتحش غير لما آخر اختبار ينجح **للمزوّد والموديل والمفتاح الحاليين** (sig).
   - من غير مفتاح محفوظ: طريق البروكسي القديم (LiteLLM) لو فيه موديل تحويل متضاف هناك.
   ═══════════════════════════════════════════════════════════════════════════ */
import { createHash } from "node:crypto";
import { encryptSecret, readSecret, activeSecretName } from "./ttconnect.js";
import { makeTranscriber, VOICE_MAX_BYTES } from "./waassistmedia.js";
import { STT_SAMPLE, sttSampleBuffer } from "./wasttsample.js";

export const STT_PROVIDERS = Object.freeze([
  Object.freeze({ id: "openai", label: "OpenAI", defaultModel: "gpt-4o-transcribe", models: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"], sarPerMin: 0.0225, keyPrefix: "sk-", keyUrl: "https://platform.openai.com/api-keys",
    url: "https://api.openai.com/v1/audio/transcriptions", shape: "openai" }),
  Object.freeze({ id: "groq", label: "Groq", defaultModel: "whisper-large-v3", models: ["whisper-large-v3", "whisper-large-v3-turbo"], sarPerMin: 0.007, keyPrefix: "gsk_", keyUrl: "https://console.groq.com/keys",
    url: "https://api.groq.com/openai/v1/audio/transcriptions", shape: "openai" }),
  Object.freeze({ id: "elevenlabs", label: "ElevenLabs", defaultModel: "scribe_v1", models: ["scribe_v1"], sarPerMin: 0.025, keyPrefix: "sk_", keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    url: "https://api.elevenlabs.io/v1/speech-to-text", shape: "elevenlabs" }),
]);
export const sttProvider = (id) => STT_PROVIDERS.find((p) => p.id === id) || null;
const publicProvider = ({ url: _u, shape: _s, ...p }) => ({ ...p, models: [...p.models] });

export const STT_DDL = `
  CREATE TABLE IF NOT EXISTS wa_stt_key (
    id INT PRIMARY KEY,
    provider TEXT NOT NULL,
    key_enc TEXT NOT NULL,
    last4 TEXT,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    saved_by TEXT,
    test JSONB
  );
`;
export const STT_MESSAGES = Object.freeze({
  no_key: "مفيش مفتاح محفوظ، ومزوّد الموديلات مافيهوش موديل تحويل صوت. الصق مفتاح المزوّد الأول.",
  key_unreadable: "المفتاح المحفوظ مابقاش مقروء (سر السيرفر اتغيّر). الصق المفتاح تاني.",
  key_other_provider: "المفتاح المحفوظ لمزوّد تاني غير المختار. الصق مفتاح المزوّد ده، أو رجّع المزوّد.",
  not_tested: "اضغط «اختبار» الأول: مفتاح «المساعد يسمع» بيتفتح بعد اختبار ناجح.",
  test_failed: "آخر اختبار للمفتاح فشل. صلّح السبب واختبر تاني.",
  test_stale: "المزوّد أو الموديل أو المفتاح اتغيّر بعد آخر اختبار. اختبر تاني.",
  unauthorized: "المزوّد رفض المفتاح: غلط، أو اتلغى، أو انتهى.",
  forbidden: "المفتاح مالوش صلاحية على الموديل ده.",
  model_not_found: "المزوّد مايعرفش اسم الموديل ده.",
  quota: "الرصيد خلص عند المزوّد، أو حد الطلبات اتوصل له.",
  bad_request: "المزوّد رفض الطلب.",
  provider_down: "المزوّد عنده عطل دلوقتي. جرّب بعد شوية.",
  timeout: "المزوّد ماردّش في الوقت.",
  network: "ماقدرناش نوصل للمزوّد.",
  wrong_text: "المزوّد رد، بس ماسمعش العيّنة صح.",
  cooldown: "استنى ١٠ ثواني بين الاختبار والتاني.",
  no_server_secret: "السيرفر ماعندوش سر تشفير (SECRETS_KEY / ADMIN_TOKEN).",
  bad_provider: "اختار المزوّد: OpenAI أو Groq أو ElevenLabs.",
  bad_key: "المفتاح مش بشكل مفتاح المزوّد ده.",
  ok: "المفتاح شغّال والمزوّد سمع العيّنة.",
});
const AUDIO_EXT = { "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "m4a", "audio/amr": "amr", "audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "webm" };
const baseMime = (m) => String(m || "").toLowerCase().split(";")[0].trim();
const statusCode = (s) => (s === 401 ? "unauthorized" : s === 403 ? "forbidden" : s === 404 ? "model_not_found" : s === 429 || s === 402 ? "quota" : s >= 500 ? "provider_down" : "bad_request");
/* كلام المزوّد نفسه (لو فيه): مقصوص، ومن غير أي حاجة شكلها مفتاح. */
export function scrubProviderText(text, key = "") {
  let s = String(text || "");
  if (key) s = s.split(String(key)).join("[key]");
  return s.replace(/\b(sk-|gsk_|sk_|xi-)[A-Za-z0-9_\-*.]{4,}/g, "[key]").replace(/Bearer\s+\S+/gi, "Bearer [key]").replace(/\s+/g, " ").trim().slice(0, 160);
}
export function keyShapeOk(provider, key) {
  const p = sttProvider(provider), k = String(key ?? "");
  return Boolean(p) && k.length >= 20 && k.length <= 300 && !/\s/.test(k) && /^[\x21-\x7e]+$/.test(k) && k.startsWith(p.keyPrefix)
    && !(p.id === "elevenlabs" && k.startsWith("sk-")) && !(p.id === "openai" && k.startsWith("sk_"));
}

/* نداء مباشر لمزوّد التحويل. ⇒ { ok, text, ms, host } أو { ok:false, reason, status?, detail?, ms, host }. عمره ما بيرمي، والمفتاح مابيطلعش في النتيجة. */
export async function transcribeDirect({ provider, key, model, buf, mime, timeoutMs = 20000, fetch: doFetch = globalThis.fetch }) {
  const p = sttProvider(provider), t0 = Date.now(), m = baseMime(mime), ext = AUDIO_EXT[m];
  if (!p) return { ok: false, reason: "bad_provider", ms: 0 };
  const host = new URL(p.url).host;
  if (!buf || !buf.length) return { ok: false, reason: "empty", ms: 0, host };
  if (!ext) return { ok: false, reason: "type", ms: 0, host };
  if (buf.length > VOICE_MAX_BYTES) return { ok: false, reason: "too_large", ms: 0, host };
  const form = new FormData();
  form.append("file", new Blob([buf], { type: m === "audio/opus" ? "audio/ogg" : m }), `voice.${ext}`);
  if (p.shape === "elevenlabs") form.append("model_id", String(model)); else { form.append("model", String(model)); form.append("response_format", "json"); }
  const headers = p.shape === "elevenlabs" ? { "xi-api-key": String(key) } : { authorization: `Bearer ${key}` };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await doFetch(p.url, { method: "POST", signal: ctl.signal, headers, body: form });
    if (!res.ok) {
      let detail = ""; try { const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch { j = null; }
        detail = scrubProviderText((j && (j.error && (j.error.message || j.error) || (j.detail && (j.detail.message || j.detail)) || j.message)) || t, key); if (typeof detail !== "string") detail = ""; } catch { detail = ""; }
      return { ok: false, reason: statusCode(Number(res.status) || 0), status: Number(res.status) || 0, detail, ms: Date.now() - t0, host };
    }
    const data = await res.json();
    const text = String((data && data.text) || "").replace(/\s+/g, " ").trim();
    return text ? { ok: true, text: text.slice(0, 1500), ms: Date.now() - t0, host } : { ok: false, reason: "empty_transcript", ms: Date.now() - t0, host };
  } catch (e) { return { ok: false, reason: e && e.name === "AbortError" ? "timeout" : "network", ms: Date.now() - t0, host }; }
  finally { clearTimeout(timer); }
}

/* deps: { pool, fetch?, env?, proxy? (محوّل البروكسي: للاختبارات), now?, log? } */
export function makeStt(deps = {}) {
  const { pool } = deps;
  const log = deps.log || console, now = deps.now || (() => new Date());
  const doFetch = deps.fetch || globalThis.fetch;
  const proxy = deps.proxy || makeTranscriber({ fetch: doFetch, env: deps.env || process.env });
  const ready = pool ? pool.query(STT_DDL).then(() => true).catch((e) => { log.error("[stt-key] schema:", e.message); return false; }) : Promise.resolve(false);
  const q = async (sql, params = []) => { try { if (!(await ready)) return null; return (await pool.query(sql, params)).rows; } catch (e) { log.error("[stt-key]", e.message); return null; } };
  let lastTestMs = 0;

  const rowOf = async () => { const r = await q("SELECT provider, key_enc, last4, saved_at, saved_by, test FROM wa_stt_key WHERE id=1"); return r === null ? null : (r[0] || false); };
  /* بصمة «اللي اتجرّب»: المزوّد + الموديل + المفتاح المتشفّر (أو proxy). أي تغيير فيهم ⇒ الاختبار القديم مابقاش ساري. */
  const sigOf = (acfg, row) => createHash("sha256").update(`${acfg.sttProvider}|${acfg.sttModel}|${row ? row.key_enc : "proxy"}`).digest("hex").slice(0, 24);
  /* ⇒ { route: "direct", key, under } | { route: "proxy" } | { route: "none", reason } */
  function routeOf(acfg, row) {
    if (row === null) return { route: "none", reason: "no_key" };
    if (!row) return { route: "proxy" };
    const r = readSecret(row.key_enc);
    if (r.plain === null) return { route: "none", reason: "key_unreadable" };
    if (row.provider !== acfg.sttProvider) return { route: "none", reason: "key_other_provider" };
    return { route: "direct", key: r.plain, under: r.under };
  }
  const publicKey = (acfg, row) => { if (!row) return { saved: false }; const r = readSecret(row.key_enc);
    return { saved: true, provider: row.provider, last4: row.last4 || null, savedAt: row.saved_at ? new Date(row.saved_at).toISOString() : null, savedBy: row.saved_by || null, readable: r.plain !== null, under: r.under, matchesProvider: row.provider === acfg.sttProvider }; };
  const testOf = (acfg, row) => { const t = row && row.test ? row.test : (row === false ? proxyTest : null); if (!t) return null; const { sig, ...pub } = t; return { ...pub, current: sig === sigOf(acfg, row || null) }; };
  let proxyTest = null;      // اختبار طريق البروكسي (من غير مفتاح محفوظ) بيتحفظ في الذاكرة بس: مفيش صف يتكتب عليه

  /* مفتاح «المساعد يسمع» ينفع يتفتح؟ ⇒ { ok, reason, message } */
  async function canEnable(acfg) {
    const row = await rowOf();
    const rt = routeOf(acfg, row);
    const no = (reason) => ({ ok: false, reason, message: STT_MESSAGES[reason] });
    if (rt.route === "none") return no(rt.reason);
    const t = testOf(acfg, row);
    if (!t) return no(rt.route === "proxy" ? "no_key" : "not_tested");
    if (!t.current) return no("test_stale");
    if (!t.ok) return no("test_failed");
    return { ok: true, reason: null, message: null };
  }
  /* التحويل الفعلي (للرسايل الصوتية وللاختبار). ⇒ نفس شكل makeTranscriber + route. */
  async function transcribe({ acfg, buf, mime, timeoutMs = 20000 }) {
    const row = await rowOf();
    const rt = routeOf(acfg, row);
    if (rt.route === "none") return { ok: false, reason: rt.reason, ms: 0, route: "none" };
    if (rt.route === "proxy") { const r = await proxy({ buf, mime, model: acfg.sttModel, timeoutMs }); return { ...r, route: "proxy" }; }
    const r = await transcribeDirect({ provider: acfg.sttProvider, key: rt.key, model: acfg.sttModel, buf, mime, timeoutMs, fetch: doFetch });
    return { ...r, provider: `stt:${r.host || acfg.sttProvider}`, route: "direct" };
  }
  async function status(acfg) {
    const row = await rowOf();
    if (row === null) return null;
    const rt = routeOf(acfg, row), ce = await canEnable(acfg);
    return { ok: true, provider: acfg.sttProvider, model: acfg.sttModel, sarPerMin: acfg.sttSarPerMin, voiceEnabled: acfg.voiceEnabled === true,
      key: publicKey(acfg, row), route: rt.route, test: testOf(acfg, row), canEnable: ce.ok, reason: ce.reason, reasonMessage: ce.message,
      providers: STT_PROVIDERS.map(publicProvider), secretStore: activeSecretName(),
      testCost: { seconds: STT_SAMPLE.seconds, sar: Math.round((STT_SAMPLE.seconds / 60) * acfg.sttSarPerMin * 1e4) / 1e4 } };
  }
  async function saveKey({ provider, key, who }) {
    const fail = (error, status = 400) => ({ ok: false, status, error, message: STT_MESSAGES[error] });
    if (!sttProvider(provider)) return fail("bad_provider");
    const k = typeof key === "string" ? key.trim() : "";
    if (!keyShapeOk(provider, k)) return fail("bad_key");
    if (!activeSecretName()) return fail("no_server_secret", 503);
    let enc; try { enc = encryptSecret(k); } catch { return fail("no_server_secret", 503); }
    const r = await q(`INSERT INTO wa_stt_key(id, provider, key_enc, last4, saved_at, saved_by, test) VALUES (1,$1,$2,$3,NOW(),$4,NULL)
                       ON CONFLICT (id) DO UPDATE SET provider=$1, key_enc=$2, last4=$3, saved_at=NOW(), saved_by=$4, test=NULL RETURNING provider`, [provider, enc, k.slice(-4), who ? String(who).slice(0, 80) : null]);
    if (!r || !r[0]) return fail("unavailable", 503);
    return { ok: true, last4: k.slice(-4), provider };
  }
  async function deleteKey() { const r = await q("DELETE FROM wa_stt_key WHERE id=1"); return r === null ? { ok: false, status: 503, error: "unavailable" } : { ok: true }; }

  /* اختبار المفتاح بالعيّنة المرفقة. بيكلّف جزء من هللة (STT_SAMPLE.seconds ثانية). ⇒ الرد اللي في العقد + cost (للتسجيل). */
  async function test(acfg) {
    const t0 = now().getTime();
    if (t0 - lastTestMs < 10_000) return { ok: false, status: 429, error: "cooldown", message: STT_MESSAGES.cooldown };
    const row = await rowOf();
    if (row === null) return { ok: false, status: 503, error: "unavailable", message: STT_MESSAGES.network };
    const rt = routeOf(acfg, row);
    const base = { route: rt.route, provider: acfg.sttProvider, model: acfg.sttModel };
    let out;
    if (rt.route === "none") out = { ok: false, ...base, ms: 0, costSar: 0, heard: null, error: rt.reason, message: STT_MESSAGES[rt.reason] };
    else {
      lastTestMs = t0;
      const r = await transcribe({ acfg, buf: sttSampleBuffer(), mime: STT_SAMPLE.mime, timeoutMs: 30000 });
      const heard = r.ok ? r.text : null, right = r.ok && heard.replace(/[ً-ْـ]/g, "").includes(STT_SAMPLE.expect);
      const code = r.ok ? (right ? null : "wrong_text") : (rt.route === "proxy" && /^(http_4|no_provider)/.test(String(r.reason)) ? "no_key" : /^http_/.test(String(r.reason)) ? statusCode(Number(String(r.reason).slice(5))) : STT_MESSAGES[r.reason] ? r.reason : r.reason === "empty_transcript" ? "wrong_text" : "bad_request");
      const cost = r.ok ? Math.round((STT_SAMPLE.seconds / 60) * acfg.sttSarPerMin * 1e6) / 1e6 : 0;
      out = { ok: Boolean(right), ...base, ms: Math.round(Number(r.ms) || 0), costSar: cost, heard: heard ? heard.slice(0, 200) : null, error: code,
        message: code ? `${STT_MESSAGES[code]}${r.detail ? ` (${r.detail})` : ""}` : STT_MESSAGES.ok, ran: true };
    }
    const stored = { ok: out.ok, at: now().toISOString(), ms: out.ms, costSar: out.costSar, heard: out.heard, error: out.error, message: out.message, sig: sigOf(acfg, row || null) };
    if (row) await q("UPDATE wa_stt_key SET test=$1::jsonb WHERE id=1", [JSON.stringify(stored)]); else proxyTest = stored;
    const ce = await canEnable(acfg);
    return { ...out, canEnable: ce.ok, reason: ce.reason };
  }
  return { ready, status, saveKey, deleteKey, test, transcribe, canEnable };
}
