/* MD3 — الموظف بيبعت صورة / ملف / رسالة صوتية في محادثة واتساب (wastaffmedia.js + whatsapp.uploadMedia + المسارات).
   بالحارس الحقيقي بتاع whatsapp.js وfetch وهمي بيسجّل كل طلب لـGraph. أرقام وهمية بس، مفيش شبكة ولا إرسال حقيقي.
   node --test wa-md3-staff-media.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

const W = await import("./whatsapp.js");
const S = await import("./wastaff.js");
const M = await import("./wastaffmedia.js");
const H = await import("./wahub.js");
const { sectionOf } = await import("./cms.js");

const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN", "WHATSAPP_TEST_PHONE_ID"];
function withEnv(vals, fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, vals);
    try { await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
}
const CONFIGURED = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1" };
const ALLOW = { ...CONFIGURED, WHATSAPP_ENABLED: "1" };
const CUST = "512345678", TESTER = "544775082", SALT = "salt-1";
const keyOf = (pn) => crypto.createHash("md5").update(`${SALT}:${pn}`).digest("hex");

/* ملفات صغيرة بأول بايتات حقيقية */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500, 1)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(800, 0x20)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(600, 2)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(3000, 3)]);
const MP4A = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypM4A "), Buffer.alloc(3000, 4)]);
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24, 0), Buffer.from("OpusHead"), Buffer.alloc(3000, 5)]);
const VORBIS = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24, 0), Buffer.from("vorbis"), Buffer.alloc(3000, 5)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(900, 6)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(900, 9)]);

function fakeApp() { const routes = {}; const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; }
/* طلب multipart وهمي: parseBody بيرجّع File حقيقي (Node 22) */
function mpCall(app, route, { param = {}, file = null, caption = undefined, voice = undefined, len = null, parseThrows = false } = {}) {
  let parsed = false;
  const c = { req: { param: (n) => param[n], query: () => undefined, header: (n) => (String(n).toLowerCase() === "content-length" && len != null ? String(len) : undefined),
    parseBody: async () => { parsed = true; if (parseThrows) throw new Error("bad"); const b = {}; if (file) b.file = file; if (caption !== undefined) b.caption = caption; if (voice !== undefined) b.voice = voice; return b; } },
  json: (body, status = 200) => ({ body, status }) };
  return Promise.resolve(app.routes[route](c)).then((r) => ({ ...r, parsed }));
}
const fileOf = (buf, name, type) => new File([buf], name, { type });

function world({ settings = {}, optins = {}, inbound = [CUST, TESTER], threads = [CUST, TESTER], portalUser = { id: "p1", name: "سلمى", role: "cashier" },
  upload = { ok: true, id: "1112223334445" }, convert = async () => ({ buf: OGG, how: "libopus" }) } = {}) {
  const db = { settings: { notifications: { whatsappEnabled: true }, waMaster: { enabled: true }, waBot: { testPhones: ["0" + TESTER] }, ...settings },
    optins: { ...optins }, inbound: [...inbound], msgs: [], staff: [], read: [], cache: [], mediaSet: [], sql: [] };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim(); db.sql.push(s);
    if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: db.inbound.includes(p[0]) ? [{}] : [] };
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: db.optins[p[0]] ? [db.optins[p[0]]] : [] };
    if (/FROM cms_contacts/i.test(s)) return { rows: [], rowCount: 0 };
    if (/^INSERT INTO wa_messages/i.test(s)) { db.msgs.push({ id: 70 + db.msgs.length, wamid: p[0], phone_norm: p[1], status: p[6], body: p[8], source: p[10], media: null }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_messages SET media=\$2::jsonb, msg_type=\$3 WHERE wamid=\$1/i.test(s)) { const m = db.msgs.find((x) => x.wamid === p[0]); if (m) { m.media = JSON.parse(p[1]); m.msg_type = p[2]; } db.mediaSet.push(p[0]); return { rows: [], rowCount: m ? 1 : 0 }; }
    if (/^SELECT id FROM wa_messages WHERE wamid=\$1/i.test(s)) { const m = db.msgs.find((x) => x.wamid === p[0]); return { rows: m ? [{ id: m.id }] : [] }; }
    if (/^INSERT INTO wa_media_cache/i.test(s)) { db.cache.push({ msg_id: p[0], variant: p[1], mime: p[2], size: p[3] }); return { rows: [], rowCount: 1 }; }
    if (/^INSERT INTO wa_staff_replies/i.test(s)) { db.staff.push({ phone_norm: p[0], wamid: p[1], by_name: p[2], role: p[3], via: p[4], test: p[5], chars: p[6], kind: p[7] }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_threads SET unread=0/i.test(s)) { db.read.push({ pn: p[0], by: p[1] }); return { rows: [], rowCount: 1 }; }
    if (/^SELECT phone_norm FROM wa_threads WHERE md5/i.test(s)) { const hit = threads.find((t) => keyOf(t) === p[1] && p[0] === SALT); return { rows: hit ? [{ phone_norm: hit }] : [] }; }
    return { rows: [], rowCount: 0 };
  } };
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url);
    if (/\/media$/.test(u)) {
      const fd = init.body; const f = fd.get("file");
      calls.push({ url: u, upload: true, auth: init.headers.Authorization, product: fd.get("messaging_product"), type: fd.get("type"), name: f && f.name, size: f && f.size, ftype: f && f.type });
      return upload.ok ? { ok: true, status: 200, json: async () => ({ id: upload.id }) } : { ok: false, status: 400, json: async () => ({ error: { code: upload.code || 131053, message: "Media upload error" } }) };
    }
    calls.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.G${calls.length}` }] }) };
  };
  const waApp = fakeApp();
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(waApp, ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const app = fakeApp();
  const audits = [];
  const requirePortal = async (c) => (portalUser ? (portalUser.role === "kitchen" ? { res: c.json({ ok: false, error: "kitchen_only" }, 403) } : { user: portalUser }) : { res: c.json({ ok: false, error: "unauthorized" }, 401) });
  const hub = { getThread: async () => ({ ok: true, messages: [] }) };
  const conv = [];
  const st = S.register(app, ctx, { wa, hub: () => hub, requirePortal, audit: (...a) => audits.push(a), keySalt: SALT, log: { error() {} }, noTimer: true,
    convertAudio: async (buf, mime) => { conv.push(mime); return convert(buf, mime); }, ffmpegCaps: async () => ({ ffmpeg: true, opus: true }) });
  return { db, app, st, wa, calls, audits, conv };
}
const send = (w, o) => w.st.sendMedia({ by: "منى", role: "operations", via: "dashboard", caption: "", ...o });
const uploads = (w) => w.calls.filter((c) => c.upload);
const msgsOut = (w) => w.calls.filter((c) => !c.upload);

/* ── الفحص ── */
test("classify: الأنواع والحدود ومحتوى الملف لازم يطابق نوعه", () => {
  const ok = (o) => { const r = M.classify(o); assert.equal(r.ok, true, JSON.stringify(r)); return r; };
  const no = (o, err) => { const r = M.classify(o); assert.equal(r.ok, false); assert.equal(r.error, err, JSON.stringify(r)); assert.ok(r.message && /[\u0600-\u06ff]/.test(r.message), "Arabic message"); };
  assert.equal(ok({ buf: JPEG, mime: "image/jpeg", name: "a.jpg" }).kind, "image");
  assert.equal(ok({ buf: PNG, mime: "image/png" }).kind, "image");
  assert.equal(ok({ buf: JPEG, mime: "image/jpg" }).mime, "image/jpeg");
  assert.equal(ok({ buf: JPEG, mime: "application/octet-stream", name: "x.JPG" }).kind, "image");      // من الامتداد
  no({ buf: HEIC, mime: "image/heic", name: "IMG_1.HEIC" }, "heic");
  no({ buf: HEIC, mime: "image/jpeg" }, "heic");
  no({ buf: Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]), mime: "image/jpeg" }, "too_large");
  no({ buf: PNG, mime: "image/jpeg" }, "mismatch");
  no({ buf: Buffer.from("<html><script>x</script>"), mime: "text/html", name: "a.html" }, "bad_type");
  no({ buf: Buffer.from("<svg/>"), mime: "image/svg+xml" }, "bad_type");
  no({ buf: JPEG, mime: "image/webp" }, "bad_type");
  const pdf = ok({ buf: PDF, mime: "application/pdf", name: "menu.pdf" }); assert.deepEqual([pdf.kind, pdf.ext], ["document", "pdf"]);
  no({ buf: EXE, mime: "application/pdf", name: "virus.pdf" }, "mismatch");
  assert.equal(ok({ buf: DOCX, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "a.docx" }).ext, "docx");
  assert.equal(ok({ buf: Buffer.from("عرض اليوم\n"), mime: "text/plain", name: "a.txt" }).kind, "document");
  no({ buf: Buffer.from([0x41, 0, 0x42]), mime: "text/plain", name: "a.txt" }, "mismatch");
  no({ buf: Buffer.concat([PDF, Buffer.alloc(16 * 1024 * 1024)]), mime: "application/pdf" }, "too_large");
  const wb = ok({ buf: WEBM, mime: "audio/webm;codecs=opus", voice: true }); assert.deepEqual([wb.kind, wb.mime, wb.convert], ["audio", "audio/webm", true]);
  const m4 = ok({ buf: MP4A, mime: "audio/mp4", voice: true }); assert.deepEqual([m4.kind, m4.convert], ["audio", false]);
  assert.equal(ok({ buf: MP4A, mime: "video/mp4", voice: true }).mime, "audio/mp4");          // سفاري ساعات بيسمّيه video/mp4
  assert.equal(ok({ buf: OGG, mime: "audio/ogg;codecs=opus" }).convert, false);
  assert.deepEqual([ok({ buf: VORBIS, mime: "audio/ogg" }).mime, M.classify({ buf: VORBIS, mime: "audio/ogg" }).convert], ["audio/ogg", true]);      // ogg/vorbis: ميتا مابتقبلوش ⇒ لازم يتحوّل
  assert.deepEqual([ok({ buf: WEBM, mime: "audio/mp4", voice: true }).mime, M.classify({ buf: WEBM, mime: "audio/mp4", voice: true }).convert], ["audio/webm", true]);   // المحتوى بيغلب الاسم
  no({ buf: JPEG, mime: "image/jpeg", voice: true }, "bad_type");
  no({ buf: PDF, mime: "audio/mpeg" }, "mismatch");
  no({ buf: Buffer.alloc(0), mime: "image/jpeg" }, "empty_file");
  no({ mime: "image/jpeg" }, "no_file");
  assert.equal(M.cleanCaption("ط".repeat(1025)).ok, false); assert.equal(M.cleanCaption("  هلا  ").text, "هلا");
  assert.equal(M.safeFileName("../../etc/passwd", "pdf"), "passwd.pdf");
  assert.equal(M.safeFileName("منيو \u0000فريش.PDF", "pdf"), "منيو فريش.PDF"); assert.equal(M.safeFileName("report.exe", "pdf"), "report.pdf");
  assert.equal(M.safeFileName("", "docx"), "ملف.docx");
});

/* ── الإرسال بالحارس الحقيقي ── */
test("صورة بتعليق: رفع لميتا ثم رسالة image من الباب الوحيد، تتسجّل echo ببيانات الملف، والملف في الكاش الخاص", withEnv(ALLOW, async () => {
  const w = world();
  const r = await send(w, { phoneNorm: "0" + CUST, file: { buf: JPEG, mime: "image/jpeg", name: "IMG_22.jpg" }, caption: "  ده شكل الطلب  " });
  assert.deepEqual(r, { ok: true, wamid: "wamid.G2", test: false, kind: "image", converted: null });
  const up = uploads(w);
  assert.equal(up.length, 1);
  assert.match(up[0].url, /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/PHONE1\/media$/);
  assert.deepEqual([up[0].auth, up[0].product, up[0].type, up[0].ftype, up[0].size], ["Bearer tok", "whatsapp", "image/jpeg", "image/jpeg", JPEG.length]);
  const out = msgsOut(w);
  assert.equal(out.length, 1); assert.match(out[0].url, /\/PHONE1\/messages$/);
  assert.deepEqual(out[0].body, { type: "image", image: { id: "1112223334445", caption: "ده شكل الطلب" }, messaging_product: "whatsapp", recipient_type: "individual", to: "966" + CUST });
  assert.deepEqual(w.db.msgs.map((m) => [m.phone_norm, m.status, m.source, m.body, m.msg_type]), [[CUST, "accepted", "echo", "ده شكل الطلب", "image"]]);
  assert.deepEqual(w.db.msgs[0].media, { kind: "image", id: "1112223334445", mime: "image/jpeg" });
  /* البيانات بتتكتب قبل ما المحادثة تتحدّث (touchThread) — الشاشة اللي بتقرا أول ما الحدث يوصل تلاقي الملف */
  const iSet = w.db.sql.findIndex((s) => /^UPDATE wa_messages SET media=/.test(s)); const iThread = w.db.sql.findIndex((s, i) => i > 0 && /wa_threads/i.test(s) && /INSERT|UPDATE/i.test(s) && !/unread=0/.test(s));
  assert.ok(iSet > 0 && (iThread === -1 || iSet < iThread), `media ${iSet} before thread ${iThread}`);
  assert.deepEqual(w.db.staff, [{ phone_norm: CUST, wamid: "wamid.G2", by_name: "منى", role: "operations", via: "dashboard", test: false, chars: 12, kind: "image" }]);
  assert.deepEqual(w.db.cache, [{ msg_id: 70, variant: "orig", mime: "image/jpeg", size: JPEG.length }]);
  assert.deepEqual(w.db.read, [{ pn: CUST, by: "منى" }]);
}));

test("ملف pdf: الاسم اللي العميل هيشوفه نضيف، والنص في المحادثة «[ملف: …]» لما مفيش تعليق", withEnv(ALLOW, async () => {
  const w = world();
  const r = await send(w, { phoneNorm: CUST, file: { buf: PDF, mime: "application/pdf", name: "C:\\fakepath\\منيو فريش كتس.pdf" } });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.kind, "document");
  assert.equal(uploads(w)[0].name, "منيو فريش كتس.pdf");
  assert.deepEqual(msgsOut(w)[0].body.document, { id: "1112223334445", filename: "منيو فريش كتس.pdf" });
  assert.equal(w.db.msgs[0].body, "[ملف: منيو فريش كتس.pdf]");
  assert.deepEqual(w.db.msgs[0].media, { kind: "document", id: "1112223334445", mime: "application/pdf", filename: "منيو فريش كتس.pdf" });
}));

test("رسالة صوتية من كروم (webm): بتتحوّل ogg/opus وتتبعت audio من غير تعليق (voice=true)", withEnv(ALLOW, async () => {
  const w = world();
  const r = await send(w, { phoneNorm: CUST, file: { buf: WEBM, mime: "audio/webm;codecs=opus", name: "voice.webm" }, voice: true, caption: "اتجاهل" });
  assert.deepEqual([r.ok, r.kind, r.converted], [true, "audio", "libopus"]);
  assert.deepEqual(w.conv, ["audio/webm"]);
  assert.deepEqual([uploads(w)[0].type, uploads(w)[0].size, uploads(w)[0].name], ["audio/ogg", OGG.length, "audio.ogg"]);
  assert.deepEqual(msgsOut(w)[0].body.audio, { id: "1112223334445" });
  assert.equal(w.db.msgs[0].body, "[رسالة صوتية]");
  assert.deepEqual(w.db.msgs[0].media, { kind: "audio", id: "1112223334445", mime: "audio/ogg", voice: true });
  assert.equal(w.db.cache[0].mime, "audio/ogg");
}));

test("webm والتحويل فشل ⇒ ٤٢٢ بسبب عربي، ولا رفع ولا إرسال · mp4 (آيفون) والتحويل فشل ⇒ بيتبعت mp4 زي ما هو", withEnv(ALLOW, async () => {
  const w = world({ convert: async () => null });
  const r = await send(w, { phoneNorm: CUST, file: { buf: WEBM, mime: "audio/webm", name: "v.webm" }, voice: true });
  assert.deepEqual([r.ok, r.status, r.error], [false, 422, "convert_failed"]); assert.match(r.message, /الآيفون/);
  assert.equal(w.calls.length, 0); assert.equal(w.db.msgs.length, 0);
  const r2 = await send(w, { phoneNorm: CUST, file: { buf: MP4A, mime: "audio/mp4", name: "v.m4a" }, voice: true });
  assert.deepEqual([r2.ok, r2.converted], [true, null]);
  assert.equal(uploads(w)[0].type, "audio/mp4");
  assert.deepEqual(w.db.msgs[0].media, { kind: "audio", id: "1112223334445", mime: "audio/mp4", voice: false });
  /* ogg جاهز (فايرفوكس): مابيتحوّلش خالص */
  const w3 = world(); const r3 = await send(w3, { phoneNorm: CUST, file: { buf: OGG, mime: "audio/ogg", name: "v.ogg" }, voice: true });
  assert.equal(r3.ok, true); assert.deepEqual(w3.conv, []);
  /* ogg/vorbis والتحويل فشل ⇒ مرفوض قبل الرفع (ميتا كانت هترفضه بعد الإرسال) */
  const w4 = world({ convert: async () => null }); const r4 = await send(w4, { phoneNorm: CUST, file: { buf: VORBIS, mime: "audio/ogg", name: "song.ogg" } });
  assert.deepEqual([r4.ok, r4.error], [false, "convert_failed"]); assert.equal(w4.calls.length, 0); assert.deepEqual(w4.conv, ["audio/ogg"]);
}));

test("النافذة مقفولة / القناة مقفولة / «إيقاف» / مفتاح المالك ⇒ رفض باسم القفل وبالعربي، ولا رفع ولا إرسال", async () => {
  const run = async (env, opts, phone = CUST) => { let out; await withEnv(env, async () => { const w = world(opts); out = await send(w, { phoneNorm: phone, file: { buf: JPEG, mime: "image/jpeg", name: "a.jpg" } });
    assert.equal(w.calls.length, 0, JSON.stringify(out)); assert.equal(w.db.msgs.length, 0); assert.equal(w.db.staff.length, 0); })(); return out; };
  let r = await run(ALLOW, { inbound: [] });
  assert.deepEqual([r.ok, r.status, r.error, r.gate], [false, 409, "window_closed", "window_closed"]); assert.match(r.message, /نافذة الـ٢٤ ساعة/);
  r = await run(CONFIGURED, {}); assert.equal(r.gate, "disabled"); assert.ok(r.message);
  r = await run({ WHATSAPP_ENABLED: "1" }, {}); assert.equal(r.gate, "unconfigured");
  r = await run(ALLOW, { settings: { waMaster: { enabled: false } } }); assert.equal(r.gate, "master_off");
  r = await run(ALLOW, { optins: { [CUST]: { stopped_at: "2026-10-10T00:00:00Z" } } }); assert.equal(r.gate, "opted_out");
  /* فحص الملف قبل الأقفال: نوع غلط مايوصلش حتى لسؤال النافذة */
  await withEnv(ALLOW, async () => { const w = world(); const x = await send(w, { phoneNorm: CUST, file: { buf: EXE, mime: "application/x-msdownload", name: "a.exe" } });
    assert.deepEqual([x.status, x.error], [400, "bad_type"]); assert.equal(w.calls.length, 0); })();
  await withEnv(ALLOW, async () => { const w = world(); const x = await send(w, { phoneNorm: CUST, file: { buf: JPEG, mime: "image/jpeg" }, caption: "ط".repeat(1025) });
    assert.deepEqual([x.status, x.error], [400, "caption_too_long"]); assert.equal(w.calls.length, 0); })();
  await withEnv(ALLOW, async () => { const w = world(); const x = await send(w, { phoneNorm: "123", file: { buf: JPEG, mime: "image/jpeg" } }); assert.equal(x.error, "bad_phone"); assert.equal(w.calls.length, 0); })();
});

test("وضع التجربة: القناة مقفولة ⇒ رقم التجربة بس (بنفس شرط النافذة)، وأي عميل تاني مرفوض قبل الرفع", withEnv(CONFIGURED, async () => {
  const w = world({ settings: { waMaster: { enabled: false } } });
  const r = await send(w, { phoneNorm: TESTER, file: { buf: PNG, mime: "image/png", name: "a.png" } });
  assert.deepEqual([r.ok, r.test], [true, true]); assert.equal(msgsOut(w)[0].body.to, "966" + TESTER); assert.equal(w.db.staff[0].test, true);
  const n = w.calls.length;
  const c = await send(w, { phoneNorm: CUST, file: { buf: PNG, mime: "image/png", name: "a.png" } });
  assert.equal(c.gate, "disabled"); assert.equal(w.calls.length, n);
}));

test("ميتا رفضت الرفع ⇒ ٥٠٢ برسالة عربي وكود ميتا، ومفيش رسالة اتبعتت ولا صف اتسجّل", withEnv(ALLOW, async () => {
  const w = world({ upload: { ok: false, code: 131053 } });
  const r = await send(w, { phoneNorm: CUST, file: { buf: JPEG, mime: "image/jpeg" } });
  assert.deepEqual([r.ok, r.status, r.error], [false, 502, "upload_failed"]); assert.match(r.message, /131053/);
  assert.equal(uploads(w).length, 1); assert.equal(msgsOut(w).length, 0); assert.equal(w.db.msgs.length, 0);
}));

/* ── whatsapp.uploadMedia ── */
test("uploadMedia: مش إرسال — بيرفض مع القفل الصلب أو من غير توكن من غير طلب شبكة، وبيبعت multipart لـgraph بس", async () => {
  await withEnv({ ...CONFIGURED, WHATSAPP_ENABLED: "0" }, async () => { const w = world(); assert.equal((await w.wa.uploadMedia({ buf: JPEG, mime: "image/jpeg" })).error, "disabled"); assert.equal(w.calls.length, 0); })();
  await withEnv({ WHATSAPP_ENABLED: "1" }, async () => { const w = world(); assert.equal((await w.wa.uploadMedia({ buf: JPEG, mime: "image/jpeg" })).error, "unconfigured"); assert.equal(w.calls.length, 0); })();
  await withEnv(ALLOW, async () => {
    const w = world();
    assert.equal((await w.wa.uploadMedia({ buf: Buffer.alloc(0), mime: "image/jpeg" })).error, "bad_file");
    assert.equal((await w.wa.uploadMedia({ buf: JPEG, mime: "not a mime" })).error, "bad_file");
    assert.equal(w.calls.length, 0);
    const r = await w.wa.uploadMedia({ buf: JPEG, mime: "image/jpeg; x=1", filename: 'a"b\r\n.jpg' });
    assert.deepEqual(r, { ok: true, id: "1112223334445" });
    assert.equal(w.calls[0].type, "image/jpeg"); assert.doesNotMatch(w.calls[0].name, /["\r\n]/);
  })();
});

test("الباب الوحيد: wastaffmedia مابيكلّمش Graph ولا بيعمل تذكرة — sendFreeform مرة واحدة؛ uploadMedia مابيلمسش ‎/messages‎؛ wastaff لسه نداء إرسال واحد", () => {
  const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const src = strip("./wastaffmedia.js");
  assert.doesNotMatch(src, /graph\.facebook\.com|\/messages|fetch\(|\.deliver\(|\.guardSend\(/);
  assert.equal((src.match(/wa\.sendFreeform\(/g) || []).length, 1);
  assert.equal((strip("./wastaff.js").match(/wa\.sendFreeform\(/g) || []).length, 1);
  const wa = strip("./whatsapp.js"); const up = wa.slice(wa.indexOf("async function uploadMedia"), wa.indexOf("async function sendTemplate"));
  assert.ok(up.length > 200); assert.doesNotMatch(up, /\/messages|deliver\(|guardSend\(/);
});

/* ── المسارات ── */
test("البورتال: كاشير ومدير يبعتوا، المطبخ ٤٠٣، من غير جلسة ٤٠١، طلب أكبر من الحد ٤١٣ قبل قراية الجسم، ومفيش ملف ٤٠٠", withEnv(ALLOW, async () => {
  const R = "POST /api/portal/wa/chats/:key/media";
  const w = world();
  let r = await mpCall(w.app, R, { param: { key: keyOf(CUST) }, file: fileOf(JPEG, "a.jpg", "image/jpeg"), caption: "تفضّل" });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual([r.body.ok, r.body.kind, r.body.wamid], [true, "image", "wamid.G2"]); assert.ok(r.body.send);
  assert.deepEqual(w.db.staff.map((x) => [x.by_name, x.role, x.via, x.kind]), [["سلمى", "cashier", "portal", "image"]]);
  assert.equal(w.audits[0][1], "wa_media");
  r = await mpCall(w.app, R, { param: { key: keyOf(CUST) }, file: fileOf(WEBM, "v.webm", "audio/webm"), voice: "1" });
  assert.equal(r.body.kind, "audio");
  const wm = world({ portalUser: { id: "m", name: "مدير", role: "manager" } });
  assert.equal((await mpCall(wm.app, R, { param: { key: keyOf(CUST) }, file: fileOf(PDF, "a.pdf", "application/pdf") })).status, 200);
  const wk = world({ portalUser: { id: "k", name: "مطبخ", role: "kitchen" } });
  r = await mpCall(wk.app, R, { param: { key: keyOf(CUST) }, file: fileOf(JPEG, "a.jpg", "image/jpeg") }); assert.equal(r.status, 403); assert.equal(wk.calls.length, 0);
  const wn = world({ portalUser: null });
  r = await mpCall(wn.app, R, { param: { key: keyOf(CUST) }, file: fileOf(JPEG, "a.jpg", "image/jpeg") }); assert.equal(r.status, 401);
  r = await mpCall(w.app, R, { param: { key: keyOf(CUST) }, len: 40 * 1024 * 1024, file: fileOf(JPEG, "a.jpg", "image/jpeg") });
  assert.deepEqual([r.status, r.body.error, r.parsed], [413, "too_large", false]);
  r = await mpCall(w.app, R, { param: { key: keyOf(CUST) } }); assert.deepEqual([r.status, r.body.error], [400, "no_file"]);
  r = await mpCall(w.app, R, { param: { key: keyOf(CUST) }, parseThrows: true }); assert.deepEqual([r.status, r.body.error], [400, "bad_body"]);
  r = await mpCall(w.app, R, { param: { key: "f".repeat(32) }, file: fileOf(JPEG, "a.jpg", "image/jpeg") }); assert.equal(r.status, 404);
  /* النافذة مقفولة من المسار: ٤٠٩ بالقفل والرسالة العربي */
  const wc = world({ inbound: [] });
  r = await mpCall(wc.app, R, { param: { key: keyOf(CUST) }, file: fileOf(JPEG, "a.jpg", "image/jpeg") });
  assert.deepEqual([r.status, r.body.gate], [409, "window_closed"]); assert.match(r.body.message, /العميل لازم يكتب الأول/); assert.equal(wc.calls.length, 0);
  const caps = await w.app.routes["GET /api/portal/wa/media-caps"]({ req: { param: () => undefined, query: () => undefined, header: () => undefined }, json: (b, s = 200) => ({ body: b, status: s }) });
  assert.equal(caps.status, 200);
  assert.deepEqual([caps.body.limits.image, caps.body.limits.document, caps.body.limits.audio, caps.body.captionMax], [5 * 1048576, 16 * 1048576, 16 * 1048576, 1024]);
  assert.deepEqual(caps.body.voice, { ffmpeg: true, opus: true, webm: true, mp4: true, ogg: true });
}));

test("اللوحة: نفس صلاحية الرد (قسم «الطلبات» + أدوار الصندوق)، والرد بيرجّع حالة الخانة", async () => {
  assert.equal(sectionOf("/api/cms/wa/threads/abc/media"), "orders");
  assert.equal(sectionOf("/api/cms/wa/threads-media-caps"), "orders");
  const sent = [];
  const pool = { async query(sql, p = []) { const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^SELECT phone_norm FROM wa_threads WHERE md5/i.test(s)) return { rows: p[1] === crypto.createHash("md5").update(`hub-salt:${CUST}`).digest("hex") ? [{ phone_norm: CUST }] : [] };
    return { rows: [], rowCount: 0 }; } };
  let user = { name: "منى", role: "operations" };
  const app = fakeApp();
  const staff = { sendMedia: async (o) => { sent.push(o); return o.file.name === "closed.jpg" ? { ok: false, status: 409, error: "window_closed", gate: "window_closed", message: "نافذة" } : { ok: true, wamid: "wamid.X", test: false, kind: "image", converted: null }; },
    sendStateFor: async () => ({ ok: true, gate: null, test: false }), mediaCaps: async () => ({ ok: true, limits: {} }) };
  H.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => ({}) }, { whoami: async () => user, timer: false, keySalt: "hub-salt", log: { error() {} },
    wa: { gate: async () => null, token: () => "t", idsInUse: () => ({}) }, staff: () => staff, waInbox: () => null, bot: () => null });
  const key = crypto.createHash("md5").update(`hub-salt:${CUST}`).digest("hex");
  let r = await mpCall(app, "POST /api/cms/wa/threads/:key/media", { param: { key }, file: fileOf(JPEG, "a.jpg", "image/jpeg"), caption: "هلا" });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual([r.body.ok, r.body.wamid, r.body.kind], [true, "wamid.X", "image"]);
  assert.deepEqual([sent[0].phoneNorm, sent[0].caption, sent[0].by, sent[0].role, sent[0].via, sent[0].file.mime], [CUST, "هلا", "منى", "operations", "dashboard", "image/jpeg"]);
  r = await mpCall(app, "POST /api/cms/wa/threads/:key/media", { param: { key }, file: fileOf(JPEG, "closed.jpg", "image/jpeg") });
  assert.deepEqual([r.status, r.body.gate], [409, "window_closed"]);
  user = { name: "س", role: "marketing" };      // دور مش في قايمة الصندوق
  r = await mpCall(app, "POST /api/cms/wa/threads/:key/media", { param: { key }, file: fileOf(JPEG, "a.jpg", "image/jpeg") });
  assert.equal(r.status, 403); assert.equal(sent.length, 2);
  user = { name: "منى", role: "operations" };
  r = await mpCall(app, "POST /api/cms/wa/threads/:key/media", { param: { key }, len: 99 * 1024 * 1024, file: fileOf(JPEG, "a.jpg", "image/jpeg") });
  assert.deepEqual([r.status, r.parsed], [413, false]);
});

test("ffmpeg مش موجود ⇒ التحويل null والقدرات false (من غير ما حاجة تقع)", async () => {
  assert.equal(await M.toOggOpus(WEBM, "audio/webm", { bin: "ffmpeg-not-installed-md3" }), null);
  assert.deepEqual(await M.ffmpegCaps({ bin: "ffmpeg-not-installed-md3", fresh: true }), { ffmpeg: false, opus: false });
  const v = await M.capsView(async () => ({ ffmpeg: false, opus: false }));
  assert.deepEqual(v.voice, { ffmpeg: false, opus: false, webm: false, mp4: true, ogg: true });
});

test("Hono حقيقي: multipart من FormData بيتقرا (ملف + تعليق + voice) ويوصل لحد ميتا الوهمية", withEnv(ALLOW, async () => {
  const { Hono } = await import("hono");
  const w = world();
  const app = new Hono();
  /* نفس المسارات بس على Hono الحقيقي (parseBody / File / content-length زي السيرفر) */
  for (const [k, h] of Object.entries(w.app.routes)) { const [m, p] = k.split(" "); app.on(m, p, h); }
  const fd = new FormData();
  fd.append("file", new File([JPEG], "صورة الطلب.jpg", { type: "image/jpeg" }));
  fd.append("caption", "تفضّل يا غالي");
  const res = await app.request(`/api/portal/wa/chats/${keyOf(CUST)}/media`, { method: "POST", body: fd });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j)); assert.deepEqual([j.ok, j.kind], [true, "image"]);
  assert.deepEqual(msgsOut(w)[0].body.image, { id: "1112223334445", caption: "تفضّل يا غالي" });
  assert.equal(uploads(w)[0].size, JPEG.length);
  const fd2 = new FormData(); fd2.append("file", new File([WEBM], "voice.webm", { type: "audio/webm;codecs=opus" })); fd2.append("voice", "1");
  const r2 = await app.request(`/api/portal/wa/chats/${keyOf(CUST)}/media`, { method: "POST", body: fd2 });
  assert.equal((await r2.json()).kind, "audio");
  const r3 = await app.request(`/api/portal/wa/chats/${keyOf(CUST)}/media`, { method: "POST", body: new FormData() });
  assert.deepEqual([r3.status, (await r3.json()).error], [400, "no_file"]);
  const r4 = await app.request(`/api/portal/wa/chats/${keyOf(CUST)}/media`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r4.status, 400);
}));
