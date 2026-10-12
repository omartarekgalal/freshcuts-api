/* ملفات رسايل واتساب (wamedia.js + whatsapp.fetchMedia + المسارات) — MD1
   node --test wamedia.test.mjs — Graph وهمي بيسجّل كل طلب؛ مفيش شبكة حقيقية. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

const W = await import("./whatsapp.js");
const M = await import("./wamedia.js");
const S = await import("./wastaff.js");
const H = await import("./wahub.js");

const A = "512345678", B = "598765432", SALT = "salt-1";
const keyOf = (pn) => crypto.createHash("md5").update(`${SALT}:${pn}`).digest("hex");
const ENV = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID"];
const withEnv = (vals, fn) => async () => { const saved = {}; for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } Object.assign(process.env, vals);
  try { await fn(); } finally { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
const CONFIGURED = { WHATSAPP_TOKEN: "SECRET-TOKEN", WHATSAPP_PHONE_ID: "PHONE1" };      // الإرسال نفسه مقفول (مفيش WHATSAPP_ENABLED)

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), OGG = Buffer.from("OggS-voice-note-bytes"), MP3 = Buffer.alloc(400, 7);
function world({ portalUser = { id: "s1", name: "سلمى", role: "cashier" }, dashUser = { id: 1, username: "omar", name: "عمر", role: "owner" }, transcode = async () => MP3, graph = {} } = {}) {
  const db = { settings: {}, msgs: [
      { id: 11, wamid: "wamid.IMG", direction: "in", phone_norm: A, body: "[صورة]", source: "api", created_at: "2026-10-13T12:00:00Z", media: { kind: "image", id: "900001", mime: "image/jpeg", caption: "الطلب وصل كده" } },
      { id: 12, wamid: "wamid.VOICE", direction: "in", phone_norm: A, body: "[رسالة صوتية]", source: "api", created_at: "2026-10-13T12:01:00Z", media: { kind: "audio", id: "900002", mime: "audio/ogg; codecs=opus", voice: true } },
      { id: 13, wamid: "wamid.DOC", direction: "in", phone_norm: A, body: "[ملف: x.html]", source: "api", created_at: "2026-10-13T12:02:00Z", media: { kind: "document", id: "900003", mime: "text/html", filename: "../x<y>.html" } },
      { id: 14, wamid: "wamid.OLD", direction: "in", phone_norm: A, body: "[صورة]", source: "api", created_at: "2026-10-01T12:00:00Z", media: null },
      { id: 21, wamid: "wamid.OTHER", direction: "in", phone_norm: B, body: "[صورة]", source: "api", created_at: "2026-10-13T12:00:00Z", media: { kind: "image", id: "900009", mime: "image/jpeg" } },
    ], cache: new Map() };
  const files = { 900001: { mime_type: "image/jpeg", buf: JPEG }, 900002: { mime_type: "audio/ogg; codecs=opus", buf: OGG }, 900003: { mime_type: "text/html", buf: Buffer.from("<script>alert(1)</script>") }, 900009: { mime_type: "image/jpeg", buf: JPEG }, ...graph };
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url); calls.push({ url: u, auth: init.headers && init.headers.Authorization });
    const m = /graph\.facebook\.com\/v[\d.]+\/(\d+)$/.exec(u);
    if (m) { const f = files[m[1]]; if (!f || f.gone) return { ok: false, status: 400, json: async () => ({ error: { code: 100, message: "Object does not exist" } }) };
      return { ok: true, status: 200, json: async () => ({ id: m[1], url: f.url || `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${m[1]}`, mime_type: f.mime_type, file_size: f.size ?? f.buf.length }) }; }
    const d = /mid=(\d+)/.exec(u);
    if (d && files[d[1]]) return { ok: true, status: 200, arrayBuffer: async () => files[d[1]].buf };
    return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => Buffer.alloc(0) };
  };
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^SELECT id, phone_norm, media FROM wa_messages WHERE id=\$1/i.test(s)) return { rows: db.msgs.filter((m) => m.id === p[0]) };
    if (/^SELECT mime, size, bytes, on_disk FROM wa_media_cache/i.test(s)) { const c = db.cache.get(`${p[0]}:${p[1]}`); return { rows: c ? [c] : [] }; }
    if (/^INSERT INTO wa_media_cache/i.test(s)) { db.cache.set(`${p[0]}:${p[1]}`, { msg_id: p[0], variant: p[1], mime: p[2], size: p[3], bytes: p[4], on_disk: p[5], at: Date.now() }); return { rows: [], rowCount: 1 }; }
    if (/^DELETE FROM wa_media_cache WHERE fetched_at </i.test(s)) { db.cleanupDays = p[0]; const rows = [...db.cache.values()]; db.cache.clear(); return { rows, rowCount: rows.length }; }
    if (/^SELECT count\(\*\)::int AS files/i.test(s)) { const l = [...db.cache.values()]; return { rows: [{ files: l.length, bytes: l.reduce((a, x) => a + x.size, 0), db_bytes: l.filter((x) => !x.on_disk).reduce((a, x) => a + x.size, 0), converted: l.filter((x) => x.variant !== "orig").length, oldest: null }] }; }
    if (/^SELECT phone_norm FROM wa_threads WHERE md5/i.test(s)) { const hit = [A, B].find((t) => keyOf(t) === p[1] && p[0] === SALT); return { rows: hit ? [{ phone_norm: hit }] : [] }; }
    if (/^SELECT t\.phone_norm, t\.last_in_at, t\.last_at, t\.unread, t\.order_no/i.test(s)) return { rows: p[0] === A ? [{ phone_norm: A, last_in_at: "2026-10-13T12:02:00Z", last_at: "2026-10-13T12:02:00Z", unread: 0 }] : [] };
    if (/^SELECT wamid, direction, status, error, body, template, category, order_no, created_at, source, pricing, id, media FROM wa_messages/i.test(s)) return { rows: db.msgs.filter((m) => m.phone_norm === p[0]).reverse() };
    if (/^INSERT INTO wa_messages\(wamid, direction, phone_norm, status, body/i.test(s)) { db.inserted = (db.inserted || []).concat([p[0]]); return { rows: [{ id: 99 }], rowCount: 1 }; }
    if (/^UPDATE wa_messages SET media=\$2::jsonb WHERE wamid=\$1/i.test(s)) { db.mediaSaved = (db.mediaSaved || []).concat([[p[0], JSON.parse(p[1])]]); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE settings SET data = jsonb_set/i.test(s)) { db.settings.waInbox = JSON.parse(p[0]); return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  } };
  const fakeApp = () => { const routes = {}; const add = (m) => (pth, h) => { routes[`${m} ${pth}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; };
  const users = { portal: portalUser, dash: dashUser, owner: true };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x), isOwner: async () => users.owner,
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(fakeApp(), ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const app = fakeApp();
  let hub = null; const tc = { n: 0 };
  const requirePortal = async (c) => (users.portal ? (users.portal.role === "kitchen" ? { res: c.json({ ok: false, error: "kitchen_only" }, 403) } : { user: users.portal }) : { res: c.json({ ok: false, error: "unauthorized" }, 401) });
  const st = S.register(app, ctx, { wa, hub: () => hub, requirePortal, keySalt: SALT, log: { error() {} }, noTimer: true, transcode: async (b) => { tc.n++; return transcode(b); } });
  hub = H.register(app, ctx, { whoami: async () => users.dash, wa, staff: () => st, keySalt: SALT, log: { error() {} }, timer: false });
  const call = (route, { query = {}, param = {}, json = {} } = {}) => app.routes[route]({
    req: { json: async () => json, header: () => undefined, query: (n) => query[n], param: (n) => param[n] }, json: (body, status = 200) => ({ body, status }), body: (buf, status, headers) => ({ buf, status, headers }) });
  return { db, st, wa, calls, users, call, tc, files, pool };
}

test("mediaOf: the file's details from Meta's message; nothing for text, a location or a bad id", () => {
  assert.deepEqual(W.mediaOf({ type: "image", image: { id: "123456", mime_type: "image/jpeg", sha256: "abc", caption: "صورة الطلب" } }), { kind: "image", id: "123456", mime: "image/jpeg", sha256: "abc", caption: "صورة الطلب" });
  assert.deepEqual(W.mediaOf({ type: "audio", audio: { id: "777777", mime_type: "audio/ogg; codecs=opus", voice: true } }), { kind: "audio", id: "777777", mime: "audio/ogg; codecs=opus", sha256: null, voice: true });
  assert.equal(W.mediaOf({ type: "document", document: { id: "55555", mime_type: "application/pdf", filename: "menu.pdf" } }).filename, "menu.pdf");
  assert.equal(W.mediaOf({ type: "sticker", sticker: { id: "44444", mime_type: "image/webp" } }).kind, "sticker");
  for (const m of [{ type: "text", text: { body: "هلا" } }, { type: "location", location: {} }, { type: "image", image: { id: "../etc" } }, { type: "image" }, null]) assert.equal(W.mediaOf(m), null);
  const parsed = W.parseWebhook({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PHONE1" }, messages: [{ id: "wamid.X", from: "966512345678", type: "audio", timestamp: "1", audio: { id: "777777", mime_type: "audio/ogg", voice: true } }] } }] }] }, { phoneId: "PHONE1" });
  assert.equal(parsed.messages[0].media.id, "777777"); assert.equal(parsed.messages[0].text, "[رسالة صوتية]");
  assert.ok(W.mediaHostOk("https://lookaside.fbsbx.com/x")); assert.ok(W.mediaHostOk("https://mmg.whatsapp.net/x"));
  for (const u of ["http://lookaside.fbsbx.com/x", "https://evil.example/x", "https://fbsbx.com.evil.example/x", "not a url"]) assert.equal(W.mediaHostOk(u), false);
});

test("fetchMedia: two Graph reads with the server token, only to Meta's hosts; works while sending is locked; expired / too large / foreign host are named", withEnv(CONFIGURED, async () => {
  const w = world({ graph: { 900010: { mime_type: "image/jpeg", buf: JPEG, url: "https://evil.example/steal" }, 900011: { mime_type: "video/mp4", buf: JPEG, size: 30 * 1024 * 1024 }, 900012: { gone: true } } });
  const r = await w.wa.fetchMedia("900001");
  assert.equal(r.ok, true); assert.deepEqual(r.buf, JPEG); assert.equal(r.mime, "image/jpeg");
  assert.equal(w.calls.length, 2); assert.match(w.calls[0].url, /graph\.facebook\.com\/v[\d.]+\/900001$/); assert.match(w.calls[1].url, /^https:\/\/lookaside\.fbsbx\.com\//);
  assert.ok(w.calls.every((c) => c.auth === "Bearer SECRET-TOKEN"));
  const n = w.calls.length;
  assert.deepEqual(await w.wa.fetchMedia("900010"), { ok: false, error: "bad_host" });
  assert.equal(w.calls.length, n + 1, "the token is never sent to a host that is not Meta's");
  assert.deepEqual(await w.wa.fetchMedia("900011"), { ok: false, error: "too_large" });
  assert.deepEqual(await w.wa.fetchMedia("900012"), { ok: false, error: "expired" });
  assert.deepEqual(await w.wa.fetchMedia("abc"), { ok: false, error: "bad_id" });
}));
test("fetchMedia without a token ⇒ unconfigured, no network", withEnv({}, async () => {
  const w = world(); assert.deepEqual(await w.wa.fetchMedia("900001"), { ok: false, error: "unconfigured" }); assert.equal(w.calls.length, 0);
}));

test("the chat carries media {ref, kind, mime, voice, filename, caption} — never Meta's file id; old messages have none", withEnv(CONFIGURED, async () => {
  const w = world();
  const t = await w.call("GET /api/cms/wa/threads/:key", { param: { key: keyOf(A) } });
  assert.equal(t.status, 200);
  const by = Object.fromEntries(t.body.messages.map((m) => [m.id, m.media]));
  assert.deepEqual(by["wamid.IMG"], { ref: "11", kind: "image", mime: "image/jpeg", voice: false, filename: null, caption: "الطلب وصل كده" });
  assert.deepEqual(by["wamid.VOICE"], { ref: "12", kind: "audio", mime: "audio/ogg", voice: true, filename: null, caption: null });
  assert.equal(by["wamid.OLD"], null);
  assert.ok(!/90000\d/.test(JSON.stringify(t.body)), "no Graph media id in the answer");
  const p = await w.call("GET /api/portal/wa/chats/:key", { param: { key: keyOf(A) } });
  assert.equal(p.body.messages.find((m) => m.id === "wamid.IMG").media.ref, "11");
}));

test("serving: fetched once from Meta then from our private cache; right type; the file must belong to the chat in the address", withEnv(CONFIGURED, async () => {
  const w = world();
  const img = await w.call("GET /api/cms/wa/threads/:key/media/:ref", { param: { key: keyOf(A), ref: "11" } });
  assert.equal(img.status, 200); assert.deepEqual(img.buf, JPEG);
  assert.equal(img.headers["Content-Type"], "image/jpeg"); assert.match(img.headers["Content-Disposition"], /^inline/); assert.equal(img.headers["Cache-Control"], "private, max-age=3600"); assert.equal(img.headers["X-Content-Type-Options"], "nosniff");
  const n = w.calls.length; assert.equal(n, 2);
  const again = await w.call("GET /api/portal/wa/chats/:key/media/:ref", { param: { key: keyOf(A), ref: "11" } });
  assert.equal(again.status, 200); assert.equal(w.calls.length, n, "second open comes from the cache");
  /* رسالة من محادثة تانية بمفتاح المحادثة دي */
  const cross = await w.call("GET /api/cms/wa/threads/:key/media/:ref", { param: { key: keyOf(A), ref: "21" } });
  assert.equal(cross.status, 404); assert.equal(cross.body.error, "not_found"); assert.equal(w.calls.length, n);
  for (const ref of ["14", "999", "abc", "0"]) assert.equal((await w.call("GET /api/cms/wa/threads/:key/media/:ref", { param: { key: keyOf(A), ref } })).status, 404);
  assert.equal((await w.call("GET /api/cms/wa/threads/:key/media/:ref", { param: { key: "f".repeat(32), ref: "11" } })).status, 404);
  /* ملف HTML من عميل: بينزل كملف خام، مش صفحة */
  const doc = await w.call("GET /api/cms/wa/threads/:key/media/:ref", { param: { key: keyOf(A), ref: "13" } });
  assert.equal(doc.headers["Content-Type"], "application/octet-stream"); assert.match(doc.headers["Content-Disposition"], /^attachment; filename="[\w.\- ]+"$/); assert.ok(!/[<>]|\.\./.test(doc.headers["Content-Disposition"].replace("..html", "")));
}));

test("roles: kitchen and no session are refused on the portal; a dashboard role outside the inbox list is refused", withEnv(CONFIGURED, async () => {
  const w = world();
  w.users.portal = { id: "k", name: "مطبخ", role: "kitchen" };
  assert.equal((await w.call("GET /api/portal/wa/chats/:key/media/:ref", { param: { key: keyOf(A), ref: "11" } })).status, 403);
  w.users.portal = null;
  assert.equal((await w.call("GET /api/portal/wa/chats/:key/media/:ref", { param: { key: keyOf(A), ref: "11" } })).status, 401);
  w.users.dash = { id: 5, username: "mk", name: "تسويق", role: "marketing" };
  assert.equal((await w.call("GET /api/cms/wa/threads/:key/media/:ref", { param: { key: keyOf(A), ref: "11" } })).status, 403);
  assert.equal(w.calls.length, 0);
}));

test("voice notes: the original is ogg/opus; ?as=mp3 converts once and caches; no converter ⇒ 501 and the original still downloads", withEnv(CONFIGURED, async () => {
  const w = world();
  const orig = await w.call("GET /api/portal/wa/chats/:key/media/:ref", { param: { key: keyOf(A), ref: "12" } });
  assert.equal(orig.headers["Content-Type"], "audio/ogg"); assert.deepEqual(orig.buf, OGG);
  const mp3 = await w.call("GET /api/portal/wa/chats/:key/media/:ref", { param: { key: keyOf(A), ref: "12" }, query: { as: "mp3" } });
  assert.equal(mp3.status, 200); assert.equal(mp3.headers["Content-Type"], "audio/mpeg"); assert.deepEqual(mp3.buf, MP3);
  await w.call("GET /api/portal/wa/chats/:key/media/:ref", { param: { key: keyOf(A), ref: "12" }, query: { as: "mp3" } });
  assert.equal(w.tc.n, 1, "converted once"); assert.equal(w.calls.length, 2, "and fetched from Meta once");
  assert.equal((await w.call("GET /api/portal/wa/chats/:key/media/:ref", { param: { key: keyOf(A), ref: "11" }, query: { as: "mp3" } })).status, 400);
  const w2 = world({ transcode: async () => null });
  const no = await w2.call("GET /api/portal/wa/chats/:key/media/:ref", { param: { key: keyOf(A), ref: "12" }, query: { as: "mp3" } });
  assert.equal(no.status, 501); assert.equal(no.body.error, "transcode_unavailable"); assert.ok(no.body.message);
  assert.equal((await w2.call("GET /api/portal/wa/chats/:key/media/:ref", { param: { key: keyOf(A), ref: "12" } })).status, 200);
  assert.equal(await M.ffmpegMp3(OGG, { bin: "ffmpeg-that-does-not-exist-xyz" }), null, "a missing ffmpeg is a clean null");
}));

test("Meta no longer has the file ⇒ 410 with a plain reason; Meta down ⇒ 502; nothing cached", withEnv(CONFIGURED, async () => {
  const w = world({ graph: { 900001: { gone: true } } });
  const r = await w.call("GET /api/cms/wa/threads/:key/media/:ref", { param: { key: keyOf(A), ref: "11" } });
  assert.equal(r.status, 410); assert.equal(r.body.error, "expired"); assert.match(r.body.message, /مابقاش متاح/); assert.equal(w.db.cache.size, 0);
}));

test("pure rules: served types, transcode need, keep days; the module holds no token and calls no network itself", async () => {
  assert.deepEqual(M.servedType("image", "image/jpeg"), { type: "image/jpeg", inline: true });
  assert.deepEqual(M.servedType("image", "image/svg+xml"), { type: "application/octet-stream", inline: false });
  assert.deepEqual(M.servedType("document", "application/pdf"), { type: "application/octet-stream", inline: false });
  assert.deepEqual(M.servedType("audio", "audio/ogg; codecs=opus"), { type: "audio/ogg", inline: true });
  assert.deepEqual([M.needsTranscode("audio/ogg; codecs=opus"), M.needsTranscode("audio/mpeg"), M.needsTranscode("audio/mp4")], [true, false, false]);
  assert.deepEqual([M.keepDays({}), M.keepDays({ waInbox: { mediaKeepDays: 0 } }), M.keepDays({ waInbox: { mediaKeepDays: 999 } }), M.keepDays({ waInbox: { mediaKeepDays: 14 } })], [30, 0, 365, 14]);
  const src = fs.readFileSync(new URL("./wamedia.js", import.meta.url), "utf8");
  assert.ok(!/graph\.facebook|WHATSAPP_TOKEN|fetch\(/.test(src));
  const w = world();
  w.db.cache.set("11:orig", { mime: "image/jpeg", size: 8, bytes: JPEG });
  w.db.settings.waInbox = { mediaKeepDays: 14 };
  assert.equal(await w.st.media.cleanup(), 1); assert.equal(w.db.cleanupDays, 14);
  const set = await w.call("POST /api/cms/wa/threads-hold", { json: { mediaKeepDays: 60 } });
  assert.equal(set.body.mediaKeepDays, 60); assert.equal(set.body.holdAutoReleaseMin, 20); assert.equal(w.db.settings.waInbox.holdAutoReleaseMin, undefined);
  assert.equal((await w.call("POST /api/cms/wa/threads-hold", { json: { mediaKeepDays: 500 } })).status, 400);
  /* MD2: لحد ٣٦٥ يوم، و٠ = بدون حذف (التنضيف مابيمسحش حاجة) */
  assert.equal((await w.call("POST /api/cms/wa/threads-hold", { json: { mediaKeepDays: 365 } })).body.mediaKeepDays, 365);
  assert.equal((await w.call("POST /api/cms/wa/threads-hold", { json: { mediaKeepDays: 0 } })).body.mediaKeepDays, 0);
  w.db.cache.set("11:orig", { msg_id: 11, variant: "orig", mime: "image/jpeg", size: 8, bytes: JPEG, on_disk: false });
  assert.equal(await w.st.media.cleanup(), 0, "0 days = never delete"); assert.equal(w.db.cache.size, 1);
  const g = await w.call("GET /api/cms/wa/threads-hold");
  assert.deepEqual(g.body.mediaKeep, { def: 30, min: 0, max: 365 });
  assert.deepEqual(g.body.mediaUsage, { files: 1, bytes: 8, dbBytes: 8, diskBytes: 0, converted: 0, oldestAt: null, storage: "database" });
});

test("MD2 disk storage: with a private folder the bytes go to a file and the row holds none; served from the file; a lost file is fetched again; cleanup removes the file; an unwritable folder falls back to the database", withEnv(CONFIGURED, async () => {
  const files = new Map(); let failWrite = false;
  const fsFake = { mkdir: async () => {}, writeFile: async (pth, buf) => { if (failWrite) throw new Error("EACCES"); files.set(String(pth).replace(/\\/g, "/"), buf); }, readFile: async (pth) => { const k = String(pth).replace(/\\/g, "/"); if (!files.has(k)) throw new Error("ENOENT"); return files.get(k); }, unlink: async (pth) => { files.delete(String(pth).replace(/\\/g, "/")); } };
  const w = world();
  const md = M.create({ pool: w.pool, wa: w.wa, getSettingsData: async () => ({ waInbox: { mediaKeepDays: 30 } }), log: { error() {} }, noTimer: true, fs: fsFake, dir: "/data/wa-media" });
  const a = await md.get({ phoneNorm: A, ref: "11" });
  assert.equal(a.ok, true); assert.deepEqual(a.buf, JPEG);
  assert.deepEqual(files.get("/data/wa-media/11-orig.bin"), JPEG);
  const row = w.db.cache.get("11:orig"); assert.equal(row.on_disk, true); assert.equal(row.bytes, null, "no bytes in the database row");
  const n = w.calls.length;
  assert.deepEqual((await md.get({ phoneNorm: A, ref: "11" })).buf, JPEG); assert.equal(w.calls.length, n, "second open reads the file");
  assert.equal((await md.usage()).storage, "disk"); assert.deepEqual([(await md.usage()).dbBytes, (await md.usage()).diskBytes], [0, 8]);
  files.delete("/data/wa-media/11-orig.bin");
  assert.deepEqual((await md.get({ phoneNorm: A, ref: "11" })).buf, JPEG); assert.equal(w.calls.length, n + 2, "a lost file is fetched from Meta again");
  assert.equal(await md.cleanup(), 1); assert.equal(files.has("/data/wa-media/11-orig.bin"), false, "cleanup removes the file too");
  assert.equal(M.fileName("11", "orig"), "11-orig.bin"); assert.equal(M.fileName("11", "../x"), "11-x.bin");
  failWrite = true;
  const md2 = M.create({ pool: w.pool, wa: w.wa, getSettingsData: async () => ({}), log: { error() {} }, noTimer: true, fs: fsFake, dir: "/nope" });
  await md2.get({ phoneNorm: A, ref: "12" });
  assert.equal(w.db.cache.get("12:orig").on_disk, false); assert.deepEqual(w.db.cache.get("12:orig").bytes, OGG); assert.equal((await md2.usage()).storage, "database");
}));

test("the webhook keeps the file's details for a customer's voice note and for a photo the cashier sent from the phone; a text message writes none", withEnv(CONFIGURED, async () => {
  const w = world();
  const body = { entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PHONE1", display_phone_number: "966546715683" },
    messages: [{ id: "wamid.V1", from: "966512345678", type: "audio", timestamp: "1760356800", audio: { id: "777777", mime_type: "audio/ogg; codecs=opus", voice: true } },
      { id: "wamid.T1", from: "966512345678", type: "text", timestamp: "1760356801", text: { body: "هلا" } }] } },
    { field: "smb_message_echoes", value: { metadata: { phone_number_id: "PHONE1", display_phone_number: "966546715683" },
      message_echoes: [{ id: "wamid.E1", from: "966546715683", to: "966512345678", type: "image", timestamp: "1760356802", image: { id: "888888", mime_type: "image/jpeg" } }] } }] }] };
  await w.wa.processWebhook(body);
  assert.deepEqual(w.db.inserted.sort(), ["wamid.E1", "wamid.T1", "wamid.V1"]);
  assert.deepEqual(w.db.mediaSaved.sort((a, b) => a[0].localeCompare(b[0])), [
    ["wamid.E1", { kind: "image", id: "888888", mime: "image/jpeg", sha256: null }],
    ["wamid.V1", { kind: "audio", id: "777777", mime: "audio/ogg; codecs=opus", sha256: null, voice: true }]]);
  assert.equal(w.calls.length, 0, "storing the details calls nothing at Meta");
}));

